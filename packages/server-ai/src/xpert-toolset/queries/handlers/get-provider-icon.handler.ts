import { ConfigService } from '@metad/server-config'
import { HttpException, HttpStatus, Inject, Logger } from '@nestjs/common'
import { IQueryHandler, QueryBus, QueryHandler } from '@nestjs/cqrs'
import { AgentMiddlewareRegistry, RequestContext, ToolsetRegistry } from '@xpert-ai/plugin-sdk'
import { existsSync, readFileSync } from 'fs'
import * as mime from 'mime-types'
import * as path from 'path'
import { ToolProviderNotFoundError } from '../../errors'
import { getBuiltinToolsetBaseUrl } from '../../provider/builtin'
import { TToolsetProviderSchema } from '../../types'
import { ToolProviderIconQuery } from '../get-provider-icon.query'
import { ListBuiltinToolProvidersQuery } from '../list-builtin-providers.query'

@QueryHandler(ToolProviderIconQuery)
export class ToolProviderIconHandler implements IQueryHandler<ToolProviderIconQuery> {
	protected logger = new Logger(ToolProviderIconHandler.name)

	@Inject(ConfigService)
	protected readonly configService: ConfigService

	@Inject(ToolsetRegistry)
	protected readonly toolsetRegistry: ToolsetRegistry

	@Inject(AgentMiddlewareRegistry)
	private readonly agentMiddlewareRegistry: AgentMiddlewareRegistry

	constructor(private readonly queryBus: QueryBus) {}

	public async execute(command: ToolProviderIconQuery): Promise<[Buffer, string]> {
		const { provider, organizationId } = command.options
		
		// Try to get organizationId from request context
		const requestOrgId = RequestContext.getOrganizationId()
		const resolvedOrganizationId = organizationId ?? requestOrgId

		// Step 1: Try to get from plugin registry (npm installed plugins)
		try {
			const pluginProvider = this.toolsetRegistry.get(provider, resolvedOrganizationId)
			if (pluginProvider) {
				const icon = pluginProvider.meta.icon
				if (icon.svg) {
					return [Buffer.from(icon.svg), 'image/svg+xml']
				} else if (icon.png) {
					// Remove prefix (data:image/png;base64, image/png;base64,)
					const base64Data = icon.png.replace(/^data:image\/[a-z]+;base64,|^image\/[a-z]+;base64,/, '')
					const byteData = Buffer.from(base64Data, 'base64')
					return [byteData, 'image/png']
				}

				return [null, 'image/svg+xml']
			}
		} catch (err) {
			// If not found in plugin registry, continue to try builtin providers
		}

		// Step 2: Try to get from builtin providers
		const providers = await this.queryBus.execute<ListBuiltinToolProvidersQuery, TToolsetProviderSchema[]>(
			new ListBuiltinToolProvidersQuery([provider])
		)
		
		if (providers[0]) {
			const filePath = path.join(this.getProviderServerPath(provider), '_assets', providers[0].identity.icon)

			if (!existsSync(filePath)) {
				return [null, null]
			}

			const mimeType = mime.lookup(filePath) || 'application/octet-stream'
			const byteData = readFileSync(filePath)
			return [byteData, mimeType]
		}

		// Step 3: Try to get from middleware
		try {
			const middleware = this.agentMiddlewareRegistry.get(provider, resolvedOrganizationId)
			if (middleware?.meta?.icon) {
				const icon = middleware.meta.icon
				let buffer: Buffer
				let mimetype = 'image/svg+xml'
				if (icon.type === 'svg') {
					buffer = Buffer.from(icon.value, 'utf-8')
				} else if (icon.type === 'image') {
					buffer = Buffer.from(icon.value, 'base64')
					mimetype = 'image/png'
				} else {
					throw new HttpException(
						'Icon format not supported:' + icon.type,
						HttpStatus.UNSUPPORTED_MEDIA_TYPE
					)
				}
				return [buffer, mimetype]
			}
		} catch (err) {
			//
		}

		// All steps failed
		throw new ToolProviderNotFoundError(`Not found tool provider '${provider}'`)
	}

	getProviderServerPath(name: string) {
		return path.join(this.configService.assetOptions.serverRoot, getBuiltinToolsetBaseUrl(name), name)
	}
}
