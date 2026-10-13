import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { describe, expect, it, vi } from 'vitest';

import { createProxyAgent, requestJson } from './transport.js';

describe('createProxyAgent', () => {
  it('socks5:// → SocksProxyAgent (локальный DNS)', () => {
    const agent = createProxyAgent('socks5://proxy.local:9050');
    expect(agent).toBeInstanceOf(SocksProxyAgent);
    expect((agent as SocksProxyAgent).shouldLookup).toBe(true);
  });

  it('socks5h:// → SocksProxyAgent с удалённым DNS', () => {
    const agent = createProxyAgent('socks5h://proxy.local:9050');
    expect(agent).toBeInstanceOf(SocksProxyAgent);
    expect((agent as SocksProxyAgent).shouldLookup).toBe(false);
  });

  it('socks:// и socks4:// → SocksProxyAgent', () => {
    expect(createProxyAgent('socks://proxy.local:1080')).toBeInstanceOf(SocksProxyAgent);
    expect(createProxyAgent('socks4://proxy.local:1080')).toBeInstanceOf(SocksProxyAgent);
  });

  it('http:// и https:// → HttpsProxyAgent (CONNECT)', () => {
    expect(createProxyAgent('http://proxy.local:3128')).toBeInstanceOf(HttpsProxyAgent);
    expect(createProxyAgent('https://proxy.local:3128')).toBeInstanceOf(HttpsProxyAgent);
  });

  it('неизвестная схема → понятная ошибка', () => {
    expect(() => createProxyAgent('ftp://proxy.local')).toThrow(
      'telegram.proxy_unsupported_scheme: ftp',
    );
    expect(() => createProxyAgent('proxy.local:1080')).toThrow('telegram.proxy_unsupported_scheme');
  });
});

describe('requestJson (прямой путь)', () => {
  it('без прокси использует переданный fetchImpl', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await requestJson('https://api.telegram.org/bottest/getMe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.telegram.org/bottest/getMe');
  });

  it('пустой/whitespace proxyUrl — тоже прямой путь через fetch', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await requestJson('https://api.telegram.org/bottest/getMe', {
      proxyUrl: '   ',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await requestJson('https://api.telegram.org/bottest/getMe', {
      proxyUrl: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('невалидный JSON → ошибка telegram.invalid_json с текстом ответа', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not json</html>', { status: 502 }));

    await expect(
      requestJson('https://api.telegram.org/bottest/getMe', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/telegram\.invalid_json \(HTTP 502\): <html>not json<\/html>/);
  });

  it('сетевая ошибка обогащается методом/URL без токена и признаком прокси', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });

    const error = (await requestJson('https://api.telegram.org/bottest-secret/getMe', {
      method: 'POST',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e)) as Error;

    expect(error.message).toContain('boom');
    expect(error.message).toContain(
      '[POST https://api.telegram.org/bot<redacted>/getMe proxy=false]',
    );
    // Токен бота в сообщение не попадает.
    expect(error.message).not.toContain('test-secret');
  });
});

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
  // close() может не вызвать callback, пока живёт незавершённый CONNECT-туннель,
  // поэтому не ждём его: принудительно рвём соединения и снимаем с учёта.
  const stop = (): void => {
    server.closeAllConnections?.();
    server.close();
    server.unref();
  };
  return { server, url: `http://127.0.0.1:${port}`, stop };
}

describe('requestJson (таймауты)', () => {
  it('прямой путь: превышение таймаута → telegram.request_timeout', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));

    await expect(
      requestJson('https://api.telegram.org/bottest/getUpdates', {
        timeoutMs: 20,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('telegram.request_timeout');
  });

  it('прямой путь: внешний signal → telegram.request_aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const pending = requestJson('https://api.telegram.org/bottest/getUpdates', {
      signal: controller.signal,
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('telegram.request_aborted');
  });

  it('путь с агентом прокси: зависший запрос → telegram.request_timeout', async () => {
    const { url, stop } = await startHangingServer();
    try {
      await expect(
        requestJson(`${url}/getUpdates`, {
          proxyUrl: url,
          body: '{}',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          timeoutMs: 30,
        }),
      ).rejects.toThrow('telegram.request_timeout');
    } finally {
      stop();
    }
  });

  it('путь с агентом: таймаут обогащён proxy=true и URL без токена', async () => {
    const { url, stop } = await startHangingServer();
    try {
      const error = (await requestJson(`${url}/bottest-secret/getMe`, {
        proxyUrl: url,
        body: '{}',
        method: 'POST',
        timeoutMs: 30,
      }).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('telegram.request_timeout');
      expect(error.message).toContain(`proxy=true`);
      expect(error.message).toContain('/bot<redacted>/getMe');
      expect(error.message).not.toContain('test-secret');
    } finally {
      stop();
    }
  });

  it('путь с агентом прокси: внешний signal → telegram.request_aborted', async () => {
    const { url, stop } = await startHangingServer();
    try {
      const controller = new AbortController();
      const pending = requestJson(`${url}/getUpdates`, {
        proxyUrl: url,
        body: '{}',
        timeoutMs: 5000,
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toThrow('telegram.request_aborted');
    } finally {
      stop();
    }
  });
});
