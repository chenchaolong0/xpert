import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { CommandBus } from '@nestjs/cqrs'
import {
  CancelConversationCommand,
  RequestContext,
  runWithRequestContext,
  TChatCardAction,
  TChatEventContext,
  TChatInboundMessage
} from '@xpert-ai/plugin-sdk'
import Bull, { Queue } from 'bull'
import { Cache } from 'cache-manager'
import type { Observable } from 'rxjs'
import { ChatLarkMessage } from './message'
import { LarkMessageCommand } from './commands'
import { translate } from './i18n'
import { LarkChannelStrategy } from './lark-channel.strategy'
import { LarkChatDispatchService } from './handoff/lark-chat-dispatch.service'
import {
  ChatLarkContext,
  isConfirmAction,
  isEndAction,
  isLarkCardActionValue,
  isRejectAction,
  resolveLarkCardActionValue,
  TIntegrationLarkOptions
} from './types'

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

/**
 * Manages Lark user-to-xpert conversation lifecycle and state.
 *
 * Responsibilities:
 * - Store and restore conversation/session metadata in cache.
 * - Orchestrate card action flows (confirm/reject/end) and session cleanup.
 * - Serialize inbound user events through per-user queues to keep ordering.
 * - Delegate actual xpert dispatch to `LarkChatDispatchService`.
 */
@Injectable()
export class LarkConversationService implements OnModuleDestroy {
  private readonly logger = new Logger(LarkConversationService.name)

  public static readonly prefix = 'lark:chat'
  private static readonly cacheTtlMs = 60 * 10 * 1000 // 10 min

  private userQueues: Map<string, Queue<LarkConversationQueueJob>> = new Map()

  constructor(
    private readonly commandBus: CommandBus,
    @Inject(forwardRef(() => LarkChatDispatchService))
    private readonly dispatchService: LarkChatDispatchService,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    private readonly larkChannel: LarkChannelStrategy
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
    await this.dispatchService.enqueueDispatch({
      xpertId,
      input: content,
      larkMessage: message
    })
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
      { ...chatContext, larkChannel: this.larkChannel },
      {
        id: larkMessageId,
        messageId: activeMessage.id || thirdPartyMessage.messageId,
        language: thirdPartyMessage.language,
        header: thirdPartyMessage.header,
        elements: [...(thirdPartyMessage.elements ?? [])],
        status: thirdPartyMessage.status as any
      } as any
    )

    const newMessage = new ChatLarkMessage({ ...chatContext, larkChannel: this.larkChannel }, {
      language: thirdPartyMessage.language
    } as any)

    if (isEndAction(action)) {
      await prevMessage.end()
      await this.cancelConversation(conversationId)
      await this.clearConversationSession(userId, xpertId)
    } else if (isConfirmAction(action)) {
      await prevMessage.done()
      await this.dispatchService.enqueueDispatch({
        xpertId,
        larkMessage: newMessage,
        options: {
          confirm: true
        }
      })
    } else if (isRejectAction(action)) {
      await prevMessage.done()
      await this.dispatchService.enqueueDispatch({
        xpertId,
        larkMessage: newMessage,
        options: {
          reject: true
        }
      })
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
    await this.larkChannel.errorMessage(
      { integrationId, chatId },
      new Error(translate('integration.Lark.ActionSessionTimedOut'))
    )
  }

  private async cancelConversation(conversationId?: string): Promise<void> {
    if (!conversationId) {
      return
    }

    try {
      await this.commandBus.execute(new CancelConversationCommand({ conversationId }))
    } catch (error) {
      this.logger.warn(
        `Failed to cancel conversation "${conversationId}" from Lark end action: ${
          (error as Error)?.message ?? error
        }`
      )
    }
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

        const user = await this.larkChannel.getUserById(tenantId, job.data.userId)
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

    if (!isLarkCardActionValue(action.value)) {
      this.logger.warn(`Unsupported card action value from Lark: ${JSON.stringify(action.value)}`)
      return
    }

    await this.onAction(
      resolveLarkCardActionValue(action.value),
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
