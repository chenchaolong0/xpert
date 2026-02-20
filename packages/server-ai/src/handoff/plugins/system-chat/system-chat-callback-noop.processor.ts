import { Injectable } from '@nestjs/common'
import {
	HandoffMessage,
	HandoffProcessorStrategy,
	IHandoffProcessor,
	ProcessContext,
	ProcessResult,
	SystemChatCallbackEnvelopePayload
} from '@xpert-ai/plugin-sdk'

export const SYSTEM_CHAT_CALLBACK_NOOP_MESSAGE_TYPE = 'system.chat_callback.noop.v1'

@Injectable()
@HandoffProcessorStrategy(SYSTEM_CHAT_CALLBACK_NOOP_MESSAGE_TYPE, {
	types: [SYSTEM_CHAT_CALLBACK_NOOP_MESSAGE_TYPE],
	policy: {
		lane: 'main'
	}
})
export class SystemChatCallbackNoopHandoffProcessor
	implements IHandoffProcessor<SystemChatCallbackEnvelopePayload>
{
	async process(
		_message: HandoffMessage<SystemChatCallbackEnvelopePayload>,
		_ctx: ProcessContext
	): Promise<ProcessResult> {
		return { status: 'ok' }
	}
}
