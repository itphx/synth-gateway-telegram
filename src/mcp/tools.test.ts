import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TelegramClient } from '../bot-api/index.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInlineKeyboard,
  MAX_CALLBACK_DATA_BYTES,
  TelegramMcpError,
  tgDeleteMessage,
  tgEditMessage,
  tgGetMe,
  tgNotify,
  tgSendButtons,
  tgSendMessage,
  tgSendToUser,
  tgStatus,
  type TelegramToolContext,
} from './tools.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Ловит ошибку из синхронной функции (для проверки машинного кода). */
function capture(fn: () => unknown): TelegramMcpError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof TelegramMcpError ? error : undefined;
  }
}

/** Dry-run-клиент: сетевых вызовов не делает (fetch бросает, если его вызовут). */
function dryRunContext(overrides: Partial<TelegramToolContext> = {}): {
  ctx: TelegramToolContext;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn(() => {
    throw new Error('сетевой вызов в dry-run');
  });
  const client = new TelegramClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  return {
    ctx: { client, defaultChatId: '-1001234567890', ownerChatId: '123456789', ...overrides },
    fetchImpl,
  };
}

describe('tg_send_message / tg_edit_message / tg_delete_message (dry-run)', () => {
  it('sendMessage подставляет chatId по умолчанию и не ходит в сеть', async () => {
    const { ctx, fetchImpl } = dryRunContext();
    const sent = await tgSendMessage(ctx, { text: 'привет' });
    expect(sent.ok).toBe(true);
    expect(sent.dryRun).toBe(true);
    expect(sent.chat_id).toBe('-1001234567890');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sendMessage прокидывает reply_to_message_id', async () => {
    const { ctx } = dryRunContext();
    const sent = await tgSendMessage(ctx, { text: 'ответ', chatId: '1', replyToMessageId: 42 });
    expect(sent.chat_id).toBe('1');
    expect(sent.reply_to_message_id).toBe(42);
  });

  it('editMessageText и deleteMessage работают в dry-run', async () => {
    const { ctx } = dryRunContext();
    const edited = await tgEditMessage(ctx, { messageId: 7, text: 'новый' });
    const deleted = await tgDeleteMessage(ctx, { messageId: 7 });
    expect(edited.dryRun).toBe(true);
    expect(deleted.dryRun).toBe(true);
  });

  it('getMe в dry-run возвращает заглушку бота', async () => {
    const { ctx } = dryRunContext();
    const me = await tgGetMe(ctx);
    expect(me.dryRun).toBe(true);
    expect(me.result?.is_bot).toBe(true);
  });

  it('sendMessage без chatId и без значения по умолчанию → ошибка', async () => {
    const { ctx } = dryRunContext({ defaultChatId: undefined });
    await expect(tgSendMessage(ctx, { text: 'x' })).rejects.toThrow('telegram.chat_id_missing');
  });
});

describe('tg_notify', () => {
  it('шлёт владельцу с маркером', async () => {
    const { ctx } = dryRunContext();
    const sent = await tgNotify(ctx, { text: 'готово' });
    expect(sent.chat_id).toBe('123456789');
    expect(sent.text).toBe('🔔 готово');
    expect(sent.dryRun).toBe(true);
  });

  it('без owner/default → ошибка кодом', async () => {
    const { ctx } = dryRunContext({ ownerChatId: undefined, defaultChatId: undefined });
    await expect(tgNotify(ctx, { text: 'x' })).rejects.toBeInstanceOf(TelegramMcpError);
  });
});

describe('tg_send_buttons', () => {
  it('маппит data → callback_data (одна кнопка — строка)', async () => {
    const { ctx } = dryRunContext();
    const sent = await tgSendButtons(ctx, {
      text: 'Выберите',
      buttons: [
        { text: '✅ Ок', data: 'approve' },
        { text: '❌ Нет', data: 'reject' },
      ],
    });
    expect(sent.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '✅ Ок', callback_data: 'approve' }],
        [{ text: '❌ Нет', callback_data: 'reject' }],
      ],
    });
  });

  it('buildInlineKeyboard отклоняет пустой список', () => {
    const error = capture(() => buildInlineKeyboard([]));
    expect(error).toBeInstanceOf(TelegramMcpError);
    expect(error?.code).toBe('telegram.buttons_empty');
  });

  it('callback_data длиннее 64 байт → ошибка', () => {
    const tooLong = 'x'.repeat(MAX_CALLBACK_DATA_BYTES + 1);
    const error = capture(() => buildInlineKeyboard([{ text: 'k', data: tooLong }]));
    expect(error).toBeInstanceOf(TelegramMcpError);
    expect(error?.code).toBe('telegram.callback_data_too_long');
  });
});

