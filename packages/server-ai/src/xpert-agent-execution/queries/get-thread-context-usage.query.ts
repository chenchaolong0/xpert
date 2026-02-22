import { IQuery } from '@nestjs/cqrs'

export type TThreadContextUsage = {
	thread_id: string
	run_id: string | null
	updated_at: string | null
	usage: {
		context_tokens: number
		input_tokens: number
		output_tokens: number
		total_tokens: number
		embed_tokens: number
		total_price: number
		currency: string | null
	}
}

export class GetThreadContextUsageQuery implements IQuery {
	static readonly type = '[Xpert Agent Execution] Get thread context usage'

	constructor(public readonly threadId: string) {}
}
