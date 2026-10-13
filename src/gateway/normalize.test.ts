import type { Update } from '../bot-api/index.js';

import { describe, expect, it } from 'vitest';

import { buildDedupKey, normalizeUpdate, type NormalizeContext } from './normalize.js';

const allowlist = { '123456789': 'ADMIN', '-1001234567890': 'LEAD' };
const ctx: NormalizeContext = { botId: 123, allowlist };

/**
 * Собирает апдейт из частичного набора полей: фикстуры Telegram намеренно
 * минимальны, поэтому здесь тестовое приведение к `Update`, а не зеркало схемы.
 */
function update(partial: { update_id: number } & Record<string, unknown>): Update {
  return partial as unknown as Update;
}

describe('buildDedupKey', () => {
  it('использует botId, затем botUsername, затем «bot»', () => {
    expect(buildDedupKey({ botId: 123, allowlist }, 5)).toBe('telegram:123:5');
    expect(buildDedupKey({ botUsername: '@gateway_bot', allowlist }, 5)).toBe(
      'telegram:@gateway_bot:5',
    );
    expect(buildDedupKey({ allowlist }, 5)).toBe('telegram:bot:5');
  });
});

describe('normalizeUpdate: message', () => {
  it('преобразует обычное сообщение в событие с identity и payload', () => {
    const event = normalizeUpdate(
      update({
        update_id: 5,
        message: {
          message_id: 10,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, is_bot: false, first_name: 'Иван', username: 'user' },
          text: 'привет',
        },
      }),
      ctx,
    );

    expect(event).not.toBeNull();
    expect(event?.source).toBe('telegram');
    expect(event?.type).toBe('message');
    expect(event?.dedupKey).toBe('telegram:123:5');
    expect(event?.identity).toEqual({
      principalId: 'tg:123456789',
      chatKey: 'chat:telegram:123456789',
      roles: ['ADMIN'],
    });
    expect(event?.payload).toMatchObject({
      chatId: '123456789',
      messageId: 10,
      text: 'привет',
      from: { id: '123456789', username: 'user', firstName: 'Иван' },
    });
    // AD-089 (claim-flow): тип чата прокидывается из `message.chat.type`.
    expect(event?.payload.chatType).toBe('private');
  });

  it('прокидывает chatType группы в payload (AD-089 claim-flow)', () => {
    const event = normalizeUpdate(
      update({
        update_id: 8,
        message: {
          message_id: 13,
          chat: { id: -1001234567890, type: 'supergroup' },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: 'всем привет',
        },
      }),
      ctx,
    );

    expect(event?.payload.chatType).toBe('supergroup');
  });

  it('без chat.type поле chatType отсутствует', () => {
    const event = normalizeUpdate(
      update({
        update_id: 10,
        message: {
          message_id: 14,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: 'привет',
        },
      }),
      ctx,
    );

    expect(event?.payload.chatType).toBeUndefined();
  });

  it('тред-сообщение добавляет threadKey и payload.threadId', () => {
    const event = normalizeUpdate(
      update({
        update_id: 6,
        message: {
          message_id: 11,
          chat: { id: -1001234567890, type: 'supergroup' },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          message_thread_id: 77,
          text: 'в топике',
        },
      }),
      ctx,
    );

    expect(event?.identity.chatKey).toBe('chat:telegram:-1001234567890');
    expect(event?.identity.threadKey).toBe('thread:telegram:-1001234567890:77');
    expect(event?.payload.threadId).toBe(77);
    // Роль берётся по chatId (приоритет), затем по userId.
    expect(event?.identity.roles).toEqual(['LEAD']);
  });

  it('payload.from несёт displayName (firstName+lastName) и isExternal: true', () => {
    const event = normalizeUpdate(
      update({
        update_id: 60,
        message: {
          message_id: 60,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван', last_name: 'Иванов' },
          text: 'привет',
        },
      }),
      ctx,
    );

    expect(event?.payload.from).toEqual({
      id: '123456789',
      firstName: 'Иван',
      lastName: 'Иванов',
      displayName: 'Иван Иванов',
      isExternal: true,
    });
  });

  it('displayName отсутствует, если нет ни имени, ни фамилии; isExternal всегда true', () => {
    const event = normalizeUpdate(
      update({
        update_id: 61,
        message: {
          message_id: 61,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: '', username: 'user' },
          text: 'привет',
        },
      }),
      ctx,
    );

    expect(event?.payload.from).toMatchObject({ id: '123456789', username: 'user', isExternal: true });
    expect(event?.payload.from.displayName).toBeUndefined();
  });

  it('группа: chatId — id группы, from.id — конкретный автор (два автора → два principalId, один chatKey)', () => {
    const groupCtx: NormalizeContext = { botId: 123, allowlist: { '-1001234567890': 'LEAD' } };
    const first = normalizeUpdate(
      update({
        update_id: 70,
        message: {
          message_id: 70,
          chat: { id: -1001234567890, type: 'supergroup' },
          from: { id: 111, is_bot: false, first_name: 'Аня' },
          text: 'первое',
        },
      }),
      groupCtx,
    );
    const second = normalizeUpdate(
      update({
        update_id: 71,
        message: {
          message_id: 71,
          chat: { id: -1001234567890, type: 'supergroup' },
          from: { id: 222, is_bot: false, first_name: 'Борис' },
          text: 'второе',
        },
      }),
      groupCtx,
    );

    expect(first?.payload.chatId).toBe('-1001234567890');
    expect(second?.payload.chatId).toBe('-1001234567890');
    expect(first?.payload.from.id).toBe('111');
    expect(second?.payload.from.id).toBe('222');
    // Разные авторы → разные principalId, но общий chatKey группы.
    expect(first?.identity.principalId).toBe('tg:111');
    expect(second?.identity.principalId).toBe('tg:222');
    expect(first?.identity.chatKey).toBe('chat:telegram:-1001234567890');
    expect(second?.identity.chatKey).toBe('chat:telegram:-1001234567890');
    expect(first?.identity.chatKey).toBe(second?.identity.chatKey);
  });

  it('топик группы: threadKey привязан к группе, авторы независимы', () => {
    const groupCtx: NormalizeContext = { botId: 123, allowlist: { '-1001234567890': 'LEAD' } };
    const event = normalizeUpdate(
      update({
        update_id: 72,
        message: {
          message_id: 72,
          chat: { id: -1001234567890, type: 'supergroup' },
          from: { id: 333, is_bot: false, first_name: 'Вера' },
          message_thread_id: 99,
          text: 'в топике группы',
        },
      }),
      groupCtx,
    );

    expect(event?.identity.chatKey).toBe('chat:telegram:-1001234567890');
    expect(event?.identity.threadKey).toBe('thread:telegram:-1001234567890:99');
    expect(event?.identity.principalId).toBe('tg:333');
    expect(event?.payload.chatId).toBe('-1001234567890');
    expect(event?.payload.from.id).toBe('333');
  });

  it('edited_message обрабатывается как message с флагом edited', () => {
    const event = normalizeUpdate(
      update({
        update_id: 7,
        edited_message: {
          message_id: 12,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: 'исправлено',
        },
      }),
      ctx,
    );
    expect(event?.type).toBe('message');
    expect(event?.payload.edited).toBe(true);
  });

  it('недопущенный пользователь/чат → null (fail-closed)', () => {
    const event = normalizeUpdate(
      update({
        update_id: 8,
        message: {
          message_id: 1,
          chat: { id: 999 },
          from: { id: 999, is_bot: false, first_name: 'Чужой' },
          text: 'x',
        },
      }),
      ctx,
    );
    expect(event).toBeNull();
  });

  it('сообщение без chat → null', () => {
    const event = normalizeUpdate(
      update({
        update_id: 9,
        message: { message_id: 1, from: { id: 123456789, is_bot: false, first_name: 'Д'} },
      }),
      ctx,
    );
    expect(event).toBeNull();
  });
});

