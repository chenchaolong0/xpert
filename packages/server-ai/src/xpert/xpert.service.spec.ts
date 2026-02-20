import { STATE_VARIABLE_HUMAN } from '@metad/contracts'
import { XpertEnqueueTriggerDispatchCommand } from './commands'
import { XpertService } from './xpert.service'

describe('XpertService trigger dispatch facade', () => {
	function createService() {
		const repository = {
			findOne: jest.fn(),
			save: jest.fn(),
			find: jest.fn(),
			findOneBy: jest.fn(),
			count: jest.fn(),
			createQueryBuilder: jest.fn().mockReturnValue({
				innerJoin: jest.fn().mockReturnThis(),
				where: jest.fn().mockReturnThis(),
				select: jest.fn().mockReturnThis(),
				getMany: jest.fn().mockResolvedValue([]),
				leftJoinAndSelect: jest.fn().mockReturnThis(),
				addOrderBy: jest.fn().mockReturnThis(),
				take: jest.fn().mockReturnThis()
			})
		}
		const storeService = {
			findAll: jest.fn()
		}
		const userService = {
			findAll: jest.fn(),
			findOne: jest.fn()
		}
		const commandBus = { execute: jest.fn().mockResolvedValue(undefined) }
		const queryBus = { execute: jest.fn() }
		const eventEmitter = { emitAsync: jest.fn() }
		const triggerRegistry = { get: jest.fn(), list: jest.fn().mockReturnValue([]) }
		const sandboxService = { listProviders: jest.fn().mockReturnValue([]) }
		const redisLockService = { acquireLock: jest.fn() }

		const service = new XpertService(
			repository as any,
			storeService as any,
			userService as any,
			commandBus as any,
			queryBus as any,
			eventEmitter as any,
			triggerRegistry as any,
			sandboxService as any,
			redisLockService as any
		)

		return {
			service,
			commandBus
		}
	}

	it('addTriggerJob forwards to XpertEnqueueTriggerDispatchCommand', async () => {
		const { service, commandBus } = createService()

		await service.addTriggerJob(
			'xpert-1',
			'user-1',
			{
				[STATE_VARIABLE_HUMAN]: {
					input: 'hello'
				}
			} as any,
			{
				trigger: null as any,
				isDraft: false,
				from: 'schedule' as any
			}
		)

		expect(commandBus.execute).toHaveBeenCalledTimes(1)
		const [command] = commandBus.execute.mock.calls[0]
		expect(command).toBeInstanceOf(XpertEnqueueTriggerDispatchCommand)
		expect(command).toEqual(
			expect.objectContaining({
				xpertId: 'xpert-1',
				userId: 'user-1',
				state: expect.objectContaining({
					[STATE_VARIABLE_HUMAN]: {
						input: 'hello'
					}
				}),
				params: expect.objectContaining({
					isDraft: false,
					from: 'schedule'
				})
			})
		)
	})

	it('enqueueTriggerDispatch forwards to XpertEnqueueTriggerDispatchCommand', async () => {
		const { service, commandBus } = createService()

		await service.enqueueTriggerDispatch(
			'xpert-1',
			'user-1',
			{
				[STATE_VARIABLE_HUMAN]: {
					input: 'hello'
				}
			} as any,
			{
				isDraft: true,
				from: 'knowledge'
			}
		)

		expect(commandBus.execute).toHaveBeenCalledTimes(1)
		const [command] = commandBus.execute.mock.calls[0]
		expect(command).toBeInstanceOf(XpertEnqueueTriggerDispatchCommand)
		expect(command).toEqual(
			expect.objectContaining({
				xpertId: 'xpert-1',
				params: expect.objectContaining({
					isDraft: true,
					from: 'knowledge'
				})
			})
		)
	})
})
