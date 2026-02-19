import { TChatOptions, TChatRequest } from '@metad/contracts'
import { defineSystemMessageType } from './message-type'

export const SYSTEM_CHAT_DISPATCH_MESSAGE_TYPE = defineSystemMessageType('chat_dispatch', 1)


export interface SystemChatCallbackTarget {
	messageType: string
	headers?: Record<string, string>
	context?: Record<string, unknown>
}

export interface SystemChatDispatchPayload extends Record<string, unknown> {
	request: TChatRequest
	options: TChatOptions & {
		xpertId: string
	}
	callback: SystemChatCallbackTarget
}

export interface SystemChatCallbackEnvelopePayload extends Record<string, unknown> {
	kind: 'stream' | 'complete' | 'error'
	sourceMessageId: string
	sequence: number
	event?: unknown
	error?: string
	context?: Record<string, unknown>
}
