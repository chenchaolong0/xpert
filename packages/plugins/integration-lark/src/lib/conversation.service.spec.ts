import { LarkConversationService } from './conversation.service'
import {
	CancelConversationCommand,
	INTEGRATION_PERMISSION_SERVICE_TOKEN,
	RequestContext
} from '@xpert-ai/plugin-sdk'
import { ChatLarkContext, LARK_CONFIRM, LARK_END_CONVERSATION, LARK_REJECT } from './types'
import { LarkTriggerStrategy } from './workflow/lark-trigger.strategy'

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

	function createFixture(params?: {
		boundXpertId?: string | null
		triggerHandled?: boolean
		legacyXpertId?: string | null
	}) {
		const commandBus = {
			execute: jest.fn().mockResolvedValue(undefined)
		}
		const dispatchService = {
			enqueueDispatch: jest.fn().mockResolvedValue('ok')
		}
		const integrationPermissionService = {
			read: jest.fn().mockResolvedValue({
				id: 'integration-1',
				options: {
					xpertId: params?.legacyXpertId === undefined ? 'legacy-xpert' : params.legacyXpertId,
					preferLanguage: 'en_US'
				}
			})
		}
		const larkTriggerStrategy = {
			getBoundXpertId: jest
				.fn()
				.mockReturnValue(params?.boundXpertId === undefined ? null : params.boundXpertId),
			handleInboundMessage: jest
				.fn()
				.mockResolvedValue(params?.triggerHandled === undefined ? false : params.triggerHandled)
		}
		const pluginContext = {
			resolve: jest.fn((token: unknown) => {
				if (token === INTEGRATION_PERMISSION_SERVICE_TOKEN) {
					return integrationPermissionService
				}
				if (token === LarkTriggerStrategy) {
					return larkTriggerStrategy
				}
				throw new Error(`Unexpected token: ${String(token)}`)
			})
		}
		const cache = new MemoryCache()
		const larkChannel = {
			errorMessage: jest.fn().mockResolvedValue(undefined),
			patchInteractiveMessage: jest.fn().mockResolvedValue(undefined),
			interactiveMessage: jest.fn().mockResolvedValue({ data: { message_id: 'generated-lark-message-id' } })
		}
		const service = new LarkConversationService(
			commandBus as any,
			dispatchService as any,
			cache as any,
			larkChannel as any,
			pluginContext as any
		)

		return {
			service,
			commandBus,
			dispatchService,
			larkChannel,
			integrationPermissionService,
			larkTriggerStrategy
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
		const { service, larkChannel, commandBus, dispatchService } = createFixture()
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
		expect(dispatchService.enqueueDispatch).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch.mock.calls[0][0].options).toEqual({ confirm: true })
		expect(commandBus.execute).not.toHaveBeenCalled()
	})

	it('keeps existing card content on end, cancels conversation and clears conversation session', async () => {
		const { service, larkChannel, commandBus, dispatchService } = createFixture()
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
		expect(dispatchService.enqueueDispatch).not.toHaveBeenCalled()
		expect(await service.getConversation(userId, xpertId)).toBeUndefined()
		expect(await service.getActiveMessage(userId, xpertId)).toBeNull()
	})

	it('resolves conversation key from card action open_id', async () => {
		const { service } = createFixture()
		const onAction = jest.spyOn(service, 'onAction').mockResolvedValue(undefined as any)
		jest.spyOn(RequestContext, 'currentUser').mockReturnValue({
			id: userId,
			tenantId: 'tenant-1'
		} as any)

		await service.handleCardAction(
			{
				value: LARK_CONFIRM,
				userId: 'ou-action-1',
				chatId: 'chat-1',
				messageId: 'action-message-id'
			} as any,
			{
				organizationId: 'org-1',
				integration: {
					id: 'integration-1',
					tenant: null,
					options: {
						xpertId
					}
				}
			} as any
		)

		expect(onAction).toHaveBeenCalledWith(
			LARK_CONFIRM,
			expect.objectContaining({
				userId,
				senderOpenId: 'ou-action-1'
			}),
			'open_id:ou-action-1',
			xpertId,
			'action-message-id'
		)
	})

	it('skips card action handling when action open_id is missing', async () => {
		const { service } = createFixture()
		const onAction = jest.spyOn(service, 'onAction').mockResolvedValue(undefined as any)
		jest.spyOn(RequestContext, 'currentUser').mockReturnValue({
			id: userId,
			tenantId: 'tenant-1'
		} as any)

		await service.handleCardAction(
			{
				value: LARK_CONFIRM,
				chatId: 'chat-1',
				messageId: 'action-message-id'
			} as any,
			{
				organizationId: 'org-1',
				integration: {
					id: 'integration-1',
					tenant: null,
					options: {
						xpertId
					}
				}
			} as any
		)

		expect(onAction).not.toHaveBeenCalled()
	})

	it('processMessage looks up active message by sender open_id key', async () => {
		const { service } = createFixture()

		const getActiveMessage = jest.spyOn(service, 'getActiveMessage')
		await service.processMessage({
			userId: 'user-1',
			senderOpenId: 'ou_sender_1',
			integrationId: 'integration-1',
			chatId: 'chat-1',
			message: {
				message: {
					content: JSON.stringify({ text: 'hello' })
				}
			}
		} as any)

		expect(getActiveMessage).toHaveBeenCalledWith('open_id:ou_sender_1', 'legacy-xpert')
	})

	it('processMessage prioritizes trigger strategy when trigger binding exists', async () => {
		const { service, larkTriggerStrategy, dispatchService, larkChannel } = createFixture({
			boundXpertId: 'trigger-xpert',
			triggerHandled: true,
			legacyXpertId: 'legacy-xpert'
		})

		await service.processMessage({
			userId: 'user-1',
			senderOpenId: 'ou_sender_1',
			integrationId: 'integration-1',
			chatId: 'chat-1',
			message: {
				message: {
					content: JSON.stringify({ text: 'hello' })
				}
			}
		} as any)

		expect(larkTriggerStrategy.handleInboundMessage).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch).not.toHaveBeenCalled()
		expect(larkChannel.errorMessage).not.toHaveBeenCalled()
	})

	it('processMessage falls back to legacy xpert dispatch when trigger is not handled', async () => {
		const { service, larkTriggerStrategy, dispatchService } = createFixture({
			boundXpertId: null,
			triggerHandled: false,
			legacyXpertId: 'legacy-xpert'
		})

		await service.processMessage({
			userId: 'user-1',
			senderOpenId: 'ou_sender_1',
			integrationId: 'integration-1',
			chatId: 'chat-1',
			message: {
				message: {
					content: JSON.stringify({ text: 'hello' })
				}
			}
		} as any)

		expect(larkTriggerStrategy.handleInboundMessage).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch.mock.calls[0][0].xpertId).toBe('legacy-xpert')
	})

	it('processMessage returns error when neither trigger nor legacy xpert is configured', async () => {
		const { service, dispatchService, larkChannel } = createFixture({
			boundXpertId: null,
			triggerHandled: false,
			legacyXpertId: null
		})

		await service.processMessage({
			userId: 'user-1',
			senderOpenId: 'ou_sender_1',
			integrationId: 'integration-1',
			chatId: 'chat-1',
			message: {
				message: {
					content: JSON.stringify({ text: 'hello' })
				}
			}
		} as any)

		expect(dispatchService.enqueueDispatch).not.toHaveBeenCalled()
		expect(larkChannel.errorMessage).toHaveBeenCalledTimes(1)
	})
})
