import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TelegramClient } from '../bot-api/index.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayStore } from './store.js';
import { AgentWatcher, chunkText, escapeHtml, parseSseData } from './watcher.js';

const CHAT_KEY = 'chat:telegram:123456789';
const SESSION_ID = 'sess_1';

function makeClient(): { client: TelegramClient; sendMessage: ReturnType<typeof vi.fn> } {
  let nextId = 100;
  const sendMessage = vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    dryRun: true,
    result: { message_id: (nextId += 1) },
    ...params,
  }));
  return { client: { dryRun: true, sendMessage } as unknown as TelegramClient, sendMessage };
}

describe('parseSseData', () => {
  it('разбирает data-блоки и отдаёт незавершённый хвост', () => {
    const buffer = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"';
    const { payloads, rest } = parseSseData(buffer);
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  it('игнорирует keepalive-комментарии', () => {
    const { payloads } = parseSseData(':keepalive\n\ndata: {"a":1}\n\n');
    expect(payloads).toEqual(['{"a":1}']);
  });
});

describe('chunkText', () => {
  it('не режет короткий текст', () => {
    expect(chunkText('привет')).toEqual(['привет']);
  });

  it('режет длинный текст по границам строк в пределах лимита', () => {
    const line = 'x'.repeat(10);
    const text = Array.from({ length: 5 }, () => line).join('\n'); // 54 символа
    const chunks = chunkText(text, 20);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });

  it('режет текст без переводов строк ровно по лимиту', () => {
    const chunks = chunkText('a'.repeat(25), 10);
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});

describe('escapeHtml', () => {
  it('экранирует спецсимволы', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('AgentWatcher.handleEvent', () => {
  let dir: string;
  let store: GatewayStore;
  let client: TelegramClient;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-watch-'));
    store = new GatewayStore(dir);
    await store.init();
    ({ client, sendMessage } = makeClient());
    await store.setChatSession(CHAT_KEY, {
      sessionId: SESSION_ID,
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 42,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function watcher(parseMode: 'plain' | 'html' = 'plain'): AgentWatcher {
    return new AgentWatcher({ baseUrl: 'http://127.0.0.1:5000/api/v2', client, store, parseMode });
  }

  it('stream.done → отправка ответа в чат с reply/thread', async () => {
    await watcher().handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_1', content: 'Ответ агента', message_index: 3 },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: '123456789',
      text: 'Ответ агента',
      replyToMessageId: 42,
      messageThreadId: 7,
    });
    const state = await store.getChatSession(CHAT_KEY);
    expect(state?.lastOutboundMessageId).toBe(101);
  });

  it('игнорирует события сессий без маршрута', async () => {
    await watcher().handleEvent({
      type: 'stream.done',
      sessionId: 'unknown',
      data: { stream_id: 'stream_x', content: 'нет' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('дедуплицирует повторный stream_id', async () => {
    const w = watcher();
    const event = {
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_dup', content: 'один раз' },
    };
    await w.handleEvent(event);
    await w.handleEvent(event);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('чанкует длинный ответ на несколько сообщений', async () => {
    const content = 'a'.repeat(5000);
    await watcher().handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_long', content },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('фоллбек message.added (assistant) отправляет, если стрима не было', async () => {
    await watcher().handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: { role: 'assistant', content: 'без стрима', message_index: 9 },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: 'без стрима' });
  });

  it('message.added не дублирует уже отправленный stream.done (по message_index)', async () => {
    const w = watcher();
    await w.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_5', content: 'ответ', message_index: 5 },
    });
    await w.handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: { role: 'assistant', content: 'ответ', message_index: 5 },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('message.added с ролью user игнорируется', async () => {
    await watcher().handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: { role: 'user', content: 'вопрос', message_index: 1 },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('stream.error → уведомление в чат', async () => {
    await watcher().handleEvent({
      type: 'stream.error',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_err', error: 'провайдер недоступен' },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining('провайдер недоступен'),
    });
  });

  it('parseMode html экранирует текст и ставит parse_mode', async () => {
    await watcher('html').handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_html', content: '<b>жирный</b> & Co' },
    });
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: '&lt;b&gt;жирный&lt;/b&gt; &amp; Co',
      parseMode: 'HTML',
    });
  });
});

describe('AgentWatcher: Bearer-провайдер (OIDC)', () => {
  it('401 при подключении → refreshBearer и повторный connect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-watch-auth-'));
    const store = new GatewayStore(dir);
    await store.init();
    const getBearer = vi.fn().mockResolvedValueOnce('stale').mockResolvedValue('fresh');
    const refreshBearer = vi.fn().mockResolvedValue('fresh');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const client = { dryRun: false, sendMessage: vi.fn() } as unknown as TelegramClient;
    const watcher = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      bearer: { getBearer, refreshBearer },
      client,
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // connect — приватный; вызываем напрямую для проверки auth-повтора.
    await (watcher as unknown as { connect(): Promise<void> }).connect();
    await rm(dir, { recursive: true, force: true });

    expect(refreshBearer).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });
});
