import { Observable, of } from 'rxjs'
import {
	SYSTEM_CHAT_DISPATCH_MESSAGE_TYPE,
	SYSTEM_CHAT_MESSAGE_UPSERT_MESSAGE_TYPE
} from '@xpert-ai/plugin-sdk'
import {
	SystemChatDispatchHandoffProcessor,
	SystemChatMessageUpsertHandoffProcessor
} from './system-chat.processor'

describe('SystemChatDispatchHandoffProcessor', () => {
	const createContext = () => ({
		runId: 'run-id',
		traceId: 'trace-id',
		abortSignal: new AbortController().signal
	})

	const createMessage = (payload: Record<string, unknown>) => ({
		id: 'message-id',
		type: SYSTEM_CHAT_DISPATCH_MESSAGE_TYPE,
		version: 1,
		tenantId: 'tenant-id',
		sessionKey: 'session-id',
		businessKey: 'business-id',
		attempt: 1,
		maxAttempts: 1,
		enqueuedAt: Date.now(),
		traceId: 'trace-id',
		payload,
		headers: {
			source: 'lark'
		}
	})

	it('returns dead when required payload fields are missing', async () => {
		const commandBus = { execute: jest.fn() }
		const handoffQueueService = { enqueue: jest.fn() }
		const processor = new SystemChatDispatchHandoffProcessor(
			commandBus as any,
			handoffQueueService as any
		)

		const result = await processor.process(
			createMessage({
				options: { xpertId: 'xpert-id' },
				callback: { messageType: 'channel.lark.chat_stream_event.v1' }
			}) as any,
			createContext() as any
		)

		expect(result).toEqual({
			status: 'dead',
			reason: 'Missing request in system chat dispatch payload'
		})
	})

	it('converts stream events to callback messages with increasing sequence', async () => {
		const commandBus = { execute: jest.fn() }
		const handoffQueueService = { enqueue: jest.fn().mockResolvedValue({ id: 'callback-job-id' }) }
		const processor = new SystemChatDispatchHandoffProcessor(
			commandBus as any,
			handoffQueueService as any
		)

		commandBus.execute.mockResolvedValue(
			of(
				{ data: { type: 'message', data: 'hello' } } as MessageEvent,
				{ data: { type: 'message', data: 'world' } } as MessageEvent
			)
		)

		const result = await processor.process(
			createMessage({
				request: { input: { input: 'hello world' } },
				options: { xpertId: 'xpert-id' },
				callback: {
					messageType: 'channel.lark.chat_stream_event.v1',
					context: { integrationId: 'integration-id' }
				}
			}) as any,
			createContext() as any
		)

		expect(result).toEqual({ status: 'ok' })
		expect(handoffQueueService.enqueue).toHaveBeenCalledTimes(3)

		const callbackPayloads = handoffQueueService.enqueue.mock.calls.map(
			([callbackMessage]: [{ payload: { sequence: number; kind: string } }]) => callbackMessage.payload
		)
		expect(callbackPayloads.map((payload) => payload.sequence)).toEqual([1, 2, 3])
		expect(callbackPayloads.map((payload) => payload.kind)).toEqual(['stream', 'stream', 'complete'])
	})

	it('emits error callback message when source observable fails', async () => {
		const commandBus = { execute: jest.fn() }
		const handoffQueueService = { enqueue: jest.fn().mockResolvedValue({ id: 'callback-job-id' }) }
		const processor = new SystemChatDispatchHandoffProcessor(
			commandBus as any,
			handoffQueueService as any
		)

		commandBus.execute.mockResolvedValue(
			new Observable<MessageEvent>((subscriber) => {
				subscriber.error(new Error('boom'))
			})
		)

		const result = await processor.process(
			createMessage({
				request: { input: { input: 'hello world' } },
				options: { xpertId: 'xpert-id' },
				callback: {
					messageType: 'channel.lark.chat_stream_event.v1'
				}
			}) as any,
			createContext() as any
		)

		expect(result).toEqual({ status: 'ok' })
		expect(handoffQueueService.enqueue).toHaveBeenCalledTimes(1)
		expect(handoffQueueService.enqueue.mock.calls[0][0].payload.kind).toBe('error')
		expect(handoffQueueService.enqueue.mock.calls[0][0].payload.error).toBe('boom')
	})
})

describe('SystemChatMessageUpsertHandoffProcessor', () => {
	it('returns dead when messageId is missing', async () => {
		const commandBus = { execute: jest.fn() }
		const processor = new SystemChatMessageUpsertHandoffProcessor(commandBus as any)

		const result = await processor.process(
			{
				id: 'message-id',
				type: SYSTEM_CHAT_MESSAGE_UPSERT_MESSAGE_TYPE,
				version: 1,
				tenantId: 'tenant-id',
				sessionKey: 'session-id',
				businessKey: 'business-id',
				attempt: 1,
				maxAttempts: 1,
				enqueuedAt: Date.now(),
				traceId: 'trace-id',
				payload: {
					thirdPartyMessage: {}
				}
			} as any
		)

		expect(result).toEqual({
			status: 'dead',
			reason: 'Missing messageId in system chat message upsert payload'
		})
	})

	it('returns dead when thirdPartyMessage is missing', async () => {
		const commandBus = { execute: jest.fn() }
		const processor = new SystemChatMessageUpsertHandoffProcessor(commandBus as any)

		const result = await processor.process(
			{
				id: 'message-id',
				type: SYSTEM_CHAT_MESSAGE_UPSERT_MESSAGE_TYPE,
				version: 1,
				tenantId: 'tenant-id',
				sessionKey: 'session-id',
				businessKey: 'business-id',
				attempt: 1,
				maxAttempts: 1,
				enqueuedAt: Date.now(),
				traceId: 'trace-id',
				payload: {
					messageId: 'chat-message-id'
				}
			} as any
		)

		expect(result).toEqual({
			status: 'dead',
			reason: 'Missing thirdPartyMessage in system chat message upsert payload'
		})
	})

	it('executes upsert command when payload is valid', async () => {
		const commandBus = { execute: jest.fn().mockResolvedValue(undefined) }
		const processor = new SystemChatMessageUpsertHandoffProcessor(commandBus as any)

		const result = await processor.process(
			{
				id: 'message-id',
				type: SYSTEM_CHAT_MESSAGE_UPSERT_MESSAGE_TYPE,
				version: 1,
				tenantId: 'tenant-id',
				sessionKey: 'session-id',
				businessKey: 'business-id',
				attempt: 1,
				maxAttempts: 1,
				enqueuedAt: Date.now(),
				traceId: 'trace-id',
				payload: {
					messageId: 'chat-message-id',
					thirdPartyMessage: {
						id: 'lark-message-id'
					}
				}
			} as any
		)

		expect(result).toEqual({ status: 'ok' })
		expect(commandBus.execute).toHaveBeenCalledTimes(1)
	})
})
