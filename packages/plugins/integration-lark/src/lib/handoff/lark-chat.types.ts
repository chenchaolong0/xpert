import { LanguagesEnum, TChatOptions } from '@metad/contracts'
import {
	defineChannelMessageType,
	HandoffRequestContextPayload,
	SystemChatCallbackEnvelopePayload
} from '@xpert-ai/plugin-sdk'


export const LARK_CHAT_STREAM_CALLBACK_MESSAGE_TYPE = defineChannelMessageType(
	'lark',
	'chat_stream_event',
	1
)

export interface LarkChatMessageSnapshot {
	id?: string
	messageId?: string
	status?: string
	language?: string
	header?: any
	elements?: any[]
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
	requestContext?: HandoffRequestContextPayload
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
	requestContext?: HandoffRequestContextPayload
}
