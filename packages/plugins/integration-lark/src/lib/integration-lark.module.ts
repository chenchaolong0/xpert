import chalk from 'chalk'
import { XpertServerPlugin, IOnPluginBootstrap, IOnPluginDestroy } from '@xpert-ai/plugin-sdk'
import { CqrsModule } from '@nestjs/cqrs'
import { DiscoveryModule } from '@nestjs/core'

import { LarkChannelStrategy } from './lark-channel.strategy'
import { LarkIntegrationStrategy } from './lark-integration.strategy'
import { LarkHooksController } from './lark.controller'
import { LarkConversationService } from './conversation.service'
import { LarkTokenStrategy } from './auth/lark-token.strategy'
import { CommandHandlers } from './commands/handlers'
import {
	LarkChatDispatchService,
	LarkChatRunStateService,
	LarkChatStreamCallbackProcessor,
} from './handoff'
import { ChatBILarkMiddleware, LarkNotifyMiddleware } from './middlewares'
import { LarkTriggerStrategy } from './workflow/lark-trigger.strategy'

@XpertServerPlugin({
	imports: [
		DiscoveryModule,
		CqrsModule,
	],
	controllers: [LarkHooksController],
	providers: [
		LarkConversationService,
		LarkChannelStrategy,
		LarkIntegrationStrategy,
		LarkTriggerStrategy,
		LarkChatDispatchService,
		LarkChatRunStateService,
		LarkChatStreamCallbackProcessor,
		...CommandHandlers,
		LarkTokenStrategy,
		ChatBILarkMiddleware,
		LarkNotifyMiddleware
	],
	exports: [
		LarkChannelStrategy,
		LarkIntegrationStrategy,
		LarkTriggerStrategy,
		LarkChatDispatchService,
		ChatBILarkMiddleware,
		LarkNotifyMiddleware
	]
})
export class IntegrationLarkPlugin implements IOnPluginBootstrap, IOnPluginDestroy {
	private logEnabled = true

	onPluginBootstrap(): void | Promise<void> {
		if (this.logEnabled) {
			console.log(chalk.green(`${IntegrationLarkPlugin.name} is being bootstrapped...`))
		}
	}

	onPluginDestroy(): void | Promise<void> {
		if (this.logEnabled) {
			console.log(chalk.green(`${IntegrationLarkPlugin.name} is being destroyed...`))
		}
	}
}
