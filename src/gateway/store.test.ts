import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStore, GatewayStore } from './store.js';

describe('FileStore', () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-store-'));
    store = new FileStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write → read: данные сохраняются и читаются обратно', async () => {
    await store.write('items/a.json', { id: 'a', value: 1 });
    expect(await store.read<{ id: string; value: number }>('items/a.json')).toEqual({
      id: 'a',
      value: 1,
    });
  });

  it('read отсутствующего файла → null', async () => {
    expect(await store.read('nope.json')).toBeNull();
  });

  it('после записи не остаётся временных файлов *.tmp.*', async () => {
    await store.write('items/b.json', { ok: true });
    const names = await readdir(join(dir, 'items'));
    expect(names).toEqual(['b.json']);
  });

  it('запись вне корня хранилища запрещена (containment)', () => {
    expect(() => store.resolvePath('../escape.json')).toThrow(/вне хранилища/);
  });
});

describe('GatewayStore', () => {
  let dir: string;
  let store: GatewayStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-state-'));
    store = new GatewayStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('offset сохраняется и переживает пересоздание хранилища', async () => {
    expect(await store.getOffset()).toBeUndefined();
    await store.setOffset(42);
    expect(await store.getOffset()).toBe(42);
    expect(await new GatewayStore(dir).getOffset()).toBe(42);
  });

  it('seenUpdates персистентны между экземплярами', async () => {
    expect(await store.hasSeen(5)).toBe(false);
    await store.markSeen(5);
    expect(await store.hasSeen(5)).toBe(true);
    expect(await new GatewayStore(dir).hasSeen(5)).toBe(true);
    expect(await store.hasSeen(6)).toBe(false);
  });

  it('chatSession хранится по chatKey', async () => {
    await store.setChatSession('chat:telegram:123456789', {
      sessionId: 'sess_1',
      chatId: '123456789',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const state = await store.getChatSession('chat:telegram:123456789');
    expect(state?.sessionId).toBe('sess_1');
    expect(await store.listChatSessions()).toHaveProperty('chat:telegram:123456789');
    expect(await store.getChatSession('chat:telegram:missing')).toBeUndefined();
  });

  it('запись состояния оставляет только JSON-файлы (без *.tmp.*)', async () => {
    await store.setOffset(1);
    await store.markSeen(1);
    const names = await readdir(join(dir, 'state'));
    expect(names.sort()).toEqual(['offset.json', 'seen-updates.json']);
  });

  it('setChatSession создаёт обратный маршрут sessionId → chatKey', async () => {
    await store.setChatSession('chat:telegram:123456789', {
      sessionId: 'sess_1',
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 42,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const route = await store.getSessionRoute('sess_1');
    expect(route).toMatchObject({
      chatKey: 'chat:telegram:123456789',
      chatId: '123456789',
      threadId: 7,
      lastInboundMessageId: 42,
    });
    expect(await store.getSessionRoute('missing')).toBeUndefined();
  });

  it('removeChatSession снимает и привязку, и маршрут', async () => {
    await store.setChatSession('chat:telegram:1', {
      sessionId: 'sess_x',
      chatId: '1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await store.removeChatSession('chat:telegram:1')).toBe(true);
    expect(await store.getChatSession('chat:telegram:1')).toBeUndefined();
    expect(await store.getSessionRoute('sess_x')).toBeUndefined();
    expect(await store.removeChatSession('chat:telegram:1')).toBe(false);
  });

  it('дедуп исходящих сообщений персистентен', async () => {
    expect(await store.hasSent('stream:abc')).toBe(false);
    await store.markSent('stream:abc');
    expect(await store.hasSent('stream:abc')).toBe(true);
    expect(await new GatewayStore(dir).hasSent('stream:abc')).toBe(true);
  });
});
