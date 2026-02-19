import {
	LanguagesEnum,
	TChatOptions
} from '@metad/contracts'
import {
	HandoffMessage,
	HANDOFF_PERMISSION_SERVICE_TOKEN,
	HandoffPermissionService,
	PluginContext,
	RequestContext,
	SYSTEM_CHAT_DISPATCH_MESSAGE_TYPE,
	SystemChatDispatchPayload
} from '@xpert-ai/plugin-sdk'
import { Inject } from '@nestjs/common'
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs'
import { randomUUID } from 'crypto'
import { ChatLarkMessage } from '../../chat/message'
import { LarkConversationService } from '../../conversation.service'
import {
	LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE,
	LarkChatCallbackContext,
	LarkChatMessageSnapshot
} from '../../handoff/lark-chat.types'
import { LarkChatRunStateService } from '../../handoff/lark-chat-run-state.service'
import { LARK_PLUGIN_CONTEXT } from '../../tokens'
import { LarkChatXpertCommand } from '../chat-xpert.command'

@CommandHandler(LarkChatXpertCommand)
export class LarkChatXpertHandler implements ICommandHandler<LarkChatXpertCommand> {
	private _handoffPermissionService: HandoffPermissionService

	constructor(
		private readonly conversationService: LarkConversationService,
		private readonly runStateService: LarkChatRunStateService,
		@Inject(LARK_PLUGIN_CONTEXT)
		private readonly pluginContext: PluginContext
	) {}

	private get handoffPermissionService(): HandoffPermissionService {
		if (!this._handoffPermissionService) {
			this._handoffPermissionService = this.pluginContext.resolve(HANDOFF_PERMISSION_SERVICE_TOKEN)
		}
		return this._handoffPermissionService
	}

	public async execute(command: LarkChatXpertCommand) {
		const { xpertId, input, larkMessage } = command
		const userId = RequestContext.currentUserId()
		const tenantId = RequestContext.currentTenantId()
		if (!tenantId) {
			throw new Error('Missing tenantId in request context')
		}

		const organizationId = RequestContext.getOrganizationId()
		const conversationId = await this.conversationService.getConversation(userId, xpertId)

		await larkMessage.update({ status: 'thinking' })
		await this.conversationService.setActiveMessage(
			userId,
			xpertId,
			this.toActiveMessageCache(larkMessage)
		)

		const runId = `lark-chat-${randomUUID()}`
		const sessionKey = conversationId ?? runId
		const language = larkMessage.language || RequestContext.getLanguageCode()
		const callbackContext: LarkChatCallbackContext = {
			tenantId,
			organizationId,
			userId,
			xpertId,
			integrationId: larkMessage.integrationId,
			chatId: larkMessage.chatId,
			senderOpenId: larkMessage.senderOpenId,
			reject: Boolean(command.options?.reject),
			streaming: this.resolveStreamingOverrideFromRequest(),
			message: this.toMessageSnapshot(larkMessage, input)
		}

		await this.runStateService.save({
			sourceMessageId: runId,
			nextSequence: 1,
			responseMessageContent: '',
			context: callbackContext,
			pendingEvents: {},
			lastFlushAt: 0,
			lastFlushedLength: 0,
			renderItems: (callbackContext.message?.elements ?? []).map((element) => ({
				kind: 'structured' as const,
				element: { ...element }
			}))
		})

		await this.handoffPermissionService.enqueue(
			{
				id: runId,
				type: SYSTEM_CHAT_DISPATCH_MESSAGE_TYPE,
				version: 1,
				tenantId,
				sessionKey,
				businessKey: sessionKey,
				attempt: 1,
				maxAttempts: 1,
				enqueuedAt: Date.now(),
				traceId: runId,
				payload: {
					request: {
						input: {
							input
						},
						conversationId,
						confirm: command.options?.confirm
					},
					options: {
						xpertId,
						from: 'feishu',
						fromEndUserId: userId,
						tenantId,
						organizationId,
						user: RequestContext.currentUser(),
						language: language as LanguagesEnum,
						channelType: 'lark',
						integrationId: larkMessage.integrationId,
						chatId: larkMessage.chatId,
						channelUserId: larkMessage.senderOpenId
					} as TChatOptions & { xpertId: string },
					callback: {
						messageType: LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE,
						headers: {
							...(organizationId ? { organizationId } : {}),
							...(userId ? { userId } : {}),
							...(language ? { language } : {}),
							...(conversationId ? { conversationId } : {}),
							source: 'lark',
							handoffQueue: 'integration',
							requestedLane: 'main',
							...(larkMessage.integrationId ? { integrationId: larkMessage.integrationId } : {})
						},
						context: callbackContext
					}
				} as SystemChatDispatchPayload,
				headers: {
					...(organizationId ? { organizationId } : {}),
					...(userId ? { userId } : {}),
					...(language ? { language } : {}),
					...(conversationId ? { conversationId } : {}),
					source: 'lark',
					requestedLane: 'main',
					handoffQueue: 'realtime',
					...(larkMessage.integrationId ? { integrationId: larkMessage.integrationId } : {})
				}
			} as HandoffMessage<SystemChatDispatchPayload>,
			{
				delayMs: 0
			}
		)

		return larkMessage
	}

	private toMessageSnapshot(message: ChatLarkMessage, text?: string): LarkChatMessageSnapshot {
		return {
			id: message.id,
			messageId: message.messageId,
			status: message.status,
			language: message.language,
			header: message.header,
			elements: [...(message.elements ?? [])],
			text
		}
	}

	private toActiveMessageCache(message: ChatLarkMessage) {
		return {
			id: message.messageId,
			thirdPartyMessage: {
				id: message.id,
				messageId: message.messageId,
				status: message.status as string,
				language: message.language,
				header: message.header,
				elements: [...(message.elements ?? [])]
			}
		}
	}

	private resolveStreamingOverrideFromRequest(): LarkChatCallbackContext['streaming'] | undefined {
		const request = RequestContext.currentRequest()
		const rawHeader =
			request?.headers?.['x-lark-stream-update-window-ms'] ??
			request?.headers?.['lark-stream-update-window-ms']
		const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
		if (!rawValue) {
			return undefined
		}
		const parsed = parseInt(String(rawValue), 10)
		if (!Number.isFinite(parsed) || parsed <= 0) {
			return undefined
		}
		return {
			updateWindowMs: parsed
		}
	}
}
