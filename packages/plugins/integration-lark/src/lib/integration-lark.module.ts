import chalk from 'chalk'
import { XpertServerPlugin, IOnPluginBootstrap, IOnPluginDestroy } from '@xpert-ai/plugin-sdk'
import { CqrsModule } from '@nestjs/cqrs'
import { DiscoveryModule } from '@nestjs/core'

import { LarkChannelStrategy } from './lark-channel.strategy'
import { LarkIntegrationStrategy } from './lark-integration.strategy'
import { LarkHooksController } from './lark.hooks.controller'
import { LarkConversationService } from './conversation.service'
import { LarkTokenStrategy } from './auth/lark-token.strategy'
import { CommandHandlers } from './commands/handlers'
import {
	LarkChatRunStateService,
	LarkChatStreamCallbackProcessor,
} from './handoff'
import { ChatBILarkMiddleware } from './middlewares'

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
		LarkChatRunStateService,
		LarkChatStreamCallbackProcessor,
		...CommandHandlers,
		LarkTokenStrategy,
		ChatBILarkMiddleware
	],
	exports: [LarkChannelStrategy, LarkIntegrationStrategy, ChatBILarkMiddleware]
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
