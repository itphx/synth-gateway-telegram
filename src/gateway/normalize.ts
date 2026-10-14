import type { CallbackQuery, Message, Update } from '../bot-api/index.js';

import { parseCommand } from './commands.js';

/**
 * AD-089: тело внешнего события Synth (совместимо со схемой приёма
 * `POST /api/v2/events` — `source`/`type`/`payload`/`identity`/`dedupKey`).
 * `id`/`ts` назначаются ядром при приёме.
 */
export interface SynthEventInput {
  source: string;
  type: string;
  payload: TelegramEventPayload;
  identity: EventIdentity;
  dedupKey: string;
}

/** AD-089: идентичность отправителя (маппинг на RBAC). */
export interface EventIdentity {
  principalId?: string;
  chatKey?: string;
  threadKey?: string;
  roles?: string[];
}

/** Метаданные вложения Telegram (без скачивания — AD-085 не реализован). */
export interface TelegramAttachmentMeta {
  kind: string;
  fileId: string;
  fileName?: string;
}

/** Нормализованное тело Telegram-события. */
export interface TelegramEventPayload {
  chatId: string;
  /**
   * Тип чата Telegram (`message.chat.type`): `'private'|'group'|'supergroup'|'channel'`.
   * AD-089 (claim-flow): код линковки показываем **только** в приватном чате —
   * в группе его увидели бы все участники и могли «угнать» привязку.
   */
  chatType?: string;
  messageId: number;
  threadId?: number;
  text?: string;
  from: {
    id: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    /**
     * Человекочитаемое имя отправителя (`[firstName, lastName].join(' ')`).
     * Ядру (AD-089, этап 1) достаточно `payload.from`: оно выводит автора как
     * `@username` → имя → `tg:<id>`.
     */
    displayName?: string;
    /** Признак внешнего отправителя (шлюз всегда внешний — AD-086/AD-089). */
    isExternal: true;
  };
  replyToMessageId?: number;
  /** Признак, что это правка ранее отправленного сообщения (`edited_message`). */
  edited?: boolean;
  attachment?: TelegramAttachmentMeta;
  /** Для `callback_query` — данные нажатой inline-кнопки. */
  callback?: {
    data?: string;
    messageId: number;
  };
  /** Для `type: 'command'` — имя slash-команды без `/` (lowercase). */
  command?: string;
  /** Для `type: 'command'` — аргументы команды. */
  args?: string;
  /**
   * Метка для правил маршрутизации ядра (`eventRouteMatchSchema.label`).
   * Для команд дублирует имя команды (`/idea` → `'idea'`).
   */
  label?: string;
}

/** Контекст нормализации: идентичность бота и список доступа. */
export interface NormalizeContext {
  /** Числовой id бота (`getMe.result.id`) — часть `dedupKey`. */
  botId?: number | string;
  /** Username бота — фоллбек для `dedupKey`, если id неизвестен. */
  botUsername?: string;
  /** Список доступа `chatId/userId → роль`. */
  allowlist: Record<string, string>;
}

/** Источник событий Telegram. */
export const TELEGRAM_SOURCE = 'telegram';

