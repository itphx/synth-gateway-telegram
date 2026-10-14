import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TelegramClient } from '../bot-api/index.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboundRegistry } from './inbound.js';
import { GatewayStore } from './store.js';
import { ADDED_FALLBACK_GRACE_MS, AgentWatcher, chunkHtmlText, chunkText, escapeHtml, isPrivateChatId, markdownToTelegramHtml, parseSseData, RICH_DRAFT_MAX_FAILURES, RICH_DRAFT_THROTTLE_MS, RICH_MESSAGE_LIMIT, TELEGRAM_MESSAGE_LIMIT, truncateHtmlText, TYPING_INTERVAL_MS, TYPING_MAX_IDLE_MS } from './watcher.js';

const CHAT_KEY = 'chat:telegram:123456789';
const SESSION_ID = 'sess_1';

/** Дисбаланс тега в HTML: открывающие минус закрывающие (0 — сбалансирован). */
function countTag(html: string, name: string): number {
  const opens = (html.match(new RegExp(`<${name}(?:\\s[^>]*)?>`, 'g')) ?? []).length;
  const closes = (html.match(new RegExp(`</${name}>`, 'g')) ?? []).length;
  return opens - closes;
}

/** Промис отложенной фоллбек-доставки сессии (разрешается после доставки/отмены). */
function pendingSettled(w: AgentWatcher, sessionId = SESSION_ID): Promise<void> | undefined {
  const map = (w as unknown as { pendingAdded: Map<string, { settled: Promise<void> }> })
    .pendingAdded;
  return map.get(sessionId)?.settled;
}

function makeClient(): {
  client: TelegramClient;
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
} {
  let nextId = 100;
  const sendMessage = vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    dryRun: true,
    result: { message_id: (nextId += 1) },
    ...params,
  }));
  const editMessageText = vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    dryRun: true,
    result: { message_id: (params.message_id as number | undefined) ?? 0 },
    ...params,
  }));
  const sendChatAction = vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    dryRun: true,
    result: true,
    ...params,
  }));
  return {
    client: {
      dryRun: true,
      sendMessage,
      editMessageText,
      sendChatAction,
    } as unknown as TelegramClient,
    sendMessage,
    editMessageText,
    sendChatAction,
  };
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

