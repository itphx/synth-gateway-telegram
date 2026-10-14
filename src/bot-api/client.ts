import type {
  InlineKeyboardMarkup,
  InputRichMessage,
  Message,
  ParseMode,
  Update,
  User,
} from '@grammyjs/types';

import { DEFAULT_REQUEST_TIMEOUT_MS, createProxyAgent, requestJson } from './transport.js';
import type { TelegramProxyAgent } from './transport.js';

const DEFAULT_BASE_URL = 'https://api.telegram.org';

/** Запас к long-poll таймауту `getUpdates`, мс. */
export const GET_UPDATES_TIMEOUT_MARGIN_MS = 15_000;

/** Опции конструктора {@link TelegramClient}. */
export interface TelegramClientOptions {
  /** Токен бота. Если не задан — клиент работает в режиме dry-run. */
  token?: string;
  /** Явное включение dry-run. По умолчанию dry-run, если нет токена. */
  dryRun?: boolean;
  /** Chat id по умолчанию для методов отправки. */
  channelId?: string;
  /** Базовый URL API (для тестов/прокси). */
  baseUrl?: string;
  /** Реализация fetch (для тестов). По умолчанию globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * URL прокси. Поддерживаются схемы `socks://`, `socks4://`, `socks5://`,
   * `socks5h://` (SOCKS) и `http://`, `https://` (CONNECT-туннель). Пустое
   * значение — прямой запрос через fetch.
   */
  proxyUrl?: string;
  /**
   * Фабрика прокси-агента (для тестов). По умолчанию {@link createProxyAgent}.
   * Агент создаётся лениво — один раз на конфигурацию — и переиспользуется.
   */
  createProxyAgentImpl?: (proxyUrl: string) => TelegramProxyAgent;
  /**
   * Таймаут обычных (не long-poll) методов, мс. По умолчанию 30000.
   * Защищает от «зависших» запросов; по истечении — ошибка
   * `telegram.request_timeout`.
   */
  requestTimeoutMs?: number;
  /**
   * Явный таймаут запроса `getUpdates`, мс. Если не задан — вычисляется как
   * `timeout * 1000 + 15000` (long-poll timeout + запас), но не меньше
   * {@link requestTimeoutMs}.
   */
  getUpdatesTimeoutMs?: number;
}

/**
 * Конверт ответа Telegram Bot API (`{ ok, result, description, error_code }`).
 * В `@grammyjs/types` такого конверта нет — это минимальный локальный тип без
 * переопределения граммовских структур; `dryRun`/прочие поля — для локальных
 * (без сети) ответов.
 */
export interface BotApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  /** Признак локального (без сети) ответа. */
  dryRun?: boolean;
  /** Дополнительные поля dry-run-ответа. */
  [key: string]: unknown;
}

/** Параметры sendMessage. */
export interface SendMessageParams {
  chatId?: string | number;
  text: string;
  parseMode?: ParseMode;
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  /** Inline-клавиатура (для кнопок ревью). */
  replyMarkup?: InlineKeyboardMarkup;
  /** id сообщения, на которое отвечаем (`reply_to_message_id`). */
  replyToMessageId?: number;
  /** id топика форума (`message_thread_id`). */
  messageThreadId?: number;
}

/**
 * Параметры sendRichMessage (Bot API 10.1 «Rich Messages», GramJS rich.d.ts).
 * Rich-контент описывается объектом {@link InputRichMessage} — ровно одно из
 * `html`/`markdown`/`blocks`. Reply — только через `reply_parameters`.
 */
export interface SendRichMessageParams {
  chatId?: string | number;
  /** Rich-контент (`{ markdown }`, `{ html }` или `{ blocks }`). */
  richMessage: InputRichMessage<never>;
  disableNotification?: boolean;
  /** Inline-клавиатура (для кнопок ревью). */
  replyMarkup?: InlineKeyboardMarkup;
  /** id сообщения, на которое отвечаем (`reply_parameters.message_id`). */
  replyToMessageId?: number;
  /** id топика форума (`message_thread_id`). */
  messageThreadId?: number;
}

