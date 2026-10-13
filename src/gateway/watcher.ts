import type { TelegramClient } from '../bot-api/index.js';

import type { BearerProvider } from './auth.js';
import type { ParseMode } from './config.js';
import type { GatewayHealth } from './health.js';
import type { GatewayStore, SessionRoute } from './store.js';

/** Максимальная длина сообщения Telegram. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

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
 * Watcher ответов агента: слушает глобальный SSE `GET /events` и доставляет
 * ответы (`stream.done`, фоллбек `message.added`, `stream.error`) в чаты,
 * привязанные к сессиям. Переподключается с backoff; дедуп исходящих —
 * персистентный (`GatewayStore.sent`).
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

  /** Останавливает watcher (прерывает активное SSE-соединение). */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
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
        if (this.stopped) break;
        this.log(`[gateway] watcher ошибка: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.stopped) break;
      await delay(backoff);
      backoff = Math.min(backoff * 2, this.maxBackoffMs);
    }
  }

  private async connect(): Promise<void> {
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
    }
  }

  /** Обрабатывает одно SSE-событие (экспортировано для тестов). */
  async handleEvent(event: SseEvent): Promise<void> {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const route = await this.store.getSessionRoute(sessionId);
    if (!route) return;

    if (event.type === 'stream.error') {
      const streamId = str(event.data.stream_id) ?? `${sessionId}:error`;
      const key = `error:${streamId}`;
      if (await this.store.hasSent(key)) return;
      await this.store.markSent(key);
      const message = str(event.data.error) ?? 'Неизвестная ошибка';
      await this.deliver(route, `⚠️ Ошибка агента: ${message}`);
      return;
    }

    if (event.type === 'stream.done') {
      const content = str(event.data.content);
      if (!content) return;
      const streamId = str(event.data.stream_id) ?? `${sessionId}:${event.timestamp ?? ''}`;
      const messageIndex = num(event.data.message_index);
      if (messageIndex !== undefined && (await this.store.hasSent(`message:${sessionId}:${messageIndex}`))) {
        return;
      }
      const key = `stream:${streamId}`;
      if (await this.store.hasSent(key)) return;
      await this.store.markSent(key);
      if (messageIndex !== undefined) await this.store.markSent(`message:${sessionId}:${messageIndex}`);
      await this.deliver(route, content);
      return;
    }

    // Фоллбек: без стрима ответ приходит как `message.added` (content обрезан ядром).
    if (event.type === 'message.added') {
      if (str(event.data.role)?.toLowerCase() !== 'assistant') return;
      const content = str(event.data.content);
      if (!content) return;
      const messageIndex = num(event.data.message_index);
      const key =
        messageIndex !== undefined
          ? `message:${sessionId}:${messageIndex}`
          : `message-content:${sessionId}:${str(event.data.stream_id) ?? content.length}`;
      if (await this.store.hasSent(key)) return;
      await this.store.markSent(key);
      await this.deliver(route, content);
    }
  }

  /** Отправляет текст в чат маршрута (с чанкингом) и обновляет состояние. */
  private async deliver(route: SessionRoute, text: string): Promise<void> {
    let lastMessageId: number | undefined;
    for (const chunk of chunkText(text)) {
      const body = this.parseMode === 'html' ? escapeHtml(chunk) : chunk;
      const response = await this.client.sendMessage({
        chatId: route.chatId,
        text: body,
        ...(this.parseMode === 'html' ? { parseMode: 'HTML' as const } : {}),
        ...(route.threadId !== undefined ? { messageThreadId: route.threadId } : {}),
        ...(route.lastInboundMessageId !== undefined
          ? { replyToMessageId: route.lastInboundMessageId }
          : {}),
      });
      lastMessageId = response.result?.message_id ?? lastMessageId;
    }
    await this.rememberOutbound(route, lastMessageId);
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

function safeParse(payload: string): SseEvent | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as SseEvent;
  } catch {
    return null;
  }
}
