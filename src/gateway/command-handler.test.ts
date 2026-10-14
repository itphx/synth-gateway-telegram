import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TelegramClient } from '../bot-api/index.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from './command-handler.js';
import type { SynthEventsClient } from './ingest.js';
import type { SynthEventInput } from './normalize.js';
import { GatewayStore } from './store.js';

interface Mocks {
  client: TelegramClient;
  sendMessage: ReturnType<typeof vi.fn>;
  synth: SynthEventsClient;
  createSession: ReturnType<typeof vi.fn>;
  createBinding: ReturnType<typeof vi.fn>;
  deleteBinding: ReturnType<typeof vi.fn>;
  listBindings: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
}

function makeMocks(): Mocks {
  const sendMessage = vi.fn(async (params: Record<string, unknown>) => ({
    ok: true,
    dryRun: true,
    result: { message_id: 1 },
    ...params,
  }));
  const client = {
    dryRun: true,
    sendMessage,
    getMe: vi.fn(async () => ({ ok: true, dryRun: true, result: { id: 0, is_bot: true, first_name: 'dry-run' } })),
  } as unknown as TelegramClient;

  const createSession = vi.fn(async () => ({ id: 'sess_new', name: 'Telegram' }));
  const createBinding = vi.fn(async (input: Record<string, unknown>) => ({ id: 'bind_1', ...input }));
  const deleteBinding = vi.fn(async () => undefined);
  const listBindings = vi.fn(async () => [] as unknown[]);
  const getSession = vi.fn(async () => null as unknown);
  const abortSession = vi.fn(async () => undefined);
  const synth = {
    createSession,
    createBinding,
    deleteBinding,
    listBindings,
    getSession,
    abortSession,
  } as unknown as SynthEventsClient;

  return {
    client,
    sendMessage,
    synth,
    createSession,
    createBinding,
    deleteBinding,
    listBindings,
    getSession,
    abortSession,
  };
}

function commandEvent(
  command: string,
  args = '',
  options: { role?: string; chatKey?: string; threadKey?: string; threadId?: number } = {},
): SynthEventInput {
  const chatKey = options.chatKey ?? 'chat:telegram:123456789';
  return {
    source: 'telegram',
    type: 'command',
    payload: {
      chatId: '123456789',
      messageId: 10,
      from: { id: '123456789', isExternal: true },
      command,
      args,
      label: command,
      ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
    },
    identity: {
      chatKey,
      ...(options.threadKey ? { threadKey: options.threadKey } : {}),
      roles: [options.role ?? 'ADMIN'],
    },
    dedupKey: 'telegram:1:1',
  };
}

