import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BotApiResponse,
  InlineKeyboardMarkup,
  TelegramClient,
  User,
} from '../bot-api/index.js';

/** Ошибка инструмента Telegram-MCP (машиночитаемый код). */
export class TelegramMcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramMcpError';
  }
}

/** Лимит Telegram на `callback_data` — 64 байта. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** Кнопка inline-клавиатуры: `data` уходит в `callback_data`. */
export interface InlineButtonInput {
  text: string;
  data: string;
}

/** Контекст выполнения инструментов: клиент и настройки. */
export interface TelegramToolContext {
  client: TelegramClient;
  /** Чат по умолчанию для send/edit/delete. */
  defaultChatId?: string;
  /** Получатель `tg_notify` (по умолчанию — `defaultChatId`). */
  ownerChatId?: string;
  /** Каталог JSON-хранилища шлюза (для `tg_status`; может отсутствовать). */
  dataDir?: string;
}

function validateCallbackData(data: string): void {
  if (data.length === 0) {
    throw new TelegramMcpError('telegram.callback_data_empty', 'callback_data не может быть пустым');
  }
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > MAX_CALLBACK_DATA_BYTES) {
    throw new TelegramMcpError(
      'telegram.callback_data_too_long',
      `callback_data превышает ${MAX_CALLBACK_DATA_BYTES} байт (получено ${bytes})`,
    );
  }
}

/** Собирает inline-клавиатуру: одна кнопка — одна строка. */
export function buildInlineKeyboard(buttons: InlineButtonInput[]): InlineKeyboardMarkup {
  if (buttons.length === 0) {
    throw new TelegramMcpError('telegram.buttons_empty', 'Список кнопок пуст');
  }
  return {
    inline_keyboard: buttons.map((button) => {
      validateCallbackData(button.data);
      return [{ text: button.text, callback_data: button.data }];
    }),
  };
}

/** `tg_send_message`: отправить сообщение в чат. */
export async function tgSendMessage(
  ctx: TelegramToolContext,
  input: { text: string; chatId?: string | number; replyToMessageId?: number },
): Promise<BotApiResponse> {
  return ctx.client.sendMessage({
    chatId: input.chatId ?? ctx.defaultChatId,
    text: input.text,
    ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
  });
}

/** `tg_edit_message`: отредактировать текст сообщения. */
export async function tgEditMessage(
  ctx: TelegramToolContext,
  input: { messageId: number; text: string; chatId?: string | number },
): Promise<BotApiResponse> {
  return ctx.client.editMessageText({
    chatId: input.chatId ?? ctx.defaultChatId,
    messageId: input.messageId,
    text: input.text,
  });
}

/** `tg_delete_message`: удалить сообщение. */
export async function tgDeleteMessage(
  ctx: TelegramToolContext,
  input: { messageId: number; chatId?: string | number },
): Promise<BotApiResponse> {
  return ctx.client.deleteMessage({
    chatId: input.chatId ?? ctx.defaultChatId,
    messageId: input.messageId,
  });
}

/** `tg_notify`: уведомление владельцу с маркером. */
export async function tgNotify(
  ctx: TelegramToolContext,
  input: { text: string },
): Promise<BotApiResponse> {
  const chatId = ctx.ownerChatId ?? ctx.defaultChatId;
  if (!chatId) {
    throw new TelegramMcpError(
      'telegram.owner_chat_id_missing',
      'Не задан получатель: GATEWAY_OWNER_CHAT_ID / GATEWAY_DEFAULT_CHAT_ID / secrets/telegram_owner_chat_id',
    );
  }
  return ctx.client.sendMessage({ chatId, text: `🔔 ${input.text}` });
}

/** `tg_send_buttons`: сообщение с inline-клавиатурой. */
export async function tgSendButtons(
  ctx: TelegramToolContext,
  input: { text: string; buttons: InlineButtonInput[]; chatId?: string | number },
): Promise<BotApiResponse> {
  return ctx.client.sendMessage({
    chatId: input.chatId ?? ctx.defaultChatId,
    text: input.text,
    replyMarkup: buildInlineKeyboard(input.buttons),
  });
}

/** `tg_get_me`: сведения о боте — проверка подключения. */
export async function tgGetMe(ctx: TelegramToolContext): Promise<BotApiResponse<User>> {
  return ctx.client.getMe();
}

/** Привязка чата к сессии из хранилища шлюза (минимальный срез). */
export interface ChatBinding {
  sessionId?: string;
  chatId?: string;
  threadId?: number;
  lastInboundMessageId?: number;
  lastOutboundMessageId?: number;
  updatedAt?: string;
}

/** Результат `tg_status`. */
export interface StatusResult {
  dryRun: boolean;
  /** Смещение long-polling шлюза (если хранилище доступно). */
  offset: number | null;
  chatId: string | null;
  chatKey: string | null;
  /** Привязка запрошенного чата (или `null`). */
  binding: ChatBinding | null;
  /** Все привязки, если `chatId` не задан. */
  chats?: Record<string, ChatBinding>;
}

/** Читает `state/chat-sessions.json`; недоступно/битый файл → пустой объект. */
function readChatSessions(dataDir: string): Record<string, ChatBinding> {
  try {
    const raw = readFileSync(join(dataDir, 'state', 'chat-sessions.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, ChatBinding>)
      : {};
  } catch {
    return {};
  }
}

/** Читает `state/offset.json`; недоступно → `null`. */
function readOffset(dataDir: string): number | null {
  try {
    const raw = readFileSync(join(dataDir, 'state', 'offset.json'), 'utf8');
    const parsed = JSON.parse(raw) as { offset?: unknown };
    return typeof parsed.offset === 'number' ? parsed.offset : null;
  } catch {
    return null;
  }
}

/**
 * `tg_status`: best-effort состояние — привязка чата/сессии из хранилища шлюза
 * (`GATEWAY_DATA_DIR`). Если хранилище недоступно — значения `null`.
 */
export async function tgStatus(
  ctx: TelegramToolContext,
  input: { chatId?: string | number } = {},
): Promise<StatusResult> {
  const chats = ctx.dataDir ? readChatSessions(ctx.dataDir) : {};
  const offset = ctx.dataDir ? readOffset(ctx.dataDir) : null;
  const chatId = input.chatId !== undefined ? String(input.chatId) : null;
  const chatKey = chatId !== null ? `chat:telegram:${chatId}` : null;

  return {
    dryRun: ctx.client.dryRun,
    offset,
    chatId,
    chatKey,
    binding: chatKey !== null ? (chats[chatKey] ?? null) : null,
    ...(chatKey === null ? { chats } : {}),
  };
}
