import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TelegramClient } from '../bot-api/index.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayStore } from './store.js';
import { ADDED_FALLBACK_GRACE_MS, AgentWatcher, chunkHtmlText, chunkText, escapeHtml, markdownToTelegramHtml, parseSseData, TELEGRAM_MESSAGE_LIMIT, truncateHtmlText, TYPING_INTERVAL_MS, TYPING_MAX_IDLE_MS } from './watcher.js';

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
