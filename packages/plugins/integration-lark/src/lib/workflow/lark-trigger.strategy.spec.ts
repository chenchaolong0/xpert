import { LarkTriggerStrategy } from '../lark-trigger.strategy'

describe('LarkTriggerStrategy', () => {
	function createStrategy() {
		const dispatchService = {
			buildDispatchMessage: jest.fn().mockResolvedValue({
				id: 'handoff-id'
			})
		}
		const integrationPermissionService = {
			read: jest.fn().mockResolvedValue({ id: 'integration-1' })
		}
		const pluginContext = {
			resolve: jest.fn().mockReturnValue(integrationPermissionService)
		}

		const strategy = new LarkTriggerStrategy(dispatchService as any, pluginContext as any)
		return {
			strategy,
			dispatchService,
			integrationPermissionService
		}
	}

	it('publishes binding and forwards inbound messages via callback', async () => {
		const { strategy, dispatchService } = createStrategy()
		const callback = jest.fn()

		strategy.publish(
			{
				xpertId: 'xpert-1',
				config: {
					enabled: true,
					integrationId: 'integration-1'
				}
			} as any,
			callback
		)

		const handled = await strategy.handleInboundMessage({
			integrationId: 'integration-1',
			input: 'hello',
			larkMessage: {} as any
		})

		expect(handled).toBe(true)
		expect(dispatchService.buildDispatchMessage).toHaveBeenCalledTimes(1)
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				from: 'lark',
				xpertId: 'xpert-1',
				handoffMessage: expect.objectContaining({ id: 'handoff-id' })
			})
		)
	})

	it('throws when one integration is bound to different xperts', () => {
		const { strategy } = createStrategy()
		strategy.publish(
			{
				xpertId: 'xpert-1',
				config: {
					enabled: true,
					integrationId: 'integration-1'
				}
			} as any,
			jest.fn()
		)

		expect(() =>
			strategy.publish(
				{
					xpertId: 'xpert-2',
					config: {
						enabled: true,
						integrationId: 'integration-1'
					}
				} as any,
				jest.fn()
			)
		).toThrow(/already bound/)
	})

	it('reports validation error when integration binding conflicts', async () => {
		const { strategy } = createStrategy()
		strategy.publish(
			{
				xpertId: 'xpert-1',
				config: {
					enabled: true,
					integrationId: 'integration-1'
				}
			} as any,
			jest.fn()
		)

		const checklist = await strategy.validate({
			xpertId: 'xpert-2',
			node: { key: 'trigger-1' },
			config: {
				enabled: true,
				integrationId: 'integration-1'
			}
		} as any)

		expect(checklist).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleCode: 'TRIGGER_LARK_INTEGRATION_CONFLICT',
					field: 'integrationId',
					level: 'error'
				})
			])
		)
	})
})
