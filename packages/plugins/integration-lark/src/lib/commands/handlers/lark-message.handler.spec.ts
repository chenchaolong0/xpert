import { LarkMessageCommand } from '../mesage.command'
import { LarkMessageHandler } from './lark-message.handler'

describe('LarkMessageHandler', () => {
	function createHandler(params?: {
		boundXpertId?: string | null
		triggerHandled?: boolean
		legacyXpertId?: string | null
	}) {
		const larkChannel = {
			errorMessage: jest.fn().mockResolvedValue(undefined)
		}
		const conversationService = {
			getActiveMessage: jest.fn().mockResolvedValue(null)
		}
		const dispatchService = {
			enqueueDispatch: jest.fn().mockResolvedValue('ok')
		}
		const larkTriggerStrategy = {
			getBoundXpertId: jest
				.fn()
				.mockReturnValue(params?.boundXpertId === undefined ? null : params.boundXpertId),
			handleInboundMessage: jest
				.fn()
				.mockResolvedValue(params?.triggerHandled === undefined ? false : params.triggerHandled)
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
		const pluginContext = {
			resolve: jest.fn().mockReturnValue(integrationPermissionService)
		}
		const handler = new LarkMessageHandler(
			larkChannel as any,
			conversationService as any,
			dispatchService as any,
			larkTriggerStrategy as any,
			pluginContext as any
		)

		return {
			handler,
			larkChannel,
			larkTriggerStrategy,
			dispatchService,
			conversationService
		}
	}

	function createCommand(overrides: Record<string, unknown> = {}) {
		return new LarkMessageCommand({
			userId: 'user-1',
			senderOpenId: 'ou_sender_1',
			integrationId: 'integration-1',
			chatId: 'chat-1',
			message: {
				message: {
					content: JSON.stringify({ text: 'hello' })
				}
			},
			...overrides
		} as any)
	}

	it('looks up active message by sender open_id key', async () => {
		const { handler, conversationService } = createHandler()

		await handler.execute(createCommand())

		expect(conversationService.getActiveMessage).toHaveBeenCalledWith('open_id:ou_sender_1', 'legacy-xpert')
	})

	it('prioritizes trigger strategy when trigger binding exists', async () => {
		const { handler, larkTriggerStrategy, dispatchService, larkChannel } = createHandler({
			boundXpertId: 'trigger-xpert',
			triggerHandled: true,
			legacyXpertId: 'legacy-xpert'
		})

		await handler.execute(createCommand())

		expect(larkTriggerStrategy.handleInboundMessage).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch).not.toHaveBeenCalled()
		expect(larkChannel.errorMessage).not.toHaveBeenCalled()
	})

	it('falls back to legacy xpert dispatch when trigger is not handled', async () => {
		const { handler, larkTriggerStrategy, dispatchService } = createHandler({
			boundXpertId: null,
			triggerHandled: false,
			legacyXpertId: 'legacy-xpert'
		})

		await handler.execute(createCommand())

		expect(larkTriggerStrategy.handleInboundMessage).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch).toHaveBeenCalledTimes(1)
		expect(dispatchService.enqueueDispatch.mock.calls[0][0].xpertId).toBe('legacy-xpert')
	})

	it('returns error when neither trigger nor legacy xpert is configured', async () => {
		const { handler, dispatchService, larkChannel } = createHandler({
			boundXpertId: null,
			triggerHandled: false,
			legacyXpertId: null
		})

		await handler.execute(createCommand())

		expect(dispatchService.enqueueDispatch).not.toHaveBeenCalled()
		expect(larkChannel.errorMessage).toHaveBeenCalledTimes(1)
	})
})