describe('normalizeUpdate: callback_query', () => {
  it('преобразует нажатие inline-кнопки в событие типа callback', () => {
    const event = normalizeUpdate(
      update({
        update_id: 20,
        callback_query: {
          id: 'cb-1',
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          message: { message_id: 30, chat: { id: 123456789 } },
          data: 'approve',
        },
      }),
      ctx,
    );

    expect(event?.type).toBe('callback');
    expect(event?.dedupKey).toBe('telegram:123:20');
    expect(event?.identity.chatKey).toBe('chat:telegram:123456789');
    expect(event?.payload.callback).toEqual({ data: 'approve', messageId: 30 });
    expect(event?.payload.chatId).toBe('123456789');
  });

  it('callback: chatType из message.chat.type (AD-089 claim-flow)', () => {
    const event = normalizeUpdate(
      update({
        update_id: 22,
        callback_query: {
          id: 'cb-3',
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          message: { message_id: 31, chat: { id: 123456789, type: 'private' } },
          data: 'approve',
        },
      }),
      ctx,
    );

    expect(event?.payload.chatType).toBe('private');
  });

  it('недопущенный отправитель callback → null', () => {
    const event = normalizeUpdate(
      update({
        update_id: 21,
        callback_query: {
          id: 'cb-2',
          from: { id: 777, is_bot: false, first_name: 'Чужой' },
          message: { message_id: 30, chat: { id: 777 } },
          data: 'approve',
        },
      }),
      ctx,
    );
    expect(event).toBeNull();
  });
});

