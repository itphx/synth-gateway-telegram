import { describe, expect, it, vi } from 'vitest';

import { SynthEventsClient, SynthEventsError } from './ingest.js';
import type { SynthEventInput } from './normalize.js';

const event: SynthEventInput = {
  source: 'telegram',
  type: 'message',
  payload: {
    chatId: '123456789',
    messageId: 1,
    from: { id: '123456789', isExternal: true },
  },
  identity: { chatKey: 'chat:telegram:123456789', roles: ['ADMIN'] },
  dedupKey: 'telegram:123:1',
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function client(fetchImpl: typeof fetch, log = vi.fn()) {
  return new SynthEventsClient({
    baseUrl: 'http://127.0.0.1:5000/api/v2',
    apiKey: 'secret-key',
    fetchImpl,
    maxRetries: 3,
    retryBaseDelayMs: 0,
    log,
  });
}

describe('SynthEventsClient.postEvent', () => {
  it('успешный POST: возвращает {event, decision, sessionId} и логирует решение', async () => {
    const responseBody = {
      event: { id: 'evt_1', source: 'telegram', type: 'message', payload: {}, identity: {}, dedupKey: 'k', ts: '2026-01-01T00:00:00.000Z' },
      decision: { kind: 'opened' },
      sessionId: 'sess_1',
    };
    const fetchImpl = vi.fn(async () => jsonResponse(201, responseBody));
    const log = vi.fn();

    const result = await client(fetchImpl as unknown as typeof fetch, log).postEvent(event);

    expect(result).toEqual(responseBody);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/events');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('opened'));
  });

  it('повторяет запрос при 5xx и успешно завершается', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }))
      .mockResolvedValueOnce(jsonResponse(502, { error: { code: 'BAD_GATEWAY' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, { event: { id: 'evt_2' }, decision: { kind: 'bound', sessionId: 's1' }, sessionId: 's1' }),
      );

    const result = await client(fetchImpl as unknown as typeof fetch).postEvent(event);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.decision.kind).toBe('bound');
    expect(result.sessionId).toBe('s1');
  });

  it('повторяет запрос при сетевой ошибке', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(201, { event: { id: 'evt_3' }, decision: { kind: 'drop', reason: 'no_route' }, sessionId: null }));

    const result = await client(fetchImpl as unknown as typeof fetch).postEvent(event);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.sessionId).toBeNull();
  });

  it('4xx — окончательная ошибка с кодом из тела, без повторов', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'Некорректное тело события' } }),
    );

    const promise = client(fetchImpl as unknown as typeof fetch).postEvent(event);

    await expect(promise).rejects.toBeInstanceOf(SynthEventsError);
    await expect(promise).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('исчерпание повторов на 5xx → ошибка', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: { code: 'UNAVAILABLE' } }));

    await expect(client(fetchImpl as unknown as typeof fetch).postEvent(event)).rejects.toMatchObject(
      { status: 503, code: 'UNAVAILABLE' },
    );
    // 1 попытка + 3 повтора
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('SynthEventsClient: привязки (заготовки фазы B)', () => {
  it('listBindings разворачивает {bindings}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { bindings: [{ id: 'b1', source: 'telegram', mode: 'bound' }] }),
    );
    const bindings = await client(fetchImpl as unknown as typeof fetch).listBindings();
    expect(bindings).toEqual([{ id: 'b1', source: 'telegram', mode: 'bound' }]);
  });

  it('createBinding отправляет POST и возвращает биндинг', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { id: 'b2', source: 'telegram', mode: 'bound', sessionId: 's1' }),
    );
    const binding = await client(fetchImpl as unknown as typeof fetch).createBinding({
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      mode: 'bound',
      sessionId: 's1',
    });
    expect(binding.id).toBe('b2');
  });

  it('deleteBinding не бросает на 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).deleteBinding('b3'),
    ).resolves.toBeUndefined();
  });

  it('listBindings фильтрует по source', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        bindings: [
          { id: 'b1', source: 'telegram', mode: 'bound' },
          { id: 'b2', source: 'cron', mode: 'queue' },
        ],
      }),
    );
    const bindings = await client(fetchImpl as unknown as typeof fetch).listBindings('telegram');
    expect(bindings.map((binding) => binding.id)).toEqual(['b1']);
  });
});

describe('SynthEventsClient: Bearer-провайдер (OIDC)', () => {
  it('401 → refreshBearer и один повтор с новым токеном', async () => {
    const bearer = {
      getBearer: vi.fn().mockResolvedValueOnce('stale').mockResolvedValue('fresh'),
      refreshBearer: vi.fn().mockResolvedValue('fresh'),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, { event: { id: 'e1' }, decision: { kind: 'drop' }, sessionId: null }),
      );
    const events = new SynthEventsClient({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      bearer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });

    const result = await events.postEvent(event);

    expect(result.sessionId).toBeNull();
    expect(bearer.refreshBearer).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });

  it('повторный 401 → окончательная ошибка (без бесконечного цикла)', async () => {
    const bearer = {
      getBearer: vi.fn().mockResolvedValue('tok'),
      refreshBearer: vi.fn().mockResolvedValue('tok'),
    };
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    const events = new SynthEventsClient({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      bearer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });

    await expect(events.postEvent(event)).rejects.toMatchObject({ status: 401 });
    expect(bearer.refreshBearer).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bearer приоритетнее статического apiKey', async () => {
    const bearer = {
      getBearer: vi.fn().mockResolvedValue('bearer-token'),
      refreshBearer: vi.fn(),
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { event: { id: 'e' }, decision: { kind: 'drop' }, sessionId: null }),
    );
    const events = new SynthEventsClient({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      apiKey: 'static-key',
      bearer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });

    await events.postEvent(event);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bearer-token');
  });
});

describe('SynthEventsClient: сессии', () => {
  it('createSession отправляет POST /sessions и возвращает сессию', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 'sess_1', name: 'Telegram' }));
    const session = await client(fetchImpl as unknown as typeof fetch).createSession({
      name: 'Telegram',
    });
    expect(session.id).toBe('sess_1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/sessions');
    expect(init.method).toBe('POST');
  });

  it('getSession 404 → null без повторов', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }));
    const session = await client(fetchImpl as unknown as typeof fetch).getSession('missing');
    expect(session).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('getSession 200 возвращает сессию', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'sess_2' }));
    expect(await client(fetchImpl as unknown as typeof fetch).getSession('sess_2')).toEqual({
      id: 'sess_2',
    });
  });

  it('getSession при 5xx повторяет и затем бросает', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }));
    await expect(
      client(fetchImpl as unknown as typeof fetch).getSession('sess_3'),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
