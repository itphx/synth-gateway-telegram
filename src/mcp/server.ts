import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  sessionIdFromMeta,
  tgDeleteMessage,
  tgEditMessage,
  tgGetMe,
  tgNotify,
  tgSendButtons,
  tgSendMessage,
  tgSendToUser,
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
  // Машинный код ошибки (TelegramMcpError/SynthUserLookupError) — агенту нужен
  // и код (для ветвления), и человекочитаемый текст.
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  const text = code && !message.startsWith(code) ? `${code}: ${message}` : message;
  console.error('[gateway-mcp] ошибка инструмента:', text);
  return { content: [{ type: 'text', text }], isError: true };
}

const chatId = z.union([z.string(), z.number()]).optional();
const threadId = z.number().int().optional();

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
        'Отправляет сообщение в чат. Целевой чат: явный chatId → привязка текущей ' +
        'сессии (Telegram-чат подставляется автоматически) → чат по умолчанию ' +
        '(GATEWAY_DEFAULT_CHAT_ID / secrets/telegram_owner_chat_id либо чат ADMIN из ' +
        'allowlist). Без токена — dry-run. Если chatId не разрешён — подсказка и тул tg_status.',
      inputSchema: {
        text: z.string(),
        chatId,
        threadId,
        replyToMessageId: z.number().int().optional(),
      },
    },
    async (input, extra) => {
      try {
        return ok(await tgSendMessage(context, input, sessionIdFromMeta(extra?._meta)));
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
    async (input, extra) => {
      try {
        return ok(await tgEditMessage(context, input, sessionIdFromMeta(extra?._meta)));
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
    async (input, extra) => {
      try {
        return ok(await tgDeleteMessage(context, input, sessionIdFromMeta(extra?._meta)));
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
        '`data` уходит в `callback_data` (до 64 байт). Целевой чат резолвится так же, ' +
        'как у tg_send_message.',
      inputSchema: {
        text: z.string(),
        buttons: z.array(z.object({ text: z.string(), data: z.string() })).min(1),
        chatId,
        threadId,
      },
    },
    async (input, extra) => {
      try {
        return ok(await tgSendButtons(context, input, sessionIdFromMeta(extra?._meta)));
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
    'tg_send_to_user',
    {
      title: 'Сообщение пользователю Synth',
      description:
        'Отправляет сообщение конкретному пользователю Synth. Адресат — один из: ' +
        '`user` (id или username учётной записи Synth; резолвится через API v2, ' +
        'нужен scope users:read), `principalId` («tg:<id>», AD-089) или `chatId` ' +
        '(напрямую). Если у пользователя нет Telegram-идентичности — понятная ошибка.',
      inputSchema: {
        text: z.string(),
        user: z.string().optional(),
        principalId: z.string().optional(),
        chatId,
        replyToMessageId: z.number().int().optional(),
      },
    },
    async (input) => {
      try {
        return ok(await tgSendToUser(context, input));
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
        'смещение long-polling. Без chatId, но из привязанной сессии — возвращает ' +
        'привязку этой сессии (sessionId/chatId/resolvedFrom). Если данных нет — null.',
      inputSchema: { chatId },
    },
    async (input, extra) => {
      try {
        return ok(await tgStatus(context, input, sessionIdFromMeta(extra?._meta)));
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
