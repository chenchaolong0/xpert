import { ChecklistItem, TWorkflowTriggerMeta } from '@metad/contracts'
import { Inject, Injectable, Logger } from '@nestjs/common'
import {
	INTEGRATION_PERMISSION_SERVICE_TOKEN,
	IntegrationPermissionService,
	IWorkflowTriggerStrategy,
	PluginContext,
	TWorkflowTriggerParams,
	WorkflowTriggerStrategy
} from '@xpert-ai/plugin-sdk'
import { ChatLarkMessage } from '../message'
import { LARK_PLUGIN_CONTEXT } from '../tokens'
import { LarkChatDispatchService } from '../handoff'
import { LarkTrigger, TLarkTriggerConfig } from './lark-trigger.types'
import { iconImage } from '../types'

type TriggerBinding = {
	xpertId: string
	callback?: (payload: any) => void
}

@Injectable()
@WorkflowTriggerStrategy(LarkTrigger)
export class LarkTriggerStrategy implements IWorkflowTriggerStrategy<TLarkTriggerConfig> {
	private readonly logger = new Logger(LarkTriggerStrategy.name)
	private readonly bindings = new Map<string, TriggerBinding>()
	private readonly xpertBindings = new Map<string, Set<string>>()
	private _integrationPermissionService: IntegrationPermissionService

	meta: TWorkflowTriggerMeta = {
		name: LarkTrigger,
		label: {
			en_US: 'Lark Trigger',
			zh_Hans: '飞书触发器'
		},
		icon: {
			type: 'image',
			value: iconImage,
		},
		configSchema: {
			type: 'object',
			properties: {
				enabled: {
					type: 'boolean',
					title: {
						en_US: 'Enabled',
						zh_Hans: '启用'
					},
					default: true
				},
				integrationId: {
					type: 'string',
					title: {
						en_US: 'Lark Integration',
						zh_Hans: '飞书集成'
					},
					'x-ui': {
						component: 'remoteSelect',
						selectUrl: '/api/integration/select-options?provider=lark'
					} as any
				}
			},
			required: ['enabled', 'integrationId']
		}
	}

	constructor(
		private readonly dispatchService: LarkChatDispatchService,
		@Inject(LARK_PLUGIN_CONTEXT)
		private readonly pluginContext: PluginContext
	) {}

	private get integrationPermissionService(): IntegrationPermissionService {
		if (!this._integrationPermissionService) {
			this._integrationPermissionService = this.pluginContext.resolve(
				INTEGRATION_PERMISSION_SERVICE_TOKEN
			)
		}
		return this._integrationPermissionService
	}

	async validate(payload: TWorkflowTriggerParams<TLarkTriggerConfig>) {
		const { xpertId, node, config } = payload
		const items: ChecklistItem[] = []
		const nodeKey = node?.key

		if (!config?.integrationId) {
			items.push({
				node: nodeKey,
				ruleCode: 'TRIGGER_LARK_INTEGRATION_REQUIRED',
				field: 'integrationId',
				value: '',
				message: {
					en_US: 'Lark integration is required',
					zh_Hans: '需要选择飞书集成'
				},
				level: 'error'
			})
			return items
		}

		try {
			const integration = await this.integrationPermissionService.read(config.integrationId)
			if (!integration) {
				items.push({
					node: nodeKey,
					ruleCode: 'TRIGGER_LARK_INTEGRATION_NOT_FOUND',
					field: 'integrationId',
					value: config.integrationId,
					message: {
						en_US: `Lark integration "${config.integrationId}" not found`,
						zh_Hans: `飞书集成 "${config.integrationId}" 不存在`
					},
					level: 'error'
				})
			}
		} catch (error) {
			this.logger.warn(
				`Validate integration "${config.integrationId}" failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			)
		}

		if (!config.enabled) {
			return items
		}

		const existing = this.bindings.get(config.integrationId)
		if (existing && existing.xpertId !== xpertId) {
			items.push({
				node: nodeKey,
				ruleCode: 'TRIGGER_LARK_INTEGRATION_CONFLICT',
				field: 'integrationId',
				value: config.integrationId,
				message: {
					en_US: `Integration "${config.integrationId}" is already bound to another xpert`,
					zh_Hans: `飞书集成 "${config.integrationId}" 已绑定到其他专家`
				},
				level: 'error'
			})
		}

		return items
	}

	publish(
		payload: TWorkflowTriggerParams<TLarkTriggerConfig>,
		callback: (payload: any) => void
	): void {
		const { xpertId, config } = payload
		if (!config?.enabled || !config.integrationId) {
			return
		}

		const integrationId = config.integrationId
		const existing = this.bindings.get(integrationId)
		if (existing && existing.xpertId !== xpertId) {
			throw new Error(
				`Lark trigger integration "${integrationId}" is already bound to xpert "${existing.xpertId}"`
			)
		}

		this.bindings.set(integrationId, {
			xpertId,
			callback
		})
		const integrationIds = this.xpertBindings.get(xpertId) ?? new Set<string>()
		integrationIds.add(integrationId)
		this.xpertBindings.set(xpertId, integrationIds)
	}

	stop(payload: TWorkflowTriggerParams<TLarkTriggerConfig>): void {
		const { xpertId, config } = payload
		const integrationId = config?.integrationId
		if (integrationId) {
			this.removeBinding(integrationId, xpertId)
			return
		}

		const integrationIds = this.xpertBindings.get(xpertId)
		if (!integrationIds?.size) {
			return
		}
		for (const id of integrationIds) {
			this.removeBinding(id, xpertId)
		}
	}

	getBoundXpertId(integrationId: string): string | null {
		return this.bindings.get(integrationId)?.xpertId ?? null
	}

	async handleInboundMessage(params: {
		integrationId: string
		input?: string
		larkMessage: ChatLarkMessage
		options?: {
			confirm?: boolean
			reject?: boolean
		}
	}): Promise<boolean> {
		const binding = this.bindings.get(params.integrationId)
		if (!binding?.xpertId) {
			return false
		}

		const handoffMessage = await this.dispatchService.buildDispatchMessage({
			xpertId: binding.xpertId,
			input: params.input,
			larkMessage: params.larkMessage,
			options: params.options
		})

		await Promise.resolve(
			binding.callback?.({
				from: LarkTrigger,
				xpertId: binding.xpertId,
				handoffMessage
			})
		)
		return true
	}

	private removeBinding(integrationId: string, expectedXpertId?: string) {
		const existing = this.bindings.get(integrationId)
		if (!existing) {
			return
		}
		if (expectedXpertId && existing.xpertId !== expectedXpertId) {
			return
		}

		this.bindings.delete(integrationId)
		const integrationIds = this.xpertBindings.get(existing.xpertId)
		if (!integrationIds) {
			return
		}
		integrationIds.delete(integrationId)
		if (!integrationIds.size) {
			this.xpertBindings.delete(existing.xpertId)
		}
	}
}