describe('ошибки Bot API', () => {
  function tokenContext(fetchImpl: unknown): TelegramToolContext {
    const client = new TelegramClient({
      token: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });
    return { client, defaultChatId: '1' };
  }

  it('ответ ok:false возвращается как есть', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      headers: new Headers(),
    }));
    const result = await tgSendMessage(tokenContext(fetchImpl), { text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.description).toContain('chat not found');
  });

  it('сетевая ошибка пробрасывается', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(tgSendMessage(tokenContext(fetchImpl), { text: 'x' })).rejects.toThrow(
      'network down',
    );
  });
});

describe('tg_send_to_user', () => {
  /** Контекст с API v2: резолв user через mock fetch Synth. */
  function lookupContext(routes: Record<string, Response>): TelegramToolContext {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const route = routes[url];
      if (!route) throw new Error(`нет маршрута: ${url}`);
      return route;
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ dryRun: true });
    return { client, synth: { baseUrl: 'http://synth:5000/api/v2', fetchImpl } };
  }

  const tgUser = {
    id: 'u-1',
    username: 'alice',
    identities: [{ provider: 'telegram', externalId: '450316139' }],
  };

  it('резолвит user → chat_id через API и отправляет', async () => {
    const ctx = lookupContext({
      'http://synth:5000/api/v2/users/alice': new Response(JSON.stringify(tgUser), { status: 200 }),
    });
    const sent = await tgSendToUser(ctx, { user: 'alice', text: 'привет', replyToMessageId: 7 });
    expect(sent.chat_id).toBe('450316139');
    expect(sent.via).toBe('user');
    expect(sent.userId).toBe('u-1');
    expect(sent.username).toBe('alice');
    expect(sent.reply_to_message_id).toBe(7);
  });

  it('fallback по principalId — без обращения к API', async () => {
    const { ctx, fetchImpl } = dryRunContext();
    const sent = await tgSendToUser(ctx, { principalId: 'tg:123', text: 'x' });
    expect(sent.chat_id).toBe('123');
    expect(sent.via).toBe('principalId');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fallback по chatId — без обращения к API', async () => {
    const { ctx, fetchImpl } = dryRunContext();
    const sent = await tgSendToUser(ctx, { chatId: '-100500', text: 'x' });
    expect(sent.chat_id).toBe('-100500');
    expect(sent.via).toBe('chatId');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('без Telegram-идентичности — ошибка telegram.no_telegram_identity', async () => {
    const ctx = lookupContext({
      'http://synth:5000/api/v2/users/bob': new Response(
        JSON.stringify({ id: 'u-2', username: 'bob', identities: [] }),
        { status: 200 },
      ),
    });
    await expect(tgSendToUser(ctx, { user: 'bob', text: 'x' })).rejects.toMatchObject({
      code: 'telegram.no_telegram_identity',
    });
  });

  it('без настроенного API v2 резолвинг по user невозможен', async () => {
    const { ctx } = dryRunContext();
    await expect(tgSendToUser(ctx, { user: 'alice', text: 'x' })).rejects.toMatchObject({
      code: 'telegram.user_lookup_unavailable',
    });
  });
});

describe('tg_status', () => {
  it('читает привязку чата и offset из хранилища шлюза', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-mcp-status-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(
      join(dir, 'state', 'chat-sessions.json'),
      JSON.stringify({
        'chat:telegram:123456789': { sessionId: 'sess_1', chatId: '123456789' },
      }),
    );
    writeFileSync(join(dir, 'state', 'offset.json'), JSON.stringify({ offset: 99 }));

    const { ctx } = dryRunContext({ dataDir: dir });
    const status = await tgStatus(ctx, { chatId: '123456789' });
    expect(status.offset).toBe(99);
    expect(status.chatKey).toBe('chat:telegram:123456789');
    expect(status.binding?.sessionId).toBe('sess_1');
  });

  it('без chatId возвращает все привязки; без хранилища — null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-mcp-status-'));
    tmpDirs.push(dir);
    const { ctx } = dryRunContext({ dataDir: dir });
    const status = await tgStatus(ctx);
    expect(status.offset).toBeNull();
    expect(status.binding).toBeNull();
    expect(status.chats).toEqual({});
  });
});
