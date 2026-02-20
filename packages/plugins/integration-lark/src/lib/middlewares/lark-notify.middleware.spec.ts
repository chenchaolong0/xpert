import { Command } from '@langchain/langgraph'
import * as langgraph from '@langchain/langgraph'
import {
  LarkNotifyMiddleware,
  LarkNotifyMiddlewareConfig
} from './lark-notify.middleware'

function createBaseConfig(): LarkNotifyMiddlewareConfig {
  return {
    integrationId: 'integration-default',
    template: {
      enabled: true,
      strict: false
    },
    defaults: {
      recipients: [{ type: 'chat_id', id: 'chat-default' }],
      postLocale: 'en_us',
      timeoutMs: 1000
    },
    tools: {
      send_text_notification: true,
      send_rich_notification: true,
      update_message: true,
      recall_message: true,
      list_users: true,
      list_chats: true
    }
  }
}

function mergeConfig(partial?: Partial<LarkNotifyMiddlewareConfig>): LarkNotifyMiddlewareConfig {
  const base = createBaseConfig()
  if (!partial) {
    return base
  }

  return {
    ...base,
    ...partial,
    template: {
      ...base.template,
      ...(partial.template ?? {})
    },
    defaults: {
      ...base.defaults,
      ...(partial.defaults ?? {})
    },
    tools: {
      ...base.tools,
      ...(partial.tools ?? {})
    }
  }
}

async function createFixture(config?: Partial<LarkNotifyMiddlewareConfig>) {
  const messageCreate = jest.fn().mockResolvedValue({
    data: {
      message_id: 'msg-default'
    }
  })
  const messagePatch = jest.fn().mockResolvedValue({})
  const messageDelete = jest.fn().mockResolvedValue({})
  const listUsers = jest.fn().mockResolvedValue({
    data: {
      items: [
        {
          open_id: 'ou_tom',
          union_id: 'uu_tom',
          user_id: 'user_tom',
          name: 'Tom Jerry',
          email: 'tom@example.com',
          mobile: '13800138000'
        },
        {
          open_id: 'ou_alice',
          union_id: 'uu_alice',
          user_id: 'user_alice',
          name: 'Alice',
          email: 'alice@example.com',
          mobile: '13900139000'
        }
      ],
      page_token: 'next-user-token',
      has_more: true
    }
  })
  const listChats = jest.fn().mockResolvedValue({
    data: {
      items: [
        {
          chat_id: 'oc_analytics',
          name: 'Analytics Team',
          description: 'Daily analytics updates'
        },
        {
          chat_id: 'oc_ops',
          name: 'Ops Team',
          description: 'Operations room'
        }
      ],
      page_token: 'next-chat-token',
      has_more: false
    }
  })

  const client = {
    im: {
      message: {
        create: messageCreate,
        patch: messagePatch,
        delete: messageDelete
      },
      chat: {
        list: listChats
      }
    },
    contact: {
      user: {
        list: listUsers
      }
    }
  }

  const larkChannel = {
    getOrCreateLarkClientById: jest.fn().mockResolvedValue(client)
  }

  const strategy = new LarkNotifyMiddleware(larkChannel as any)
  const middleware = await Promise.resolve(strategy.createMiddleware(mergeConfig(config), {} as any))

  return {
    middleware,
    larkChannel,
    client,
    messageCreate,
    messagePatch,
    messageDelete,
    listUsers,
    listChats
  }
}

function getTool(middleware: any, name: string) {
  const tool = middleware.tools.find((item) => item.name === name)
  if (!tool) {
    throw new Error(`Tool ${name} not found`)
  }
  return tool
}

