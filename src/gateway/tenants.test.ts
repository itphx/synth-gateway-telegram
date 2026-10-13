import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TelegramClient } from '../bot-api/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthTokenProvider } from './auth.js';
import type { CommandHandler } from './command-handler.js';
import {
  DEFAULT_TENANT_ID,
  loadConfig,
  parseTenantsFile,
  tenantStoreDir,
  type ConfigOverrides,
  type TenantDefaults,
} from './config.js';
import { aggregateHealth, GatewayHealthRegistry, type HealthSnapshot } from './health.js';
import type { SynthHealthProbe } from './health-probe.js';
import type { SynthEventsClient } from './ingest.js';
import type { Poller, PollerOptions } from './poller.js';
import { createTenantRuntime } from './runtime.js';
import { createApp } from './server.js';
import { GatewayStore } from './store.js';
import type { AgentWatcher } from './watcher.js';

/** Пустой каталог секретов: изолирует тесты от реального `secrets/`. */
let emptySecretsDir: string;

beforeAll(() => {
  emptySecretsDir = mkdtempSync(join(tmpdir(), 'gateway-tenant-secrets-'));
});

afterAll(() => {
  rmSync(emptySecretsDir, { recursive: true, force: true });
});

/** Временный каталог с файлом `tenants.json`. */
function writeTenants(content: string): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-tenants-'));
  const path = join(dir, 'tenants.json');
  writeFileSync(path, content);
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Глобальные дефолты для прямого разбора `tenants.json`. */
function globals(overrides: Partial<TenantDefaults> = {}): TenantDefaults {
  return {
    telegram: {},
    synth: { baseUrl: 'http://127.0.0.1:5000/api/v2', oidc: {} },
    allowlist: {},
    parseMode: 'plain',
    unknownAction: 'register',
    watch: true,
    pollTimeoutSec: 30,
    requestTimeoutSec: 30,
    dryRun: false,
    ...overrides,
  };
}

/** `loadConfig` с герметичным каталогом секретов. */
function load(env: NodeJS.ProcessEnv, overrides: ConfigOverrides = {}) {
  return loadConfig(env, { secretsDir: emptySecretsDir, ...overrides });
}

describe('parseTenantsFile', () => {
  it('разбирает валидный файл: id, креды, allowlist (строковый и объектный), дефолты', () => {
    const tenants = parseTenantsFile(
      {
        tenants: [
          {
            id: 'dev',
            botToken: ' dev-token ',
            synthUrl: 'http://127.0.0.1:5000/api/v2/',
            serviceKey: 'synth_svc_dev',
            allowlist: '123456789:ADMIN, -1001234567890:lead',
            parseMode: 'html',
            watch: false,
            pollTimeoutSec: 45,
          },
          {
            id: 'test',
            token: 'test-token',
            synth: { url: 'https://synth.test/api/v2' },
            proxyUrl: 'http://proxy:3129',
            allowlist: { '1': 'lead', '2': 'USER' },
          },
        ],
      },
      globals({ requestTimeoutSec: 12 }),
    );

    expect(tenants.map((tenant) => tenant.id)).toEqual(['dev', 'test']);

    const [dev, test] = tenants;
    expect(dev?.telegram.token).toBe('dev-token');
    expect(dev?.synth.baseUrl).toBe('http://127.0.0.1:5000/api/v2');
    expect(dev?.synth.serviceKey).toBe('synth_svc_dev');
    expect(dev?.allowlist).toEqual({ '123456789': 'ADMIN', '-1001234567890': 'LEAD' });
    expect(dev?.parseMode).toBe('html');
    expect(dev?.watch).toBe(false);
    expect(dev?.pollTimeoutSec).toBe(45);
    expect(dev?.requestTimeoutSec).toBe(12);

    expect(test?.telegram.token).toBe('test-token');
    expect(test?.synth.baseUrl).toBe('https://synth.test/api/v2');
    expect(test?.telegram.proxyUrl).toBe('http://proxy:3129');
    expect(test?.allowlist).toEqual({ '1': 'LEAD', '2': 'USER' });
    // Дефолты (глобальные) для незаданных полей.
    expect(test?.parseMode).toBe('plain');
    expect(test?.watch).toBe(true);
    expect(test?.pollTimeoutSec).toBe(30);
  });

  it('ошибка: дублирующийся id', () => {
    expect(() =>
      parseTenantsFile(
        { tenants: [{ id: 'dev', botToken: 't' }, { id: 'dev', botToken: 't2' }] },
        globals(),
      ),
    ).toThrow(/повторяющийся id/);
  });

  it('ошибка: недопустимый id', () => {
    expect(() =>
      parseTenantsFile({ tenants: [{ id: 'Dev Bot', botToken: 't' }] }, globals()),
    ).toThrow(/недопустимый id/);
    expect(() =>
      parseTenantsFile({ tenants: [{ id: '-lead', botToken: 't' }] }, globals()),
    ).toThrow(/недопустимый id/);
  });

  it('ошибка: отсутствует id', () => {
    expect(() => parseTenantsFile({ tenants: [{ botToken: 't' }] }, globals())).toThrow(
      /отсутствует обязательное поле «id»/,
    );
  });

  it('ошибка: неизвестное поле (fail-fast — опечатка не уводит тенант на чужой Synth)', () => {
    expect(() =>
      parseTenantsFile({ tenants: [{ id: 'dev', botToken: 't', syntUrl: 'http://x' }] }, globals()),
    ).toThrow(/неизвестное поле «syntUrl»/);
  });

  it('ошибка: нет botToken вне dry-run', () => {
    expect(() => parseTenantsFile({ tenants: [{ id: 'dev' }] }, globals())).toThrow(
      /не задан botToken/,
    );
  });

  it('без botToken при форсированном dry-run — допустимо', () => {
    const tenants = parseTenantsFile({ tenants: [{ id: 'dev' }] }, globals({ dryRun: true }));
    expect(tenants[0]?.telegram.token).toBeUndefined();
  });

  it('ошибки: не объект, лишнее поле верхнего уровня, пустой список', () => {
    expect(() => parseTenantsFile([], globals())).toThrow(/ожидается объект/);
    expect(() => parseTenantsFile({ tenants: [], extra: 1 }, globals())).toThrow(
      /неизвестное поле «extra»/,
    );
    expect(() => parseTenantsFile({ tenants: [] }, globals())).toThrow(/непустым массивом/);
  });
});

