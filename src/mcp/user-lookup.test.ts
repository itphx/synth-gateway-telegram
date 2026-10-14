import { describe, expect, it, vi } from 'vitest';

import {
  findSynthUser,
  identityExternalId,
  parsePrincipalId,
  pickTelegramIdentity,
  resolveTelegramChatId,
  SynthUserLookupError,
  TELEGRAM_API_UNAVAILABLE,
  TELEGRAM_NO_TELEGRAM_IDENTITY,
  TELEGRAM_PRINCIPAL_INVALID,
  TELEGRAM_TARGET_REQUIRED,
  TELEGRAM_USER_FORBIDDEN,
  TELEGRAM_USER_LOOKUP_UNAVAILABLE,
  TELEGRAM_USER_NOT_FOUND,
} from './user-lookup.js';

const BASE_URL = 'http://synth-backend:5000/api/v2';

/** Ответ API v2: JSON-конверт + статус. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Мок fetch с маршрутизацией по пути (метод — GET). */
function mockFetch(routes: Record<string, Response | (() => Response)>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const route = routes[url];
    if (!route) throw new Error(`нет маршрута: ${url}`);
    return typeof route === 'function' ? route() : route;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const TELEGRAM_USER = {
  id: 'u-1',
  username: 'alice',
  identities: [
    { provider: 'github', externalId: 'gh-1' },
    { provider: 'telegram', externalId: '450316139', username: 'alice_tg' },
  ],
};

describe('parsePrincipalId / identityExternalId', () => {
  it('разбирает tg:<id> и нечисловые id', () => {
    expect(parsePrincipalId('tg:450316139')).toEqual({ provider: 'tg', externalId: '450316139' });
    expect(parsePrincipalId('Telegram:alice')).toEqual({
      provider: 'telegram',
      externalId: 'alice',
    });
    expect(parsePrincipalId('tg')).toBeNull();
    expect(parsePrincipalId('tg:')).toBeNull();
    expect(parsePrincipalId(':1')).toBeNull();
  });

  it('читает externalId и snake-case external_id', () => {
    expect(identityExternalId({ externalId: '1' })).toBe('1');
    expect(identityExternalId({ external_id: ' 2 ' })).toBe('2');
    expect(identityExternalId({})).toBeUndefined();
  });

  it('выбирает первую Telegram-идентичность (provider tg|telegram)', () => {
    expect(
      pickTelegramIdentity({
        identities: [{ provider: 'tg', externalId: '7' }, { provider: 'telegram', externalId: '8' }],
      })?.externalId,
    ).toBe('7');
    expect(pickTelegramIdentity({ identities: [{ provider: 'github', externalId: '9' }] })).toBeUndefined();
    expect(pickTelegramIdentity({})).toBeUndefined();
  });
});

describe('resolveTelegramChatId: прямой адресат (без API)', () => {
  it('chatId — без обращения к API', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const target = await resolveTelegramChatId(
      { baseUrl: BASE_URL, fetchImpl },
      { chatId: 12345 },
    );
    expect(target).toEqual({ chatId: '12345', via: 'chatId' });
    expect(calls).toHaveLength(0);
  });

  it('principalId «tg:<id>» — без обращения к API', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const target = await resolveTelegramChatId(
      { baseUrl: BASE_URL, fetchImpl },
      { principalId: 'tg:450316139' },
    );
    expect(target).toEqual({ chatId: '450316139', via: 'principalId' });
    expect(calls).toHaveLength(0);
  });

  it('числовой principalId без префикса — трактуется как chat id', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const target = await resolveTelegramChatId(
      { baseUrl: BASE_URL, fetchImpl },
      { principalId: '-100123' },
    );
    expect(target).toEqual({ chatId: '-100123', via: 'principalId' });
    expect(calls).toHaveLength(0);
  });

  it('principalId чужого провайдера — понятная ошибка', async () => {
    const { fetchImpl } = mockFetch({});
    await expect(
      resolveTelegramChatId({ baseUrl: BASE_URL, fetchImpl }, { principalId: 'github:42' }),
    ).rejects.toMatchObject({ code: TELEGRAM_PRINCIPAL_INVALID });
  });

  it('без адресата — ошибка telegram.target_required', async () => {
    await expect(resolveTelegramChatId(undefined, {})).rejects.toMatchObject({
      code: TELEGRAM_TARGET_REQUIRED,
    });
  });
});

