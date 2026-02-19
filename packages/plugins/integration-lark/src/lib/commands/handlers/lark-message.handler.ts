import {
	INTEGRATION_PERMISSION_SERVICE_TOKEN,
	IntegrationPermissionService,
	PluginContext,
} from '@xpert-ai/plugin-sdk'
import { Inject } from '@nestjs/common'
import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs'
import { ChatLarkMessage } from '../../message'
import { LarkConversationService } from '../../conversation.service'
import { LarkChannelStrategy } from '../../lark-channel.strategy'
import { LARK_PLUGIN_CONTEXT } from '../../tokens'
import { LarkChatXpertCommand } from '../chat-xpert.command'
import { LarkMessageCommand } from '../mesage.command'
import { TIntegrationLarkOptions } from '../../types'

@CommandHandler(LarkMessageCommand)
export class LarkMessageHandler implements ICommandHandler<LarkMessageCommand> {
	private _integrationPermissionService: IntegrationPermissionService

	constructor(
		private readonly larkChannel: LarkChannelStrategy,
		private readonly conversationService: LarkConversationService,
		@Inject(LARK_PLUGIN_CONTEXT)
		private readonly pluginContext: PluginContext,
		private readonly commandBus: CommandBus
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
		const { userId, integrationId, message, input } = options
		const integration = await this.integrationPermissionService.read(integrationId)
		if (!integration) {
			throw new Error(`Integration ${integrationId} not found`)
		}

		if (integration.options?.xpertId) {
			let text = input
			if (!text && message) {
				const { content } = message.message
				const textContent = JSON.parse(content)
				text = textContent.text as string
			}

			const activeMessage = await this.conversationService.getActiveMessage(
				userId,
				integration.options.xpertId
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

			return await this.commandBus.execute(
				new LarkChatXpertCommand(integration.options.xpertId, text, larkMessage)
			)
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
