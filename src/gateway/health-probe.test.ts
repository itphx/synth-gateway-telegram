import { describe, expect, it, vi } from 'vitest';

import { GatewayHealth } from './health.js';
import { SynthHealthProbe } from './health-probe.js';

describe('SynthHealthProbe', () => {
  it('успешный ответ → up и правильный путь /health', async () => {
    const health = new GatewayHealth();
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{"status":"healthy"}', { status: 200 }),
    );
    const probe = new SynthHealthProbe({
      baseUrl: 'http://synth.local:5000/api/v2/',
      health,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(health.snapshot().synth).toBe('down');
    expect(await probe.probe()).toBe('up');
    expect(health.snapshot().synth).toBe('up');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://synth.local:5000/api/v2/health');
  });

  it('HTTP-ошибка → down', async () => {
    const health = new GatewayHealth();
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const probe = new SynthHealthProbe({
      baseUrl: 'http://synth.local:5000/api/v2',
      health,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await probe.probe()).toBe('down');
    expect(health.snapshot().synth).toBe('down');
  });

  it('сетевая ошибка → down, исключение не пробрасывается', async () => {
    const health = new GatewayHealth();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const probe = new SynthHealthProbe({
      baseUrl: 'http://synth.local:5000/api/v2',
      health,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await probe.probe()).toBe('down');
    expect(health.snapshot().synth).toBe('down');
  });

  it('превышение короткого таймаута → down (зависший запрос не блокирует)', async () => {
    const health = new GatewayHealth();
    const logs: string[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const probe = new SynthHealthProbe({
      baseUrl: 'http://synth.local:5000/api/v2',
      health,
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (message) => logs.push(message),
    });

    expect(await probe.probe()).toBe('down');
    expect(health.snapshot().synth).toBe('down');
    expect(logs.join('\n')).toContain('health-проба Synth');
  });
});