/** Строит стабильный ключ дедупликации: `telegram:<bot>:<update_id>`. */
export function buildDedupKey(ctx: NormalizeContext, updateId: number): string {
  const bot = ctx.botId ?? ctx.botUsername ?? 'bot';
  return `telegram:${bot}:${updateId}`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Тип чата Telegram (`message.chat.type`) — `'private'|'group'|'supergroup'|'channel'`.
 * `undefined`, если поле отсутствует/пустое. Используется для решения «показывать
 * ли код линковки» (AD-089 claim-flow: только приватный чат).
 */
function chatTypeOf(chat: { type?: unknown } | undefined): string | undefined {
  return str(chat?.type);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Роль доступа по чату, затем по пользователю; `undefined` — недопущен. */
function resolveRole(
  allowlist: Record<string, string>,
  chatId: string | undefined,
  userId: string | undefined,
): string | undefined {
  if (chatId !== undefined && allowlist[chatId]) return allowlist[chatId];
  if (userId !== undefined && allowlist[userId]) return allowlist[userId];
  return undefined;
}

/** Извлекает текстовые метаданные вложения (kind/fileId/fileName?), не скачивая файл. */
export function extractAttachment(message: Message): TelegramAttachmentMeta | undefined {
  const photo = message.photo?.at(-1);
  if (photo) return { kind: 'photo', fileId: photo.file_id };
  const document = message.document as { file_id: string; file_name?: string } | undefined;
  if (document) {
    const fileName = str(document.file_name);
    return { kind: 'document', fileId: document.file_id, ...(fileName ? { fileName } : {}) };
  }
  if (message.video) return { kind: 'video', fileId: message.video.file_id };
  if (message.audio) return { kind: 'audio', fileId: message.audio.file_id };
  if (message.voice) return { kind: 'voice', fileId: message.voice.file_id };
  if (message.sticker) return { kind: 'sticker', fileId: message.sticker.file_id };
  return undefined;
}

function buildFrom(
  from: Message['from'] | CallbackQuery['from'],
): TelegramEventPayload['from'] {
  const id = from?.id;
  const username = str(from?.username);
  const firstName = str(from?.first_name);
  const lastName = str(from?.last_name);
  // `displayName` — читаемое имя в порядке «Ядру достаточно payload.from»:
  // `[first_name, last_name].filter(Boolean).join(' ')`.
  const displayName = [firstName, lastName].filter(Boolean).join(' ');
  return {
    id: id === undefined || id === null ? 'unknown' : String(id),
    ...(username ? { username } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(displayName ? { displayName } : {}),
    isExternal: true,
  };
}

/** Нормализует `message`/`edited_message`; `null` — событие не публикуется. */
function normalizeMessage(
  message: Message,
  ctx: NormalizeContext,
  dedupKey: string,
  edited: boolean,
): SynthEventInput | null {
  const rawChatId = message.chat?.id;
  if (rawChatId === undefined || rawChatId === null) return null;
  const chatId = String(rawChatId);

  const rawUserId = message.from?.id;
  const userId = rawUserId === undefined || rawUserId === null ? undefined : String(rawUserId);

  const role = resolveRole(ctx.allowlist, chatId, userId);
  if (!role) return null;

  const threadId = num(message.message_thread_id);
  const replyToMessageId = num(
    (message.reply_to_message as { message_id?: unknown } | undefined)?.message_id,
  );
  const text = str(message.text) ?? str(message.caption);
  const attachment = extractAttachment(message);
  const chatType = chatTypeOf(message.chat);

  const identity: EventIdentity = {
    ...(userId ? { principalId: `tg:${userId}` } : {}),
    chatKey: `chat:${TELEGRAM_SOURCE}:${chatId}`,
    ...(threadId !== undefined
      ? { threadKey: `thread:${TELEGRAM_SOURCE}:${chatId}:${threadId}` }
      : {}),
    roles: [role],
  };

  // Явные slash-команды — отдельный тип события (`type:'command'`) с меткой
  // `payload.label` для правил маршрутизации ядра.
  const command = text ? parseCommand(text) : null;
  if (command) {
    const commandPayload: TelegramEventPayload = {
      chatId,
      ...(chatType ? { chatType } : {}),
      messageId: message.message_id,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(text ? { text } : {}),
      from: buildFrom(message.from),
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
      ...(edited ? { edited: true } : {}),
      command: command.name,
      args: command.args,
      label: command.name,
    };
    return { source: TELEGRAM_SOURCE, type: 'command', payload: commandPayload, identity, dedupKey };
  }

  const payload: TelegramEventPayload = {
    chatId,
    ...(chatType ? { chatType } : {}),
    messageId: message.message_id,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(text ? { text } : {}),
    from: buildFrom(message.from),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(edited ? { edited: true } : {}),
    ...(attachment ? { attachment } : {}),
  };

  return { source: TELEGRAM_SOURCE, type: 'message', payload, identity, dedupKey };
}

/** Нормализует `callback_query`; `null` — событие не публикуется. */
function normalizeCallback(
  callback: CallbackQuery,
  ctx: NormalizeContext,
  dedupKey: string,
): SynthEventInput | null {
  // `CallbackQuery.message` — `MaybeInaccessibleMessage`; у недоступного
  // сообщения нет полей `from`/`message_thread_id`, поэтому приводим к `Message`.
  const message = callback.message as Message | undefined;
  const rawChatId = message?.chat?.id;
  const chatId = rawChatId === undefined || rawChatId === null ? undefined : String(rawChatId);

  const from = callback.from ?? message?.from;
  const rawUserId = from?.id;
  const userId = rawUserId === undefined || rawUserId === null ? undefined : String(rawUserId);

  const role = resolveRole(ctx.allowlist, chatId, userId);
  if (!role) return null;

  const threadId = num(message?.message_thread_id);
  const messageId = message?.message_id ?? 0;
  const data = str(callback.data);
  const chatType = chatTypeOf(message?.chat);

  const identity: EventIdentity = {
    ...(userId ? { principalId: `tg:${userId}` } : {}),
    ...(chatId ? { chatKey: `chat:${TELEGRAM_SOURCE}:${chatId}` } : {}),
    ...(chatId && threadId !== undefined
      ? { threadKey: `thread:${TELEGRAM_SOURCE}:${chatId}:${threadId}` }
      : {}),
    roles: [role],
  };

  const payload: TelegramEventPayload = {
    chatId: chatId ?? '',
    ...(chatType ? { chatType } : {}),
    messageId,
    ...(threadId !== undefined ? { threadId } : {}),
    // Человекочитаемый текст события: ядро (`eventToMessageText`) и UI показывают
    // `payload.text`, иначе сериализуют весь payload в JSON-блоб. `callback_data`
    // при этом сохраняется в `payload.callback` (машиночитаемость для модели).
    text: data ? `🔘 Нажата кнопка: ${data}` : '🔘 Нажата кнопка',
    from: buildFrom(from),
    callback: { ...(data ? { data } : {}), messageId },
  };

  return { source: TELEGRAM_SOURCE, type: 'callback', payload, identity, dedupKey };
}

/**
 * Преобразует апдейт Telegram в тело внешнего события Synth.
 *
 * Поддерживаются `message`, `edited_message` (обрабатывается как `message` с
 * флагом `edited`) и `callback_query`. Пользователь/чат, отсутствующие в
 * списке доступа, дают `null` (fail-closed: событие не публикуется).
 */
export function normalizeUpdate(
  update: Update,
  ctx: NormalizeContext,
): SynthEventInput | null {
  const dedupKey = buildDedupKey(ctx, update.update_id);
  if (update.callback_query) {
    return normalizeCallback(update.callback_query, ctx, dedupKey);
  }
  if (update.message) {
    return normalizeMessage(update.message, ctx, dedupKey, false);
  }
  if (update.edited_message) {
    return normalizeMessage(update.edited_message, ctx, dedupKey, true);
  }
  return null;
}
