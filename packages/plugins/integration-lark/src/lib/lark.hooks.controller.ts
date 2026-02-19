import * as lark from '@larksuiteoapi/node-sdk'
import { IIntegration } from '@metad/contracts'
import {
	INTEGRATION_PERMISSION_SERVICE_TOKEN,
	IntegrationPermissionService,
	PluginContext,
	RequestContext,
	runWithRequestContext,
	TChatEventContext,
} from '@xpert-ai/plugin-sdk'
import {
	BadRequestException,
	Body,
	Controller,
	ForbiddenException,
	HttpCode,
	Inject,
	Param,
	Post,
	Request,
	Response,
	UseGuards
} from '@nestjs/common'
import { CommandBus } from '@nestjs/cqrs'
import express from 'express'
import { LarkAuthGuard } from './auth/lark-auth.guard'
import { ChatLarkMessage } from './chat/message'
import { LarkChatXpertCommand } from './commands/chat-xpert.command'
import { Public } from './decorators/public.decorator'
import { LarkChannelStrategy } from './lark-channel.strategy'
import { LarkService } from './lark.service'
import { LARK_PLUGIN_CONTEXT } from './tokens'
import { TIntegrationLarkOptions } from './types'

@Controller('lark')
export class LarkHooksController {
	private _integrationPermissionService: IntegrationPermissionService

	constructor(
		private readonly commandBus: CommandBus,
		private readonly larkService: LarkService,
		@Inject(LARK_PLUGIN_CONTEXT)
		private readonly pluginContext: PluginContext,
		private readonly larkChannel: LarkChannelStrategy
	) {}

	private get integrationPermissionService(): IntegrationPermissionService {
		if (!this._integrationPermissionService) {
			this._integrationPermissionService = this.pluginContext.resolve(
				INTEGRATION_PERMISSION_SERVICE_TOKEN
			)
		}
		return this._integrationPermissionService
	}

	@Public()
	@UseGuards(LarkAuthGuard)
	@Post('webhook/:id')
	@HttpCode(200) // response code 200 required by lark server
	async webhook(
		@Param('id') integrationId: string,
		@Request() req: express.Request,
		@Response() res: express.Response
	): Promise<void> {
		const integration = await this.integrationPermissionService.read<IIntegration<TIntegrationLarkOptions>>(
			integrationId,
			{
				relations: ['tenant'],
			}
		)
		if (!integration) {
			throw new BadRequestException(`Integration ${integrationId} not found. Please save the integration first before configuring webhook URL in Lark.`)
		}

		// Handle Lark webhook URL verification challenge explicitly (plain + encrypted body).
		// This avoids dispatching to event handlers and prevents 500 on malformed encrypted challenge payloads.
		const challenge = this.resolveUrlVerificationChallenge(req.body, integration.options)
		if (challenge) {
			res.status(200).json({ challenge })
			return
		}

		const ctx: TChatEventContext<TIntegrationLarkOptions> = {
			integration,
			tenantId: integration.tenantId,
			organizationId: integration.organizationId
		}

		const handler = this.larkChannel.createEventHandler(ctx)
		const contextUser = RequestContext.currentUser() ?? (req.user as any)
		const languageHeader = this.getHeaderValue(req.headers['language'])
		const requestId = this.getHeaderValue(req.headers['x-request-id'])
		const requestHeaders: Record<string, string> = {
			['organization-id']: integration.organizationId
		}
		if (integration.options?.preferLanguage) {
			requestHeaders['language'] = integration.options.preferLanguage
		} else if (languageHeader) {
			requestHeaders['language'] = languageHeader
		}
		if (requestId) {
			requestHeaders['x-request-id'] = requestId
		}

		await new Promise<void>((resolve, reject) => {
			runWithRequestContext(
				{
					user: contextUser,
					headers: requestHeaders
				},
				{},
				() => {
					handler(req, res).then(resolve).catch(reject)
				}
			)
		})
	}