describe('LarkNotifyMiddleware', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(langgraph, 'getCurrentTaskInput').mockReturnValue({} as any)
  })

  it('createMiddleware exposes default tool names', async () => {
    const { middleware } = await createFixture()

    expect(middleware.tools.map((tool) => tool.name)).toEqual([
      'lark_send_text_notification',
      'lark_send_rich_notification',
      'lark_update_message',
      'lark_recall_message',
      'lark_list_users',
      'lark_list_chats'
    ])
  })

  it('respects tools switch flags', async () => {
    const { middleware } = await createFixture({
      tools: {
        send_text_notification: false,
        send_rich_notification: false,
        update_message: false,
        recall_message: false,
        list_users: false,
        list_chats: false
      }
    })

    expect(middleware.tools).toHaveLength(0)
  })

  it('uses tool integrationId over middleware integrationId', async () => {
    const { middleware, larkChannel } = await createFixture({ integrationId: 'integration-from-config' })

    await getTool(middleware, 'lark_send_text_notification').invoke(
      {
        integrationId: 'integration-from-args',
        recipients: [{ type: 'chat_id', id: 'chat-1' }],
        content: 'hello'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(larkChannel.getOrCreateLarkClientById).toHaveBeenCalledWith('integration-from-args')
  })

  it('renders mustache variables from runtime state for integration, recipients and content', async () => {
    const { middleware, messageCreate } = await createFixture({
      integrationId: '{{runtime.integrationId}}',
      defaults: {
        recipients: [{ type: 'chat_id', id: '{{runtime.chatId}}' }],
        timeoutMs: 1000,
        postLocale: 'en_us'
      }
    })

    jest.spyOn(langgraph, 'getCurrentTaskInput').mockReturnValue({
      runtime: {
        integrationId: 'integration-from-state',
        chatId: 'chat-from-state',
        userName: 'Alice'
      }
    } as any)

    await getTool(middleware, 'lark_send_text_notification').invoke(
      {
        content: 'Hi {{runtime.userName}}'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          receive_id_type: 'chat_id'
        },
        data: expect.objectContaining({
          receive_id: 'chat-from-state'
        })
      })
    )
    const content = JSON.parse(messageCreate.mock.calls[0][0].data.content)
    expect(content.text).toBe('Hi Alice')
  })

  it('sends text notification and writes state fields', async () => {
    const { middleware, messageCreate } = await createFixture()

    const result = await getTool(middleware, 'lark_send_text_notification').invoke(
      {
        recipients: [{ type: 'chat_id', id: 'chat-a' }],
        content: 'text-notify'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(result).toBeInstanceOf(Command)
    expect(messageCreate).toHaveBeenCalledTimes(1)
    expect(result.update.lark_notify_last_result.successCount).toBe(1)
    expect(result.update.lark_notify_last_result.failureCount).toBe(0)
    expect(result.update.lark_notify_last_message_ids).toEqual(['msg-default'])
  })

  it('returns partial success for batch text notifications', async () => {
    const { middleware, messageCreate } = await createFixture()
    messageCreate.mockImplementation(({ data }) => {
      if (data.receive_id === 'chat-failed') {
        throw new Error('mock failure')
      }
      return Promise.resolve({
        data: {
          message_id: `msg-${data.receive_id}`
        }
      })
    })

    const result = await getTool(middleware, 'lark_send_text_notification').invoke(
      {
        recipients: [
          { type: 'chat_id', id: 'chat-ok' },
          { type: 'chat_id', id: 'chat-failed' }
        ],
        content: 'batch-notify'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(result.update.lark_notify_last_result.successCount).toBe(1)
    expect(result.update.lark_notify_last_result.failureCount).toBe(1)
    expect(result.update.lark_notify_last_result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'chat_id:chat-ok', success: true }),
        expect.objectContaining({ target: 'chat_id:chat-failed', success: false })
      ])
    )
  })

  it('sends rich notification in post mode', async () => {
    const { middleware, messageCreate } = await createFixture()

    await getTool(middleware, 'lark_send_rich_notification').invoke(
      {
        recipients: [{ type: 'chat_id', id: 'chat-post' }],
        mode: 'post',
        locale: 'zh_cn',
        markdown: '## hello'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(messageCreate).toHaveBeenCalledTimes(1)
    const payload = messageCreate.mock.calls[0][0]
    expect(payload.data.msg_type).toBe('post')
    const content = JSON.parse(payload.data.content)
    expect(content.zh_cn.content[0][0].text).toBe('## hello')
  })

  it('sends rich notification in interactive mode', async () => {
    const { middleware, messageCreate } = await createFixture()
    const card = {
      elements: [{ tag: 'markdown', content: 'interactive body' }]
    }

    await getTool(middleware, 'lark_send_rich_notification').invoke(
      {
        recipients: [{ type: 'chat_id', id: 'chat-card' }],
        mode: 'interactive',
        card
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(messageCreate).toHaveBeenCalledTimes(1)
    const payload = messageCreate.mock.calls[0][0]
    expect(payload.data.msg_type).toBe('interactive')
    expect(JSON.parse(payload.data.content)).toEqual(card)
  })

  it('updates message via patch API', async () => {
    const { middleware, messagePatch } = await createFixture()

    const result = await getTool(middleware, 'lark_update_message').invoke(
      {
        messageId: 'om_update_1',
        mode: 'text',
        content: 'updated content'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(result).toBeInstanceOf(Command)
    expect(messagePatch).toHaveBeenCalledWith({
      path: { message_id: 'om_update_1' },
      data: { content: JSON.stringify({ text: 'updated content' }) }
    })
  })

  it('recalls message via delete API', async () => {
    const { middleware, messageDelete } = await createFixture()

    const result = await getTool(middleware, 'lark_recall_message').invoke(
      {
        messageId: 'om_recall_1'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-id'
        }
      }
    )

    expect(result).toBeInstanceOf(Command)
    expect(messageDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_recall_1' }
      })
    )
  })

  it('lists users and chats with pagination and keyword filter', async () => {
    const { middleware } = await createFixture()

    const usersResult = await getTool(middleware, 'lark_list_users').invoke(
      {
        keyword: 'tom',
        pageSize: 50,
        pageToken: 'token-u'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-users'
        }
      }
    )

    const chatsResult = await getTool(middleware, 'lark_list_chats').invoke(
      {
        keyword: 'analytics',
        pageSize: 50,
        pageToken: 'token-c'
      },
      {
        metadata: {
          tool_call_id: 'tool-call-chats'
        }
      }
    )

    expect(usersResult.update.lark_notify_last_result.data).toEqual(
      expect.objectContaining({
        hasMore: true,
        pageToken: 'next-user-token',
        items: [expect.objectContaining({ name: 'Tom Jerry' })]
      })
    )

    expect(chatsResult.update.lark_notify_last_result.data).toEqual(
      expect.objectContaining({
        hasMore: false,
        pageToken: 'next-chat-token',
        items: [expect.objectContaining({ name: 'Analytics Team' })]
      })
    )
  })

  it('throws clear errors when integration or recipients is missing', async () => {
    const noIntegration = await createFixture({
      integrationId: null,
      defaults: {
        recipients: [{ type: 'chat_id', id: 'chat-1' }],
        postLocale: 'en_us',
        timeoutMs: 1000
      }
    })

    await expect(
      getTool(noIntegration.middleware, 'lark_send_text_notification').invoke({
        content: 'no integration'
      })
    ).rejects.toThrow('integrationId is required')

    const noRecipients = await createFixture({
      defaults: {
        recipients: [],
        postLocale: 'en_us',
        timeoutMs: 1000
      }
    })

    await expect(
      getTool(noRecipients.middleware, 'lark_send_text_notification').invoke({
        content: 'no recipients'
      })
    ).rejects.toThrow('recipients is required')
  })
})
