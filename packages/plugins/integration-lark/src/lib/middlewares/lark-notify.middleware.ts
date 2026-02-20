import { ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { InferInteropZodInput, interopSafeParse } from '@langchain/core/utils/types'
import { Command, getCurrentTaskInput } from '@langchain/langgraph'
import { getToolCallIdFromConfig, TAgentMiddlewareMeta } from '@metad/contracts'
import { Injectable, Logger } from '@nestjs/common'
import {
  AgentMiddleware,
  AgentMiddlewareStrategy,
  IAgentMiddlewareContext,
  IAgentMiddlewareStrategy,
  PromiseOrValue,
  getErrorMessage
} from '@xpert-ai/plugin-sdk'
import { z } from 'zod/v3'
import { LarkChannelStrategy } from '../lark-channel.strategy'
import { iconImage } from '../types'

const LARK_NOTIFY_MIDDLEWARE_NAME = 'LarkNotifyMiddleware'
const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_POST_LOCALE = 'en_us'
const MAX_BATCH_CONCURRENCY = 5

const RecipientTypeSchema = z.enum(['chat_id', 'open_id', 'user_id', 'union_id', 'email'])
const PostLocaleSchema = z.enum(['en_us', 'zh_cn', 'ja_jp'])

const RecipientSchema = z.object({
  type: RecipientTypeSchema.describe('Lark receive_id_type'),
  id: z.string().describe('Lark receive_id value')
})

const middlewareConfigSchema = z.object({
  integrationId: z.string().optional().nullable(),
  template: z
    .object({
      enabled: z.boolean().default(true),
      strict: z.boolean().default(false)
    })
    .default({}),
  defaults: z
    .object({
      recipients: z.array(RecipientSchema).default([]),
      postLocale: PostLocaleSchema.default(DEFAULT_POST_LOCALE),
      timeoutMs: z.number().int().min(100).default(DEFAULT_TIMEOUT_MS)
    })
    .default({}),
  tools: z
    .object({
      send_text_notification: z.boolean().default(true),
      send_rich_notification: z.boolean().default(true),
      update_message: z.boolean().default(true),
      recall_message: z.boolean().default(true),
      list_users: z.boolean().default(true),
      list_chats: z.boolean().default(true)
    })
    .default({})
})

const larkNotifyStateSchema = z.object({
  lark_notify_last_result: z.record(z.any()).nullable().default(null),
  lark_notify_last_message_ids: z.array(z.string()).default([])
})

const sendTextNotificationSchema = z.object({
  integrationId: z.string().optional().nullable().describe('Lark integration id, overrides middleware config when provided'),
  recipients: z.array(RecipientSchema).optional().nullable().describe('Target recipients. Use type + id pairs.'),
  content: z.string().describe('Text content to send'),
  timeoutMs: z.number().int().min(100).optional().nullable().describe('Request timeout in milliseconds')
})

const sendRichNotificationSchema = z.object({
  integrationId: z.string().optional().nullable().describe('Lark integration id, overrides middleware config when provided'),
  recipients: z.array(RecipientSchema).optional().nullable().describe('Target recipients. Use type + id pairs.'),
  mode: z.enum(['post', 'interactive']).describe('post=rich text, interactive=card'),
  markdown: z.string().optional().nullable().describe('Markdown content for post mode'),
  card: z.record(z.any()).optional().nullable().describe('Lark interactive card payload for interactive mode'),
  locale: PostLocaleSchema.optional().nullable().describe('Locale key for post mode content'),
  timeoutMs: z.number().int().min(100).optional().nullable().describe('Request timeout in milliseconds')
})

const updateMessageSchema = z.object({
  integrationId: z.string().optional().nullable().describe('Lark integration id, overrides middleware config when provided'),
  messageId: z.string().describe('Lark message id to update'),
  mode: z.enum(['text', 'interactive']).describe('text updates text content, interactive updates card content'),
  content: z.string().optional().nullable().describe('Text content for text mode'),
  markdown: z.string().optional().nullable().describe('Markdown content for interactive mode'),
  card: z.record(z.any()).optional().nullable().describe('Card payload for interactive mode'),
  timeoutMs: z.number().int().min(100).optional().nullable().describe('Request timeout in milliseconds')
})

const recallMessageSchema = z.object({
  integrationId: z.string().optional().nullable().describe('Lark integration id, overrides middleware config when provided'),
  messageId: z.string().describe('Lark message id to recall'),
  timeoutMs: z.number().int().min(100).optional().nullable().describe('Request timeout in milliseconds')
})

const listUsersSchema = z.object({
  integrationId: z.string().optional().nullable().describe('Lark integration id, overrides middleware config when provided'),
  keyword: z.string().optional().nullable().describe('Filter keyword for users'),
  pageSize: z.number().int().min(1).max(100).optional().nullable().default(20).describe('Lark users page size'),
  pageToken: z.string().optional().nullable().describe('Lark users page token'),
  timeoutMs: z.number().int().min(100).optional().nullable().describe('Request timeout in milliseconds')
})

const listChatsSchema = z.object({
  integrationId: z.string().optional().nullable().describe('Lark integration id, overrides middleware config when provided'),
  keyword: z.string().optional().nullable().describe('Filter keyword for chats'),
  pageSize: z.number().int().min(1).max(100).optional().nullable().default(20).describe('Lark chats page size'),
  pageToken: z.string().optional().nullable().describe('Lark chats page token'),
  timeoutMs: z.number().int().min(100).optional().nullable().describe('Request timeout in milliseconds')
})

export type LarkRecipient = z.infer<typeof RecipientSchema>

export type LarkNotifyResultItem = {
  target: string
  success: boolean
  messageId?: string | null
  error?: string
}

export type LarkNotifyResult = {
  tool: string
  integrationId: string
  successCount: number
  failureCount: number
  results: LarkNotifyResultItem[]
  data?: Record<string, unknown>
}

type LarkNotifyState = z.infer<typeof larkNotifyStateSchema>
type LarkNotifyMiddlewareConfig = InferInteropZodInput<typeof middlewareConfigSchema>

function getCurrentStateSafe() {
  try {
    return (getCurrentTaskInput<Record<string, unknown>>() ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

function getValueByPath(source: Record<string, unknown>, path: string): unknown {
  if (!path?.trim()) {
    return undefined
  }

  const normalized = path.trim().replace(/\[(\d+)\]/g, '.$1')
  const segments = normalized.split('.').filter(Boolean)
  let current: unknown = source

  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function renderTemplateString(
  value: string,
  state: Record<string, unknown>,
  options: { enabled: boolean; strict: boolean }
): unknown {
  if (!options.enabled) {
    return value
  }

  const templatePattern = /{{\s*([^{}]+?)\s*}}/g
  if (!templatePattern.test(value)) {
    return value
  }

  const fullPattern = /^{{\s*([^{}]+?)\s*}}$/
  const fullMatch = value.match(fullPattern)
  if (fullMatch) {
    const resolved = getValueByPath(state, fullMatch[1])
    if (resolved === undefined) {
      if (options.strict) {
        throw new Error(`Template variable '${fullMatch[1]}' is not found in current state`)
      }
      return value
    }
    return resolved
  }

  return value.replace(templatePattern, (_, rawPath: string) => {
    const resolved = getValueByPath(state, rawPath)
    if (resolved === undefined) {
      if (options.strict) {
        throw new Error(`Template variable '${rawPath}' is not found in current state`)
      }
      return `{{${rawPath}}}`
    }

    if (resolved == null) {
      return ''
    }

    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

function renderTemplateValue<T>(
  value: T,
  state: Record<string, unknown>,
  options: { enabled: boolean; strict: boolean }
): T {
  if (typeof value === 'string') {
    return renderTemplateString(value, state, options) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, state, options)) as T
  }

  if (isPlainObject(value)) {
    return Object.entries(value).reduce((acc, [key, item]) => {
      acc[key] = renderTemplateValue(item, state, options)
      return acc
    }, {} as Record<string, unknown>) as T
  }

  return value
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeTimeout(value: unknown, fallback: number): number {
  const timeout = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(timeout) && timeout >= 100) {
    return timeout
  }
  return fallback
}

function normalizeIntInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  const integer = Math.floor(parsed)
  if (integer < min || integer > max) {
    return fallback
  }
  return integer
}

function normalizeRecipients(value: unknown): LarkRecipient[] {
  const recipientTypes = RecipientTypeSchema.options as readonly string[]
  if (!Array.isArray(value)) {
    return []
  }

  return value.reduce<LarkRecipient[]>((acc, item) => {
    const type = normalizeString((item as LarkRecipient)?.type)
    const id = normalizeString((item as LarkRecipient)?.id)
    if (!type || !id) {
      return acc
    }
    if (!recipientTypes.includes(type)) {
      return acc
    }
    acc.push({
      type: type as LarkRecipient['type'],
      id
    })
    return acc
  }, [])
}

function collectMessageIds(result: LarkNotifyResult): string[] {
  return result.results
    .filter((item) => item.success && !!item.messageId)
    .map((item) => item.messageId as string)
}

function toToolMessageContent(result: LarkNotifyResult) {
  const payload = result.data ? { ...result, data: result.data } : result
  return JSON.stringify(payload)
}

function formatError(error: unknown): string {
  const message = (error as any)?.response?.data?.msg || getErrorMessage(error)
  return message || 'Unknown error'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout while ${label} after ${timeoutMs}ms`))
    }, timeoutMs)

    promise
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

@Injectable()
@AgentMiddlewareStrategy(LARK_NOTIFY_MIDDLEWARE_NAME)
export class LarkNotifyMiddleware implements IAgentMiddlewareStrategy {
  private readonly logger = new Logger(LarkNotifyMiddleware.name)

  constructor(private readonly larkChannel: LarkChannelStrategy) {}

  meta: TAgentMiddlewareMeta = {
    name: LARK_NOTIFY_MIDDLEWARE_NAME,
    icon: {
      type: 'image',
      value: iconImage
    },
    label: {
      en_US: 'Lark Notify Middleware',
      zh_Hans: '飞书通知中间件'
    },
    description: {
      en_US: 'Provides built-in tools to send notifications to Lark users or chats.',
      zh_Hans: '提供向飞书用户或群组发送通知的内置工具。'
    },
    configSchema: {
      type: 'object',
      properties: {
        integrationId: {
          type: 'string',
          title: {
            en_US: 'Lark Integration',
            zh_Hans: '飞书集成'
          },
          description: {
            en_US: 'Default integration used by notify tools',
            zh_Hans: '通知工具默认使用的飞书集成'
          },
          'x-ui': {
            component: 'remoteSelect',
            selectUrl: '/api/integration/select-options?provider=lark'
          }
        },
        template: {
          type: 'object',
          properties: {
            enabled: {
              type: 'boolean',
              default: true,
              title: {
                en_US: 'Enable Mustache Template',
                zh_Hans: '启用 Mustache 模板'
              }
            },
            strict: {
              type: 'boolean',
              default: false,
              title: {
                en_US: 'Strict Template Mode',
                zh_Hans: '模板严格模式'
              }
            }
          }
        },
        defaults: {
          type: 'object',
          properties: {
            recipients: {
              type: 'array',
              title: {
                en_US: 'Default Recipients',
                zh_Hans: '默认收件人'
              },
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['chat_id', 'open_id', 'user_id', 'union_id', 'email']
                  },
                  id: {
                    type: 'string'
                  }
                },
                required: ['type', 'id']
              }
            },
            postLocale: {
              type: 'string',
              enum: ['en_us', 'zh_cn', 'ja_jp'],
              default: DEFAULT_POST_LOCALE,
              title: {
                en_US: 'Post Locale',
                zh_Hans: '富文本语言'
              }
            },
            timeoutMs: {
              type: 'number',
              default: DEFAULT_TIMEOUT_MS,
              minimum: 100,
              title: {
                en_US: 'Timeout (ms)',
                zh_Hans: '超时毫秒'
              }
            }
          }
        },
        tools: {
          type: 'object',
          properties: {
            send_text_notification: { type: 'boolean', default: true },
            send_rich_notification: { type: 'boolean', default: true },
            update_message: { type: 'boolean', default: true },
            recall_message: { type: 'boolean', default: true },
            list_users: { type: 'boolean', default: true },
            list_chats: { type: 'boolean', default: true }
          }
        }
      }
    } as TAgentMiddlewareMeta['configSchema']
  }

  createMiddleware(
    options: LarkNotifyMiddlewareConfig,
    _context: IAgentMiddlewareContext
  ): PromiseOrValue<AgentMiddleware> {
    void _context

    const { data, error } = interopSafeParse(middlewareConfigSchema, options ?? {})
    if (error) {
      throw new Error(`LarkNotifyMiddleware configuration error: ${error.message}`)
    }

    const parsed = data!
    const templateOptions = {
      enabled: parsed.template?.enabled !== false,
      strict: parsed.template?.strict === true
    }

    const enabledTools = {
      sendText: parsed.tools?.send_text_notification !== false,
      sendRich: parsed.tools?.send_rich_notification !== false,
      updateMessage: parsed.tools?.update_message !== false,
      recallMessage: parsed.tools?.recall_message !== false,
      listUsers: parsed.tools?.list_users !== false,
      listChats: parsed.tools?.list_chats !== false
    }

    const resolveInput = <T extends Record<string, unknown>>(value: T) => {
      const state = getCurrentStateSafe()
      const renderedInput = renderTemplateValue(value, state, templateOptions)
      const renderedDefaults = renderTemplateValue(parsed.defaults, state, templateOptions)
      const renderedIntegration = renderTemplateValue(parsed.integrationId, state, templateOptions)
      const integrationId =
        normalizeString((renderedInput as Record<string, unknown>)?.integrationId) || normalizeString(renderedIntegration)
      const timeoutMs = normalizeTimeout(
        (renderedInput as Record<string, unknown>)?.timeoutMs,
        normalizeTimeout(renderedDefaults.timeoutMs, DEFAULT_TIMEOUT_MS)
      )

      return {
        state,
        renderedInput,
        renderedDefaults,
        integrationId,
        timeoutMs
      }
    }

    const resolveRecipients = (renderedInput: Record<string, unknown>, renderedDefaults: Record<string, unknown>) => {
      const parameterRecipients = normalizeRecipients(renderedInput.recipients)
      if (parameterRecipients.length) {
        return parameterRecipients
      }
      return normalizeRecipients(renderedDefaults.recipients)
    }

    const requireIntegrationId = (integrationId: string | null, toolName: string) => {
      if (!integrationId) {
        throw new Error(`[${toolName}] integrationId is required. Configure middleware integration or pass integrationId in tool parameters.`)
      }
      return integrationId
    }

    const requireRecipients = (recipients: LarkRecipient[], toolName: string) => {
      if (!recipients.length) {
        throw new Error(`[${toolName}] recipients is required. Configure defaults.recipients or pass recipients in tool parameters.`)
      }
      return recipients
    }

    const getClient = async (integrationId: string, timeoutMs: number, toolName: string) => {
      try {
        return await withTimeout(
          this.larkChannel.getOrCreateLarkClientById(integrationId),
          timeoutMs,
          `[${toolName}] load integration '${integrationId}'`
        )
      } catch (error) {
        throw new Error(`[${toolName}] Integration '${integrationId}' is unavailable: ${formatError(error)}`)
      }
    }

    const buildCommand = (toolName: string, toolCallId: string, result: LarkNotifyResult) => {
      return new Command({
        update: {
          lark_notify_last_result: result,
          lark_notify_last_message_ids: collectMessageIds(result),
          messages: [
            new ToolMessage({
              content: toToolMessageContent(result),
              name: toolName,
              tool_call_id: toolCallId,
              status: result.failureCount ? 'error' : 'success'
            })
          ]
        }
      })
    }

    const runSendTaskBatch = async (params: {
      integrationId: string
      toolName: string
      recipients: LarkRecipient[]
      timeoutMs: number
      task: (recipient: LarkRecipient) => Promise<{ messageId?: string | null }>
    }): Promise<LarkNotifyResult> => {
      const results: LarkNotifyResultItem[] = []

      for (let i = 0; i < params.recipients.length; i += MAX_BATCH_CONCURRENCY) {
        const group = params.recipients.slice(i, i + MAX_BATCH_CONCURRENCY)
        const settled = await Promise.allSettled(
          group.map(async (recipient) => {
            const result = await withTimeout(
              params.task(recipient),
              params.timeoutMs,
              `[${params.toolName}] send to ${recipient.type}:${recipient.id}`
            )
            return {
              target: `${recipient.type}:${recipient.id}`,
              success: true,
              messageId: result.messageId ?? null
            } as LarkNotifyResultItem
          })
        )

        settled.forEach((item, index) => {
          const recipient = group[index]
          if (item.status === 'fulfilled') {
            results.push(item.value)
          } else {
            results.push({
              target: `${recipient.type}:${recipient.id}`,
              success: false,
              error: formatError(item.reason)
            })
          }
        })
      }

      const successCount = results.filter((item) => item.success).length
      const failureCount = results.length - successCount

      this.logger.log(
        `[${params.toolName}] integrationId=${params.integrationId}, recipientCount=${params.recipients.length}, successCount=${successCount}, failureCount=${failureCount}`
      )

      return {
        tool: params.toolName,
        integrationId: params.integrationId,
        successCount,
        failureCount,
        results
      }
    }

    const tools = []

    if (enabledTools.sendText) {
      tools.push(
        tool(
          async (parameters, config) => {
            const toolName = 'lark_send_text_notification'
            const toolCallId = getToolCallIdFromConfig(config)
            const { renderedInput, renderedDefaults, integrationId, timeoutMs } = resolveInput(parameters)
            const resolvedIntegrationId = requireIntegrationId(integrationId, toolName)
            const recipients = requireRecipients(resolveRecipients(renderedInput, renderedDefaults), toolName)
            const content = normalizeString(renderedInput.content)

            if (!content) {
              throw new Error(`[${toolName}] content is required`)
            }

            const client = await getClient(resolvedIntegrationId, timeoutMs, toolName)

            const result = await runSendTaskBatch({
              integrationId: resolvedIntegrationId,
              toolName,
              recipients,
              timeoutMs,
              task: async (recipient) => {
                const response = await client.im.message.create({
                  params: {
                    receive_id_type: recipient.type
                  },
                  data: {
                    receive_id: recipient.id,
                    msg_type: 'text',
                    content: JSON.stringify({ text: content })
                  }
                })

                return {
                  messageId: response?.data?.message_id ?? null
                }
              }
            })

            return buildCommand(toolName, toolCallId, result)
          },
          {
            name: 'lark_send_text_notification',
            description: 'Send text notifications to Lark users/chats with partial-success batch semantics.',
            schema: sendTextNotificationSchema,
            verboseParsingErrors: true
          }
        )
      )
    }

    if (enabledTools.sendRich) {
      tools.push(
        tool(
          async (parameters, config) => {
            const toolName = 'lark_send_rich_notification'
            const toolCallId = getToolCallIdFromConfig(config)
            const { renderedInput, renderedDefaults, integrationId, timeoutMs } = resolveInput(parameters)
            const resolvedIntegrationId = requireIntegrationId(integrationId, toolName)
            const recipients = requireRecipients(resolveRecipients(renderedInput, renderedDefaults), toolName)
            const mode = renderedInput.mode as 'post' | 'interactive'
            const localeCandidate =
              normalizeString(renderedInput.locale) ||
              normalizeString(renderedDefaults.postLocale) ||
              DEFAULT_POST_LOCALE

            if (!PostLocaleSchema.options.includes(localeCandidate as any)) {
              throw new Error(`[${toolName}] locale must be one of: ${PostLocaleSchema.options.join(', ')}`)
            }
            const locale = localeCandidate as z.infer<typeof PostLocaleSchema>

            const markdown = normalizeString(renderedInput.markdown)
            const card = isPlainObject(renderedInput.card) ? renderedInput.card : null

            if (mode === 'post' && !markdown) {
              throw new Error(`[${toolName}] markdown is required when mode=post`)
            }
            if (mode === 'interactive' && !card && !markdown) {
              throw new Error(`[${toolName}] card or markdown is required when mode=interactive`)
            }

            const client = await getClient(resolvedIntegrationId, timeoutMs, toolName)

            const result = await runSendTaskBatch({
              integrationId: resolvedIntegrationId,
              toolName,
              recipients,
              timeoutMs,
              task: async (recipient) => {
                const response = await client.im.message.create({
                  params: {
                    receive_id_type: recipient.type
                  },
                  data: {
                    receive_id: recipient.id,
                    msg_type: mode === 'post' ? 'post' : 'interactive',
                    content:
                      mode === 'post'
                        ? JSON.stringify({
                            [locale]: {
                              content: [
                                [
                                  {
                                    tag: 'md',
                                    text: markdown
                                  }
                                ]
                              ]
                            }
                          })
                        : JSON.stringify(
                            card || {
                              elements: [{ tag: 'markdown', content: markdown }]
                            }
                          )
                  }
                })

                return {
                  messageId: response?.data?.message_id ?? null
                }
              }
            })

            return buildCommand(toolName, toolCallId, result)
          },
          {
            name: 'lark_send_rich_notification',
            description: 'Send post/interactive notifications to Lark users/chats with partial-success batch semantics.',
            schema: sendRichNotificationSchema,
            verboseParsingErrors: true
          }
        )
      )
    }

    if (enabledTools.updateMessage) {
      tools.push(
        tool(
          async (parameters, config) => {
            const toolName = 'lark_update_message'
            const toolCallId = getToolCallIdFromConfig(config)
            const { renderedInput, integrationId, timeoutMs } = resolveInput(parameters)
            const resolvedIntegrationId = requireIntegrationId(integrationId, toolName)
            const messageId = normalizeString(renderedInput.messageId)
            const mode = renderedInput.mode as 'text' | 'interactive'

            if (!messageId) {
              throw new Error(`[${toolName}] messageId is required`)
            }

            let content: string = null
            if (mode === 'text') {
              const text = normalizeString(renderedInput.content)
              if (!text) {
                throw new Error(`[${toolName}] content is required when mode=text`)
              }
              content = JSON.stringify({ text })
            } else {
              const card = isPlainObject(renderedInput.card) ? renderedInput.card : null
              const markdown = normalizeString(renderedInput.markdown)
              if (!card && !markdown) {
                throw new Error(`[${toolName}] card or markdown is required when mode=interactive`)
              }
              content = JSON.stringify(
                card || {
                  elements: [{ tag: 'markdown', content: markdown }]
                }
              )
            }

            const client = await getClient(resolvedIntegrationId, timeoutMs, toolName)
            try {
              await withTimeout(
                client.im.message.patch({
                  path: { message_id: messageId },
                  data: { content }
                }),
                timeoutMs,
                `[${toolName}] update message '${messageId}'`
              )
            } catch (error) {
              throw new Error(`[${toolName}] Failed to update message '${messageId}': ${formatError(error)}`)
            }

            const result: LarkNotifyResult = {
              tool: toolName,
              integrationId: resolvedIntegrationId,
              successCount: 1,
              failureCount: 0,
              results: [
                {
                  target: `message:${messageId}`,
                  success: true,
                  messageId
                }
              ]
            }

            this.logger.log(
              `[${toolName}] integrationId=${resolvedIntegrationId}, recipientCount=1, successCount=1, failureCount=0`
            )

            return buildCommand(toolName, toolCallId, result)
          },
          {
            name: 'lark_update_message',
            description: 'Update an existing Lark message.',
            schema: updateMessageSchema,
            verboseParsingErrors: true
          }
        )
      )
    }

    if (enabledTools.recallMessage) {
      tools.push(
        tool(
          async (parameters, config) => {
            const toolName = 'lark_recall_message'
            const toolCallId = getToolCallIdFromConfig(config)
            const { renderedInput, integrationId, timeoutMs } = resolveInput(parameters)
            const resolvedIntegrationId = requireIntegrationId(integrationId, toolName)
            const messageId = normalizeString(renderedInput.messageId)

            if (!messageId) {
              throw new Error(`[${toolName}] messageId is required`)
            }

            const client = await getClient(resolvedIntegrationId, timeoutMs, toolName)
            try {
              await withTimeout(
                (client.im.message as any).delete({
                  path: { message_id: messageId }
                }),
                timeoutMs,
                `[${toolName}] recall message '${messageId}'`
              )
            } catch (error) {
              throw new Error(`[${toolName}] Failed to recall message '${messageId}': ${formatError(error)}`)
            }

            const result: LarkNotifyResult = {
              tool: toolName,
              integrationId: resolvedIntegrationId,
              successCount: 1,
              failureCount: 0,
              results: [
                {
                  target: `message:${messageId}`,
                  success: true,
                  messageId
                }
              ]
            }

            this.logger.log(
              `[${toolName}] integrationId=${resolvedIntegrationId}, recipientCount=1, successCount=1, failureCount=0`
            )

            return buildCommand(toolName, toolCallId, result)
          },
          {
            name: 'lark_recall_message',
            description: 'Recall an existing Lark message.',
            schema: recallMessageSchema,
            verboseParsingErrors: true
          }
        )
      )
    }

    if (enabledTools.listUsers) {
      tools.push(
        tool(
          async (parameters, config) => {
            const toolName = 'lark_list_users'
            const toolCallId = getToolCallIdFromConfig(config)
            const { renderedInput, integrationId, timeoutMs } = resolveInput(parameters)
            const resolvedIntegrationId = requireIntegrationId(integrationId, toolName)
            const keyword = normalizeString(renderedInput.keyword)?.toLowerCase()
            const pageSize = normalizeIntInRange(renderedInput.pageSize, 20, 1, 100)
            const pageToken = normalizeString(renderedInput.pageToken)

            const client = await getClient(resolvedIntegrationId, timeoutMs, toolName)
            let response: Awaited<ReturnType<typeof client.contact.v3.user.findByDepartment>>;
            try {
              response = await withTimeout(
                client.contact.v3.user.findByDepartment({
                  params: {
                    user_id_type: 'open_id',
                    department_id_type: 'open_department_id',
                    department_id: '0',
                    page_size: pageSize,
                    page_token: pageToken || undefined
                  },
                }),
                timeoutMs,
                `[${toolName}] list users`
              )
            } catch (error) {
              throw new Error(`[${toolName}] Failed to list users: ${formatError(error)}`)
            }

            const items = (response?.data?.items ?? [])
              .map((item) => ({
                open_id: item?.open_id ?? null,
                union_id: item?.union_id ?? null,
                user_id: item?.user_id ?? null,
                name: item?.name ?? null,
                email: item?.email ?? null,
                mobile: item?.mobile ?? null,
                avatar: item?.avatar?.avatar_240 ?? null
              }))
              .filter((item) => {
                if (!keyword) {
                  return true
                }
                const values = [item.name, item.email, item.mobile, item.user_id, item.open_id, item.union_id]
                return values.some((value) => String(value || '').toLowerCase().includes(keyword))
              })

            const result: LarkNotifyResult = {
              tool: toolName,
              integrationId: resolvedIntegrationId,
              successCount: 1,
              failureCount: 0,
              results: [{ target: 'users', success: true }],
              data: {
                items,
                pageToken: response?.data?.page_token ?? null,
                hasMore: response?.data?.has_more ?? false
              }
            }

            this.logger.log(`[${toolName}] integrationId=${resolvedIntegrationId}, successCount=1, failureCount=0`)

            return buildCommand(toolName, toolCallId, result)
          },
          {
            name: 'lark_list_users',
            description: 'List users available for Lark notifications.',
            schema: listUsersSchema,
            verboseParsingErrors: true
          }
        )
      )
    }

    if (enabledTools.listChats) {
      tools.push(
        tool(
          async (parameters, config) => {
            const toolName = 'lark_list_chats'
            const toolCallId = getToolCallIdFromConfig(config)
            const { renderedInput, integrationId, timeoutMs } = resolveInput(parameters)
            const resolvedIntegrationId = requireIntegrationId(integrationId, toolName)
            const keyword = normalizeString(renderedInput.keyword)?.toLowerCase()
            const pageSize = normalizeIntInRange(renderedInput.pageSize, 20, 1, 100)
            const pageToken = normalizeString(renderedInput.pageToken)

            const client = await getClient(resolvedIntegrationId, timeoutMs, toolName)
            let response: Awaited<ReturnType<typeof client.im.chat.list>>;
            try {
              response = await withTimeout(
                client.im.chat.list({
                  params: {
                    page_size: pageSize,
                    page_token: pageToken || undefined
                  }
                }),
                timeoutMs,
                `[${toolName}] list chats`
              )
            } catch (error) {
              throw new Error(`[${toolName}] Failed to list chats: ${formatError(error)}`)
            }

            const items = (response?.data?.items ?? [])
              .map((item) => ({
                ...item,
                chat_id: item?.chat_id ?? null,
                name: item?.name ?? null,
                avatar: item?.avatar ?? null,
                description: item?.description ?? null,
              }))
              .filter((item) => {
                if (!keyword) {
                  return true
                }
                const values = [item.name, item.chat_id, item.description]
                return values.some((value) => String(value || '').toLowerCase().includes(keyword))
              })

            const result: LarkNotifyResult = {
              tool: toolName,
              integrationId: resolvedIntegrationId,
              successCount: 1,
              failureCount: 0,
              results: [{ target: 'chats', success: true }],
              data: {
                items,
                pageToken: response?.data?.page_token ?? null,
                hasMore: response?.data?.has_more ?? false
              }
            }

            this.logger.log(`[${toolName}] integrationId=${resolvedIntegrationId}, successCount=1, failureCount=0`)

            return buildCommand(toolName, toolCallId, result)
          },
          {
            name: 'lark_list_chats',
            description: 'List chats available for Lark notifications.',
            schema: listChatsSchema,
            verboseParsingErrors: true
          }
        )
      )
    }

    return {
      name: LARK_NOTIFY_MIDDLEWARE_NAME,
      stateSchema: larkNotifyStateSchema,
      tools
    }
  }
}

export type { LarkNotifyMiddlewareConfig, LarkNotifyState }