/**
 * Параметры sendRichMessageDraft — стриминг **черновика** rich-сообщения.
 * Черновик эфемерен (~30 c, исчезает сам) и доступен **только в приватных
 * чатах**; чтобы ответ сохранился, после генерации нужно вызвать
 * `sendRichMessage`. `draftId` ≠ 0 и стабилен для одного потока — правки с тем
 * же id анимируются.
 */
export interface SendRichMessageDraftParams {
  /** Только приватный чат (числовой id). */
  chatId: number;
  /** Стабильный ненулевой id черновика потока. */
  draftId: number;
  richMessage: InputRichMessage<never>;
  /** id топика форума (`message_thread_id`). */
  messageThreadId?: number;
  /** Показать кнопку остановки генерации. */
  canStop?: boolean;
  /** Оставить черновик в чате при остановке. */
  keepOnStop?: boolean;
}

/**
 * Тип действия `sendChatAction` (по документации Bot API). В `@grammyjs/types`
 * отдельного алиаса нет — тип локальный (минимальный конверт, как
 * {@link BotApiResponse}).
 */
export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note';

/** Параметры sendChatAction. */
export interface SendChatActionParams {
  chatId?: string | number;
  action: ChatAction;
  /** id топика форума (`message_thread_id`). */
  messageThreadId?: number;
}

/** Параметры getUpdates (long-polling). */
export interface GetUpdatesParams {
  /** Смещение: подтверждает апдейты с `update_id < offset`. */
  offset?: number;
  /** Таймаут long-polling в секундах. */
  timeout?: number;
  /** Максимум апдейтов за проход. */
  limit?: number;
  /** Типы апдейтов, которые нужно получать. */
  allowedUpdates?: string[];
  /** Внешний сигнал прерывания (например, остановка поллера). */
  signal?: AbortSignal;
}

/** Параметры editMessageText. */
export interface EditMessageTextParams {
  chatId?: string | number;
  messageId: number;
  /** Новый текст (`text` не задаётся при правке через `richMessage`). */
  text?: string;
  /** Новый rich-контент (`rich_message`); альтернатива `text`. */
  richMessage?: InputRichMessage<never>;
  parseMode?: ParseMode;
  disableWebPagePreview?: boolean;
  /**
   * Новая inline-клавиатура. Пустая разметка (`{ inline_keyboard: [] }`) снимает
   * клавиатуру.
   */
  replyMarkup?: InlineKeyboardMarkup;
}

/** Параметры deleteMessage. */
export interface DeleteMessageParams {
  chatId?: string | number;
  messageId: number;
}

/** Параметры answerCallbackQuery. */
export interface AnswerCallbackQueryParams {
  /** Идентификатор callback-запроса (из апдейта `callback_query.id`). */
  callbackQueryId: string;
  /** Текст-подтверждение (до 200 символов). */
  text?: string;
  /** Показать текст как модальное уведомление вместо всплывающей подсказки. */
  showAlert?: boolean;
}

/** Параметры editMessageReplyMarkup (правка/снятие клавиатуры). */
export interface EditMessageReplyMarkupParams {
  chatId?: string | number;
  messageId: number;
  /**
   * Новая разметка. Если не задана — клавиатура снимается (шлётся пустая
   * `inline_keyboard`).
   */
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Минимальный клиент Telegram Bot API на `globalThis.fetch` (Node 22+),
 * без внешних зависимостей.
 *
 * Если токен не задан, клиент переходит в режим **dry-run**: методы не делают
 * сетевых вызовов и возвращают `{ ok: true, dryRun: true, ... }`.
 */
export class TelegramClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly proxyUrl?: string;
  private readonly createAgent: (proxyUrl: string) => TelegramProxyAgent;
  private readonly requestTimeoutMs: number;
  private readonly getUpdatesTimeoutMs?: number;
  /**
   * Прокси-агент, созданный лениво и переиспользуемый между запросами
   * (keep-alive/CONNECT-туннели не рвутся). `undefined` — прямой путь через fetch.
   */
  private proxyAgent?: TelegramProxyAgent;

  /** Режим без сетевых вызовов. */
  readonly dryRun: boolean;
  /** Chat id по умолчанию. */
  readonly channelId?: string;

