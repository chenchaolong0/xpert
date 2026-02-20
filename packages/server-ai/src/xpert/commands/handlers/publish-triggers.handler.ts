import { IWFNTrigger, IXpert, TXpertGraph, WorkflowNodeTypeEnum } from '@metad/contracts'
import { getErrorMessage } from '@metad/server-common'
import { Logger } from '@nestjs/common'
import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs'
import { HandoffMessage, IWorkflowTriggerStrategy, WorkflowTriggerRegistry } from '@xpert-ai/plugin-sdk'
import { HandoffQueueService } from '../../../handoff/message-queue.service'
import { XpertEnqueueTriggerDispatchCommand } from '../enqueue-trigger-dispatch.command'
import { XpertPublishTriggersCommand } from '../publish-triggers.command'

@CommandHandler(XpertPublishTriggersCommand)
export class XpertPublishTriggersHandler implements ICommandHandler<XpertPublishTriggersCommand> {
	readonly #logger = new Logger(XpertPublishTriggersHandler.name)

	constructor(
		private readonly triggerRegistry: WorkflowTriggerRegistry,
		private readonly commandBus: CommandBus,
		private readonly handoffQueue: HandoffQueueService
	) {}

	public async execute(command: XpertPublishTriggersCommand): Promise<void> {
		const { xpert, options } = command
		const strict = options?.strict ?? false
		if (options?.previousGraph) {
			await this.stopTriggers(xpert.id, options.previousGraph, strict)
		}

		const triggers = this.listPublishedTriggers(xpert.graph)
		for await (const trigger of triggers) {
			let provider: IWorkflowTriggerStrategy<any>
			try {
				provider = this.triggerRegistry.get(trigger.from)
			} catch (error) {
				if (strict) {
					throw error
				}
				this.#logger.warn(
					`Trigger provider "${trigger.from}" not found for xpert "${xpert.id}", skip publish`
				)
				continue
			}

			try {
				await Promise.resolve(
					provider.publish(
						{
							xpertId: xpert.id,
							config: trigger.config
						},
						(payload) => {
							this.handleTriggerPayload(xpert, trigger, payload).catch((error) => {
								this.#logger.error(
									`Trigger "${trigger.from}" callback failed for xpert "${xpert.id}": ${getErrorMessage(error)}`
								)
							})
						}
					)
				)
			} catch (error) {
				if (strict) {
					throw error
				}
				this.#logger.error(
					`Publish trigger "${trigger.from}" failed for xpert "${xpert.id}": ${getErrorMessage(error)}`
				)
			}
		}
	}

	private async handleTriggerPayload(xpert: IXpert, trigger: IWFNTrigger, payload: any) {
		if (!payload) {
			this.#logger.warn(`Trigger "${trigger.from}" returned empty payload for xpert "${xpert.id}"`)
			return
		}

		if (payload.handoffMessage) {
			await this.handoffQueue.enqueue(payload.handoffMessage as HandoffMessage)
			return
		}

		if (!payload.state) {
			this.#logger.warn(`Trigger "${trigger.from}" payload has no state for xpert "${xpert.id}"`)
			return
		}

		await this.commandBus.execute(
			new XpertEnqueueTriggerDispatchCommand(xpert.id, null, payload.state, {
				isDraft: false,
				from: payload.from,
				executionId: payload.executionId
			})
		)
	}

	private async stopTriggers(xpertId: string, graph: TXpertGraph, strict: boolean) {
		const triggers = this.listPublishedTriggers(graph)
		for (const trigger of triggers) {
			let provider: IWorkflowTriggerStrategy<any>
			try {
				provider = this.triggerRegistry.get(trigger.from)
			} catch (error) {
				if (strict) {
					throw error
				}
				continue
			}

			try {
				await Promise.resolve(
					provider.stop({
						xpertId,
						config: trigger.config
					})
				)
			} catch (error) {
				if (strict) {
					throw error
				}
				this.#logger.warn(
					`Stop trigger "${trigger.from}" failed for xpert "${xpertId}": ${getErrorMessage(error)}`
				)
			}
		}
	}

	private listPublishedTriggers(graph?: TXpertGraph): IWFNTrigger[] {
		return (
			graph?.nodes
				?.filter((node) => node.type === 'workflow' && node.entity.type === WorkflowNodeTypeEnum.TRIGGER)
				.map((node) => node.entity as IWFNTrigger)
				.filter((node) => node.from && node.from !== 'chat') ?? []
		)
	}
}
