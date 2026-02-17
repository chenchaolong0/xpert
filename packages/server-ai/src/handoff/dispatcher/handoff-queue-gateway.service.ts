import { InjectQueue } from '@nestjs/bull'
import { Injectable } from '@nestjs/common'
import { HandoffMessage } from '@xpert-ai/plugin-sdk'
import { Queue } from 'bull'
import {
	HandoffQueueName,
	XPERT_HANDOFF_JOB,
	XPERT_HANDOFF_QUEUE,
	XPERT_HANDOFF_QUEUE_BATCH,
	XPERT_HANDOFF_QUEUE_INTEGRATION,
	XPERT_HANDOFF_QUEUE_REALTIME
} from '../constants'

export interface HandoffQueueEnqueueOptions {
	delayMs?: number
}

export interface HandoffQueueEnqueueItem {
	queueName: HandoffQueueName
	message: HandoffMessage
	options?: HandoffQueueEnqueueOptions
}

@Injectable()
export class HandoffQueueGatewayService {
	readonly #queueByName: Record<HandoffQueueName, Queue<HandoffMessage>>

	constructor(
		@InjectQueue(XPERT_HANDOFF_QUEUE)
		private readonly defaultQueue: Queue<HandoffMessage>,
		@InjectQueue(XPERT_HANDOFF_QUEUE_REALTIME)
		private readonly realtimeQueue: Queue<HandoffMessage>,
		@InjectQueue(XPERT_HANDOFF_QUEUE_BATCH)
		private readonly batchQueue: Queue<HandoffMessage>,
		@InjectQueue(XPERT_HANDOFF_QUEUE_INTEGRATION)
		private readonly integrationQueue: Queue<HandoffMessage>
	) {
		this.#queueByName = {
			[XPERT_HANDOFF_QUEUE]: this.defaultQueue,
			[XPERT_HANDOFF_QUEUE_REALTIME]: this.realtimeQueue,
			[XPERT_HANDOFF_QUEUE_BATCH]: this.batchQueue,
			[XPERT_HANDOFF_QUEUE_INTEGRATION]: this.integrationQueue
		}
	}

	async enqueue(
		queueName: HandoffQueueName,
		message: HandoffMessage,
		options?: HandoffQueueEnqueueOptions
	) {
		await this.getQueue(queueName).add(XPERT_HANDOFF_JOB, message, {
			delay: Math.max(0, options?.delayMs ?? 0),
			removeOnComplete: true,
			removeOnFail: false
		})
	}

	async enqueueMany(items: HandoffQueueEnqueueItem[]) {
		for (const item of items) {
			await this.enqueue(item.queueName, item.message, item.options)
		}
	}

	private getQueue(queueName: HandoffQueueName): Queue<HandoffMessage> {
		return this.#queueByName[queueName]
	}
}
