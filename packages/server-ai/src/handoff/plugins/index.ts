import { AgentChatHandoffProcessor } from './agent-chat/agent-chat.processor'
import {
	SystemChatDispatchHandoffProcessor,
} from './system-chat/system-chat.processor'

export const Processors = [
	AgentChatHandoffProcessor,
	SystemChatDispatchHandoffProcessor,
]