	private resolveUrlVerificationChallenge(body: any, options: TIntegrationLarkOptions): string | null {
		const verify = (payload: any) => {
			if (payload?.type !== 'url_verification') {
				return null
			}

			if (!payload?.challenge) {
				throw new BadRequestException('Missing challenge in Lark url_verification payload')
			}

			if (options?.verificationToken && payload?.token !== options.verificationToken) {
				throw new ForbiddenException('Invalid Lark verification token')
			}

			return payload.challenge as string
		}

		if (body?.type === 'url_verification') {
			return verify(body)
		}

		// Encrypted webhook payload usually contains only one field: { encrypt: "..." }.
		if (body?.encrypt && Object.keys(body).length === 1) {
			if (!options?.encryptKey) {
				throw new BadRequestException('Encrypt Key is required for encrypted Lark webhook payload')
			}

			try {
				const decrypted = new lark.AESCipher(options.encryptKey).decrypt(body.encrypt)
				const payload = JSON.parse(decrypted)
				return verify(payload)
			} catch (error: any) {
				throw new BadRequestException(`Failed to decrypt Lark webhook payload: ${error?.message || 'Unknown error'}`)
			}
		}

		return null
	}

	private getHeaderValue(value: string | string[] | undefined): string | undefined {
		return Array.isArray(value) ? value[0] : value
	}

	@Public()
	@Post('e2e/handoff/chat')
	@HttpCode(200)
	async handoffE2E(
		@Body() body: {
			tenantId: string
			organizationId?: string
			userId?: string
			user?: Record<string, any>
			integrationId: string
			chatId: string
			senderOpenId?: string
			xpertId: string
			input?: string
			language?: string
			options?: {
				confirm?: boolean
				reject?: boolean
			}
			mockLarkUpdate?: boolean
			headers?: Record<string, string>
			message?: {
				id?: string
				messageId?: string
				status?: string
				language?: string
				header?: any
				elements?: any[]
				text?: string
			}
		},
		@Request() req: express.Request
	) {
		this.assertE2EAccess(req)
		const normalized = this.normalizeE2ERequest(body)

		const larkMessage = new ChatLarkMessage(
			{
				tenant: null,
				organizationId: normalized.organizationId,
				integrationId: normalized.integrationId,
				userId: normalized.userId,
				chatId: normalized.chatId,
				senderOpenId: normalized.senderOpenId,
				larkService: this.larkService
			},
			{
				id: normalized.message?.id,
				messageId: normalized.message?.messageId,
				status: normalized.message?.status as any,
				language: normalized.message?.language ?? normalized.language,
				header: normalized.message?.header,
				elements: [...(normalized.message?.elements ?? [])],
				text: normalized.message?.text ?? normalized.input
			}
		)
		if (normalized.mockLarkUpdate) {
			this.mockLarkMessageUpdate(larkMessage, normalized.message?.id)
		}

		await new Promise<void>((resolve, reject) => {
			runWithRequestContext(
				{
					user: normalized.user,
					headers: normalized.requestHeaders
				},
				{},
				() => {
					this.commandBus
						.execute(
							new LarkChatXpertCommand(
								normalized.xpertId,
								normalized.input,
								larkMessage,
								normalized.options
							)
						)
						.then(() => resolve())
						.catch(reject)
				}
			)
		})

		return {
			accepted: true,
			messageType: 'system.chat_dispatch.v1',
			larkMessage: {
				id: larkMessage.id,
				messageId: larkMessage.messageId,
				status: larkMessage.status,
				language: larkMessage.language
			}
		}
	}

	private assertE2EAccess(req: express.Request) {
		const expectedKey = process.env.INTEGRATION_LARK_E2E_API_KEY
		if (!expectedKey) {
			return
		}

		const headerValue = req.headers['x-e2e-key']
		const actualKey = Array.isArray(headerValue) ? headerValue[0] : headerValue
		if (!actualKey || actualKey !== expectedKey) {
			throw new ForbiddenException('Invalid x-e2e-key')
		}
	}