describe('loadConfig: мультитенантность', () => {
  it('без файла — один legacy-тенант default из env', () => {
    const config = load({ TELEGRAM_BOT_TOKEN: 'bot' });
    expect(config.tenantsFile).toBeUndefined();
    expect(config.tenants).toHaveLength(1);
    expect(config.tenants[0]?.id).toBe(DEFAULT_TENANT_ID);
    expect(config.tenants[0]?.telegram.token).toBe('bot');
    expect(config.dryRun).toBe(false);
  });

  it('файл из --tenants-file: per-tenant значения приоритетнее глобальных дефолтов', () => {
    const tf = writeTenants(
      JSON.stringify({
        tenants: [{ id: 'dev', synthUrl: 'http://dev/api/v2', allowlist: 'dev:ADMIN' }],
      }),
    );
    try {
      const config = load(
        {
          SYNTH_URL: 'http://global/api/v2',
          GATEWAY_ALLOWLIST: 'global:USER',
          TELEGRAM_BOT_TOKEN: 'global-bot',
        },
        { tenantsFile: tf.path },
      );
      // Глобальные поля не изменились.
      expect(config.synth.baseUrl).toBe('http://global/api/v2');
      expect(config.allowlist).toEqual({ global: 'USER' });
      expect(config.tenantsFile).toBe(tf.path);
      // Тенант приоритетнее глобальных дефолтов.
      expect(config.tenants[0]?.synth.baseUrl).toBe('http://dev/api/v2');
      expect(config.tenants[0]?.allowlist).toEqual({ dev: 'ADMIN' });
      // Незаданное поле наследует глобальный дефолт.
      expect(config.tenants[0]?.telegram.token).toBe('global-bot');
      expect(config.dryRun).toBe(false);
    } finally {
      tf.cleanup();
    }
  });

  it('env GATEWAY_TENANTS_FILE используется, если флага нет', () => {
    const tf = writeTenants(JSON.stringify({ tenants: [{ id: 'test', botToken: 't' }] }));
    try {
      const config = load({ GATEWAY_TENANTS_FILE: tf.path });
      expect(config.tenantsFile).toBe(tf.path);
      expect(config.tenants[0]?.id).toBe('test');
    } finally {
      tf.cleanup();
    }
  });

  it('дефолтный путь secrets/tenants.json подхватывается автоматически', () => {
    const secrets = mkdtempSync(join(tmpdir(), 'gateway-tenant-secrets-auto-'));
    writeFileSync(
      join(secrets, 'tenants.json'),
      JSON.stringify({ tenants: [{ id: 'dev', botToken: 't' }] }),
    );
    try {
      const config = loadConfig({}, { secretsDir: secrets });
      expect(config.tenantsFile).toBe(join(secrets, 'tenants.json'));
      expect(config.tenants[0]?.id).toBe('dev');
    } finally {
      rmSync(secrets, { recursive: true, force: true });
    }
  });

  it('явный путь без файла → понятная ошибка', () => {
    expect(() => load({}, { tenantsFile: join(emptySecretsDir, 'nope.json') })).toThrow(
      /не найден файл тенантов/,
    );
  });

  it('битый JSON → понятная ошибка', () => {
    const tf = writeTenants('{ not json ');
    try {
      expect(() => load({}, { tenantsFile: tf.path })).toThrow(/некорректный JSON/);
    } finally {
      tf.cleanup();
    }
  });

  it('мульти-режим: dry-run по умолчанию false (токены у тенантов), форсируется env/флагом', () => {
    const tf = writeTenants(JSON.stringify({ tenants: [{ id: 'dev', botToken: 't' }] }));
    try {
      expect(load({}, { tenantsFile: tf.path }).dryRun).toBe(false);
      expect(load({ GATEWAY_DRY_RUN: 'true' }, { tenantsFile: tf.path }).dryRun).toBe(true);
      expect(load({}, { tenantsFile: tf.path, dryRun: true }).dryRun).toBe(true);
    } finally {
      tf.cleanup();
    }
  });
});