describe('markdownToTelegramHtml', () => {
  it('экранирует HTML-инъекции', () => {
    expect(markdownToTelegramHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('рендерит жирный, курсив, зачёркнутый и инлайн-код', () => {
    expect(markdownToTelegramHtml('**жирный** и *курсив* ~~зачёркнутый~~ `код`')).toBe(
      '<b>жирный</b> и <i>курсив</i> <s>зачёркнутый</s> <code>код</code>',
    );
    expect(markdownToTelegramHtml('__тоже жирный__ и _курсив_')).toBe(
      '<b>тоже жирный</b> и <i>курсив</i>',
    );
  });

  it('рендерит ссылки с экранированием href', () => {
    expect(markdownToTelegramHtml('[Synth](https://example.com/a?x=1&y=2)')).toBe(
      '<a href="https://example.com/a?x=1&amp;y=2">Synth</a>',
    );
    expect(markdownToTelegramHtml('[t](https://ex.com/a"b)')).toBe(
      '<a href="https://ex.com/a&quot;b">t</a>',
    );
  });

  it('рендерит заголовки, цитаты и горизонтальные линии', () => {
    expect(markdownToTelegramHtml('## Заголовок')).toBe('<b>Заголовок</b>');
    expect(markdownToTelegramHtml('> цитата\n> вторая')).toBe(
      '<blockquote>цитата\nвторая</blockquote>',
    );
    expect(markdownToTelegramHtml('---')).toBe('———');
    expect(markdownToTelegramHtml('- один\n- два')).toBe('• один\n• два');
  });

  it('рендерит фенсед-блок без языка и с языком', () => {
    expect(markdownToTelegramHtml('```\nconst a = 1;\n```')).toBe('<pre>const a = 1;</pre>');
    expect(markdownToTelegramHtml('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it('незакрытые маркеры остаются литералами (стриминг-толерантность)', () => {
    expect(markdownToTelegramHtml('**незакрыт')).toBe('**незакрыт');
    expect(markdownToTelegramHtml('*курсив без конца')).toBe('*курсив без конца');
    expect(markdownToTelegramHtml('текст `код без конца')).toBe('текст `код без конца');
    // Баланс тегов: ни одного открытого тега без закрытия.
    expect(markdownToTelegramHtml('**bold** и **незакрыт')).toBe('<b>bold</b> и **незакрыт');
  });

  it('жирный может охватывать несколько строк', () => {
    expect(markdownToTelegramHtml('**начало\nконец**')).toBe('<b>начало\nконец</b>');
  });

  it('экранирует спецсимволы внутри кода, но не трогает разметку', () => {
    expect(markdownToTelegramHtml('`a && b < c`')).toBe('<code>a &amp;&amp; b &lt; c</code>');
  });

  it('не трогает идентификаторы с подчёркиваниями', () => {
    expect(markdownToTelegramHtml('snake_case_name')).toBe('snake_case_name');
  });
});

describe('chunkHtmlText', () => {
  it('не режет короткий HTML', () => {
    expect(chunkHtmlText('<b>привет</b>')).toEqual(['<b>привет</b>']);
  });

  it('не рвёт HTML-сущности', () => {
    const text = '&amp;'.repeat(50);
    for (const chunk of chunkHtmlText(text, 20)) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk).not.toMatch(/&[a-zA-Z#0-9]*$/);
    }
  });

  it('закрывает и заново открывает теги на границе чанка', () => {
    const text = `<b>${'x'.repeat(100)}</b>`;
    const chunks = chunkHtmlText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      expect(countTag(chunk, 'b')).toBe(0);
    }
    // Все текст-символы сохранены (служебные переоткрытия тегов убраны).
    expect(chunks.join('').replace(/<\/?b>/g, '')).toBe(`x`.repeat(100));
  });

  it('сохраняет атрибуты при переоткрытии (ссылка)', () => {
    const text = `<a href="https://example.com">${'y'.repeat(80)}</a>`;
    const chunks = chunkHtmlText(text, 40);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      const opens = (chunk.match(/<a href="https:\/\/example\.com">/g) ?? []).length;
      const closes = (chunk.match(/<\/a>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('не режет внутри тега', () => {
    const text = `<b>${'z'.repeat(60)}</b>`;
    for (const chunk of chunkHtmlText(text, 20)) {
      expect(chunk).not.toMatch(/<[^>]*$/);
    }
  });
});

describe('truncateHtmlText', () => {
  it('возвращает короткий HTML как есть', () => {
    expect(truncateHtmlText('<b>ok</b>')).toBe('<b>ok</b>');
  });

  it('обрезает и закрывает открытые теги в пределах лимита', () => {
    const result = truncateHtmlText(`<b>${'x'.repeat(100)}`, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('…</b>')).toBe(true);
  });

  it('не рвёт сущность при обрезке', () => {
    const result = truncateHtmlText('&amp;'.repeat(50), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).not.toMatch(/&[a-zA-Z#0-9]*…$/);
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

  it('фоллбек message.added (assistant) доставляет после grace-паузы', async () => {
    vi.useFakeTimers();
    try {
      const w = watcher();
      await w.handleEvent({
        type: 'message.added',
        sessionId: SESSION_ID,
        data: { role: 'assistant', content: 'без стрима', message_index: 9 },
      });
      // Сразу ничего не отправляем — ждём, не придёт ли stream.done.
      expect(sendMessage).not.toHaveBeenCalled();
      const settled = pendingSettled(w);
      await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
      await settled;
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: 'без стрима' });
    } finally {
      vi.useRealTimers();
    }
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

  it('parseMode html рендерит Markdown ответа', async () => {
    await watcher('html').handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_md', content: '**жирный** и `код`' },
    });
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: '<b>жирный</b> и <code>код</code>',
      parseMode: 'HTML',
    });
  });

  it('parseMode plain не рендерит Markdown', async () => {
    await watcher('plain').handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 'stream_plain_md', content: '**жирный**' },
    });
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: '**жирный**' });
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty('parseMode');
  });
});

describe('AgentWatcher: стриминг и индикатор «Печатает…»', () => {
  let dir: string;
  let store: GatewayStore;
  let client: TelegramClient;
  let sendMessage: ReturnType<typeof vi.fn>;
  let editMessageText: ReturnType<typeof vi.fn>;
  let sendChatAction: ReturnType<typeof vi.fn>;
  let watcher: AgentWatcher;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'gateway-stream-'));
    store = new GatewayStore(dir);
    await store.init();
    ({ client, sendMessage, editMessageText, sendChatAction } = makeClient());
    await store.setChatSession(CHAT_KEY, {
      sessionId: SESSION_ID,
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 42,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    watcher = new AgentWatcher({ baseUrl: 'http://127.0.0.1:5000/api/v2', client, store });
  });

  afterEach(async () => {
    watcher.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const chunk = (data: Record<string, unknown>, sessionId = SESSION_ID): Promise<void> =>
    watcher.handleEvent({ type: 'stream.chunk', sessionId, data });

  it('включает «Печатает…» на stream.start и повторяет каждые ~4 c', async () => {
    await watcher.handleEvent({
      type: 'stream.start',
      sessionId: SESSION_ID,
      data: { stream_id: 's1' },
    });
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendChatAction.mock.calls[0]?.[0]).toMatchObject({
      chatId: '123456789',
      action: 'typing',
      messageThreadId: 7,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendChatAction).toHaveBeenCalledTimes(3);
  });

  it('stop() гасит индикатор', async () => {
    await watcher.handleEvent({
      type: 'stream.start',
      sessionId: SESSION_ID,
      data: { stream_id: 's1' },
    });
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sendChatAction).toHaveBeenCalledTimes(1);
  });

  it('до появления контента держит только индикатор (reasoning не стримится)', async () => {
    await watcher.handleEvent({
      type: 'stream.start',
      sessionId: SESSION_ID,
      data: { stream_id: 's1' },
    });
    await chunk({ stream_id: 's1', reasoning: 'размышление' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(sendChatAction).toHaveBeenCalledTimes(1);
  });

  it('накапливает чанки: создаёт live-сообщение и правит с троттлингом', async () => {
    await chunk({ stream_id: 's1', content: 'Привет' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: '123456789',
      text: 'Привет',
      replyToMessageId: 42,
      messageThreadId: 7,
    });

    // Второй чанк сразу — окно троттлинга не истекло, правки нет.
    await chunk({ stream_id: 's1', content: ' мир' });
    expect(editMessageText).not.toHaveBeenCalled();

    // После окна — правка накопленным текстом.
    await vi.advanceTimersByTimeAsync(1500);
    await chunk({ stream_id: 's1', content: '!' });
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText.mock.calls[0]?.[0]).toMatchObject({
      messageId: 101,
      text: 'Привет мир!',
    });
  });

  it('не правит сообщение, если текст не изменился', async () => {
    await chunk({ stream_id: 's1', content: 'текст' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await chunk({ stream_id: 's1', reasoning: 'ещё думаю' });
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('обрезает live-сообщение по лимиту Telegram', async () => {
    await chunk({ stream_id: 's1', content: 'x'.repeat(5000) });
    const text = sendMessage.mock.calls[0]?.[0]?.text as string;
    expect(text.length).toBe(TELEGRAM_MESSAGE_LIMIT);
    expect(text.endsWith('…')).toBe(true);
  });

  it('parseMode html экранирует live-сообщение', async () => {
    watcher = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      parseMode: 'html',
    });
    await chunk({ stream_id: 's1', content: '<b>a</b> & b' });
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: '&lt;b&gt;a&lt;/b&gt; &amp; b',
      parseMode: 'HTML',
    });
  });

  it('parseMode html: live-превью рендерит Markdown и закрывает теги при обрезке', async () => {
    watcher = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      parseMode: 'html',
    });
    await chunk({ stream_id: 's1', content: `**${'x'.repeat(5000)}**` });
    const text = sendMessage.mock.calls[0]?.[0]?.text as string;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(text.startsWith('<b>')).toBe(true);
    expect(text.endsWith('…</b>')).toBe(true);
  });

  it('parseMode html: экранирование не теряет контент (live-превью и финал)', async () => {
    watcher = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      parseMode: 'html',
    });
    const content = '&'.repeat(3000) + 'КОНЕЦ';
    // Живой путь: превью обрезается до лимита, но не рвёт HTML-сущность.
    await chunk({ stream_id: 's1', content });
    const live = sendMessage.mock.calls[0]?.[0]?.text as string;
    expect(live.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(live.endsWith('…')).toBe(true);
    expect(live).not.toMatch(/&[a-zA-Z#0-9]*…$/);

    // Финал: полный контент доставляется несколькими сообщениями без потерь.
    sendMessage.mockClear();
    editMessageText.mockClear();
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content, message_index: 3 },
    });
    const bodies = [
      ...editMessageText.mock.calls.map((call) => (call[0] as { text: string }).text),
      ...sendMessage.mock.calls.map((call) => (call[0] as { text: string }).text),
    ];
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.join('')).toContain('КОНЕЦ');
    expect(bodies.join('')).toContain('&amp;');
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it('parseMode html: финал без live (deliver) тоже не теряет контент', async () => {
    watcher = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      parseMode: 'html',
    });
    const content = '&'.repeat(3000) + 'КОНЕЦ';
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content, message_index: 4 },
    });
    const bodies = sendMessage.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.join('')).toContain('КОНЕЦ');
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it('stream.done редактирует live-сообщение полным контентом и дедуплицирует', async () => {
    await chunk({ stream_id: 's1', content: 'Часть' });
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'Полный ответ', message_index: 3 },
    });
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText.mock.calls[0]?.[0]).toMatchObject({
      messageId: 101,
      text: 'Полный ответ',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1); // только live-сообщение

    // Повторный done (reconnect) — без дубля.
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'Полный ответ', message_index: 3 },
    });
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Индикатор остановлен.
    const typingCalls = sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sendChatAction).toHaveBeenCalledTimes(typingCalls);
  });

  it('stream.done длинного ответа: первый чанк в live, остальные — новыми сообщениями', async () => {
    await chunk({ stream_id: 's1', content: 'начало' });
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'a'.repeat(5000) },
    });
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2); // live + продолжение
  });

  it('чанки после финала игнорируются', async () => {
    await chunk({ stream_id: 's1', content: 'контент' });
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'контент', message_index: 1 },
    });
    sendMessage.mockClear();
    editMessageText.mockClear();
    await chunk({ stream_id: 's1', content: 'допоздний' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('stream.done без content финализирует накопленным текстом', async () => {
    await chunk({ stream_id: 's1', content: 'накоплено' });
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', message_index: 7 },
    });
    expect(editMessageText.mock.calls.at(-1)?.[0]).toMatchObject({
      messageId: 101,
      text: 'накоплено',
    });
  });

  it('stream.done без контента и live ничего не шлёт', async () => {
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's-empty', message_index: 8 },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('stream.cancelled финализирует частичным текстом с пометкой', async () => {
    await chunk({ stream_id: 's1', content: 'частичный' });
    await watcher.handleEvent({
      type: 'stream.cancelled',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'частичный ответ' },
    });
    expect(editMessageText.mock.calls.at(-1)?.[0]).toMatchObject({
      messageId: 101,
      text: 'частичный ответ\n\n⏹ Остановлено',
    });
    const typingCalls = sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sendChatAction).toHaveBeenCalledTimes(typingCalls);
  });

  it('stream.cancelled без контента и live → короткая пометка', async () => {
    await watcher.handleEvent({
      type: 'stream.cancelled',
      sessionId: SESSION_ID,
      data: { stream_id: 's-empty' },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: '⏹ Остановлено' });
  });

  it('stream.error правит live-сообщение, если оно есть', async () => {
    await chunk({ stream_id: 's1', content: 'текст' });
    sendMessage.mockClear();
    await watcher.handleEvent({
      type: 'stream.error',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', error: 'сбой провайдера' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText.mock.calls.at(-1)?.[0]).toMatchObject({
      messageId: 101,
      text: expect.stringContaining('Ошибка агента'),
    });
  });

  it('stream.retry добавляет приписку в live-сообщение', async () => {
    await chunk({ stream_id: 's1', content: 'текст' });
    await watcher.handleEvent({
      type: 'stream.retry',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', attempt: 2, max_retries: 3 },
    });
    expect(editMessageText.mock.calls.at(-1)?.[0]).toMatchObject({
      messageId: 101,
      text: 'текст\n\n↻ повтор 2/3…',
    });
  });

  it('при 429 (retry_after) не спамит правками', async () => {
    await chunk({ stream_id: 's1', content: 'a' });
    editMessageText.mockResolvedValueOnce({
      ok: false,
      error_code: 429,
      parameters: { retry_after: 10 },
    });
    await vi.advanceTimersByTimeAsync(1500);
    await chunk({ stream_id: 's1', content: 'b' });
    expect(editMessageText).toHaveBeenCalledTimes(1);

    // Внутри окна retry_after правки подавляются.
    await vi.advanceTimersByTimeAsync(1500);
    await chunk({ stream_id: 's1', content: 'c' });
    expect(editMessageText).toHaveBeenCalledTimes(1);

    // После окна — правка снова идёт.
    await vi.advanceTimersByTimeAsync(10_000);
    await chunk({ stream_id: 's1', content: 'd' });
    expect(editMessageText).toHaveBeenCalledTimes(2);
  });

  it('ошибки Telegram не роняют watcher', async () => {
    sendMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(chunk({ stream_id: 's1', content: 'x' })).resolves.toBeUndefined();
    await chunk({ stream_id: 's1', content: 'y' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('AgentWatcher: фоллбек message.added с grace-паузой', () => {
  let dir: string;
  let store: GatewayStore;
  let client: TelegramClient;
  let sendMessage: ReturnType<typeof vi.fn>;
  let watcher: AgentWatcher;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'gateway-added-'));
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
    watcher = new AgentWatcher({ baseUrl: 'http://127.0.0.1:5000/api/v2', client, store });
  });

  afterEach(async () => {
    watcher.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const added = (data: Record<string, unknown>): Promise<void> =>
    watcher.handleEvent({ type: 'message.added', sessionId: SESSION_ID, data });

  it('message.added раньше stream.done → одно сообщение с полным контентом', async () => {
    await added({
      role: 'assistant',
      content: 'огрызок',
      message_index: 5,
      metadata: { stream_id: 's7' },
    });
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's7', content: 'полный ответ', message_index: 5 },
    });
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS * 2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: 'полный ответ' });
  });

  it('stream.done раньше message.added → одно сообщение', async () => {
    await watcher.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: 's7', content: 'полный ответ', message_index: 5 },
    });
    await added({
      role: 'assistant',
      content: 'огрызок',
      message_index: 5,
      metadata: { stream_id: 's7' },
    });
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS * 2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: 'полный ответ' });
  });

  it('только message.added → доставляется после grace-паузы', async () => {
    await added({ role: 'assistant', content: 'без стрима', message_index: 9 });
    expect(sendMessage).not.toHaveBeenCalled();
    const settled = pendingSettled(watcher);
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
    await settled;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ text: 'без стрима' });
  });

  it('message.added при уже отправленном stream:<id> → пропуск', async () => {
    await store.markSent('stream:s7');
    await added({
      role: 'assistant',
      content: 'огрызок',
      message_index: 5,
      metadata: { stream_id: 's7' },
    });
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS * 2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('stop() гасит отложенную доставку', async () => {
    await added({ role: 'assistant', content: 'без стрима', message_index: 9 });
    watcher.stop();
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS * 2);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('AgentWatcher: обрыв SSE и watchdog индикатора', () => {
  let dir: string;
  let store: GatewayStore;
  let client: TelegramClient;
  let sendChatAction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'gateway-typing-'));
    store = new GatewayStore(dir);
    await store.init();
    ({ client, sendChatAction } = makeClient());
    await store.setChatSession(CHAT_KEY, {
      sessionId: SESSION_ID,
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 42,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function makeWatcher(fetchImpl?: typeof fetch): AgentWatcher {
    return new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  const liveSize = (w: AgentWatcher): number =>
    (w as unknown as { live: Map<string, unknown> }).live.size;

  const start = (w: AgentWatcher): Promise<void> =>
    w.handleEvent({ type: 'stream.start', sessionId: SESSION_ID, data: { stream_id: 's1' } });

  it('watchdog гасит индикатор после простоя сессии', async () => {
    const w = makeWatcher();
    await start(w);
    expect(sendChatAction.mock.calls.length).toBeGreaterThan(0);

    // До порога индикатор продолжает обновляться…
    await vi.advanceTimersByTimeAsync(TYPING_MAX_IDLE_MS);
    const calls = sendChatAction.mock.calls.length;
    // …после простоя — самоостанавливается.
    await vi.advanceTimersByTimeAsync(TYPING_MAX_IDLE_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(calls);
    w.stop();
  });

  it('watchdog не мешает живому стриму (события продлевают индикатор)', async () => {
    const w = makeWatcher();
    await start(w);
    await vi.advanceTimersByTimeAsync(TYPING_MAX_IDLE_MS - TYPING_INTERVAL_MS);
    await w.handleEvent({ type: 'stream.retry', sessionId: SESSION_ID, data: { stream_id: 's1', attempt: 1 } });
    const before = sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 2);
    expect(sendChatAction.mock.calls.length).toBeGreaterThan(before);
    w.stop();
  });

  it('обрыв SSE (finally connect) гасит таймеры и очищает live', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'stream.start', sessionId: SESSION_ID, data: { stream_id: 's1' } })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    const w = makeWatcher(fetchImpl as unknown as typeof fetch);
    await (w as unknown as { connect(): Promise<void> }).connect();

    expect(sendChatAction.mock.calls.length).toBeGreaterThan(0);
    expect(liveSize(w)).toBe(0);
    const calls = sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendChatAction).toHaveBeenCalledTimes(calls);
  });

  it('переподключение SSE сбрасывает live-состояние прошлого соединения', async () => {
    const fetchImpl = vi.fn();
    const w = makeWatcher(fetchImpl as unknown as typeof fetch);
    await start(w);
    expect(liveSize(w)).toBe(1);

    const closed = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    fetchImpl.mockResolvedValue(new Response(closed, { status: 200 }));
    const connecting = (w as unknown as { connect(): Promise<void> }).connect();
    // Старт connect синхронно сбрасывает состояние, не дожидаясь сети.
    expect(liveSize(w)).toBe(0);
    await connecting;
    w.stop();
  });

  it('stop() гасит индикатор и очищает live', async () => {
    const w = makeWatcher();
    await start(w);
    w.stop();
    expect(liveSize(w)).toBe(0);
    const calls = sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendChatAction).toHaveBeenCalledTimes(calls);
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

describe('AgentWatcher: rich-режим (parseMode markdown)', () => {
  let dir: string;
  let store: GatewayStore;
  let client: TelegramClient;
  let sendMessage: ReturnType<typeof vi.fn>;
  let editMessageText: ReturnType<typeof vi.fn>;
  let sendChatAction: ReturnType<typeof vi.fn>;
  let sendRichMessage: ReturnType<typeof vi.fn>;
  let sendRichMessageDraft: ReturnType<typeof vi.fn>;
  let watcher: AgentWatcher;

  function makeRichClient(): void {
    let nextId = 100;
    sendMessage = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      dryRun: true,
      result: { message_id: (nextId += 1) },
      ...params,
    }));
    editMessageText = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      dryRun: true,
      result: { message_id: (params.message_id as number | undefined) ?? 0 },
      ...params,
    }));
    sendChatAction = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      dryRun: true,
      result: true,
      ...params,
    }));
    sendRichMessage = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      dryRun: true,
      result: { message_id: (nextId += 1) },
      ...params,
    }));
    sendRichMessageDraft = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      dryRun: true,
      result: true,
      ...params,
    }));
    client = {
      dryRun: true,
      sendMessage,
      editMessageText,
      sendChatAction,
      sendRichMessage,
      sendRichMessageDraft,
    } as unknown as TelegramClient;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'gateway-rich-'));
    store = new GatewayStore(dir);
    await store.init();
    makeRichClient();
    // Приватный чат: положительный числовой id (черновики доступны).
    await store.setChatSession(CHAT_KEY, {
      sessionId: SESSION_ID,
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 42,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    watcher = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      parseMode: 'markdown',
    });
  });

  afterEach(async () => {
    watcher.stop();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  const chunk = (data: Record<string, unknown>): Promise<void> =>
    watcher.handleEvent({ type: 'stream.chunk', sessionId: SESSION_ID, data });

  const done = (data: Record<string, unknown>): Promise<void> =>
    watcher.handleEvent({ type: 'stream.done', sessionId: SESSION_ID, data });

  async function setChatId(chatId: string): Promise<void> {
    await store.setChatSession(CHAT_KEY, {
      sessionId: SESSION_ID,
      chatId,
      threadId: 7,
      lastInboundMessageId: 42,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  /**
   * Задаёт исходы `sendRichMessageDraft` по порядку вызовов (последний повторяется):
   * `ok` — успех, `fail` — транзиентный сбой (5xx), `empty` — RICH_MESSAGE_EMPTY.
   */
  function setDraftOutcomes(outcomes: Array<'ok' | 'fail' | 'empty'>): void {
    let index = 0;
    sendRichMessageDraft.mockImplementation(async (params: Record<string, unknown>) => {
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? 'ok';
      index += 1;
      if (outcome === 'empty') {
        return { ok: false, error_code: 400, description: 'Bad Request: RICH_MESSAGE_EMPTY' };
      }
      if (outcome === 'fail') {
        return { ok: false, error_code: 500, description: 'Internal Server Error' };
      }
      return { ok: true, dryRun: true, result: true, ...params };
    });
  }

  it('isPrivateChatId: положительный id — приватный, группы/каналы — нет', () => {
    expect(isPrivateChatId('123456789')).toBe(true);
    expect(isPrivateChatId('-1001234567890')).toBe(false);
    expect(isPrivateChatId('-42')).toBe(false);
    expect(isPrivateChatId('@channel')).toBe(false);
  });

  it('приватный чат: черновики стримятся, финал — sendRichMessage', async () => {
    await chunk({ stream_id: 's1', content: '# Заголовок\n' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendRichMessageDraft.mock.calls[0]?.[0]).toMatchObject({
      chatId: 123456789,
      richMessage: { markdown: '# Заголовок\n' },
      messageThreadId: 7,
    });
    // Кнопка «стоп» в черновике не шлётся: апдейт `stopped_message_generation`
    // шлюз не обрабатывает — остановка только командой `/stop`.
    expect(sendRichMessageDraft.mock.calls[0]?.[0]).not.toHaveProperty('canStop');
    // Живой текст в rich-режиме обычным сообщением не шлётся.
    expect(sendMessage).not.toHaveBeenCalled();

    // Второй чанк внутри окна троттлинга — черновик не правится.
    await chunk({ stream_id: 's1', content: 'текст' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    // После окна — правка накопленным Markdown.
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: '!' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendRichMessageDraft.mock.calls[1]?.[0]).toMatchObject({
      richMessage: { markdown: '# Заголовок\nтекст!' },
    });

    // Финал — персистентный sendRichMessage с полным Markdown.
    await done({ stream_id: 's1', content: '# Заголовок\nтекст!', message_index: 3 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: '123456789',
      richMessage: { markdown: '# Заголовок\nтекст!' },
      replyToMessageId: 42,
      messageThreadId: 7,
    });
    expect(sendMessage).not.toHaveBeenCalled();

    // Повторный done (reconnect) — дедуп: второго rich-финала нет.
    await done({ stream_id: 's1', content: '# Заголовок\nтекст!', message_index: 3 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
  });

  it('в группе черновиков нет: только «Печатает…» и финальный sendRichMessage', async () => {
    await setChatId('-1001234567890');
    await chunk({ stream_id: 's1', content: 'ответ' });
    expect(sendRichMessageDraft).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    // Индикатор «Печатает…» включён.
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    await done({ stream_id: 's1', content: 'ответ', message_index: 4 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: '-1001234567890',
      richMessage: { markdown: 'ответ' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('Markdown с таблицей уходит в rich как есть (не рендерится в html)', async () => {
    const table = '| Метрика | Значение |\n|:--------|---------:|\n| Скорость | **42** |';
    await done({ stream_id: 's1', content: table, message_index: 5 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: table },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('stream.done: rich отклонён (400) → html-фоллбек с чанками', async () => {
    sendRichMessage.mockResolvedValueOnce({
      ok: false,
      error_code: 400,
      description: 'unsupported rich content',
    });
    await done({ stream_id: 's1', content: '**жирный** и `код`', message_index: 6 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: '<b>жирный</b> и <code>код</code>',
      parseMode: 'HTML',
    });
  });

  it('текст > 32768 символов не идёт в rich — html-фоллбек с чанками', async () => {
    const content = 'a'.repeat(RICH_MESSAGE_LIMIT + 1);
    // На стриме oversize черновики не шлются (и html live тоже — решение за финалом).
    await chunk({ stream_id: 's1', content });
    expect(sendRichMessageDraft).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await done({ stream_id: 's1', content, message_index: 7 });
    // rich-вызов даже не делается — сразу html-путь.
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessage.mock.calls) {
      expect((call[0] as { text: string }).text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });

  it('stream.cancelled: rich с частичным текстом и пометкой об остановке', async () => {
    await chunk({ stream_id: 's1', content: 'частичный' });
    await watcher.handleEvent({
      type: 'stream.cancelled',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'частичный ответ' },
    });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: 'частичный ответ\n\n⏹ Остановлено' },
    });
    // Индикатор остановлен.
    const typingCalls = sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 3);
    expect(sendChatAction).toHaveBeenCalledTimes(typingCalls);
  });

  it('stream.error: rich-уведомление об ошибке', async () => {
    await watcher.handleEvent({
      type: 'stream.error',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', error: 'провайдер недоступен' },
    });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: expect.stringContaining('провайдер недоступен') },
    });
  });

  it('пустой/пробельный накопленный текст не шлётся черновиком', async () => {
    await chunk({ stream_id: 's1', content: '\n' });
    await chunk({ stream_id: 's1', content: '   ' });
    // Telegram отклонил бы пустой rich-черновик (RICH_MESSAGE_EMPTY) — не шлём.
    expect(sendRichMessageDraft).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    // Первый содержательный чанк — черновик уходит уже с накопленным текстом.
    await chunk({ stream_id: 's1', content: 'ок' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendRichMessageDraft.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: '\n   ок' },
    });
  });

  it('RICH_MESSAGE_EMPTY — не сбой: следующий содержательный чанк шлёт черновик', async () => {
    setDraftOutcomes(['empty', 'ok']);
    await chunk({ stream_id: 's1', content: '**жирный**' });
    // «Показывать нечего» — черновик пропущен, html live-сообщение не шлётся.
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    // Канал не отключён: следующий содержательный чанк снова шлёт черновик.
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: ' и ещё' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendRichMessageDraft.mock.calls[1]?.[0]).toMatchObject({
      richMessage: { markdown: '**жирный** и ещё' },
    });
    expect(sendMessage).not.toHaveBeenCalled();

    // Финал всё равно rich.
    await done({ stream_id: 's1', content: '**жирный** и ещё', message_index: 8 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: '**жирный** и ещё' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('429 при черновике уважает retry_after: окно тишины, не фатал', async () => {
    let calls = 0;
    sendRichMessageDraft.mockImplementation(async (params: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 5',
          parameters: { retry_after: 5 },
        };
      }
      return { ok: true, dryRun: true, result: true, ...params };
    });
    await chunk({ stream_id: 's1', content: 'a' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    // Внутри окна retry_after черновики не шлются.
    await vi.advanceTimersByTimeAsync(1000);
    await chunk({ stream_id: 's1', content: 'b' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    // После окна — снова шлём: 429 не фатален, канал жив.
    await vi.advanceTimersByTimeAsync(5000);
    await chunk({ stream_id: 's1', content: 'c' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();

    await done({ stream_id: 's1', content: 'abc', message_index: 14 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('один транзиентный сбой черновика не убивает стриминг', async () => {
    setDraftOutcomes(['fail', 'ok', 'ok']);
    await chunk({ stream_id: 's1', content: 'первый' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    // Сбой нестиккий: следующие черновики всё равно шлются.
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: ' второй' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: ' третий' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(3);
    // Поток не переведён на html: обычных сообщений/правок нет.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();

    await done({ stream_id: 's1', content: 'первый второй третий', message_index: 11 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('три последовательных сбоя отключают черновики, финал всё равно rich', async () => {
    setDraftOutcomes(['fail']);
    await chunk({ stream_id: 's1', content: 'a' });
    await chunk({ stream_id: 's1', content: 'b' });
    await chunk({ stream_id: 's1', content: 'c' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(RICH_DRAFT_MAX_FAILURES);
    expect(sendMessage).not.toHaveBeenCalled();

    // Канал отключён: следующий чанк не шлёт ни черновика, ни html.
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: 'd' });
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(RICH_DRAFT_MAX_FAILURES);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();

    // Финал не зависит от сбоев черновиков — sendRichMessage, не html.
    await done({ stream_id: 's1', content: 'abcd', message_index: 12 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: 'abcd' },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('успешный черновик сбрасывает счётчик: сбой, успех, сбой, сбой не отключает', async () => {
    setDraftOutcomes(['fail', 'ok', 'fail', 'fail', 'ok']);
    await chunk({ stream_id: 's1', content: '1' }); // сбой (1)
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: '2' }); // успех — сброс в 0
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: '3' }); // сбой (1)
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: '4' }); // сбой (2) — порог не достигнут
    await vi.advanceTimersByTimeAsync(RICH_DRAFT_THROTTLE_MS);
    await chunk({ stream_id: 's1', content: '5' }); // успех — черновики живы
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(5);
    expect(sendMessage).not.toHaveBeenCalled();

    await done({ stream_id: 's1', content: '12345', message_index: 13 });
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('message.added (фоллбек без стрима) доставляется rich-сообщением', async () => {
    await watcher.handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: { role: 'assistant', content: '## Заголовок', message_index: 9 },
    });
    const pending = (watcher as unknown as {
      pendingAdded: Map<string, { settled: Promise<void> }>;
    }).pendingAdded.get(SESSION_ID)?.settled;
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
    await pending;
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({
      richMessage: { markdown: '## Заголовок' },
    });
  });

  it('ошибки Telegram на rich-методах не роняют watcher', async () => {
    sendRichMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(
      done({ stream_id: 's1', content: 'ответ', message_index: 10 }),
    ).resolves.toBeUndefined();
    // rich упал — доставили html-фоллбеком.
    expect(sendMessage).toHaveBeenCalled();
  });
});

describe('AgentWatcher: адресат reply по стриму (реестр входящих)', () => {
  let dir: string;
  let store: GatewayStore;
  let client: TelegramClient;
  let sendMessage: ReturnType<typeof vi.fn>;
  let inbound: InboundRegistry;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'gateway-reply-'));
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
    inbound = new InboundRegistry();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function watcher(parseMode: 'plain' | 'markdown' = 'plain'): AgentWatcher {
    return new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
      parseMode,
      inbound,
    });
  }

  /** `message.added(user)` с metadata прогона (`dedup_key` + `stream_id`). */
  const linkUser = (w: AgentWatcher, dedupKey: string, streamId: string): Promise<void> =>
    w.handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: {
        role: 'user',
        content: 'вопрос',
        metadata: { dedup_key: dedupKey, stream_id: streamId },
      },
    });

  const done = (
    w: AgentWatcher,
    streamId: string,
    content: string,
    messageIndex: number,
  ): Promise<void> =>
    w.handleEvent({
      type: 'stream.done',
      sessionId: SESSION_ID,
      data: { stream_id: streamId, content, message_index: messageIndex },
    });

  /** Ответы Telegram по порядку: текст + адресат reply. */
  const replies = (): Array<{ text: string; replyToMessageId?: number }> =>
    sendMessage.mock.calls.map((call) => call[0] as { text: string; replyToMessageId?: number });

  it('message.added(user) связывает стрим с сообщением-источником → reply на него', async () => {
    const w = watcher();
    inbound.rememberInbound('telegram:bot:100', 5);
    await linkUser(w, 'telegram:bot:100', 's1');

    await done(w, 's1', 'ответ', 1);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 5 });
  });

  it('три сообщения во время ответа на 1-е: ответы 1→11, 2→22, 3→33 (не на последнее)', async () => {
    const w = watcher();
    inbound.rememberInbound('telegram:bot:1', 11);
    inbound.rememberInbound('telegram:bot:2', 22);
    inbound.rememberInbound('telegram:bot:3', 33);
    await linkUser(w, 'telegram:bot:1', 's1');
    await linkUser(w, 'telegram:bot:2', 's2');
    await linkUser(w, 'telegram:bot:3', 's3');

    // Пока шёл ответ, поллер перезаписал «последнее входящее» на самое новое.
    await store.setChatSession(CHAT_KEY, {
      sessionId: SESSION_ID,
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 33,
      updatedAt: '2026-01-01T00:00:01.000Z',
    });

    await done(w, 's1', 'Ответ 1', 1);
    await done(w, 's2', 'Ответ 2', 2);
    await done(w, 's3', 'Ответ 3', 3);

    expect(replies().map((r) => r.replyToMessageId)).toEqual([11, 22, 33]);
  });

  it('неизвестный стрим → fallback на route.lastInboundMessageId', async () => {
    const w = watcher();
    await done(w, 's-unknown', 'ответ', 1);

    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 42 });
  });

  it('message.added(user) без metadata не создаёт связь и не шлёт сообщений', async () => {
    const w = watcher();
    await w.handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: { role: 'user', content: 'вопрос' },
    });
    expect(sendMessage).not.toHaveBeenCalled();

    await done(w, 's1', 'ответ', 1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 42 });
  });

  it('dedup_key, неизвестный реестру, не создаёт связь → fallback', async () => {
    const w = watcher();
    await linkUser(w, 'telegram:bot:777', 's1');
    await done(w, 's1', 'ответ', 1);

    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 42 });
  });

  it('live-сообщение (stream.chunk) отвечает на сообщение-источник своего стрима', async () => {
    const w = watcher();
    inbound.rememberInbound('telegram:bot:100', 7);
    await linkUser(w, 'telegram:bot:100', 's1');

    await w.handleEvent({
      type: 'stream.chunk',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'частично' },
    });

    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: 'частично',
      replyToMessageId: 7,
    });
  });

  it('stream.error использует stream_id события → reply на его сообщение', async () => {
    const w = watcher();
    inbound.rememberInbound('telegram:bot:100', 8);
    await linkUser(w, 'telegram:bot:100', 's1');

    await w.handleEvent({
      type: 'stream.error',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', error: 'сбой провайдера' },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 8 });
  });

  it('stream.cancelled использует stream_id события → reply на его сообщение', async () => {
    const w = watcher();
    inbound.rememberInbound('telegram:bot:100', 9);
    await linkUser(w, 'telegram:bot:100', 's1');

    await w.handleEvent({
      type: 'stream.cancelled',
      sessionId: SESSION_ID,
      data: { stream_id: 's1', content: 'частичный' },
    });

    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      text: 'частичный\n\n⏹ Остановлено',
      replyToMessageId: 9,
    });
  });

  it('rich-финал (sendRichMessage) отвечает на сообщение-источник стрима', async () => {
    const sendRichMessage = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      dryRun: true,
      result: { message_id: 500 },
      ...params,
    }));
    const richClient = { ...(client as object), sendRichMessage } as unknown as TelegramClient;
    inbound.rememberInbound('telegram:bot:100', 15);
    const w = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client: richClient,
      store,
      parseMode: 'markdown',
      inbound,
    });
    await linkUser(w, 'telegram:bot:100', 's1');

    await done(w, 's1', '**ответ**', 1);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 15 });
  });

  it('без реестра (inbound не задан) поведение прежнее — fallback на маршрут', async () => {
    const w = new AgentWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      client,
      store,
    });
    await w.handleEvent({
      type: 'message.added',
      sessionId: SESSION_ID,
      data: {
        role: 'user',
        content: 'вопрос',
        metadata: { dedup_key: 'telegram:bot:100', stream_id: 's1' },
      },
    });
    await done(w, 's1', 'ответ', 1);

    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ replyToMessageId: 42 });
  });
});
