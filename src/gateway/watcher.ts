import type { BotApiResponse, TelegramClient } from '../bot-api/index.js';

import type { BearerProvider } from './auth.js';
import type { ParseMode } from './config.js';
import type { GatewayHealth } from './health.js';
import type { GatewayStore, SessionRoute } from './store.js';

/** Максимальная длина сообщения Telegram. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Интервал повтора статуса «Печатает…», мс (Telegram держит статус ~5 c). */
export const TYPING_INTERVAL_MS = 4000;

/** Простой сессии, после которого индикатор «Печатает…» гасится сам, мс. */
export const TYPING_MAX_IDLE_MS = 60_000;

/** Минимальный интервал между правками live-сообщения, мс. */
export const EDIT_THROTTLE_MS = 1500;

/** Метка, добавляемая к частичному ответу при остановке (`/stop`). */
export const STOPPED_MARK = '⏹ Остановлено';

/** Максимум запоминаемых завершённых `stream_id` (защита от допоздних чанков). */
const FINALIZED_STREAMS_LIMIT = 500;

/**
 * Состояние активного стрима сессии (live-сообщение Telegram + индикатор
 * «Печатает…»). `text` — накопленный контент (reasoning не накапливается и в
 * Telegram не стримится), `rendered` — последний отправленный/отредактированный
 * текст (чтобы не ловить 400 `message is not modified`).
 */
interface LiveStream {
  streamId?: string;
  /** id редактируемого live-сообщения Telegram (появляется с первым контентом). */
  messageId?: number;
  /** Накопленный контент (без reasoning). */
  text: string;
  /** Служебная приписка (например, «↻ повтор 2/3…»). */
  note?: string;
  /** Время последней правки live-сообщения (или её отложенного повтора при 429). */
  lastEditAt: number;
  /** Время последнего события сессии (для watchdog индикатора «Печатает…»). */
  lastActivityAt: number;
  /** Последний отправленный текст; правка не шлётся, если текст не изменился. */
  rendered?: string;
  typingTimer?: ReturnType<typeof setInterval>;
  finalized: boolean;
}

/** Событие глобального SSE-потока `GET /events` (конверт ядра). */
export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
  sessionId?: string;
  timestamp?: string;
}

/** Опции {@link AgentWatcher}. */
export interface WatcherOptions {
  /** Базовый URL API v2. */
  baseUrl: string;
  /** Служебный Bearer-ключ (standalone/dev; без `bearer`). */
  apiKey?: string;
  /** Провайдер Bearer-токена (OIDC/стат. ключ); при задании приоритетнее `apiKey`. */
  bearer?: BearerProvider;
  client: TelegramClient;
  store: GatewayStore;
  parseMode?: ParseMode;
  /** Реализация fetch (для тестов). */
  fetchImpl?: typeof fetch;
  /** Начальная пауза переподключения, мс (по умолчанию 1000). */
  backoffMs?: number;
  /** Максимальная пауза переподключения, мс (по умолчанию 30000). */
  maxBackoffMs?: number;
  health?: GatewayHealth;
  log?: (message: string) => void;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Разбирает буфер SSE на полезные нагрузки `data:`.
 *
 * Блоки разделяются пустой строкой; комментарии-keepalive (`:keepalive`)
 * игнорируются. Возвращает разобранные payload'ы и незавершённый «хвост» буфера.
 */
export function parseSseData(buffer: string): { payloads: string[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const payloads: string[] = [];
  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());
    if (dataLines.length > 0) payloads.push(dataLines.join('\n'));
  }
  return { payloads, rest };
}

