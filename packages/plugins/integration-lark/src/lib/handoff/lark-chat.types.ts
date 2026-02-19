import { LanguagesEnum, TChatOptions } from '@metad/contracts'
import {
	defineChannelMessageType,
	SystemChatCallbackEnvelopePayload
} from '@xpert-ai/plugin-sdk'


export const LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE = defineChannelMessageType(
	'lark',
	'chat_stream_event',
	1
)

export type LarkElementScalar = string | number | boolean | null

export interface LarkElementObject {
	[key: string]: LarkElementScalar | LarkElementObject | Array<LarkElementScalar | LarkElementObject>
}

export interface LarkCardElement extends LarkElementObject {
	tag: string
}

export interface LarkMarkdownElement extends LarkCardElement {
	tag: 'markdown'
	content: string
}

export type LarkStreamTextElement = LarkMarkdownElement

export type LarkEventElement = LarkMarkdownElement

export type LarkStructuredElement = LarkCardElement

export type LarkRenderElement =
	| LarkStreamTextElement
	| LarkEventElement
	| LarkStructuredElement

export interface LarkStreamTextRenderItem {
	kind: 'stream_text'
	text: string
}

export interface LarkEventRenderItem {
	kind: 'event'
	id: string
	eventType: string
	tool?: string | null
	title?: string | null
	message?: string | null
	status?: string | null
	error?: string | null
}

export interface LarkStructuredRenderItem {
	kind: 'structured'
	element: LarkStructuredElement
}

export type LarkRenderItem = LarkStreamTextRenderItem | LarkEventRenderItem | LarkStructuredRenderItem

export interface LarkChatMessageSnapshot {
	id?: string
	messageId?: string
	status?: string
	language?: string
	header?: any
	elements?: LarkCardElement[]
	text?: string
}

export interface LarkChatCallbackContext extends Record<string, unknown> {
	tenantId: string
	organizationId?: string
	userId: string
	xpertId: string
	integrationId?: string
	chatId?: string
	senderOpenId?: string
	reject?: boolean
	streaming?: {
		updateWindowMs?: number
	}
	message: LarkChatMessageSnapshot
}

export interface LarkChatStreamCallbackPayload extends SystemChatCallbackEnvelopePayload {
	context?: LarkChatCallbackContext
}

export interface LarkChatHandoffPayload extends Record<string, unknown> {
	request: {
		input: {
			input: string
		}
		conversationId?: string
		confirm?: boolean
	}
	options: TChatOptions & {
		xpertId: string
		from: string
		fromEndUserId: string
		tenantId: string
		organizationId?: string
		user?: any
		language?: LanguagesEnum
		channelType?: string
		integrationId?: string
		chatId?: string
		channelUserId?: string
	}
}
