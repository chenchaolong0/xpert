import {
	INTEGRATION_PERMISSION_SERVICE_TOKEN,
	IntegrationPermissionService,
	PluginContext,
} from '@xpert-ai/plugin-sdk'
import { Inject } from '@nestjs/common'
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs'
import { ChatLarkMessage } from '../../message'
import { LarkConversationService } from '../../conversation.service'
import { LarkChannelStrategy } from '../../lark-channel.strategy'
import { LarkTriggerStrategy } from '../../workflow/lark-trigger.strategy'
import { LARK_PLUGIN_CONTEXT } from '../../tokens'
import { LarkMessageCommand } from '../mesage.command'
import { TIntegrationLarkOptions } from '../../types'
import { LarkChatDispatchService } from '../../handoff'
import { resolveConversationUserKey } from '../../conversation-user-key'

@CommandHandler(LarkMessageCommand)
export class LarkMessageHandler implements ICommandHandler<LarkMessageCommand> {
	private _integrationPermissionService: IntegrationPermissionService

	constructor(
		private readonly larkChannel: LarkChannelStrategy,
		private readonly conversationService: LarkConversationService,
		private readonly dispatchService: LarkChatDispatchService,
		private readonly larkTriggerStrategy: LarkTriggerStrategy,
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

	public async execute(command: LarkMessageCommand): Promise<unknown> {
		const { options } = command
		const { userId, integrationId, message, input, senderOpenId } = options
		const integration = await this.integrationPermissionService.read(integrationId)
		if (!integration) {
			throw new Error(`Integration ${integrationId} not found`)
		}

		let text = input
		if (!text && message?.message?.content) {
			try {
				const textContent = JSON.parse(message.message.content)
				text = textContent.text as string
			} catch {
				text = message.message.content
			}
		}

		const triggerXpertId = this.larkTriggerStrategy.getBoundXpertId(integrationId)
		const fallbackXpertId = integration.options?.xpertId
		const targetXpertId = triggerXpertId ?? fallbackXpertId

		if (targetXpertId) {
			const conversationUserKey = resolveConversationUserKey({
				senderOpenId,
				fallbackUserId: userId
			})
			const activeMessage = await this.conversationService.getActiveMessage(
				conversationUserKey ?? userId,
				targetXpertId
			)
			const larkMessage = new ChatLarkMessage(
				{ ...options, larkChannel: this.larkChannel },
				{
					text,
					language:
						activeMessage?.thirdPartyMessage?.language ||
						(<TIntegrationLarkOptions>integration.options)?.preferLanguage
				}
			)

			const handledByTrigger = await this.larkTriggerStrategy.handleInboundMessage({
				integrationId,
				input: text,
				larkMessage
			})
			if (handledByTrigger) {
				return larkMessage
			}

			if (fallbackXpertId) {
				return await this.dispatchService.enqueueDispatch({
					xpertId: fallbackXpertId,
					input: text,
					larkMessage
				})
			}
		}

		await this.larkChannel.errorMessage(
			{
				integrationId,
				chatId: options.chatId
			},
			new Error('No xpertId configured for this Lark integration. Please configure xpertId first.')
		)
		return null
	}
}
