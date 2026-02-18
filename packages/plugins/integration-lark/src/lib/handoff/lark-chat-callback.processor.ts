import {
	ChatMessageEventTypeEnum,
	ChatMessageTypeEnum,
	messageContentText,
	XpertAgentExecutionStatusEnum
} from '@metad/contracts'
import { Inject, Injectable, Logger } from '@nestjs/common'
import {
	HandoffMessage,
	HandoffProcessorStrategy,
	IHandoffProcessor,
	PluginContext,
	ProcessContext,
	ProcessResult,
} from '@xpert-ai/plugin-sdk'
import { ChatLarkMessage } from '../chat/message'
import { LarkConversationService } from '../conversation.service'
import { LarkService } from '../lark.service'
import {
	DEFAULT_STREAM_UPDATE_WINDOW_MS,
	IntegrationLarkPluginConfig,
	MAX_STREAM_UPDATE_WINDOW_MS,
	MIN_STREAM_UPDATE_WINDOW_MS
} from '../plugin-config'
import { LARK_PLUGIN_CONTEXT } from '../tokens'
import {
	LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE,
	LarkChatCallbackContext,
	LarkChatMessageSnapshot,
	LarkChatStreamCallbackPayload
} from './lark-chat.types'
import { LarkChatRunState, LarkChatRunStateService } from './lark-chat-run-state.service'

/**
 * Callback processor for Lark stream events.
 *
 * End-to-end path:
 * server-ai system dispatch processor -> callback queue message -> this processor.
 *
 * Responsibilities:
 * - restore run state per source message id
 * - reorder out-of-order callbacks by sequence
 * - apply stream/event callbacks to Lark message
 * - finalize run and clear run state on completion
 */
@Injectable()
@HandoffProcessorStrategy(LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE, {
	types: [LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE],
	policy: {
		lane: 'main'
	}
})
export class LarkChatStreamCallbackProcessor implements IHandoffProcessor<LarkChatStreamCallbackPayload> {
	private readonly logger = new Logger(LarkChatStreamCallbackProcessor.name)
	private readonly sourceLocks = new Map<string, Promise<unknown>>()

	constructor(
		private readonly conversationService: LarkConversationService,
		private readonly larkService: LarkService,
		private readonly runStateService: LarkChatRunStateService,
		@Inject(LARK_PLUGIN_CONTEXT)
		private readonly pluginContext: PluginContext<IntegrationLarkPluginConfig>
	) {}

	async process(
		message: HandoffMessage<LarkChatStreamCallbackPayload>,
		_ctx: ProcessContext
	): Promise<ProcessResult> {
		// this.logger.debug(`Processing Lark chat callback message with id "${message.id}"`, message)
		const payload = message.payload
		if (!payload?.sourceMessageId) {
			return {
				status: 'dead',
				reason: 'Missing sourceMessageId in Lark callback payload'
			}
		}
		if (!payload?.sequence || payload.sequence <= 0) {
			return {
				status: 'dead',
				reason: 'Missing sequence in Lark callback payload'
			}
		}

		return this.runWithSourceLock(payload.sourceMessageId, async () => {
			let state = await this.runStateService.get(payload.sourceMessageId)
			if (!state) {
				if (!payload.context) {
					return {
						status: 'dead',
						reason: `Run state not found for source message "${payload.sourceMessageId}"`
					}
				}
				state = this.createRunState(payload.sourceMessageId, payload.context)
			}
			state = this.ensureRunStateDefaults(state)

			if (payload.sequence < state.nextSequence) {
				return { status: 'ok' }
			}

			if (!state.pendingEvents[String(payload.sequence)]) {
				state.pendingEvents[String(payload.sequence)] = payload
			}

			const completed = await this.processPendingEvents(state)
			if (completed) {
				await this.runStateService.clear(state.sourceMessageId)
			} else {
				await this.runStateService.save(state)
			}

			return { status: 'ok' }
		})
	}

	private async runWithSourceLock(
		sourceMessageId: string,
		task: () => Promise<ProcessResult>
	): Promise<ProcessResult> {
		const previous = this.sourceLocks.get(sourceMessageId) ?? Promise.resolve()
		const current = previous
			.catch(() => undefined)
			.then(task)
		this.sourceLocks.set(sourceMessageId, current)

		try {
			return await current
		} finally {
			if (this.sourceLocks.get(sourceMessageId) === current) {
				this.sourceLocks.delete(sourceMessageId)
			}
		}
	}

