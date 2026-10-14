import type { BotApiResponse, TelegramClient, Update } from '../bot-api/index.js';
import { describe, expect, it, vi } from 'vitest';

import { InboundRegistry } from './inbound.js';
import type { SynthEventsClient } from './ingest.js';
import type { EventIdentity } from './normalize.js';
import { Poller } from './poller.js';
import type { GatewayStore } from './store.js';

/** Минимальный in-memory дубль {@link GatewayStore} для тестов поллера. */
function makeStore(): GatewayStore & {
  seen: Set<number>;
  offsets: number[];
} {
  const seen = new Set<number>();
  const offsets: number[] = [];
  let offset = 0;
  const stub = {
    seen,
    offsets,
    getOffset: async () => offset,
    setOffset: async (value: number) => {
      offset = value;
      offsets.push(value);
    },
    hasSeen: async (id: number) => seen.has(id),
    markSeen: async (id: number) => {
      seen.add(id);
    },
    setChatSession: async () => {},
    getChatSession: async () => null,
    getSessionRoute: async () => null,
    hasSent: async () => false,
    markSent: async () => {},
  };
  return stub as unknown as GatewayStore & { seen: Set<number>; offsets: number[] };
}

const eventsStub = {} as unknown as SynthEventsClient;

/** Поллер с настроенным клиентом и стабом событий (для тестов политики). */
function makePolicyPoller(options: {
  client: unknown;
  events: unknown;
  unknownAction?: 'register' | 'hint' | 'reject';
  store?: GatewayStore;
  log?: (message: string) => void;
  isSenderKnown?: (identity: EventIdentity) => boolean | Promise<boolean>;
  inbound?: InboundRegistry;
}): Poller {
  return new Poller({
    client: options.client as unknown as TelegramClient,
    events: options.events as unknown as SynthEventsClient,
    store: options.store ?? makeStore(),
    allowlist: { '123456789': 'ADMIN' },
    errorBackoffMs: 1,
    ...(options.unknownAction ? { unknownAction: options.unknownAction } : {}),
    ...(options.isSenderKnown ? { isSenderKnown: options.isSenderKnown } : {}),
    ...(options.inbound ? { inbound: options.inbound } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
}

/** Клиент с одним текстовым апдейтом и перехватом sendMessage. */
function textUpdateClient(chatType?: string): {
  client: { dryRun: boolean; getUpdates: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    dryRun: true,
    result: { message_id: 1 },
    ...params,
  }));
  return {
    client: {
      dryRun: false,
      getUpdates: vi.fn(async () => ({
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 5,
              chat: { id: 123456789, ...(chatType ? { type: chatType } : {}) },
              from: { id: 123456789, is_bot: false, first_name: 'Иван' },
              text: 'привет',
            },
          },
        ],
      })),
      sendMessage,
    },
    sendMessage,
  };
}

describe('Poller: политика неизвестного отправителя', () => {
  const ingestResult = {
    event: { id: 'e1', source: 'telegram', type: 'message', payload: {}, identity: {}, dedupKey: 'k', ts: 't' },
    decision: { kind: 'bind' },
    sessionId: 'sess_1',
  };

  it('register (дефолт): событие публикуется, в чат ничего не отвечаем', async () => {
    const { client, sendMessage } = textUpdateClient();
    const postEvent = vi.fn(async () => ingestResult);
    const poller = makePolicyPoller({ client, events: { postEvent } });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reject + неизвестный отправитель: событие НЕ публикуется, уходит отказ', async () => {
    const { client, sendMessage } = textUpdateClient();
    const postEvent = vi.fn(async () => ingestResult);
    const poller = makePolicyPoller({ client, events: { postEvent }, unknownAction: 'reject' });

    await poller.runOnce();

    expect(postEvent).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: '123456789',
      replyToMessageId: 5,
    });
    expect((sendMessage.mock.calls[0]?.[0] as { text: string }).text).toContain('не сопоставлен');
  });

  it('reject + известный отправитель (инъекция резолвера): публикуется без отказа', async () => {
    const { client, sendMessage } = textUpdateClient();
    const postEvent = vi.fn(async () => ingestResult);
    const isSenderKnown = vi.fn((_identity: EventIdentity) => true);
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'reject',
      isSenderKnown,
    });

    await poller.runOnce();

    expect(isSenderKnown).toHaveBeenCalledTimes(1);
    expect(isSenderKnown.mock.calls[0]?.[0]).toMatchObject({ principalId: 'tg:123456789' });
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('hint: событие публикуется, публикацию не блокируем, факт — в лог, в чат ничего', async () => {
    const { client, sendMessage } = textUpdateClient();
    const postEvent = vi.fn(async () => ingestResult);
    const logs: string[] = [];
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'hint',
      log: (m) => logs.push(m),
    });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('gateway.unknown_sender_hint');
  });

  it('hint + известный отправитель: лог не пишется (сопоставление подтверждено)', async () => {
    const { client, sendMessage } = textUpdateClient();
    const postEvent = vi.fn(async () => ingestResult);
    const logs: string[] = [];
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'hint',
      isSenderKnown: () => true,
      log: (m) => logs.push(m),
    });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('gateway.unknown_sender_hint');
  });

  // --- AD-089 (claim-flow): код линковки только в приватном чате ---

  const hintResult = {
    ...ingestResult,
    identityHint: { code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' },
  };

  it('hint + identityHint + приватный чат: отправляем сообщение с кодом', async () => {
    const { client, sendMessage } = textUpdateClient('private');
    const postEvent = vi.fn(async () => hintResult);
    const poller = makePolicyPoller({ client, events: { postEvent }, unknownAction: 'hint' });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ chatId: '123456789', replyToMessageId: 5 });
    const text = (sendMessage.mock.calls[0]?.[0] as { text: string }).text;
    // Привязка — только в UI Synth (claim-flow); команды /link у бота нет.
    expect(text).toContain('ABC-DEF');
    expect(text).toContain('Идентичности');
    expect(text).not.toContain('/link');
  });

  it('hint + identityHint + группа: сообщение НЕ отправляем, пишем лог', async () => {
    const { client, sendMessage } = textUpdateClient('group');
    const postEvent = vi.fn(async () => hintResult);
    const logs: string[] = [];
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'hint',
      log: (m) => logs.push(m),
    });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('gateway.identity_hint_not_private');
  });

  it('hint + identityHint + supergroup: сообщение НЕ отправляем, пишем лог', async () => {
    const { client, sendMessage } = textUpdateClient('supergroup');
    const postEvent = vi.fn(async () => hintResult);
    const logs: string[] = [];
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'hint',
      log: (m) => logs.push(m),
    });

    await poller.runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('gateway.identity_hint_not_private');
  });

  it('hint без identityHint: сообщение не отправляем (никакого кода)', async () => {
    const { client, sendMessage } = textUpdateClient('private');
    const postEvent = vi.fn(async () => ingestResult);
    const logs: string[] = [];
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'hint',
      log: (m) => logs.push(m),
    });

    await poller.runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('ABC-DEF');
  });

  it('register + identityHint: политика не hint — сообщение не отправляем', async () => {
    const { client, sendMessage } = textUpdateClient('private');
    const postEvent = vi.fn(async () => hintResult);
    const poller = makePolicyPoller({ client, events: { postEvent } });

    await poller.runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ошибка публикации не роняет поллер и не шлёт напоминаний', async () => {
    const { client, sendMessage } = textUpdateClient();
    const postEvent = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const store = makeStore();
    const poller = makePolicyPoller({
      client,
      events: { postEvent },
      unknownAction: 'register',
      store,
    });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.offsets.at(-1)).toBe(101);
  });
});