  constructor(options: TelegramClientOptions = {}) {
    this.token = options.token?.trim() ? options.token.trim() : undefined;
    this.dryRun = options.dryRun ?? !this.token;
    this.channelId = options.channelId;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.proxyUrl = options.proxyUrl;
    this.createAgent = options.createProxyAgentImpl ?? createProxyAgent;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.getUpdatesTimeoutMs = options.getUpdatesTimeoutMs;
  }

  /**
   * Освобождает прокси-агент (keep-alive/CONNECT-соединения). Идемпотентно;
   * без прокси — no-op. Вызывать при остановке клиента/процесса.
   */
  close(): void {
    try {
      this.proxyAgent?.destroy();
    } catch {
      /* noop */
    }
    this.proxyAgent = undefined;
  }

  /** Лениво создаёт прокси-агент один раз на конфигурацию. */
  private resolveProxyAgent(): TelegramProxyAgent | undefined {
    const proxyUrl = this.proxyUrl?.trim();
    if (!proxyUrl) return undefined;
    if (!this.proxyAgent) {
      this.proxyAgent = this.createAgent(proxyUrl);
    }
    return this.proxyAgent;
  }

  /** Отправляет сообщение в канал/чат. */
  async sendMessage(params: SendMessageParams): Promise<BotApiResponse<Message>> {
    const chatId = this.resolveChatId(params.chatId);
    const payload: Record<string, unknown> = { chat_id: chatId, text: params.text };
    if (params.parseMode) payload.parse_mode = params.parseMode;
    if (params.disableWebPagePreview) payload.link_preview_options = { is_disabled: true };
    if (params.disableNotification) payload.disable_notification = true;
    if (params.replyMarkup) payload.reply_markup = params.replyMarkup;
    if (params.replyToMessageId !== undefined) payload.reply_to_message_id = params.replyToMessageId;
    if (params.messageThreadId !== undefined) payload.message_thread_id = params.messageThreadId;
    return this.call<Message>('sendMessage', payload);
  }