	/**
	 * Flush pending callbacks strictly by nextSequence.
	 *
	 * We process only when the expected sequence exists; out-of-order messages
	 * stay buffered in pendingEvents until earlier sequence arrives.
	 */
	private async processPendingEvents(state: LarkChatRunState): Promise<boolean> {
		this.logger.debug(
			`Processing pending events for source message "${state.sourceMessageId}": nextSequence=${state.nextSequence}, pendingCount=${Object.keys(state.pendingEvents).length}`
		)
		
		while (state.pendingEvents[String(state.nextSequence)]) {
			const payload = state.pendingEvents[String(state.nextSequence)]
			delete state.pendingEvents[String(state.nextSequence)]
			this.logger.debug(
				`Applying callback payload for source message "${state.sourceMessageId}": sequence=${payload.sequence}, kind=${payload.kind}`
			)

			switch (payload.kind) {
				case 'stream': {
					await this.applyStreamEvent(state, payload.event)
					break
				}
				case 'complete': {
					await this.completeRun(state)
					return true
				}
				case 'error': {
					await this.failRun(state, payload.error)
					return true
				}
				default: {
					this.logger.warn(
						`Unprocessed Lark callback kind "${(payload as { kind?: unknown }).kind}" in source message "${state.sourceMessageId}"`
					)
				}
			}

			state.nextSequence += 1
		}

		return false
	}

	/**
	 * Apply one callback stream event.
	 *
	 * MESSAGE:
	 * - append content into response buffer
	 * - keep compatibility with structured update payload
	 * - flush buffered text to Lark by configurable time window
	 *
	 * EVENT:
	 * - apply conversation/message lifecycle events
	 */
	private async applyStreamEvent(state: LarkChatRunState, event: unknown) {
		const context = state.context
		let larkMessage: ChatLarkMessage | undefined
		const ensureLarkMessage = (): ChatLarkMessage => {
			if (!larkMessage) {
				larkMessage = this.createLarkMessage(context)
				const fallbackLanguage = this.resolveMessageLanguage(context)
				if (!larkMessage.language && fallbackLanguage) {
					larkMessage.language = fallbackLanguage
				}
			}
			return larkMessage
		}

		const eventPayload = (event as MessageEvent | undefined)?.data
		if (!eventPayload) {
			this.logger.warn('Unrecognized handoff stream event')
			return
		}
		this.logger.debug(
			`Applying stream event for source message "${state.sourceMessageId}": type=${eventPayload.type}`
		)

		if (eventPayload.type === ChatMessageTypeEnum.MESSAGE) {
			state.responseMessageContent += messageContentText(eventPayload.data)
			if (typeof eventPayload.data !== 'string') {
				if (eventPayload.data?.type === 'update') {
					const message = ensureLarkMessage()
					await message.update(eventPayload.data.data)
					context.message = this.toMessageSnapshot(message, context.message?.text)
					await this.syncActiveMessageCache(context)
					return
				} else if (eventPayload.data?.type !== 'text') {
					this.logger.warn('Unprocessed chat message event payload')
				}
			}

			this.logger.debug(`Appended stream content for source message "${state.sourceMessageId}", current buffered length: ${state.responseMessageContent.length}`)
			const now = Date.now()
			const updateWindowMs = this.resolveStreamUpdateWindowMs(context)
			if (this.shouldFlushStreamContent(state, now, updateWindowMs)) {
				const message = ensureLarkMessage()
				await this.flushStreamContent(state, message, now)
				context.message = this.toMessageSnapshot(message, context.message?.text)
				await this.syncActiveMessageCache(context)
			}
			return
		}

		if (eventPayload.type !== ChatMessageTypeEnum.EVENT) {
			return
		}

		switch (eventPayload.event) {
			case ChatMessageEventTypeEnum.ON_CONVERSATION_START: {
				await this.conversationService.setConversation(
					context.userId,
					context.xpertId,
					eventPayload.data.id
				)
				break
			}
			case ChatMessageEventTypeEnum.ON_MESSAGE_START: {
				context.message = {
					...(context.message ?? {}),
					messageId: eventPayload.data.id
				}
				await this.syncActiveMessageCache(context)
				break
			}
			case ChatMessageEventTypeEnum.ON_CONVERSATION_END: {
				if (
					eventPayload.data.status === XpertAgentExecutionStatusEnum.INTERRUPTED &&
					eventPayload.data.operation
				) {
					const message = ensureLarkMessage()
					await message.confirm(eventPayload.data.operation)
				} else if (eventPayload.data.status === XpertAgentExecutionStatusEnum.ERROR) {
					const message = ensureLarkMessage()
					await message.error(eventPayload.data.error || 'Internal Error')
				}
				break
			}
			case ChatMessageEventTypeEnum.ON_AGENT_START:
			case ChatMessageEventTypeEnum.ON_AGENT_END:
			case ChatMessageEventTypeEnum.ON_MESSAGE_END: {
				break
			}
			default: {
				this.logger.warn(
					`Unprocessed chat event type from handoff stream: ${eventPayload.event as string}`
				)
			}
		}

		if (larkMessage) {
			context.message = this.toMessageSnapshot(larkMessage, context.message?.text)
			await this.syncActiveMessageCache(context)
		}
	}