describe('Poller (ошибки и останов)', () => {
  it('продолжает цикл после таймаута getUpdates (backoff, без падения)', async () => {
    const logs: string[] = [];
    let polls = 0;
    const client = {
      dryRun: false,
      getUpdates: vi.fn(async (): Promise<BotApiResponse<Update[]>> => {
        polls += 1;
        if (polls === 1) throw new Error('telegram.request_timeout');
        poller.stop();
        return { ok: true, result: [] };
      }),
    };

    const poller = new Poller({
      client: client as unknown as TelegramClient,
      events: eventsStub,
      store: makeStore(),
      allowlist: {},
      errorBackoffMs: 1,
      log: (message) => logs.push(message),
    });

    await poller.run();

    expect(polls).toBe(2);
    expect(logs.join('\n')).toContain('telegram.request_timeout');
    expect(logs.join('\n')).toContain('поллер остановлен');
  });

  it('stop() прерывает висящий getUpdates через AbortSignal', async () => {
    let abortObserved = false;
    const client = {
      dryRun: false,
      getUpdates: (params: { signal?: AbortSignal }): Promise<BotApiResponse<Update[]>> =>
        new Promise((_resolve, reject) => {
          const signal = params.signal;
          if (!signal) {
            reject(new Error('signal не передан'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              reject(new Error('telegram.request_aborted'));
            },
            { once: true },
          );
        }),
    };

    const poller = new Poller({
      client: client as unknown as TelegramClient,
      events: eventsStub,
      store: makeStore(),
      allowlist: {},
      errorBackoffMs: 1,
    });

    const running = poller.run();
    // Даём циклу дойти до getUpdates, затем имитируем SIGTERM.
    await new Promise((resolve) => setTimeout(resolve, 5));
    poller.stop();
    await running;

    expect(abortObserved).toBe(true);
  });

  it('runOnce: апдейт вне allowlist пропускается, но offset сдвигается (дедуп/семантика)', async () => {
    const store = makeStore();
    const client = {
      dryRun: false,
      getUpdates: vi.fn(async (): Promise<BotApiResponse<Update[]>> => ({
        ok: true,
        result: [{ update_id: 7 }],
      })),
    };

    const poller = new Poller({
      client: client as unknown as TelegramClient,
      events: eventsStub,
      store,
      allowlist: {},
    });

    await poller.runOnce();

    expect(store.seen.has(7)).toBe(true);
    expect(store.offsets.at(-1)).toBe(8);
  });
});

describe('Poller: реестр входящих (reply на сообщение-источник)', () => {
  it('после успешной публикации запоминает dedupKey → messageId', async () => {
    const { client } = textUpdateClient();
    const postEvent = vi.fn(async () => ({ decision: { kind: 'bind' }, sessionId: null }));
    const inbound = new InboundRegistry();
    const poller = makePolicyPoller({ client, events: { postEvent }, inbound });

    await poller.runOnce();

    expect(postEvent).toHaveBeenCalledTimes(1);
    // `botId`/`botUsername` не заданы → фоллбек `bot`; message_id апдейта — 5.
    expect(inbound.inboundMessageId('telegram:bot:100')).toBe(5);
  });

  it('при сбое публикации входящее НЕ запоминается', async () => {
    const { client } = textUpdateClient();
    const postEvent = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const inbound = new InboundRegistry();
    const poller = makePolicyPoller({ client, events: { postEvent }, inbound });

    await poller.runOnce();

    expect(inbound.inboundMessageId('telegram:bot:100')).toBeUndefined();
  });
});
