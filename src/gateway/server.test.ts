import { describe, expect, it } from 'vitest';

import type { GatewayConfig } from './config.js';
import { createApp } from './server.js';

const config: GatewayConfig = {
  version: 'test',
  repoRoot: '/tmp',
  dataDir: '/tmp',
  host: '127.0.0.1',
  port: 0,
  dryRun: true,
  tenants: [
    {
      id: 'default',
      telegram: {},
      synth: { baseUrl: 'http://127.0.0.1:5000/api/v2', oidc: {} },
      allowlist: {},
      parseMode: 'plain',
      unknownAction: 'register',
      watch: true,
      pollTimeoutSec: 30,
      requestTimeoutSec: 30,
    },
  ],
  watch: true,
  parseMode: 'plain',
  unknownAction: 'register',
  pollTimeoutSec: 30,
  requestTimeoutSec: 30,
  telegram: {},
  synth: { baseUrl: 'http://127.0.0.1:5000/api/v2', oidc: {} },
  allowlist: {},
};

describe('HTTP health-сервер шлюза', () => {
  it('GET /health отвечает 200 без auth', async () => {
    const res = await createApp(config).request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      source: string;
      synth: string;
      bot: string;
      watcher: string;
      auth: string;
      token: string;
    };
    expect(body).toMatchObject({
      status: 'ok',
      version: 'test',
      source: 'telegram',
      auth: 'none',
      token: 'error',
    });
  });

  it('GET /health отражает состояние health (best-effort)', async () => {
    const { GatewayHealth } = await import('./health.js');
    const health = new GatewayHealth();
    health.setSynth('up');
    health.setWatcher('up');
    health.setBot('ok');
    health.setAuth('oidc');
    health.setToken('ok');
    const res = await createApp(config, health).request('/health');
    expect(await res.json()).toMatchObject({
      synth: 'up',
      bot: 'ok',
      watcher: 'up',
      auth: 'oidc',
      token: 'ok',
    });
  });

  it('GET /health отражает режим service-key (AD-052)', async () => {
    const { GatewayHealth } = await import('./health.js');
    const health = new GatewayHealth();
    health.setAuth('service-key');
    health.setToken('ok');
    const res = await createApp(config, health).request('/health');
    expect(await res.json()).toMatchObject({ auth: 'service-key', token: 'ok' });
  });

  it('GET /api/health отвечает 200 без auth', async () => {
    expect((await createApp(config).request('/api/health')).status).toBe(200);
  });

  it('404 на неизвестном маршруте', async () => {
    const res = await createApp(config).request('/api/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
