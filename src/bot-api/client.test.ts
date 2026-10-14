import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { TelegramClient } from './client.js';
import { createProxyAgent } from './transport.js';

/** Поднимает HTTP-сервер, который принимает соединение, но никогда не отвечает. */
async function startHangingServer(): Promise<{ server: Server; url: string; stop: () => void }> {
  const server = createServer(() => {
    /* намеренно не отвечаем */
  });
  server.on('connect', () => {
    /* CONNECT-туннель тоже не завершаем */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const stop = (): void => {
    server.closeAllConnections?.();
    server.close();
    server.unref();
  };
  return { server, url: `http://127.0.0.1:${port}`, stop };
}

describe('TelegramClient (dry-run)', () => {
  it('без токена уходит в dry-run и не делает сетевых вызовов', async () => {
    const fetchImpl = vi.fn();
    const client = new TelegramClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(client.dryRun).toBe(true);

    const sent = await client.sendMessage({ chatId: '@channel', text: 'привет' });
    expect(sent.ok).toBe(true);
    expect(sent.dryRun).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dry-run sendMessage подставляет chat_id и parse_mode', async () => {
    const client = new TelegramClient({ dryRun: true, channelId: '-1001234567890' });
    const sent = await client.sendMessage({ text: '<b>привет</b>', parseMode: 'HTML' });
    expect(sent.chat_id).toBe('-1001234567890');
    expect(sent.parse_mode).toBe('HTML');
    expect(sent.text).toBe('<b>привет</b>');
  });

  it('getMe в dry-run возвращает заглушку бота', async () => {
    const client = new TelegramClient({});
    const me = await client.getMe();
    expect(me.ok).toBe(true);
    expect(me.dryRun).toBe(true);
    expect(me.result?.is_bot).toBe(true);
  });

  it('editMessageText и deleteMessage не падают в dry-run', async () => {
    const client = new TelegramClient({ channelId: '42' });
    const edited = await client.editMessageText({ messageId: 7, text: 'новый текст' });
    const deleted = await client.deleteMessage({ messageId: 7 });
    expect(edited.dryRun).toBe(true);
    expect(deleted.dryRun).toBe(true);
  });

  it('бросает ошибку, если chat_id не задан', async () => {
    const client = new TelegramClient({ dryRun: true });
    await expect(client.sendMessage({ text: 'x' })).rejects.toThrow('telegram.chat_id_missing');
  });

  it('getUpdates в dry-run возвращает пустой список без сети', async () => {
    const fetchImpl = vi.fn();
    const client = new TelegramClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const updates = await client.getUpdates({ timeout: 0 });
    expect(updates.ok).toBe(true);
    expect(updates.dryRun).toBe(true);
    expect(updates.result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proxyUrl не мешает dry-run (сетевых вызовов нет)', async () => {
    const fetchImpl = vi.fn();
    const client = new TelegramClient({
      proxyUrl: 'socks5://proxy.local:9050',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const me = await client.getMe();
    expect(client.dryRun).toBe(true);
    expect(me.dryRun).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dry-run sendMessage прокидывает reply_markup', async () => {
    const client = new TelegramClient({ dryRun: true, channelId: '1' });
    const sent = await client.sendMessage({
      text: 'текст',
      replyMarkup: { inline_keyboard: [[{ text: '✅', callback_data: 'approve' }]] },
    });
    expect(sent.reply_markup).toEqual({ inline_keyboard: [[{ text: '✅', callback_data: 'approve' }]] });
  });

  it('dry-run sendMessage прокидывает reply_to_message_id и message_thread_id', async () => {
    const client = new TelegramClient({ dryRun: true, channelId: '1' });
    const sent = await client.sendMessage({
      text: 'ответ',
      replyToMessageId: 42,
      messageThreadId: 7,
    });
    expect(sent.reply_to_message_id).toBe(42);
    expect(sent.message_thread_id).toBe(7);
  });

  it('dry-run answerCallbackQuery прокидывает callback_query_id/text/show_alert', async () => {
    const fetchImpl = vi.fn();
    const client = new TelegramClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.answerCallbackQuery({
      callbackQueryId: 'cq1',
      text: 'Готово',
      showAlert: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.callback_query_id).toBe('cq1');
    expect(result.text).toBe('Готово');
    expect(result.show_alert).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dry-run sendChatAction подставляет chat_id, action и message_thread_id', async () => {
    const fetchImpl = vi.fn();
    const client = new TelegramClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.sendChatAction({
      chatId: '-1001234567890',
      action: 'typing',
      messageThreadId: 7,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.chat_id).toBe('-1001234567890');
    expect(result.action).toBe('typing');
    expect(result.message_thread_id).toBe(7);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dry-run editMessageReplyMarkup без replyMarkup снимает клавиатуру', async () => {
    const client = new TelegramClient({ dryRun: true, channelId: '42' });
    const result = await client.editMessageReplyMarkup({ messageId: 7 });
    expect(result.dryRun).toBe(true);
    expect(result.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('dry-run editMessageText прокидывает пустую reply_markup (снятие клавиатуры)', async () => {
    const client = new TelegramClient({ dryRun: true, channelId: '42' });
    const result = await client.editMessageText({
      messageId: 7,
      text: 'статус',
      replyMarkup: { inline_keyboard: [] },
    });
    expect(result.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

describe('TelegramClient getUpdates (с токеном)', () => {
  it('делает POST в Bot API и возвращает апдейты', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: [{ update_id: 5 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelegramClient({
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const updates = await client.getUpdates({ offset: 3, timeout: 30, allowedUpdates: ['message'] });
    expect(updates.result?.[0]?.update_id).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/bottest-token/getUpdates');
    expect(JSON.parse(init.body)).toEqual({ offset: 3, timeout: 30, allowed_updates: ['message'] });
  });
});

describe('TelegramClient (с токеном)', () => {
  it('делает POST в Bot API и возвращает ответ', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelegramClient({
      token: 'test-token',
      channelId: '@chan',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(client.dryRun).toBe(false);
    const sent = await client.sendMessage({ text: 'hi' });

    expect(sent.ok).toBe(true);
    expect(sent.result?.message_id).toBe(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
  });

  it('answerCallbackQuery делает POST в Bot API', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelegramClient({
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.answerCallbackQuery({
      callbackQueryId: 'cq',
      text: 't',
      showAlert: true,
    });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/bottest-token/answerCallbackQuery');
    expect(JSON.parse(init.body)).toEqual({ callback_query_id: 'cq', text: 't', show_alert: true });
  });

  it('sendChatAction делает POST в Bot API с action/message_thread_id', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelegramClient({
      token: 'test-token',
      channelId: '42',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.sendChatAction({ action: 'typing', messageThreadId: 7 });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendChatAction');
    expect(JSON.parse(init.body)).toEqual({
      chat_id: '42',
      action: 'typing',
      message_thread_id: 7,
    });
  });

  it('editMessageReplyMarkup делает POST с пустой клавиатурой', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelegramClient({
      token: 'test-token',
      channelId: '42',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.editMessageReplyMarkup({ messageId: 7 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/bottest-token/editMessageReplyMarkup');
    expect(JSON.parse(init.body)).toEqual({
      chat_id: '42',
      message_id: 7,
      reply_markup: { inline_keyboard: [] },
    });
  });
});

describe('TelegramClient (таймауты и прерывание)', () => {
  it('обычный метод: requestTimeoutMs → telegram.request_timeout', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const client = new TelegramClient({
      token: 'test-token',
      channelId: '1',
      requestTimeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.sendMessage({ text: 'x' })).rejects.toThrow('telegram.request_timeout');
  });

  it('getUpdates: длинный long-poll не обрывается дефолтным таймаутом; применяется getUpdatesTimeoutMs', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const client = new TelegramClient({
      token: 'test-token',
      getUpdatesTimeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getUpdates({ timeout: 30 })).rejects.toThrow('telegram.request_timeout');
  });

  it('getUpdates: внешний signal прерывает запрос', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = new TelegramClient({
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const pending = client.getUpdates({ timeout: 30, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow('telegram.request_aborted');
  });
});

describe('TelegramClient (прокси-агент: жизненный цикл)', () => {
  it('агент создаётся один раз на конфигурацию и переиспользуется между запросами', async () => {
    const { url, stop } = await startHangingServer();
    try {
      const factory = vi.fn((proxyUrl: string) => createProxyAgent(proxyUrl));
      const client = new TelegramClient({
        token: 'test-token',
        proxyUrl: url,
        createProxyAgentImpl: factory,
        requestTimeoutMs: 20,
      });

      await expect(client.getMe()).rejects.toThrow('telegram.request_timeout');
      await expect(client.getMe()).rejects.toThrow('telegram.request_timeout');
      await expect(client.sendMessage({ text: 'x', chatId: '1' })).rejects.toThrow(
        'telegram.request_timeout',
      );

      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith(url);
    } finally {
      stop();
    }
  });

  it('агент не уничтожается на таймауте запроса, close() освобождает его', async () => {
    const { url, stop } = await startHangingServer();
    try {
      const agent = createProxyAgent(url);
      const destroy = vi.spyOn(agent, 'destroy');
      const client = new TelegramClient({
        token: 'test-token',
        proxyUrl: url,
        createProxyAgentImpl: () => agent,
        requestTimeoutMs: 20,
      });

      await expect(client.getMe()).rejects.toThrow('telegram.request_timeout');
      expect(destroy).not.toHaveBeenCalled();

      client.close();
      expect(destroy).toHaveBeenCalledTimes(1);
      // Идемпотентно: повторный close() ничего не ломает.
      client.close();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('dry-run не создаёт прокси-агент (ленивое создание)', () => {
    const factory = vi.fn((proxyUrl: string) => createProxyAgent(proxyUrl));
    const client = new TelegramClient({
      proxyUrl: 'socks5://proxy.local:9050',
      createProxyAgentImpl: factory,
    });
    expect(client.dryRun).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });
});
