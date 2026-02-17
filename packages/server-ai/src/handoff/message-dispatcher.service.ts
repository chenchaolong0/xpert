import { Injectable } from '@nestjs/common'
import { HandoffPendingResultService } from './pending-result.service'
import { HandoffMessage, HandoffProcessorRegistry, LaneName, ProcessResult, RunSource } from '@xpert-ai/plugin-sdk'

// const RUN_SOURCES: RunSource[] = ['chat', 'xpert', 'lark', 'analytics', 'api']
// const LANE_NAMES: LaneName[] = ['main', 'subagent', 'cron', 'nested']

@Injectable()
export class MessageDispatcherService {
	constructor(
		private readonly processorRegistry: HandoffProcessorRegistry,
		private readonly pendingResults: HandoffPendingResultService
	) {}

	async dispatch(message: HandoffMessage): Promise<ProcessResult> {
		this.assertMessage(message)

		const organizationId = this.getOrganizationId(message)
		const resolved = this.processorRegistry.get(message.type, organizationId)
		const runId = message.id
		const abortController = new AbortController()

		return resolved.process(message, {
			runId,
			traceId: message.traceId,
			abortSignal: abortController.signal,
			emit: (event) => {
				this.pendingResults.publish(message.id, event)
			}
		})
	}

	private assertMessage(message: HandoffMessage) {
		if (!message) {
			throw new Error('Invalid handoff message: message is required')
		}
		if (!message.id) {
			throw new Error('Invalid handoff message: id is required')
		}
		if (!message.type) {
			throw new Error('Invalid handoff message: type is required')
		}
		if (!message.tenantId) {
			throw new Error('Invalid handoff message: tenantId is required')
		}
		if (!message.sessionKey) {
			throw new Error('Invalid handoff message: sessionKey is required')
		}
		if (!message.traceId) {
			throw new Error('Invalid handoff message: traceId is required')
		}
		if (!message.businessKey) {
			throw new Error('Invalid handoff message: businessKey is required')
		}
	}

	private getOrganizationId(message: HandoffMessage): string | undefined {
		return this.getHeader(message, 'organizationId')
	}

	private getHeader(message: HandoffMessage, key: string): string | undefined {
		const value = message.headers?.[key]
		if (typeof value === 'string' && value.length > 0) {
			return value
		}
		return undefined
	}
}
