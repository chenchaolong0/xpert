import {
	LanguagesEnum,
	TChatOptions
} from '@metad/contracts'
import { forwardRef, Inject, Injectable } from '@nestjs/common'
import {
	AGENT_CHAT_DISPATCH_MESSAGE_TYPE,
	HandoffMessage,
	HANDOFF_PERMISSION_SERVICE_TOKEN,
	HandoffPermissionService,
	PluginContext,
	RequestContext,
	SystemChatDispatchPayload
} from '@xpert-ai/plugin-sdk'
import { randomUUID } from 'crypto'
import { LarkConversationService } from '../conversation.service'
import { ChatLarkMessage } from '../message'
import { LARK_PLUGIN_CONTEXT } from '../tokens'
import { LarkChatRunStateService } from './lark-chat-run-state.service'
import {
	LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE,
	LarkChatCallbackContext,
	LarkChatMessageSnapshot
} from './lark-chat.types'

export type TLarkChatDispatchInput = {
	xpertId: string
	input?: string
	larkMessage: ChatLarkMessage
	options?: {
		confirm?: boolean
		reject?: boolean
	}
}

/**
 * Builds and enqueues handoff messages for Lark chat requests.
 *
 * Responsibilities:
 * - Translate Lark-side input/message context into system chat dispatch payloads.
 * - Persist stream/run callback state used by incremental UI updates.
 * - Update active message/session cache so follow-up actions can resume context.
 */
@Injectable()
export class LarkChatDispatchService {
	private _handoffPermissionService: HandoffPermissionService

	constructor(
		@Inject(forwardRef(() => LarkConversationService))
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

	async enqueueDispatch(input: TLarkChatDispatchInput): Promise<ChatLarkMessage> {
		const message = await this.buildDispatchMessage(input)
		await this.handoffPermissionService.enqueue(message, {
			delayMs: 0
		})
		return input.larkMessage
	}

	async buildDispatchMessage(input: TLarkChatDispatchInput): Promise<HandoffMessage<SystemChatDispatchPayload>> {
		const { xpertId, larkMessage } = input
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
			reject: Boolean(input.options?.reject),
			streaming: this.resolveStreamingOverrideFromRequest(),
			message: this.toMessageSnapshot(larkMessage, input.input)
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

		return {
			id: runId,
			type: AGENT_CHAT_DISPATCH_MESSAGE_TYPE,
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
						input: input.input
					},
					conversationId,
					confirm: input.options?.confirm
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
		}
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
