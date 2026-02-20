import { AgentChatHandoffProcessor } from './agent-chat/agent-chat.processor'
import {
	SystemChatDispatchHandoffProcessor,
} from './system-chat/system-chat.processor'
import {
	SystemChatCallbackNoopHandoffProcessor
} from './system-chat/system-chat-callback-noop.processor'

export const Processors = [
	AgentChatHandoffProcessor,
	SystemChatDispatchHandoffProcessor,
	SystemChatCallbackNoopHandoffProcessor,
]
