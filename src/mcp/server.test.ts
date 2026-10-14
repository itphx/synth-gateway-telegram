import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TelegramClient } from '../bot-api/index.js';

import { describe, expect, it } from 'vitest';

import { createMcpServer, SERVER_NAME } from './server.js';
import type { TelegramToolContext } from './tools.js';

/** Контекст с dry-run-клиентом (без токена — сетевых вызовов нет). */
function dryRunContext(): TelegramToolContext {
  const client = new TelegramClient({ dryRun: true });
  return { client, defaultChatId: '-1001234567890', ownerChatId: '123456789' };
}

async function connect(context: TelegramToolContext): Promise<Client> {
  const server = createMcpServer(context, 'test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe(`MCP-сервер ${SERVER_NAME}`, () => {
  it('регистрирует все инструменты шлюза', async () => {
    const client = await connect(dryRunContext());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          'tg_delete_message',
          'tg_edit_message',
          'tg_get_me',
          'tg_notify',
          'tg_send_buttons',
          'tg_send_message',
          'tg_send_to_user',
          'tg_status',
        ].sort(),
      );
      // Схемы: обязательные поля присутствуют.
      const send = tools.find((tool) => tool.name === 'tg_send_message');
      expect(send?.inputSchema.required).toEqual(['text']);
      const sendToUser = tools.find((tool) => tool.name === 'tg_send_to_user');
      expect(sendToUser?.inputSchema.required).toEqual(['text']);
      const buttons = tools.find((tool) => tool.name === 'tg_send_buttons');
      expect(buttons?.inputSchema.required?.sort()).toEqual(['buttons', 'text']);
    } finally {
      await client.close();
    }
  });

  it('tg_send_message в dry-run возвращает {dryRun:true} без сети', async () => {
    const client = await connect(dryRunContext());
    try {
      const result = await client.callTool({
        name: 'tg_send_message',
        arguments: { text: 'привет' },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ dryRun: true, chat_id: '-1001234567890' });
    } finally {
      await client.close();
    }
  });

  it('tg_get_me в dry-run отдаёт заглушку бота', async () => {
    const client = await connect(dryRunContext());
    try {
      const result = await client.callTool({ name: 'tg_get_me', arguments: {} });
      const structured = result.structuredContent as { dryRun?: boolean; result?: { is_bot?: boolean } };
      expect(structured.dryRun).toBe(true);
      expect(structured.result?.is_bot).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('tg_send_to_user по principalId работает без API Synth (dry-run)', async () => {
    const client = await connect(dryRunContext());
    try {
      const result = await client.callTool({
        name: 'tg_send_to_user',
        arguments: { text: 'привет', principalId: 'tg:450316139' },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        dryRun: true,
        chat_id: '450316139',
        via: 'principalId',
      });
    } finally {
      await client.close();
    }
  });

  it('tg_send_to_user без адресата — понятная ошибка инструмента', async () => {
    const client = await connect(dryRunContext());
    try {
      const result = await client.callTool({ name: 'tg_send_to_user', arguments: { text: 'x' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('telegram.target_required');
    } finally {
      await client.close();
    }
  });

  it('tg_send_message берёт chatId/thread/reply из привязки сессии по _meta', async () => {
    const context: TelegramToolContext = {
      client: new TelegramClient({ dryRun: true }),
      defaultChatId: '-1001234567890',
      resolveSessionChat: async (sessionId) =>
        sessionId === 'sess_1'
          ? { chatId: '777', threadId: 3, lastInboundMessageId: 4 }
          : undefined,
    };
    const client = await connect(context);
    try {
      const result = await client.callTool({
        name: 'tg_send_message',
        arguments: { text: 'привет' },
        _meta: { 'synth/session_id': 'sess_1' },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        dryRun: true,
        chat_id: '777',
        message_thread_id: 3,
        reply_to_message_id: 4,
      });
    } finally {
      await client.close();
    }
  });

  it('tg_status по _meta-сессии возвращает привязку этой сессии', async () => {
    const context: TelegramToolContext = {
      client: new TelegramClient({ dryRun: true }),
      dataDir: undefined,
      resolveSessionChat: async () => ({ chatId: '777', chatKey: 'chat:telegram:777' }),
    };
    const client = await connect(context);
    try {
      const result = await client.callTool({
        name: 'tg_status',
        arguments: {},
        _meta: { 'synth/session_id': 'sess_meta' },
      });
      expect(result.structuredContent).toMatchObject({
        sessionId: 'sess_meta',
        chatId: '777',
        resolvedFrom: 'session',
      });
    } finally {
      await client.close();
    }
  });

  it('ошибка инструмента возвращается с isError и кодом', async () => {
    // Контекст без чата по умолчанию → tg_send_message падает с chat_id_missing.
    const client = await connect({ client: new TelegramClient({ dryRun: true }) });
    try {
      const result = await client.callTool({ name: 'tg_send_message', arguments: { text: 'x' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('telegram.chat_id_missing');
    } finally {
      await client.close();
    }
  });
});
