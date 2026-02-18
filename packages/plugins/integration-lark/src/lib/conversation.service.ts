import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { CommandBus } from '@nestjs/cqrs'
import {
  RequestContext,
  runWithRequestContext,
  TChatCardAction,
  TChatEventContext,
  TChatInboundMessage
} from '@xpert-ai/plugin-sdk'
import Bull, { Queue } from 'bull'
import { Cache } from 'cache-manager'
import type { Observable } from 'rxjs'
import { ChatLarkMessage } from './chat/message'
import { LarkMessageCommand } from './commands'
import { LarkChatXpertCommand } from './commands/chat-xpert.command'
import { translate } from './i18n'
import { LarkService } from './lark.service'
import { ChatLarkContext, isConfirmAction, isEndAction, isRejectAction, TIntegrationLarkOptions } from './types'

type LarkConversationQueueJob = ChatLarkContext & {
  tenantId?: string
}

type LarkActiveMessage = {
  id?: string
  thirdPartyMessage?: {
    id?: string
    messageId?: string
    language?: string
    header?: any
    elements?: any[]
    status?: string
  }
}

@Injectable()
export class LarkConversationService implements OnModuleDestroy {
  private readonly logger = new Logger(LarkConversationService.name)

  @Inject(forwardRef(() => LarkService))
  private readonly larkService: LarkService

  public static readonly prefix = 'lark:chat'
  private static readonly cacheTtlMs = 60 * 10 * 1000 // 10 min

  private userQueues: Map<string, Queue<LarkConversationQueueJob>> = new Map()

  constructor(
    private readonly commandBus: CommandBus,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache
  ) {}

  /**
   * Get conversation ID for a user to xpert.
   * 
   * @param userId 
   * @param xpertId 
   * @returns Conversation ID
   */
  async getConversation(userId: string, xpertId: string) {
    const key = this.getConversationCacheKey(userId, xpertId)
    return await this.cacheManager.get<string>(key)
  }

  /**
   * Set conversation ID for a user to xpert.
   * 
   * @param userId 
   * @param xpertId 
   * @param conversationId 
   */
  async setConversation(userId: string, xpertId: string, conversationId: string) {
    const key = this.getConversationCacheKey(userId, xpertId)
    await this.cacheManager.set(key, conversationId, LarkConversationService.cacheTtlMs)
  }

  async getActiveMessage(userId: string, xpertId: string): Promise<LarkActiveMessage | null> {
    const key = this.getActiveMessageCacheKey(userId, xpertId)
    const message = await this.cacheManager.get<LarkActiveMessage>(key)
    return message ?? null
  }

  async setActiveMessage(userId: string, xpertId: string, message: LarkActiveMessage): Promise<void> {
    const key = this.getActiveMessageCacheKey(userId, xpertId)
    await this.cacheManager.set(key, message, LarkConversationService.cacheTtlMs)
  }

  async clearConversationSession(userId: string, xpertId: string): Promise<void> {
    await this.cacheManager.del(this.getConversationCacheKey(userId, xpertId))
    await this.cacheManager.del(this.getActiveMessageCacheKey(userId, xpertId))
  }

  async ask(xpertId: string, content: string, message: ChatLarkMessage) {
    await this.commandBus.execute(new LarkChatXpertCommand(xpertId, content, message))
  }

  /**
   * Respond to card button click events.
   * 
   * @param action 
   * @param chatContext 
   * @param userId 
   * @param xpertId 
   * @returns 
   */
  async onAction(
    action: string,
    chatContext: ChatLarkContext,
    userId: string,
    xpertId: string,
    actionMessageId?: string
  ) {
    const conversationId = await this.getConversation(userId, xpertId)

    if (!conversationId) {
      return this.replyActionSessionTimedOut(chatContext)
    }

    if (!isEndAction(action) && !isConfirmAction(action) && !isRejectAction(action)) {
      const user = RequestContext.currentUser()
      const userQueue = await this.getUserQueue(user.id)
      // Adding task to user's queue
      await userQueue.add({
        ...chatContext,
        tenantId: user.tenantId,
        input: action
      })
      return
    }

    const activeMessage = await this.getActiveMessage(userId, xpertId)
    const thirdPartyMessage = activeMessage?.thirdPartyMessage

    const larkMessageId = actionMessageId || thirdPartyMessage?.id
    if (!activeMessage || !thirdPartyMessage || !larkMessageId) {
      await this.clearConversationSession(userId, xpertId)
      return this.replyActionSessionTimedOut(chatContext)
    }

    const prevMessage = new ChatLarkMessage(
      { ...chatContext, larkService: this.larkService },
      {
        id: larkMessageId,
        messageId: activeMessage.id || thirdPartyMessage.messageId,
        language: thirdPartyMessage.language,
        header: thirdPartyMessage.header,
        elements: [...(thirdPartyMessage.elements ?? [])],
        status: thirdPartyMessage.status as any
      } as any
    )

    const newMessage = new ChatLarkMessage({ ...chatContext, larkService: this.larkService }, {
      language: thirdPartyMessage.language
    } as any)

    if (isEndAction(action)) {
      await prevMessage.end()
      await this.clearConversationSession(userId, xpertId)
    } else if (isConfirmAction(action)) {
      await prevMessage.done()
      await this.commandBus.execute(
        new LarkChatXpertCommand(xpertId, null, newMessage, {
          confirm: true
        })
      )
    } else if (isRejectAction(action)) {
      await prevMessage.done()
      await this.commandBus.execute(
        new LarkChatXpertCommand(xpertId, null, newMessage, {
          reject: true
        })
      )
    }
  }

