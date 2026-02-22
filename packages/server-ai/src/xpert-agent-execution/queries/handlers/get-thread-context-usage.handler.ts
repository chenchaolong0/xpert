import { IQueryHandler, QueryHandler } from '@nestjs/cqrs'
import { InjectRepository } from '@nestjs/typeorm'
import { In, IsNull, Repository } from 'typeorm'
import { XpertAgentExecution } from '../../agent-execution.entity'
import { GetThreadContextUsageQuery, TThreadContextUsage } from '../get-thread-context-usage.query'

@QueryHandler(GetThreadContextUsageQuery)
export class GetThreadContextUsageHandler implements IQueryHandler<GetThreadContextUsageQuery> {
	constructor(
		@InjectRepository(XpertAgentExecution)
		private readonly repository: Repository<XpertAgentExecution>
	) {}

	public async execute(command: GetThreadContextUsageQuery): Promise<TThreadContextUsage> {
		const rootExecution = await this.repository.findOne({
			where: {
				threadId: command.threadId,
				parentId: IsNull()
			},
			order: {
				updatedAt: 'DESC'
			}
		})

		if (!rootExecution) {
			return this.empty(command.threadId)
		}

		const usage = {
			context_tokens: 0,
			input_tokens: this.toNumber(rootExecution.inputTokens),
			output_tokens: this.toNumber(rootExecution.outputTokens),
			total_tokens: this.toNumber(rootExecution.tokens),
			embed_tokens: this.toNumber(rootExecution.embedTokens),
			total_price: this.toNumber(rootExecution.totalPrice),
			currency: rootExecution.currency ?? null
		}

		const queue = [rootExecution.id]
		const visited = new Set<string>([rootExecution.id])
		while (queue.length > 0) {
			const batch = queue.splice(0, 100)
			const children = await this.repository.find({
				where: {
					parentId: In(batch)
				}
			})

			for (const child of children) {
				if (!child.id || visited.has(child.id)) {
					continue
				}

				visited.add(child.id)
				queue.push(child.id)

				usage.input_tokens += this.toNumber(child.inputTokens)
				usage.output_tokens += this.toNumber(child.outputTokens)
				usage.total_tokens += this.toNumber(child.tokens)
				usage.embed_tokens += this.toNumber(child.embedTokens)
				usage.total_price += this.toNumber(child.totalPrice)

				if (!usage.currency && child.currency) {
					usage.currency = child.currency
				}
			}
		}

		usage.context_tokens = usage.input_tokens

		return {
			thread_id: command.threadId,
			run_id: rootExecution.id,
			updated_at: rootExecution.updatedAt?.toISOString() ?? null,
			usage
		}
	}

	private empty(threadId: string): TThreadContextUsage {
		return {
			thread_id: threadId,
			run_id: null,
			updated_at: null,
			usage: {
				context_tokens: 0,
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
				embed_tokens: 0,
				total_price: 0,
				currency: null
			}
		}
	}

	private toNumber(value: unknown): number {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value
		}
		if (typeof value === 'string') {
			const parsed = Number.parseFloat(value)
			if (Number.isFinite(parsed)) {
				return parsed
			}
		}
		return 0
	}
}
