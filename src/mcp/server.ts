import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  tgDeleteMessage,
  tgEditMessage,
  tgGetMe,
  tgNotify,
  tgSendButtons,
  tgSendMessage,
  tgStatus,
  type TelegramToolContext,
} from './tools.js';

/** Имя MCP-сервера (тулы неймспейсятся Synth как `synth-gateway-telegram_<tool>`). */
export const SERVER_NAME = 'synth-gateway-telegram';

/** Тонкая обёртка над инструментами: JSON в `content` + `structuredContent`. */
interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: isRecord(data) ? data : { result: data },
  };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[gateway-mcp] ошибка инструмента:', message);
  return { content: [{ type: 'text', text: message }], isError: true };
}

const chatId = z.union([z.string(), z.number()]).optional();

/**
 * Регистрирует MCP-тулы шлюза (AD-089/AD-046). Имена тулов зафиксированы
 * контрактом (см. `skills/gateway-telegram/SKILL.md`).
 */
export function createMcpServer(context: TelegramToolContext, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });

  server.registerTool(
    'tg_send_message',
    {
      title: 'Отправить сообщение',
      description:
        'Отправляет сообщение в чат. chatId по умолчанию — GATEWAY_DEFAULT_CHAT_ID ' +
        '(или secrets/telegram_owner_chat_id). Без токена — dry-run.',
      inputSchema: {
        text: z.string(),
        chatId,
        replyToMessageId: z.number().int().optional(),
      },
    },
    async (input) => {
      try {
        return ok(await tgSendMessage(context, input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'tg_edit_message',
    {
      title: 'Отредактировать сообщение',
      description: 'Редактирует текст ранее отправленного сообщения шлюза.',
      inputSchema: { messageId: z.number().int(), text: z.string(), chatId },
    },
    async (input) => {
      try {
        return ok(await tgEditMessage(context, input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'tg_delete_message',
    {
      title: 'Удалить сообщение',
      description: 'Удаляет сообщение в чате.',
      inputSchema: { messageId: z.number().int(), chatId },
    },
    async (input) => {
      try {
        return ok(await tgDeleteMessage(context, input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'tg_notify',
    {
      title: 'Уведомить владельца',
      description:
        'Отправляет уведомление владельцу (owner chat) с маркером «🔔». ' +
        'Не спамить: только по значимым событиям.',
      inputSchema: { text: z.string() },
    },
    async (input) => {
      try {
        return ok(await tgNotify(context, input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'tg_send_buttons',
    {
      title: 'Сообщение с inline-кнопками',
      description:
        'Отправляет сообщение с inline-клавиатурой. Каждая кнопка — отдельная строка; ' +
        '`data` уходит в `callback_data` (до 64 байт).',
      inputSchema: {
        text: z.string(),
        buttons: z.array(z.object({ text: z.string(), data: z.string() })).min(1),
        chatId,
      },
    },
    async (input) => {
      try {
        return ok(await tgSendButtons(context, input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'tg_get_me',
    {
      title: 'Проверка бота',
      description: 'Сведения о боте (getMe) — проверка подключения.',
    },
    async () => {
      try {
        return ok(await tgGetMe(context));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'tg_status',
    {
      title: 'Состояние шлюза',
      description:
        'Best-effort: привязка чата к сессии из хранилища шлюза (GATEWAY_DATA_DIR), ' +
        'смещение long-polling. Если данных нет — null.',
      inputSchema: { chatId },
    },
    async (input) => {
      try {
        return ok(await tgStatus(context, input));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}

/** Запускает MCP-сервер по stdio (для подключения к opencode). */
export async function runMcpServer(
  context: TelegramToolContext,
  version: string,
): Promise<void> {
  const server = createMcpServer(context, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
