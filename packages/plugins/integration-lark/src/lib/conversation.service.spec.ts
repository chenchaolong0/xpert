import { LarkConversationService } from './conversation.service'
import { CancelConversationCommand } from '@xpert-ai/plugin-sdk'
import { ChatLarkContext, LARK_CONFIRM, LARK_END_CONVERSATION, LARK_REJECT } from './types'

class MemoryCache {
	private readonly store = new Map<string, unknown>()

	async set(key: string, value: unknown) {
		this.store.set(key, value)
	}

	async get<T = unknown>(key: string): Promise<T | undefined> {
		return this.store.get(key) as T | undefined
	}

	async del(key: string) {
		this.store.delete(key)
	}
}

describe('LarkConversationService', () => {
	const userId = 'user-1'
	const xpertId = 'xpert-1'

	function createChatContext(): ChatLarkContext {
		return {
			tenant: null as any,
			organizationId: 'org-1',
			integrationId: 'integration-1',
			userId,
			chatId: 'chat-1'
		}
	}

	function createFixture() {
		const commandBus = {
			execute: jest.fn().mockResolvedValue(undefined)
		}
		const cache = new MemoryCache()
		const larkChannel = {
			errorMessage: jest.fn().mockResolvedValue(undefined),
			patchInteractiveMessage: jest.fn().mockResolvedValue(undefined),
			interactiveMessage: jest.fn().mockResolvedValue({ data: { message_id: 'generated-lark-message-id' } })
		}
		const service = new LarkConversationService(commandBus as any, cache as any, larkChannel as any)

		return {
			service,
			commandBus,
			larkChannel
		}
	}

	it.each([LARK_CONFIRM, LARK_REJECT, LARK_END_CONVERSATION])(
		'returns timeout and clears caches when active message is missing (%s)',
		async (action) => {
			const { service, larkChannel } = createFixture()
			await service.setConversation(userId, xpertId, 'conversation-1')

			await service.onAction(action, createChatContext(), userId, xpertId, 'action-message-id')

			expect(larkChannel.errorMessage).toHaveBeenCalledTimes(1)
			expect(await service.getConversation(userId, xpertId)).toBeUndefined()
			expect(await service.getActiveMessage(userId, xpertId)).toBeNull()
		}
	)

	it('uses action.messageId fallback when cached thirdPartyMessage.id is missing', async () => {
		const { service, larkChannel, commandBus } = createFixture()
		await service.setConversation(userId, xpertId, 'conversation-1')
		await service.setActiveMessage(userId, xpertId, {
			id: 'chat-message-id',
			thirdPartyMessage: {
				messageId: 'chat-message-id',
				language: 'en_US',
				header: null,
				elements: [{ tag: 'markdown', content: 'cached body' }],
				status: 'thinking'
			}
		})

		await service.onAction(LARK_CONFIRM, createChatContext(), userId, xpertId, 'action-message-id')

		expect(larkChannel.patchInteractiveMessage).toHaveBeenCalledTimes(1)
		expect(larkChannel.patchInteractiveMessage).toHaveBeenCalledWith(
			'integration-1',
			'action-message-id',
			expect.any(Object)
		)
		const patchPayload = (larkChannel.patchInteractiveMessage as jest.Mock).mock.calls[0][2]
		expect(patchPayload.elements).toContainEqual({ tag: 'markdown', content: 'cached body' })
		expect(commandBus.execute).toHaveBeenCalledTimes(1)
		expect(commandBus.execute.mock.calls[0][0].options).toEqual({ confirm: true })
	})

	it('keeps existing card content on end, cancels conversation and clears conversation session', async () => {
		const { service, larkChannel, commandBus } = createFixture()
		await service.setConversation(userId, xpertId, 'conversation-1')
		await service.setActiveMessage(userId, xpertId, {
			id: 'chat-message-id',
			thirdPartyMessage: {
				id: 'cached-lark-message-id',
				messageId: 'chat-message-id',
				language: 'en_US',
				header: null,
				elements: [{ tag: 'markdown', content: 'persisted body' }],
				status: 'thinking'
			}
		})

		await service.onAction(LARK_END_CONVERSATION, createChatContext(), userId, xpertId)

		expect(larkChannel.patchInteractiveMessage).toHaveBeenCalledTimes(1)
		expect(larkChannel.patchInteractiveMessage).toHaveBeenCalledWith(
			'integration-1',
			'cached-lark-message-id',
			expect.any(Object)
		)
		const patchPayload = (larkChannel.patchInteractiveMessage as jest.Mock).mock.calls[0][2]
		expect(
			patchPayload.elements.some(
				(element: { tag?: string; content?: string }) =>
					element.tag === 'markdown' && element.content === 'persisted body'
			)
		).toBe(true)
		expect(commandBus.execute).toHaveBeenCalledTimes(1)
		expect(commandBus.execute.mock.calls[0][0]).toBeInstanceOf(CancelConversationCommand)
		expect(commandBus.execute.mock.calls[0][0].input).toEqual({ conversationId: 'conversation-1' })
		expect(await service.getConversation(userId, xpertId)).toBeUndefined()
		expect(await service.getActiveMessage(userId, xpertId)).toBeNull()
	})
})