	private async completeRun(state: LarkChatRunState) {
		const context = state.context
		const larkMessage = this.createLarkMessage(context)
		const currentStatus = context.message?.status
		const keepTerminalState =
			currentStatus === XpertAgentExecutionStatusEnum.INTERRUPTED ||
			currentStatus === XpertAgentExecutionStatusEnum.ERROR

		if (!keepTerminalState) {
			if (state.responseMessageContent) {
				// Force full-content overwrite to avoid duplicate append on complete.
				larkMessage.elements = [{ tag: 'markdown', content: state.responseMessageContent }]
				await larkMessage.update({
					status: XpertAgentExecutionStatusEnum.SUCCESS
				})
			} else if (context.reject || larkMessage.elements.length > 0) {
				await larkMessage.update({
					status: XpertAgentExecutionStatusEnum.SUCCESS
				})
			}
		}

		context.message = this.toMessageSnapshot(larkMessage, context.message?.text)
		await this.syncActiveMessageCache(context)
	}

	private async failRun(state: LarkChatRunState, error?: string) {
		const larkMessage = this.createLarkMessage(state.context)
		await larkMessage.error(error || 'Internal Error')
		state.context.message = this.toMessageSnapshot(larkMessage, state.context.message?.text)
		await this.syncActiveMessageCache(state.context)
	}

	private createLarkMessage(context: LarkChatCallbackContext): ChatLarkMessage {
		const language = this.resolveMessageLanguage(context)
		if (language && context.message?.language !== language) {
			context.message = {
				...(context.message ?? {}),
				language
			}
		}

		return new ChatLarkMessage(
			{
				tenant: null,
				organizationId: context.organizationId,
				integrationId: context.integrationId,
				userId: context.userId,
				chatId: context.chatId,
				senderOpenId: context.senderOpenId,
				larkService: this.larkService
			},
			{
				id: context.message?.id,
				messageId: context.message?.messageId,
				status: context.message?.status as any,
				language,
				header: context.message?.header,
				elements: [...(context.message?.elements ?? [])],
				text: context.message?.text
			}
		)
	}

	private createRunState(sourceMessageId: string, context: LarkChatCallbackContext): LarkChatRunState {
		return {
			sourceMessageId,
			nextSequence: 1,
			responseMessageContent: '',
			context,
			pendingEvents: {},
			lastFlushAt: 0,
			lastFlushedLength: 0
		}
	}

	private ensureRunStateDefaults(state: LarkChatRunState): LarkChatRunState {
		return {
			...state,
			pendingEvents: state.pendingEvents ?? {},
			lastFlushAt: state.lastFlushAt ?? 0,
			lastFlushedLength: state.lastFlushedLength ?? 0
		}
	}

	private resolveStreamUpdateWindowMs(context: LarkChatCallbackContext): number {
		const fromContext = context.streaming?.updateWindowMs
		const fromConfig = this.pluginContext.config?.streaming?.updateWindowMs
		const candidate = fromContext ?? fromConfig ?? DEFAULT_STREAM_UPDATE_WINDOW_MS
		return Math.min(
			MAX_STREAM_UPDATE_WINDOW_MS,
			Math.max(MIN_STREAM_UPDATE_WINDOW_MS, candidate)
		)
	}

	private shouldFlushStreamContent(
		state: LarkChatRunState,
		now: number,
		updateWindowMs: number
	): boolean {
		if (!state.responseMessageContent) {
			return false
		}
		if (state.responseMessageContent.length <= state.lastFlushedLength) {
			return false
		}
		return now - state.lastFlushAt >= updateWindowMs
	}

	private async flushStreamContent(
		state: LarkChatRunState,
		larkMessage: ChatLarkMessage,
		now: number
	) {
		this.logger.debug(`Flushing stream content for source message "${state.sourceMessageId}", content length: ${state.responseMessageContent.length}`)
		// Overwrite rendering: replace with one markdown block using full buffered response.
		larkMessage.elements = [
			{
				tag: 'markdown',
				content: state.responseMessageContent
			}
		]
		await larkMessage.update()
		state.lastFlushAt = now
		state.lastFlushedLength = state.responseMessageContent.length
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

	private async syncActiveMessageCache(context: LarkChatCallbackContext): Promise<void> {
		if (!context?.userId || !context?.xpertId) {
			return
		}

		const message = context.message ?? {}
		const language = this.resolveMessageLanguage(context)
		await this.conversationService.setActiveMessage(context.userId, context.xpertId, {
			id: message.messageId,
			thirdPartyMessage: {
				id: message.id,
				messageId: message.messageId,
				status: message.status,
				language,
				header: message.header,
				elements: [...(message.elements ?? [])]
			}
		})
	}

	private resolveMessageLanguage(context: LarkChatCallbackContext): string | undefined {
		const snapshotLanguage = context.message?.language
		if (typeof snapshotLanguage === 'string' && snapshotLanguage.length > 0) {
			return snapshotLanguage
		}
		const requestLanguage = context.requestContext?.headers?.['language']
		if (typeof requestLanguage === 'string' && requestLanguage.length > 0) {
			return requestLanguage
		}
		return undefined
	}
}