describe('resolveTelegramChatId: резолвинг user через API v2', () => {
  it('резолв по id: GET /users/:id + identities → chat_id', async () => {
    const { fetchImpl, calls } = mockFetch({
      [`${BASE_URL}/users/u-1`]: jsonResponse(200, TELEGRAM_USER),
    });
    const target = await resolveTelegramChatId(
      { baseUrl: BASE_URL, serviceKey: 'synth_svc_test', fetchImpl },
      { user: 'u-1' },
    );
    expect(target).toEqual({
      chatId: '450316139',
      via: 'user',
      userId: 'u-1',
      username: 'alice',
    });
    // Машинная креда тенанта уходит в Authorization (без утечки в лог).
    expect(calls[0]?.headers.authorization).toBe('Bearer synth_svc_test');
  });

  it('резолв по username: 404 на /users/:id → поиск в GET /users', async () => {
    const { fetchImpl, calls } = mockFetch({
      [`${BASE_URL}/users/alice`]: jsonResponse(404, { error: { code: 'NOT_FOUND' } }),
      [`${BASE_URL}/users`]: jsonResponse(200, { users: [TELEGRAM_USER] }),
    });
    const target = await resolveTelegramChatId({ baseUrl: BASE_URL, fetchImpl }, { user: 'alice' });
    expect(target.chatId).toBe('450316139');
    expect(target.via).toBe('user');
    expect(calls.map((call) => call.url)).toEqual([`${BASE_URL}/users/alice`, `${BASE_URL}/users`]);
  });

  it('ответ в конверте { user } тоже понимается', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/u-1`]: jsonResponse(200, { user: TELEGRAM_USER }),
    });
    const target = await resolveTelegramChatId({ baseUrl: BASE_URL, fetchImpl }, { user: 'u-1' });
    expect(target.chatId).toBe('450316139');
  });

  it('нет Telegram-идентичности → telegram.no_telegram_identity', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/bob`]: jsonResponse(200, {
        id: 'u-2',
        username: 'bob',
        identities: [{ provider: 'github', externalId: 'gh-2' }],
      }),
    });
    await expect(
      resolveTelegramChatId({ baseUrl: BASE_URL, fetchImpl }, { user: 'bob' }),
    ).rejects.toMatchObject({ code: TELEGRAM_NO_TELEGRAM_IDENTITY });
  });

  it('пользователь не найден → telegram.user_not_found', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/ghost`]: jsonResponse(404, { error: { code: 'NOT_FOUND' } }),
      [`${BASE_URL}/users`]: jsonResponse(200, { users: [TELEGRAM_USER] }),
    });
    await expect(
      resolveTelegramChatId({ baseUrl: BASE_URL, fetchImpl }, { user: 'ghost' }),
    ).rejects.toMatchObject({ code: TELEGRAM_USER_NOT_FOUND });
  });

  it('403 (нет scope users:read) → telegram.user_forbidden', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/u-1`]: jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'scope' },
      }),
    });
    const error = await resolveTelegramChatId(
      { baseUrl: BASE_URL, fetchImpl },
      { user: 'u-1' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SynthUserLookupError);
    expect((error as SynthUserLookupError).code).toBe(TELEGRAM_USER_FORBIDDEN);
    expect((error as SynthUserLookupError).status).toBe(403);
  });

  it('сетевая ошибка → telegram.synth_api_unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      resolveTelegramChatId({ baseUrl: BASE_URL, fetchImpl }, { user: 'u-1' }),
    ).rejects.toMatchObject({ code: TELEGRAM_API_UNAVAILABLE });
  });

  it('5xx → telegram.synth_api_unavailable с статусом', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/u-1`]: jsonResponse(500, { error: { message: 'boom' } }),
    });
    const error = await resolveTelegramChatId(
      { baseUrl: BASE_URL, fetchImpl },
      { user: 'u-1' },
    ).catch((e: unknown) => e);
    expect((error as SynthUserLookupError).code).toBe(TELEGRAM_API_UNAVAILABLE);
    expect((error as SynthUserLookupError).status).toBe(500);
  });

  it('без настроенного API v2 резолвинг по user недоступен (fallback подсказан)', async () => {
    await expect(resolveTelegramChatId(undefined, { user: 'alice' })).rejects.toMatchObject({
      code: TELEGRAM_USER_LOOKUP_UNAVAILABLE,
    });
  });
});

describe('findSynthUser', () => {
  it('ищет по id, затем по username в списке', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/u-1`]: jsonResponse(200, TELEGRAM_USER),
    });
    const user = await findSynthUser({ baseUrl: BASE_URL, fetchImpl }, 'u-1');
    expect(user.username).toBe('alice');
  });

  it('пустой/битый список → user_not_found', async () => {
    const { fetchImpl } = mockFetch({
      [`${BASE_URL}/users/x`]: jsonResponse(404, {}),
      [`${BASE_URL}/users`]: jsonResponse(200, {}),
    });
    await expect(findSynthUser({ baseUrl: BASE_URL, fetchImpl }, 'x')).rejects.toMatchObject({
      code: TELEGRAM_USER_NOT_FOUND,
    });
  });
});