/** Режет текст на сообщения не длиннее `limit`, предпочитая границы строк. */
export function chunkText(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Экранирует спецсимволы HTML для `parse_mode: 'HTML'`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Режет **уже экранированный** для `parse_mode: 'HTML'` текст на сообщения не
 * длиннее `limit`. В отличие от {@link chunkText}, учитывает раздувание текста
 * HTML-сущностями: граница выбирается так, чтобы не разорвать сущность `&…;`.
 */
export function chunkHtmlText(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Предпочитаем границу строки, затем пробел, иначе — сам лимит.
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) {
      const space = rest.lastIndexOf(' ', limit);
      cut = space > 0 ? space + 1 : limit;
    }
    // Не рвать HTML-сущность `&…;`: отступаем к её началу.
    const amp = rest.lastIndexOf('&', cut - 1);
    if (amp >= 0 && rest.indexOf(';', amp) >= cut) cut = amp > 0 ? amp : cut;
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Watcher ответов агента: слушает глобальный SSE `GET /events` и доставляет
 * ответы в чаты, привязанные к сессиям. Пока агент генерирует ответ, в чате
 * держится индикатор «Печатает…» и стримится live-сообщение (накопленный
 * контент, троттлинг правок); финал приходит из `stream.done` (фоллбек —
 * `message.added`), отмена — `stream.cancelled`, сбой — `stream.error`.
 * Переподключается с backoff; дедуп исходящих — персистентный
 * (`GatewayStore.sent`).
 */
export class AgentWatcher {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly bearer?: BearerProvider;
  private readonly client: TelegramClient;
  private readonly store: GatewayStore;
  private readonly parseMode: ParseMode;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly health?: GatewayHealth;
  private readonly log: (message: string) => void;
  private controller?: AbortController;
  private stopped = false;
  /** Активные стримы по сессиям (live-сообщение + индикатор). */
  private readonly live = new Map<string, LiveStream>();
  /** Завершённые `stream_id` — допоздние чанки после `done`/`cancelled` игнорируются. */
  private readonly finalizedStreams = new Set<string>();

  constructor(options: WatcherOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.bearer = options.bearer;
    this.client = options.client;
    this.store = options.store;
    this.parseMode = options.parseMode ?? 'plain';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.backoffMs = options.backoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.health = options.health;
    this.log = options.log ?? (() => {});
  }

  /** Останавливает watcher (прерывает SSE-соединение и гасит индикаторы). */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.resetLiveState();
  }

  /**
   * Гасит все активные индикаторы и сбрасывает live-состояния сессий. Вызывается
   * при обрыве/переподключении SSE: события, потерянные между соединениями, не
   * восстановить, поэтому финал доставится как новое сообщение (дедуп-ключи не
   * выставлены), а индикатор не остаётся висеть.
   */
  private resetLiveState(): void {
    for (const live of this.live.values()) this.clearTyping(live);
    this.live.clear();
  }

  /** Цикл подключения к SSE с переподключением и backoff. */
  async run(): Promise<void> {
    if (this.client.dryRun) {
      this.log('[gateway] watcher: dry-run — доставка ответов отключена');
      return;
    }
    let backoff = this.backoffMs;
    while (!this.stopped) {
      try {
        await this.connect();
        backoff = this.backoffMs;
      } catch (error) {
        this.health?.setWatcher('down');
        this.resetLiveState();
        if (this.stopped) break;
        this.log(`[gateway] watcher ошибка: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.stopped) break;
      await delay(backoff);
      backoff = Math.min(backoff * 2, this.maxBackoffMs);
    }
  }

  private async connect(): Promise<void> {
    // Обрыв/переподключение: события между соединениями потеряны — сбрасываем
    // live-состояния и гасим индикаторы, чтобы они не зависли.
    this.resetLiveState();
    const controller = new AbortController();
    this.controller = controller;

    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const token = this.bearer ? await this.bearer.getBearer() : this.apiKey;
    if (token) headers.authorization = `Bearer ${token}`;

    const url = `${this.baseUrl}/events`;
    let response = await this.fetchImpl(url, { headers, signal: controller.signal });

    // 401 — токен истёк/недействителен: обновляем и повторяем один раз.
    if (response.status === 401 && this.bearer) {
      await response.body?.cancel().catch(() => undefined);
      try {
        await this.bearer.refreshBearer();
      } catch {
        /* ошибку получения токена отразит health */
      }
      const retryToken = await this.bearer.getBearer().catch(() => undefined);
      const retryHeaders: Record<string, string> = { ...headers };
      if (retryToken) retryHeaders.authorization = `Bearer ${retryToken}`;
      else delete retryHeaders.authorization;
      response = await this.fetchImpl(url, { headers: retryHeaders, signal: controller.signal });
    }

    if (!response.ok || !response.body) {
      throw new Error(`SSE ${response.status} ${response.statusText}`);
    }
    this.health?.setWatcher('up');
    this.log('[gateway] watcher подключён к SSE /events');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { payloads, rest } = parseSseData(buffer);
        buffer = rest;
        for (const payload of payloads) {
          const parsed = safeParse(payload);
          if (parsed) await this.handleEvent(parsed);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* уже освобождён */
      }
      this.health?.setWatcher('down');
      this.resetLiveState();
    }
  }

  /** Обрабатывает одно SSE-событие (экспортировано для тестов). */
  async handleEvent(event: SseEvent): Promise<void> {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const route = await this.store.getSessionRoute(sessionId);
    if (!route) return;

    const active = this.live.get(sessionId);
    if (active) active.lastActivityAt = Date.now();

    switch (event.type) {
      case 'stream.start':
        this.startTyping(sessionId, route, str(event.data.stream_id));
        return;
      case 'stream.chunk':
        await this.onStreamChunk(sessionId, route, event.data);
        return;
      case 'stream.retry':
        await this.onStreamRetry(sessionId, route, event.data);
        return;
      case 'stream.cancelled':
        await this.onStreamCancelled(sessionId, route, event);
        return;
      case 'stream.error':
        await this.onStreamError(sessionId, route, event.data);
        return;
      case 'stream.done':
        await this.onStreamDone(sessionId, route, event);
        return;
      case 'message.added':
        // Фоллбек: без стрима ответ приходит как `message.added` (content обрезан ядром).
        await this.onMessageAdded(sessionId, route, event.data);
        return;
      default:
        return;
    }
  }

  /** `stream.chunk` — накопление контента и правка live-сообщения. */
  private async onStreamChunk(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    const streamId = str(data.stream_id);
    if (streamId !== undefined && this.finalizedStreams.has(streamId)) return;
    const live = this.ensureLive(sessionId, streamId);
    if (live.finalized) return;
    this.startTypingFor(route, live);

    // `content` — дельта контента; `is_final`-чанк приходит с пустым `content`.
    const delta = str(data.content);
    if (delta) live.text += delta;
    // reasoning в Telegram не стримим: пока контента нет — только «Печатает…».
    if (live.text.length === 0) return;
    await this.flushLive(route, live, false);
  }

  /** `stream.retry` — приписка «↻ повтор N/MAX…» в live-сообщение (best-effort). */
  private async onStreamRetry(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live || live.finalized) return;
    const attempt = num(data.attempt);
    if (attempt === undefined) return;
    const max = num(data.max_retries);
    live.note = `↻ повтор ${attempt}${max !== undefined ? `/${max}` : ''}…`;
    if (live.messageId === undefined || live.text.length === 0) return;
    await this.flushLive(route, live, true);
  }

  /** `stream.cancelled` — финализация частичным текстом с пометкой об остановке. */
  private async onStreamCancelled(
    sessionId: string,
    route: SessionRoute,
    event: SseEvent,
  ): Promise<void> {
    const live = this.live.get(sessionId);
    const streamId =
      str(event.data.stream_id) ?? live?.streamId ?? `${sessionId}:${event.timestamp ?? ''}`;
    const key = `stream:${streamId}`;
    if (await this.store.hasSent(key)) {
      this.finishLive(sessionId, live);
      return;
    }
    await this.store.markSent(key);
    this.markFinalized(streamId);
    this.finishLive(sessionId, live);
    const content = str(event.data.content) ?? live?.text ?? '';
    await this.finalize(route, live, content, STOPPED_MARK);
  }

  /** `stream.error` — правка live-сообщения (если есть) либо новое уведомление. */
  private async onStreamError(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    const live = this.live.get(sessionId);
    const streamId = str(data.stream_id) ?? live?.streamId ?? `${sessionId}:error`;
    const key = `error:${streamId}`;
    if (await this.store.hasSent(key)) {
      this.finishLive(sessionId, live);
      return;
    }
    await this.store.markSent(key);
    this.markFinalized(streamId);
    this.finishLive(sessionId, live);

    const message = str(data.error) ?? 'Неизвестная ошибка';
    const raw = `⚠️ Ошибка агента: ${message}`;
    if (live?.messageId !== undefined) {
      const edited = await this.safeEdit(route, live.messageId, this.renderText(raw));
      if (edited) {
        await this.rememberOutbound(route, live.messageId);
        return;
      }
    }
    await this.deliver(route, raw);
  }

  /** `stream.done` — финал: live-сообщение редактируется полным контентом. */
  private async onStreamDone(
    sessionId: string,
    route: SessionRoute,
    event: SseEvent,
  ): Promise<void> {
    const live = this.live.get(sessionId);
    const streamId =
      str(event.data.stream_id) ?? live?.streamId ?? `${sessionId}:${event.timestamp ?? ''}`;
    const content = str(event.data.content) ?? live?.text ?? '';
    // Нечего доставлять (нет контента и live-сообщения не было) — как раньше,
    // не помечаем stream как отправленный; индикатор гасим.
    if (!content && live?.messageId === undefined) {
      this.finishLive(sessionId, live);
      return;
    }
    const messageIndex = num(event.data.message_index);
    if (
      messageIndex !== undefined &&
      (await this.store.hasSent(`message:${sessionId}:${messageIndex}`))
    ) {
      this.finishLive(sessionId, live);
      return;
    }
    const key = `stream:${streamId}`;
    if (await this.store.hasSent(key)) {
      this.finishLive(sessionId, live);
      return;
    }
    await this.store.markSent(key);
    if (messageIndex !== undefined) await this.store.markSent(`message:${sessionId}:${messageIndex}`);
    this.markFinalized(streamId);
    this.finishLive(sessionId, live);
    await this.finalize(route, live, content);
  }

  /** Фоллбек-доставка `message.added` (assistant) без стрима. */
  private async onMessageAdded(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (str(data.role)?.toLowerCase() !== 'assistant') return;
    const content = str(data.content);
    if (!content) return;
    const messageIndex = num(data.message_index);
    const key =
      messageIndex !== undefined
        ? `message:${sessionId}:${messageIndex}`
        : `message-content:${sessionId}:${str(data.stream_id) ?? content.length}`;
    if (await this.store.hasSent(key)) return;
    await this.store.markSent(key);
    await this.deliver(route, content);
  }

  /** Стартует индикатор «Печатает…» для сессии (если ещё не запущен). */
  private startTyping(sessionId: string, route: SessionRoute, streamId?: string): void {
    const live = this.ensureLive(sessionId, streamId);
    this.startTypingFor(route, live);
  }

  private startTypingFor(route: SessionRoute, live: LiveStream): void {
    if (live.finalized || live.typingTimer) return;
    live.lastActivityAt = Date.now();
    void this.sendTyping(route);
    const timer = setInterval(() => {
      // Watchdog: без событий по сессии индикатор «Печатает…» не висит вечно.
      if (Date.now() - live.lastActivityAt > TYPING_MAX_IDLE_MS) {
        this.clearTyping(live);
        return;
      }
      void this.sendTyping(route);
    }, TYPING_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    live.typingTimer = timer;
  }

  /** Разовая отправка статуса «печатает…» (ошибки Telegram не роняют watcher). */
  private async sendTyping(route: SessionRoute): Promise<void> {
    try {
      await this.client.sendChatAction({
        chatId: route.chatId,
        action: 'typing',
        ...(route.threadId !== undefined ? { messageThreadId: route.threadId } : {}),
      });
    } catch (error) {
      this.log(`[gateway] watcher: не удалось отправить статус «печатает»: ${errorMessage(error)}`);
    }
  }

  /** Гасит таймер индикатора. */
  private clearTyping(live: LiveStream): void {
    if (!live.typingTimer) return;
    clearInterval(live.typingTimer);
    live.typingTimer = undefined;
  }

  /** Возвращает (при необходимости создаёт) состояние стрима сессии. */
  private ensureLive(sessionId: string, streamId?: string): LiveStream {
    let live = this.live.get(sessionId);
    if (live && streamId !== undefined && live.streamId !== undefined && live.streamId !== streamId) {
      // Новый стрим в той же сессии — предыдущий больше не актуален.
      this.clearTyping(live);
      live = undefined;
    }
    if (!live) {
      live = {
        text: '',
        lastEditAt: 0,
        lastActivityAt: Date.now(),
        finalized: false,
        ...(streamId !== undefined ? { streamId } : {}),
      };
      this.live.set(sessionId, live);
    } else if (streamId !== undefined && live.streamId === undefined) {
      live.streamId = streamId;
    }
    return live;
  }

  /** Останавливает индикатор и убирает состояние стрима. */
  private finishLive(sessionId: string, live: LiveStream | undefined): void {
    if (live) {
      live.finalized = true;
      this.clearTyping(live);
    }
    this.live.delete(sessionId);
  }

  private markFinalized(streamId: string): void {
    this.finalizedStreams.add(streamId);
    if (this.finalizedStreams.size > FINALIZED_STREAMS_LIMIT) {
      const oldest = this.finalizedStreams.values().next().value;
      if (oldest !== undefined) this.finalizedStreams.delete(oldest);
    }
  }

  /**
   * Отправляет live-сообщение при первом контенте либо правит его с
   * троттлингом. Правка не шлётся, если текст не изменился (иначе Telegram
   * отвечает 400 `message is not modified`).
   */
  private async flushLive(route: SessionRoute, live: LiveStream, force: boolean): Promise<void> {
    const body = this.renderLive(live);
    if (body === live.rendered) return;
    const now = Date.now();

    if (live.messageId === undefined) {
      const id = await this.sendText(route, body);
      if (id === undefined) return;
      live.messageId = id;
      live.lastEditAt = now;
      live.rendered = body;
      await this.rememberOutbound(route, id);
      return;
    }

    if (!force && now - live.lastEditAt < EDIT_THROTTLE_MS) return;
    const result = await this.editText(route, live.messageId, body);
    if (result.ok) {
      live.lastEditAt = now;
      live.rendered = body;
      return;
    }
    // 429 — уважаем `retry_after`: не спамим правками до истечения окна.
    if (result.retryAfterMs !== undefined) live.lastEditAt = now + result.retryAfterMs;
  }

  /**
   * Финал стрима: live-сообщение редактируется первым чанком, остальные
   * досылаются новыми сообщениями; без live — обычная доставка с чанкингом.
   */
  private async finalize(
    route: SessionRoute,
    live: LiveStream | undefined,
    text: string,
    marker?: string,
  ): Promise<void> {
    const body = marker ? (text ? `${text}\n\n${marker}` : marker) : text;
    if (!body) return;
    const chunks = this.renderChunks(body);
    if (live?.messageId === undefined) {
      await this.deliver(route, body);
      return;
    }

    const first = chunks[0] ?? '';
    await this.safeEdit(route, live.messageId, first);
    live.rendered = first;
    let lastMessageId = live.messageId;
    for (const chunk of chunks.slice(1)) {
      const id = await this.sendText(route, chunk);
      if (id !== undefined) lastMessageId = id;
    }
    await this.rememberOutbound(route, lastMessageId);
  }

  /** Отправляет текст в чат маршрута (с чанкингом) и обновляет состояние. */
  private async deliver(route: SessionRoute, text: string): Promise<void> {
    let lastMessageId: number | undefined;
    for (const chunk of this.renderChunks(text)) {
      const id = await this.sendText(route, chunk);
      if (id !== undefined) lastMessageId = id;
    }
    await this.rememberOutbound(route, lastMessageId);
  }

  /** Отправляет одно сообщение; ошибки Telegram логируются и не бросаются. */
  private async sendText(route: SessionRoute, body: string): Promise<number | undefined> {
    try {
      const response = await this.client.sendMessage({
        chatId: route.chatId,
        text: body,
        ...(this.parseMode === 'html' ? { parseMode: 'HTML' as const } : {}),
        ...(route.threadId !== undefined ? { messageThreadId: route.threadId } : {}),
        ...(route.lastInboundMessageId !== undefined
          ? { replyToMessageId: route.lastInboundMessageId }
          : {}),
      });
      if (response.ok === false) {
        this.log(`[gateway] watcher: Telegram отклонил sendMessage: ${describeBotError(response)}`);
        return undefined;
      }
      return response.result?.message_id;
    } catch (error) {
      this.log(`[gateway] watcher: ошибка sendMessage: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Правка сообщения с разбором исхода (ok / retry_after при 429). */
  private async editText(
    route: SessionRoute,
    messageId: number,
    body: string,
  ): Promise<{ ok: boolean; retryAfterMs?: number }> {
    try {
      const response = await this.client.editMessageText({
        chatId: route.chatId,
        messageId,
        text: body,
        ...(this.parseMode === 'html' ? { parseMode: 'HTML' as const } : {}),
      });
      if (response.ok === false) {
        this.log(
          `[gateway] watcher: Telegram отклонил editMessageText (${messageId}): ${describeBotError(response)}`,
        );
        const retryAfter = retryAfterMs(response);
        return { ok: false, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
      }
      return { ok: true };
    } catch (error) {
      this.log(`[gateway] watcher: ошибка editMessageText (${messageId}): ${errorMessage(error)}`);
      return { ok: false };
    }
  }

  /** Правка без разбора исхода — для финала (ошибки логируются внутри). */
  private async safeEdit(route: SessionRoute, messageId: number, body: string): Promise<boolean> {
    const result = await this.editText(route, messageId, body);
    return result.ok;
  }

  /** Текст live-сообщения: накопленный контент + приписка, с обрезкой по лимиту. */
  private renderLive(live: LiveStream): string {
    const text = live.note ? `${live.text}\n\n${live.note}` : live.text;
    return this.renderText(text);
  }

  /**
   * Готовые к отправке чанки. Для `parse_mode: 'html'` экранирование делается
   * **до** нарезки, чтобы раздувание сущностями не приводило к потере контента;
   * для `plain` поведение прежнее.
   */
  private renderChunks(text: string): string[] {
    if (this.parseMode !== 'html') return chunkText(text);
    return chunkHtmlText(escapeHtml(text));
  }

  /**
   * Готовит текст к отправке: экранирование HTML (при `parse_mode: html`) и
   * обрезка до лимита Telegram с многоточием. Обрезка не рвёт HTML-сущность.
   */
  private renderText(text: string): string {
    const body = this.parseMode === 'html' ? escapeHtml(text) : text;
    if (body.length <= TELEGRAM_MESSAGE_LIMIT) return body;
    const cut = body.slice(0, TELEGRAM_MESSAGE_LIMIT - 1).replace(/&[a-zA-Z#0-9]*$/, '');
    return `${cut}…`;
  }

  /** Обновляет `lastOutboundMessageId` в привязке чата. */
  private async rememberOutbound(route: SessionRoute, messageId: number | undefined): Promise<void> {
    if (messageId === undefined) return;
    const state = await this.store.getChatSession(route.chatKey);
    if (!state) return;
    await this.store.setChatSession(route.chatKey, {
      ...state,
      lastOutboundMessageId: messageId,
      updatedAt: new Date().toISOString(),
    });
  }
}

/** Признак `retry_after` (сек) из ответа Telegram при 429. */
function retryAfterMs(response: BotApiResponse<unknown>): number | undefined {
  const parameters = response.parameters as { retry_after?: unknown } | undefined;
  const retryAfter = parameters?.retry_after;
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return undefined;
  }
  return retryAfter * 1000;
}

/** Человекочитаемое описание ошибки Telegram-ответа (без секретов). */
function describeBotError(response: BotApiResponse<unknown>): string {
  const description = typeof response.description === 'string' ? response.description : undefined;
  const code = response.error_code;
  return description ?? (typeof code === 'number' ? `error_code=${code}` : 'unknown');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeParse(payload: string): SseEvent | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as SseEvent;
  } catch {
    return null;
  }
}