  /**
   * Отправляет rich-сообщение (Bot API 10.1): нативные заголовки/списки/таблицы.
   * Reply — через `reply_parameters` (не `reply_to_message_id`). Лимиты: до
   * 32768 символов, 500 блоков, 20 колонок в таблице.
   */
  async sendRichMessage(params: SendRichMessageParams): Promise<BotApiResponse<Message>> {
    const chatId = this.resolveChatId(params.chatId);
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: params.richMessage,
    };
    if (params.disableNotification) payload.disable_notification = true;
    if (params.replyMarkup) payload.reply_markup = params.replyMarkup;
    if (params.replyToMessageId !== undefined) {
      payload.reply_parameters = { message_id: params.replyToMessageId };
    }
    if (params.messageThreadId !== undefined) payload.message_thread_id = params.messageThreadId;
    return this.call<Message>('sendRichMessage', payload);
  }

  /**
   * Стримит черновик rich-сообщения (эфемерный ~30 c, только приватные чаты).
   * Правки с тем же `draftId` анимируются. Чтобы ответ сохранился — по
   * завершении вызвать {@link sendRichMessage}.
   */
  async sendRichMessageDraft(
    params: SendRichMessageDraftParams,
  ): Promise<BotApiResponse<boolean>> {
    const payload: Record<string, unknown> = {
      chat_id: params.chatId,
      draft_id: params.draftId,
      rich_message: params.richMessage,
    };
    if (params.messageThreadId !== undefined) payload.message_thread_id = params.messageThreadId;
    if (params.canStop !== undefined) payload.can_stop = params.canStop;
    if (params.keepOnStop !== undefined) payload.keep_on_stop = params.keepOnStop;
    return this.call<boolean>('sendRichMessageDraft', payload);
  }

  /**
   * Сообщает клиенту статус («Печатает…» и т. п.). Статус держится ~5 секунд
   * либо сбрасывается приходящим сообщением — вызывать повторно, пока действие
   * продолжается.
   */
  async sendChatAction(params: SendChatActionParams): Promise<BotApiResponse<boolean>> {
    const chatId = this.resolveChatId(params.chatId);
    const payload: Record<string, unknown> = { chat_id: chatId, action: params.action };
    if (params.messageThreadId !== undefined) payload.message_thread_id = params.messageThreadId;
    return this.call<boolean>('sendChatAction', payload);
  }

  /** Редактирует текст ранее отправленного сообщения (или его rich-контент). */
  async editMessageText(params: EditMessageTextParams): Promise<BotApiResponse<Message>> {
    const chatId = this.resolveChatId(params.chatId);
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: params.messageId,
    };
    if (params.richMessage) payload.rich_message = params.richMessage;
    if (params.text !== undefined) payload.text = params.text;
    if (params.parseMode) payload.parse_mode = params.parseMode;
    if (params.disableWebPagePreview) payload.link_preview_options = { is_disabled: true };
    if (params.replyMarkup) payload.reply_markup = params.replyMarkup;
    return this.call<Message>('editMessageText', payload);
  }

  /**
   * Правка только клавиатуры сообщения. Если `replyMarkup` не задана — снимает
   * клавиатуру (пустая `inline_keyboard`).
   */
  async editMessageReplyMarkup(
    params: EditMessageReplyMarkupParams,
  ): Promise<BotApiResponse<Message>> {
    const chatId = this.resolveChatId(params.chatId);
    return this.call<Message>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: params.messageId,
      reply_markup: params.replyMarkup ?? { inline_keyboard: [] },
    });
  }

  /** Отвечает на callback-запрос inline-кнопки (снимает «часики» у клиента). */
  async answerCallbackQuery(params: AnswerCallbackQueryParams): Promise<BotApiResponse<boolean>> {
    const payload: Record<string, unknown> = { callback_query_id: params.callbackQueryId };
    if (params.text !== undefined) payload.text = params.text;
    if (params.showAlert !== undefined) payload.show_alert = params.showAlert;
    return this.call<boolean>('answerCallbackQuery', payload);
  }

  /** Удаляет сообщение. */
  async deleteMessage(params: DeleteMessageParams): Promise<BotApiResponse<boolean>> {
    const chatId = this.resolveChatId(params.chatId);
    return this.call<boolean>('deleteMessage', {
      chat_id: chatId,
      message_id: params.messageId,
    });
  }

  /** Сведения о боте — проверка подключения. */
  async getMe(): Promise<BotApiResponse<User>> {
    if (this.isDryRun()) {
      return {
        ok: true,
        dryRun: true,
        result: { id: 0, is_bot: true, first_name: 'dry-run' },
      };
    }
    return this.call<User>('getMe', {});
  }

  /**
   * Получает апдейты методом long-polling. В dry-run возвращает пустой список
   * без сетевого вызова (бот делает один проход и выходит).
   */
  async getUpdates(params: GetUpdatesParams = {}): Promise<BotApiResponse<Update[]>> {
    if (this.isDryRun()) {
      return { ok: true, dryRun: true, result: [] };
    }
    const payload: Record<string, unknown> = {};
    if (params.offset !== undefined) payload.offset = params.offset;
    if (params.timeout !== undefined) payload.timeout = params.timeout;
    if (params.limit !== undefined) payload.limit = params.limit;
    if (params.allowedUpdates) payload.allowed_updates = params.allowedUpdates;
    const pollMs = (params.timeout ?? 0) * 1000 + GET_UPDATES_TIMEOUT_MARGIN_MS;
    const timeoutMs = this.getUpdatesTimeoutMs ?? Math.max(this.requestTimeoutMs, pollMs);
    return this.call<Update[]>('getUpdates', payload, {
      timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  private isDryRun(): boolean {
    return this.dryRun || !this.token;
  }

  private resolveChatId(explicit?: string | number): string | number {
    const chatId = explicit ?? this.channelId;
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('telegram.chat_id_missing');
    }
    return chatId;
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    requestOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BotApiResponse<T>> {
    if (this.isDryRun()) {
      return { ok: true, dryRun: true, method, ...payload };
    }
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const timeoutMs = requestOptions.timeoutMs ?? this.requestTimeoutMs;
    const agent = this.resolveProxyAgent();
    const response = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      fetchImpl: this.fetchImpl,
      timeoutMs,
      ...(agent ? { agent } : {}),
      ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
    });
    return response.json as BotApiResponse<T>;
  }
}