describe('normalizeUpdate: вложения и неподдержанные апдейты', () => {
  it('собирает метаданные document с именем файла (без скачивания)', () => {
    const event = normalizeUpdate(
      update({
        update_id: 30,
        message: {
          message_id: 40,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          document: { file_id: 'file-1', file_name: 'report.pdf' } as { file_id: string },
        },
      }),
      ctx,
    );
    expect(event?.payload.attachment).toEqual({
      kind: 'document',
      fileId: 'file-1',
      fileName: 'report.pdf',
    });
  });

  it('для photo берёт последний размер (наибольший)', () => {
    const event = normalizeUpdate(
      update({
        update_id: 31,
        message: {
          message_id: 41,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          photo: [{ file_id: 'small' }, { file_id: 'large' }],
        },
      }),
      ctx,
    );
    expect(event?.payload.attachment).toEqual({ kind: 'photo', fileId: 'large' });
  });

  it('апдейт без message/edited_message/callback_query → null', () => {
    expect(normalizeUpdate(update({ update_id: 32 }), ctx)).toBeNull();
  });
});

describe('normalizeUpdate: команды', () => {
  it('/synth → type command с label и args', () => {
    const event = normalizeUpdate(
      update({
        update_id: 40,
        message: {
          message_id: 50,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: '/synth сделай отчёт',
        },
      }),
      ctx,
    );
    expect(event?.type).toBe('command');
    expect(event?.payload.command).toBe('synth');
    expect(event?.payload.args).toBe('сделай отчёт');
    expect(event?.payload.label).toBe('synth');
    expect(event?.identity.chatKey).toBe('chat:telegram:123456789');
  });

  it('/idea → label idea (для правил маршрутизации)', () => {
    const event = normalizeUpdate(
      update({
        update_id: 41,
        message: {
          message_id: 51,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: '/idea новая фича',
        },
      }),
      ctx,
    );
    expect(event?.type).toBe('command');
    expect(event?.payload.label).toBe('idea');
    expect(event?.payload.command).toBe('idea');
    expect(event?.payload.args).toBe('новая фича');
  });

  it('локальная команда (/help) тоже нормализуется как command', () => {
    const event = normalizeUpdate(
      update({
        update_id: 42,
        message: {
          message_id: 52,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: '/help',
        },
      }),
      ctx,
    );
    expect(event?.type).toBe('command');
    expect(event?.payload.command).toBe('help');
    expect(event?.payload.label).toBe('help');
  });

  it('обычный текст не превращается в команду', () => {
    const event = normalizeUpdate(
      update({
        update_id: 43,
        message: {
          message_id: 53,
          chat: { id: 123456789 },
          from: { id: 123456789, is_bot: false, first_name: 'Иван' },
          text: 'обычное сообщение',
        },
      }),
      ctx,
    );
    expect(event?.type).toBe('message');
    expect(event?.payload.command).toBeUndefined();
  });
});