describe('CommandHandler', () => {
  let dir: string;
  let store: GatewayStore;
  let mocks: Mocks;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-cmd-'));
    store = new GatewayStore(dir);
    await store.init();
    mocks = makeMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function handler(): CommandHandler {
    return new CommandHandler({ client: mocks.client, synth: mocks.synth, store, dryRun: true });
  }

  const lastText = (): string => {
    const call = mocks.sendMessage.mock.calls.at(-1)?.[0] as { text?: string } | undefined;
    return call?.text ?? '';
  };

  it('/help отвечает справкой локально', async () => {
    const handled = await handler().handle(commandEvent('help'));
    expect(handled).toBe(true);
    expect(lastText()).toContain('/synth');
    expect(lastText()).toContain('/stop');
  });

  it('/stop без привязки сообщает об отсутствии сессии', async () => {
    const handled = await handler().handle(commandEvent('stop'));
    expect(handled).toBe(true);
    expect(mocks.abortSession).not.toHaveBeenCalled();
    expect(lastText()).toContain('Нет активной сессии');
  });

  it('/stop прерывает сессию чата', async () => {
    await store.setChatSession('chat:telegram:123456789', {
      sessionId: 'sess_live',
      chatId: '123456789',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const handled = await handler().handle(commandEvent('stop'));
    expect(handled).toBe(true);
    expect(mocks.abortSession).toHaveBeenCalledWith('sess_live');
    expect(lastText()).toContain('Остановлено');
  });

  it('/stop с ошибкой abort → ⚠️, локально обработано', async () => {
    await store.setChatSession('chat:telegram:123456789', {
      sessionId: 'sess_live',
      chatId: '123456789',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.abortSession.mockRejectedValueOnce(new Error('нет активного стрима'));
    const handled = await handler().handle(commandEvent('stop'));
    expect(handled).toBe(true);
    expect(lastText()).toContain('⚠️');
  });

  it('/synth и /idea — pass-through в ядро (не обрабатываются локально)', async () => {
    expect(await handler().handle(commandEvent('synth', 'задача'))).toBe(false);
    expect(await handler().handle(commandEvent('idea', 'идея'))).toBe(false);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('неизвестная команда → подсказка, локально', async () => {
    const handled = await handler().handle(commandEvent('foo'));
    expect(handled).toBe(true);
    expect(lastText()).toContain('Неизвестная команда /foo');
  });

  it('/status показывает чат и отсутствие привязки', async () => {
    await handler().handle(commandEvent('status'));
    expect(lastText()).toContain('Чат: 123456789');
    expect(lastText()).toContain('Привязка: нет');
  });

  it('/status показывает имя отправителя и principalId (диагностика сопоставления)', async () => {
    const event = commandEvent('status');
    event.payload.from = {
      id: '123456789',
      username: 'user',
      firstName: 'Иван',
      displayName: 'Иван Иванов',
      isExternal: true,
    };
    event.identity = { ...event.identity, principalId: 'tg:123456789' };
    await handler().handle(event);
    expect(lastText()).toContain('Отправитель:');
    expect(lastText()).toContain('@user');
    expect(lastText()).toContain('tg:123456789');
  });

  it('/status без username берёт displayName', async () => {
    const event = commandEvent('status');
    event.payload.from = {
      id: '123456789',
      firstName: 'Иван',
      lastName: 'Иванов',
      displayName: 'Иван Иванов',
      isExternal: true,
    };
    event.identity = { ...event.identity, principalId: 'tg:123456789' };
    await handler().handle(event);
    expect(lastText()).toContain('Иван Иванов');
  });

  it('/help указывает связку с учётной записью по коду в UI Synth', async () => {
    await handler().handle(commandEvent('help'));
    expect(lastText()).toContain('учётной запис');
    expect(lastText()).toContain('код');
    expect(lastText()).toContain('Идентичности');
  });

  it('/bind без аргумента создаёт сессию и привязку', async () => {
    const handled = await handler().handle(commandEvent('bind'));
    expect(handled).toBe(true);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createBinding).toHaveBeenCalledWith({
      source: 'telegram',
      chatKey: 'chat:telegram:123456789',
      mode: 'bound',
      sessionId: 'sess_new',
    });
    expect(lastText()).toContain('sess_new');
    const state = await store.getChatSession('chat:telegram:123456789');
    expect(state?.sessionId).toBe('sess_new');
    expect(state?.lastInboundMessageId).toBe(10);
  });

  it('/bind <sessionId> проверяет существование и привязывает', async () => {
    mocks.getSession.mockResolvedValueOnce({ id: 'sess_42' });
    await handler().handle(commandEvent('bind', 'sess_42'));
    expect(mocks.getSession).toHaveBeenCalledWith('sess_42');
    expect(mocks.createBinding).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess_42' }),
    );
  });

  it('/bind <sessionId> для отсутствующей сессии не создаёт привязку', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    await handler().handle(commandEvent('bind', 'missing'));
    expect(mocks.createBinding).not.toHaveBeenCalled();
    expect(lastText()).toContain('не найдена');
  });

  it('/unbind удаляет привязку и состояние', async () => {
    await store.setChatSession('chat:telegram:123456789', {
      sessionId: 'sess_old',
      chatId: '123456789',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mocks.listBindings.mockResolvedValueOnce([
      { id: 'bind_old', source: 'telegram', chatKey: 'chat:telegram:123456789', mode: 'bound' },
    ]);
    await handler().handle(commandEvent('unbind'));
    expect(mocks.deleteBinding).toHaveBeenCalledWith('bind_old');
    expect(await store.getChatSession('chat:telegram:123456789')).toBeUndefined();
    expect(lastText()).toContain('снята');
  });

  it('/unbind без привязки сообщает об этом', async () => {
    mocks.listBindings.mockResolvedValueOnce([]);
    await handler().handle(commandEvent('unbind'));
    expect(mocks.deleteBinding).not.toHaveBeenCalled();
    expect(lastText()).toContain('нет');
  });

  it('/new снимает старую привязку и создаёт новую сессию', async () => {
    mocks.listBindings.mockResolvedValueOnce([
      { id: 'bind_old', source: 'telegram', chatKey: 'chat:telegram:123456789', mode: 'bound' },
    ]);
    await handler().handle(commandEvent('new'));
    expect(mocks.deleteBinding).toHaveBeenCalledWith('bind_old');
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(lastText()).toContain('sess_new');
  });

  it('управление привязкой запрещено роли USER', async () => {
    const handled = await handler().handle(commandEvent('bind', '', { role: 'USER' }));
    expect(handled).toBe(true);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(lastText()).toContain('Недостаточно прав');
  });

  it('использует threadKey для топика', async () => {
    await handler().handle(
      commandEvent('bind', '', { threadKey: 'thread:telegram:123456789:77', threadId: 77 }),
    );
    expect(mocks.createBinding).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: 'thread:telegram:123456789:77' }),
    );
  });
});
