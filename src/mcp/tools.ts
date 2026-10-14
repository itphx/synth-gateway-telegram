import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BotApiResponse,
  InlineKeyboardMarkup,
  Message,
  TelegramClient,
  User,
} from '../bot-api/index.js';

import {
  resolveTelegramChatId,
  type SynthUserLookupOptions,
  type TelegramTargetInput,
} from './user-lookup.js';

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

/** Ключ метаданных MCP-запроса с id сессии Synth (`_meta`-контракт ядра). */
export const SESSION_ID_META_KEY = 'synth/session_id';

/**
 * Текст ошибки при неразрешённом целевом чате. Согласован с пользователем:
 * подсказывает явный `chatId`, авто-подстановку в привязанной сессии и `tg_status`.
 */
export const CHAT_ID_MISSING_MESSAGE =
  'Не задан chatId: укажите параметр chatId явно; в сессии, привязанной к Telegram-чату, ' +
  'он подставляется автоматически; id чата можно узнать тулом tg_status.';

/** Кнопка inline-клавиатуры: `data` уходит в `callback_data`. */
export interface InlineButtonInput {
  text: string;
  data: string;
}

/** Привязка чата к сессии (срез `GatewayStore.SessionRoute`) для резолва из `_meta`. */
export interface SessionChat {
  /** Chat id Telegram. */
  chatId: string;
  /** Ключ чата в хранилище (`chat:telegram:<chatId>`). */
  chatKey?: string;
  /** id топика форума (если чат — форум). */
  threadId?: number;
  /** id последнего входящего сообщения (для reply-адресата). */
  lastInboundMessageId?: number;
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
  /**
   * Резолвер привязки чата по id сессии Synth (`_meta['synth/session_id']`).
   * Реализуется транспортом (HTTP — per-tenant `tenantStoreDir`, stdio —
   * `config.dataDir`); стор инстанцируется лениво. Не задан — резолв по сессии
   * недоступен (работает явный `chatId`/`defaultChatId`).
   */
  resolveSessionChat?: (sessionId: string) => Promise<SessionChat | undefined>;
  /**
   * Доступ к API v2 Synth (нужен `tg_send_to_user` для резолвинга `user` →
   * Telegram-идентичность). Не задан — резолвинг по `user` недоступен
   * (работают `principalId`/`chatId`).
   */
  synth?: SynthUserLookupOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Извлекает id сессии Synth из `_meta` MCP-запроса (контракт `synth/session_id`).
 * Это метаданные запроса, а не `extra.sessionId` MCP-транспорта.
 */
export function sessionIdFromMeta(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta[SESSION_ID_META_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Откуда взят целевой `chatId`. */
export type ChatIdSource = 'arg' | 'session' | 'default';

interface ResolvedChat {
  chatId: string | number;
  resolvedFrom: ChatIdSource;
  /** Привязка сессии (если `_meta`-сессия резолвилась). */
  route?: SessionChat;
}

/** Непустое значение chatId (`undefined`/`null`/пустая строка — нет значения). */
function isSetChatId(value: string | number | undefined | null): value is string | number {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** Совпадает ли целевой `chatId` с чатом привязки сессии. */
function sameChat(chatId: string | number, route: SessionChat): boolean {
  return String(chatId) === route.chatId;
}

/**
 * Резолвит целевой чат по приоритету: явный аргумент → привязка сессии
 * (`_meta`) → `ctx.defaultChatId` (в HTTP-режиме — tenant-дефолт из allowlist).
 * Неразрешённый чат → {@link TelegramMcpError} `telegram.chat_id_missing`.
 */
async function resolveChatId(
  ctx: TelegramToolContext,
  explicit: string | number | undefined,
  sessionId: string | undefined,
): Promise<ResolvedChat> {
  // Привязку сессии читаем всегда (нужна для threadId/reply), но ошибку стора
  // не пробрасываем наружу: транспортный сбой не должен ломать отправку.
  let route: SessionChat | undefined;
  if (sessionId && ctx.resolveSessionChat) {
    try {
      route = await ctx.resolveSessionChat(sessionId);
    } catch {
      route = undefined;
    }
  }

  if (isSetChatId(explicit)) {
    return { chatId: explicit, resolvedFrom: 'arg', ...(route ? { route } : {}) };
  }
  if (route?.chatId) {
    return { chatId: route.chatId, resolvedFrom: 'session', route };
  }
  if (isSetChatId(ctx.defaultChatId)) {
    return { chatId: ctx.defaultChatId, resolvedFrom: 'default' };
  }
  throw new TelegramMcpError('telegram.chat_id_missing', CHAT_ID_MISSING_MESSAGE);
}

/** `messageThreadId` из привязки сессии — только если целевой чат ей совпадает. */
function threadIdFromRoute(target: ResolvedChat): number | undefined {
  if (!target.route || target.route.threadId === undefined) return undefined;
  return sameChat(target.chatId, target.route) ? target.route.threadId : undefined;
}

/** `replyToMessageId` из привязки сессии — только если целевой чат ей совпадает. */
function replyToFromRoute(target: ResolvedChat): number | undefined {
  if (!target.route || target.route.lastInboundMessageId === undefined) return undefined;
  return sameChat(target.chatId, target.route) ? target.route.lastInboundMessageId : undefined;
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
  input: {
    text: string;
    chatId?: string | number;
    /** id топика форума (`message_thread_id`); иначе — из привязки сессии. */
    threadId?: number;
    replyToMessageId?: number;
  },
  sessionId?: string,
): Promise<BotApiResponse> {
  const target = await resolveChatId(ctx, input.chatId, sessionId);
  const threadId = input.threadId ?? threadIdFromRoute(target);
  const replyToMessageId = input.replyToMessageId ?? replyToFromRoute(target);
  return ctx.client.sendMessage({
    chatId: target.chatId,
    text: input.text,
    ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  });
}

/** `tg_edit_message`: отредактировать текст сообщения. */
export async function tgEditMessage(
  ctx: TelegramToolContext,
  input: { messageId: number; text: string; chatId?: string | number },
  sessionId?: string,
): Promise<BotApiResponse> {
  const target = await resolveChatId(ctx, input.chatId, sessionId);
  return ctx.client.editMessageText({
    chatId: target.chatId,
    messageId: input.messageId,
    text: input.text,
  });
}

/** `tg_delete_message`: удалить сообщение. */
export async function tgDeleteMessage(
  ctx: TelegramToolContext,
  input: { messageId: number; chatId?: string | number },
  sessionId?: string,
): Promise<BotApiResponse> {
  const target = await resolveChatId(ctx, input.chatId, sessionId);
  return ctx.client.deleteMessage({
    chatId: target.chatId,
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
  input: {
    text: string;
    buttons: InlineButtonInput[];
    chatId?: string | number;
    /** id топика форума (`message_thread_id`); иначе — из привязки сессии. */
    threadId?: number;
  },
  sessionId?: string,
): Promise<BotApiResponse> {
  const target = await resolveChatId(ctx, input.chatId, sessionId);
  const threadId = input.threadId ?? threadIdFromRoute(target);
  return ctx.client.sendMessage({
    chatId: target.chatId,
    text: input.text,
    replyMarkup: buildInlineKeyboard(input.buttons),
    ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
  });
}

/** `tg_get_me`: сведения о боте — проверка подключения. */
export async function tgGetMe(ctx: TelegramToolContext): Promise<BotApiResponse<User>> {
  return ctx.client.getMe();
}

/** Вход `tg_send_to_user`: адресат (user | principalId | chatId) + текст. */
export interface TgSendToUserInput extends TelegramTargetInput {
  text: string;
  replyToMessageId?: number;
}

/** Ответ `tg_send_to_user`: ответ Bot API + разрешённый адресат. */
export interface TgSendToUserResult extends BotApiResponse<Message> {
  /** Как получен адресат (`chatId` | `principalId` | `user`). */
  via: 'chatId' | 'principalId' | 'user';
  /** Итоговый chat_id. */
  chatId: string;
  /** id/username пользователя Synth (при резолвинге по `user`). */
  userId?: string;
  username?: string;
}

/**
 * `tg_send_to_user`: сообщение конкретному пользователю Synth.
 *
 * `user` (id/username Synth) резолвится через API v2 машинной кредой тенанта
 * (нужен scope `users:read`) → `identities[]` provider `telegram` → chat_id.
 * `principalId` (`tg:<id>`) и `chatId` отправляются без обращения к API.
 */
export async function tgSendToUser(
  ctx: TelegramToolContext,
  input: TgSendToUserInput,
): Promise<TgSendToUserResult> {
  const target = await resolveTelegramChatId(ctx.synth, input);
  const response = await ctx.client.sendMessage({
    chatId: target.chatId,
    text: input.text,
    ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
  });
  return {
    ...response,
    via: target.via,
    chatId: target.chatId,
    ...(target.userId !== undefined ? { userId: target.userId } : {}),
    ...(target.username !== undefined ? { username: target.username } : {}),
  };
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
  /** id сессии Synth из `_meta` (если вызов пришёл из сессии). */
  sessionId?: string;
  chatId: string | null;
  chatKey: string | null;
  /** Откуда взят `chatId`: аргумент/сессия/дефолт/не разрешён. */
  resolvedFrom: 'arg' | 'session' | 'default' | 'none';
  /** Привязка запрошенного чата (или `null`). */
  binding: ChatBinding | null;
  /** Все привязки, если чат не задан и не разрешён. */
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
 * (`GATEWAY_DATA_DIR`). Целевой чат разрешается по приоритету: явный `chatId` →
 * привязка сессии (`_meta['synth/session_id']`) → `ctx.defaultChatId`. Если чат не
 * разрешён — возвращаются все привязки. Хранилище недоступно — значения `null`.
 */
export async function tgStatus(
  ctx: TelegramToolContext,
  input: { chatId?: string | number } = {},
  sessionId?: string,
): Promise<StatusResult> {
  const chats = ctx.dataDir ? readChatSessions(ctx.dataDir) : {};
  const offset = ctx.dataDir ? readOffset(ctx.dataDir) : null;

  let chatId: string | null = null;
  let chatKey: string | null = null;
  let resolvedFrom: StatusResult['resolvedFrom'] = 'none';

  if (isSetChatId(input.chatId)) {
    chatId = String(input.chatId);
    chatKey = `chat:telegram:${chatId}`;
    resolvedFrom = 'arg';
  } else {
    // Сбой стора не должен ломать статус — трактуем как «привязки нет».
    let route: SessionChat | undefined;
    if (sessionId && ctx.resolveSessionChat) {
      try {
        route = await ctx.resolveSessionChat(sessionId);
      } catch {
        route = undefined;
      }
    }
    if (route?.chatId) {
      chatId = route.chatId;
      chatKey = route.chatKey ?? `chat:telegram:${route.chatId}`;
      resolvedFrom = 'session';
    } else if (isSetChatId(ctx.defaultChatId)) {
      chatId = String(ctx.defaultChatId);
      chatKey = `chat:telegram:${chatId}`;
      resolvedFrom = 'default';
    }
  }

  return {
    dryRun: ctx.client.dryRun,
    offset,
    ...(sessionId ? { sessionId } : {}),
    chatId,
    chatKey,
    resolvedFrom,
    binding: chatKey !== null ? (chats[chatKey] ?? null) : null,
    ...(chatKey === null ? { chats } : {}),
  };
}