  private getConversationCacheKey(userId: string, xpertId: string): string {
    return `${LarkConversationService.prefix}:${userId}:${xpertId}`
  }

  private getActiveMessageCacheKey(userId: string, xpertId: string): string {
    return `${this.getConversationCacheKey(userId, xpertId)}:active-message`
  }

  private async replyActionSessionTimedOut(chatContext: ChatLarkContext): Promise<void> {
    const { integrationId, chatId } = chatContext
    await this.larkService.errorMessage(
      { integrationId, chatId },
      new Error(translate('integration.Lark.ActionSessionTimedOut'))
    )
  }

  /**
   * Get or create user queue
   *
   * @param userId
   * @returns
   */
  async getUserQueue(userId: string): Promise<Bull.Queue<LarkConversationQueueJob>> {
    if (!this.userQueues.has(userId)) {
      const queue = new Bull<LarkConversationQueueJob>(`lark:user:${userId}`, {
        redis: this.getBullRedisConfig()
      })

      /**
       * Bind processing logic, maximum concurrency is one
       */
      queue.process(1, async (job) => {
        const tenantId = job.data.tenantId || job.data.tenant?.id
        if (!tenantId) {
          this.logger.warn(`Missing tenantId for user ${job.data.userId}, skip job ${job.id}`)
          return
        }

        const user = await this.larkService.getUserById(tenantId, job.data.userId)
        if (!user) {
          this.logger.warn(`User ${job.data.userId} not found, skip job ${job.id}`)
          return
        }

        runWithRequestContext(
          {
            user,
            headers: {
              ['organization-id']: job.data.organizationId,
              ['tenant-id']: tenantId,
              ...(job.data.preferLanguage
                ? {
                    language: job.data.preferLanguage
                  }
                : {})
            }
          },
          {},
          async () => {
            try {
              await this.commandBus.execute<LarkMessageCommand, Observable<any>>(new LarkMessageCommand(job.data))
              return `Processed message: ${job.id}`
            } catch (err) {
              this.logger.error(err)
            }
          }
        )
      })

      // completed event
      queue.on('completed', (job) => {
        console.log(`Job ${job.id} for user ${userId} completed.`)
      })

      // failed event
      queue.on('failed', (job, error) => {
        console.error(`Job ${job.id} for user ${userId} failed:`, error.message)
      })

      queue.on('error', (error) => {
        this.logger.error(`Queue lark:user:${userId} error: ${error?.message || error}`)
      })

      // Save user's queue
      this.userQueues.set(userId, queue)
    }

    return this.userQueues.get(userId)
  }

  private getBullRedisConfig(): Bull.QueueOptions['redis'] {
    const redisUrl = process.env.REDIS_URL
    if (redisUrl) {
      return redisUrl
    }

    const host = process.env.REDIS_HOST || 'localhost'
    const portRaw = process.env.REDIS_PORT || 6379
    const username = process.env['REDIS.USERNAME'] || process.env.REDIS_USER || process.env.REDIS_USERNAME || undefined
    const password = process.env.REDIS_PASSWORD || undefined

    const port = Number(portRaw)
    const redis: Bull.QueueOptions['redis'] = {
      host,
      port: Number.isNaN(port) ? 6379 : port
    }
    if (username) {
      redis['username'] = username
    }
    if (password) {
      redis['password'] = password
    }

    const tlsFlag = process.env.REDIS_TLS
    if (tlsFlag === 'true') {
      redis['tls'] = {
        host,
        port: Number.isNaN(port) ? 6379 : port
      }
    }

    return redis
  }

  /**
   * Handle inbound message from IChatChannel
   *
   * This method is called by LarkHooksController when a message is received via webhook.
   * It creates a job in the user's queue for processing.
   *
   * @param message - Parsed inbound message
   * @param ctx - Event context containing integration info
   */
  async handleMessage(message: TChatInboundMessage, ctx: TChatEventContext<TIntegrationLarkOptions>): Promise<void> {
    const user = RequestContext.currentUser()
    if (!user) {
      this.logger.warn('No user in request context, cannot handle message')
      return
    }

    const userQueue = await this.getUserQueue(user.id)

    // Add task to user's queue
    await userQueue.add({
      tenant: ctx.integration.tenant,
      tenantId: user.tenantId || ctx.tenantId,
      organizationId: ctx.organizationId,
      integrationId: ctx.integration.id,
      preferLanguage: ctx.integration.options?.preferLanguage,
      userId: user.id,
      message: message.raw,
      chatId: message.chatId,
      chatType: message.chatType,
      senderOpenId: message.senderId // Lark sender's open_id
    })
  }

  /**
   * Handle card action from IChatChannel
   *
   * This method is called by LarkHooksController when a card button is clicked.
   *
   * @param action - Parsed card action
   * @param ctx - Event context containing integration info
   */
  async handleCardAction(action: TChatCardAction, ctx: TChatEventContext<TIntegrationLarkOptions>): Promise<void> {
    const { xpertId } = ctx.integration.options ?? {}
    if (!xpertId) {
      this.logger.warn('No xpertId configured for integration')
      return
    }

    const user = RequestContext.currentUser()
    if (!user) {
      this.logger.warn('No user in request context, cannot handle card action')
      return
    }

    await this.onAction(
      action.value,
      {
        tenant: ctx.integration.tenant,
        organizationId: ctx.organizationId,
        integrationId: ctx.integration.id,
        preferLanguage: ctx.integration.options?.preferLanguage,
        userId: user.id,
        chatId: action.chatId
      } as ChatLarkContext,
      user.id,
      xpertId,
      action.messageId
    )
  }

  async onModuleDestroy() {
    for (const queue of this.userQueues.values()) {
      await queue.close()
    }
  }
}
