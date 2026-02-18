import { Injectable } from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { IntegrationPermissionService } from "@xpert-ai/plugin-sdk"
import { IntegrationService } from "../../integration"

@Injectable()
export class PluginIntegrationPermissionService implements IntegrationPermissionService {
  constructor(private readonly moduleRef: ModuleRef) {}

  async read<TIntegration = any>(id: string, options?: Record<string, any>): Promise<TIntegration | null> {
    if (!id) {
      return null
    }

		let integrationService: IntegrationService
		try {
			integrationService = this.moduleRef.get<IntegrationService>(IntegrationService, {
				strict: false,
			})
		} catch {
			return null
		}
		if (!integrationService) {
			return null
		}

    try {
      return (await integrationService.findOne(id, options as any)) as TIntegration
    } catch {
      return null
    }
  }
}