	private normalizeE2ERequest(body: {
		tenantId: string
		organizationId?: string
		userId?: string
		user?: Record<string, any>
		integrationId: string
		chatId: string
		senderOpenId?: string
		xpertId: string
		input?: string
		language?: string
		options?: {
			confirm?: boolean
			reject?: boolean
		}
		mockLarkUpdate?: boolean
		headers?: Record<string, string>
		message?: {
			id?: string
			messageId?: string
			status?: string
			language?: string
			header?: any
			elements?: any[]
			text?: string
		}
	}) {
		if (!body?.tenantId) {
			throw new BadRequestException('Missing tenantId')
		}
		if (!body?.integrationId) {
			throw new BadRequestException('Missing integrationId')
		}
		if (!body?.chatId) {
			throw new BadRequestException('Missing chatId')
		}
		if (!body?.xpertId) {
			throw new BadRequestException('Missing xpertId')
		}
		if (!body?.input && !body?.options?.confirm && !body?.options?.reject) {
			throw new BadRequestException('Missing input (or confirm/reject option)')
		}

		const userId = body.user?.id || body.userId
		if (!userId) {
			throw new BadRequestException('Missing userId')
		}

		const user = body.user
			? {
					...body.user,
					id: body.user.id ?? userId,
					tenantId: body.user.tenantId ?? body.tenantId
				}
			: {
					id: userId,
					tenantId: body.tenantId
				}

		const requestHeaders: Record<string, string> = {
			...(body.headers ?? {}),
			'tenant-id': body.tenantId
		}
		if (body.organizationId) {
			requestHeaders['organization-id'] = body.organizationId
		}
		if (body.language) {
			requestHeaders['language'] = body.language
		}
		const mockLarkUpdate =
			body.mockLarkUpdate ?? process.env.INTEGRATION_LARK_E2E_MOCK_LARK_UPDATE !== 'false'

		return {
			...body,
			userId,
			user,
			requestHeaders,
			mockLarkUpdate
		}
	}

	private mockLarkMessageUpdate(larkMessage: ChatLarkMessage, fallbackId?: string) {
		larkMessage.update = async (options?: Parameters<ChatLarkMessage['update']>[0]) => {
			console.log('Mock Lark message update called with options:', options)
			if (options?.language) {
				larkMessage.language = options.language
			}
			if (options?.status) {
				larkMessage.status = options.status
			}
			if (options?.header) {
				larkMessage.header = options.header
			}
			if (options?.elements?.length) {
				larkMessage.elements.push(...options.elements)
			}
			if (!larkMessage.id) {
				larkMessage.id = fallbackId ?? `e2e-lark-message-${Date.now()}`
			}
		}
	}

	// @Get('chat-select-options')
	// async getChatSelectOptions(@Query('integration') id: string) {
	// 	if (!id) {
	// 		throw new BadRequestException(
	// 			await this.core.i18n.t('integration.Lark.Error_SelectAIntegration', {
	// 				lang: mapTranslationLanguage(RequestContext.getLanguageCode())
	// 			})
	// 		)
	// 	}
	// 	const client = await this.larkService.getOrCreateLarkClientById(id)
	// 	try {
	// 		const result = await client.im.chat.list()
	// 		const items = result.data.items
	// 		return items.map((item) => ({
	// 			value: item.chat_id,
	// 			label: item.name,
	// 			icon: item.avatar
	// 		}))
	// 	} catch (err: any) {
	// 		if ((<AxiosError>err).response?.data) {
	// 			throw new BadRequestException(err.response.data.msg)
	// 		}
	// 		throw new BadRequestException(err)
	// 	}
	// }

	// @Get('user-select-options')
	// async getUserSelectOptions(@Query('integration') id: string) {
	// 	if (!id) {
	// 		throw new BadRequestException(
	// 			await this.core.i18n.t('integration.Lark.Error_SelectAIntegration', {
	// 				lang: mapTranslationLanguage(RequestContext.getLanguageCode())
	// 			})
	// 		)
	// 	}
	// 	const client = await this.larkService.getOrCreateLarkClientById(id)

	// 	try {
	// 		const result = await client.contact.user.list({
	// 			params: {}
	// 		})
	// 		const items = result.data.items

	// 		// Use open_id to match resolveReceiveId() in LarkChannelStrategy
	// 		return items.map((item) => ({
	// 			value: item.open_id,
	// 			label: item.name || item.email || item.mobile,
	// 			icon: item.avatar
	// 		}))
	// 	} catch (err: any) {
	// 		if ((<AxiosError>err).response?.data) {
	// 			throw new BadRequestException(err.response.data.msg)
	// 		}
	// 		throw new BadRequestException(err)
	// 	}
	// }
}