describe('tenantStoreDir: изоляция состояния', () => {
  it('legacy default → корень dataDir; мульти/остальные → dataDir/tenants/<id>', () => {
    expect(tenantStoreDir('/data', DEFAULT_TENANT_ID, true)).toBe('/data');
    expect(tenantStoreDir('/data', DEFAULT_TENANT_ID, false)).toBe('/data/tenants/default');
    expect(tenantStoreDir('/data', 'dev', true)).toBe('/data/tenants/dev');
    expect(tenantStoreDir('/data', 'dev', false)).toBe('/data/tenants/dev');
  });

  it('состояние тенантов не пересекается (offset/seen/chatSessions изолированы)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-tenant-state-'));
    try {
      const dev = new GatewayStore(tenantStoreDir(root, 'dev', false));
      const test = new GatewayStore(tenantStoreDir(root, 'test', false));
      await dev.init();
      await test.init();

      await dev.setOffset(11);
      await dev.markSeen(1);
      await dev.setChatSession('chat:telegram:1', {
        sessionId: 'sess_dev',
        chatId: '1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await dev.markSent('stream:dev');

      expect(await test.getOffset()).toBeUndefined();
      expect(await test.hasSeen(1)).toBe(false);
      expect(await test.getChatSession('chat:telegram:1')).toBeUndefined();
      expect(await test.getSessionRoute('sess_dev')).toBeUndefined();
      expect(await test.hasSent('stream:dev')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('health-агрегат', () => {
  function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
    return {
      synth: 'up',
      bot: 'ok',
      watcher: 'up',
      auth: 'service-key',
      token: 'ok',
      ...overrides,
    };
  }

  it('все тенанты up → агрегат ok', () => {
    expect(aggregateHealth([snapshot(), snapshot()]).status).toBe('ok');
  });

  it('один тенант down → агрегат down + плоские поля down', () => {
    const health = aggregateHealth([snapshot(), snapshot({ synth: 'down' })]);
    expect(health.status).toBe('down');
    expect(health.synth).toBe('down');
  });

  it('один тенант degraded (bot unknown/token error) → degraded', () => {
    expect(aggregateHealth([snapshot(), snapshot({ bot: 'unknown' })]).status).toBe('degraded');
    expect(aggregateHealth([snapshot(), snapshot({ token: 'error' })]).status).toBe('degraded');
  });

  it('разные режимы auth → агрегат none; смесь ok/dry-run → bot ok', () => {
    const health = aggregateHealth([
      snapshot({ auth: 'service-key' }),
      snapshot({ auth: 'oidc', bot: 'dry-run' }),
    ]);
    expect(health.auth).toBe('none');
    expect(health.bot).toBe('ok');
  });

  it('реестр: разбивка по тенантам + агрегат + отдача через GET /health', async () => {
    const registry = new GatewayHealthRegistry();
    for (const id of ['dev', 'test']) {
      const health = registry.register(id);
      health.setSynth('up');
      health.setBot('ok');
      health.setWatcher('up');
      health.setAuth('service-key');
      health.setToken('ok');
    }

    const snapshotAll = registry.snapshot();
    expect(snapshotAll.aggregate.status).toBe('ok');
    expect(Object.keys(snapshotAll.tenants)).toEqual(['dev', 'test']);

    const config = load({ GATEWAY_TENANTS_FILE: '' });
    const res = await createApp(config, registry).request('/health');
    const body = (await res.json()) as {
      status: string;
      synth: string;
      tenants: Record<string, { synth: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.synth).toBe('up');
    expect(body.tenants.dev?.synth).toBe('up');
    expect(body.tenants.test?.synth).toBe('up');

    registry.get('test')?.setSynth('down');
    const degraded = (await (await createApp(config, registry).request('/health')).json()) as {
      status: string;
      tenants: Record<string, { synth: string }>;
    };
    expect(degraded.status).toBe('down');
    expect(degraded.tenants.test?.synth).toBe('down');
    expect(degraded.tenants.dev?.synth).toBe('up');
  });
});

describe('fan-out рантаймов тенантов (seam, без сети)', () => {
  it('два тенанта → два поллера/стора в изолированных каталогах, watcher/probe на каждого', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gateway-fanout-'));
    const tf = writeTenants(
      JSON.stringify({
        tenants: [
          { id: 'dev', botToken: 'dev-token', allowlist: 'dev:ADMIN' },
          { id: 'test', botToken: 'test-token', allowlist: 'test:LEAD' },
        ],
      }),
    );
    try {
      const config = load({}, { tenantsFile: tf.path, dataDir });
      expect(config.tenants).toHaveLength(2);

      const registry = new GatewayHealthRegistry();
      const pollers: PollerOptions[] = [];
      const storeDirs: string[] = [];
      const watchers: string[] = [];
      const probes: string[] = [];

      const runtimes = [];
      for (const tenant of config.tenants) {
        runtimes.push(
          await createTenantRuntime(config, tenant, true, {
            health: registry.register(tenant.id),
            log: () => {},
            isLegacy: config.tenantsFile === undefined,
            createStore: (dir) => {
              storeDirs.push(dir);
              return { init: async () => {} } as unknown as GatewayStore;
            },
            createAuth: () =>
              ({
                mode: 'service-key',
                check: async () => 'ok',
              }) as unknown as AuthTokenProvider,
            createClient: () =>
              ({ dryRun: false, close: () => {} }) as unknown as TelegramClient,
            createEvents: () => ({}) as SynthEventsClient,
            createCommands: () => ({}) as CommandHandler,
            createPoller: (options) => {
              pollers.push(options);
              return { run: async () => {}, runOnce: async () => {}, stop: () => {} } as unknown as Poller;
            },
            createWatcher: () => {
              watchers.push('watcher');
              return {} as AgentWatcher;
            },
            createHealthProbe: () => {
              probes.push('probe');
              return {} as SynthHealthProbe;
            },
            resolveIdentity: async () => ({ botId: 1, botUsername: 'bot' }),
          }),
        );
      }

      expect(runtimes).toHaveLength(2);
      expect(pollers).toHaveLength(2);
      expect(new Set(storeDirs).size).toBe(2);
      expect(storeDirs).toContain(tenantStoreDir(dataDir, 'dev', false));
      expect(storeDirs).toContain(tenantStoreDir(dataDir, 'test', false));
      expect(watchers).toHaveLength(2);
      expect(probes).toHaveLength(2);
      // Per-tenant allowlist не смешивается.
      expect(pollers.map((options) => options.allowlist)).toEqual([
        { dev: 'ADMIN' },
        { test: 'LEAD' },
      ]);
    } finally {
      tf.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('legacy-режим: единственный тенант default пишет в корень dataDir', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gateway-legacy-'));
    try {
      const config = load({ TELEGRAM_BOT_TOKEN: 'bot' }, { dataDir });
      const storeDirs: string[] = [];
      await createTenantRuntime(config, config.tenants[0]!, false, {
        health: new GatewayHealthRegistry().register('default'),
        log: () => {},
        isLegacy: true,
        createStore: (dir) => {
          storeDirs.push(dir);
          return { init: async () => {} } as unknown as GatewayStore;
        },
        createAuth: () => ({ mode: 'api-key', check: async () => 'ok' }) as unknown as AuthTokenProvider,
        createClient: () => ({ dryRun: false, close: () => {} }) as unknown as TelegramClient,
        createEvents: () => ({}) as SynthEventsClient,
        createCommands: () => ({}) as CommandHandler,
        createPoller: () => ({ run: async () => {}, stop: () => {} }) as unknown as Poller,
        resolveIdentity: async () => ({}),
      });
      expect(storeDirs).toEqual([dataDir]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
