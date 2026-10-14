import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POLL_TIMEOUT_SEC,
  DEFAULT_PORT,
  DEFAULT_REQUEST_TIMEOUT_SEC,
  DEFAULT_SYNTH_URL,
  envOr,
  loadConfig,
  parseAllowlist,
  parseBool,
  type ConfigOverrides,
} from './config.js';

/** Пустой каталог секретов: изолирует тесты от реального `secrets/`. */
let emptySecretsDir: string;

beforeAll(() => {
  emptySecretsDir = mkdtempSync(join(tmpdir(), 'gateway-secrets-empty-'));
});

afterAll(() => {
  rmSync(emptySecretsDir, { recursive: true, force: true });
});

/** `loadConfig` с герметичным пустым каталогом секретов по умолчанию. */
function load(env: NodeJS.ProcessEnv, overrides: ConfigOverrides = {}) {
  return loadConfig(env, { secretsDir: emptySecretsDir, ...overrides });
}

/** Создаёт временный каталог секретов с заданными файлами. */
function withSecrets(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-secrets-'));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), value);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('envOr', () => {
  it('отсутствующее/пустое/whitespace значение → fallback, иначе trim', () => {
    expect(envOr({}, 'X')).toBeUndefined();
    expect(envOr({}, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '' }, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '   ' }, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '  v  ' }, 'X', 'fb')).toBe('v');
  });
});

describe('parseBool', () => {
  it('распознаёт true/false-значения и игнорирует прочее', () => {
    expect(parseBool('1')).toBe(true);
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('on')).toBe(true);
    expect(parseBool('0')).toBe(false);
    expect(parseBool('no')).toBe(false);
    expect(parseBool('')).toBeUndefined();
    expect(parseBool('maybe')).toBeUndefined();
  });
});

describe('parseAllowlist', () => {
  it('разбирает chatId:ROLE, нормализует роль, игнорирует мусор', () => {
    expect(parseAllowlist('123456789:ADMIN, -1001234567890:lead')).toEqual({
      '123456789': 'ADMIN',
      '-1001234567890': 'LEAD',
    });
    expect(parseAllowlist('')).toEqual({});
    expect(parseAllowlist('bad, :ROLE, 123:')).toEqual({});
  });
});

describe('loadConfig', () => {
  it('значения по умолчанию', () => {
    const config = load({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.synth.baseUrl).toBe(DEFAULT_SYNTH_URL);
    expect(config.telegram.token).toBeUndefined();
    expect(config.synth.apiKey).toBeUndefined();
    expect(config.allowlist).toEqual({});
    // Без токена шлюз уходит в dry-run.
    expect(config.dryRun).toBe(true);
    expect(config.dataDir).toBe(load({}).dataDir);
  });

  it('пустая строка env (подстановка opencode {env:VAR}) → значения по умолчанию', () => {
    const config = load({
      GATEWAY_HOST: '',
      GATEWAY_PORT: '',
      SYNTH_URL: '',
      TELEGRAM_BOT_TOKEN: '',
      GATEWAY_DATA_DIR: '',
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.synth.baseUrl).toBe(DEFAULT_SYNTH_URL);
    expect(config.telegram.token).toBeUndefined();
    expect(config.dataDir).toBe(load({}).dataDir);
  });

  it('непустое env читается и обрезается по краям', () => {
    const config = load({
      GATEWAY_HOST: '  0.0.0.0  ',
      GATEWAY_PORT: ' 7200 ',
      TELEGRAM_BOT_TOKEN: ' bot-token ',
      SYNTH_URL: ' http://synth.local:5000/api/v2/ ',
      SYNTH_API_KEY: ' key ',
      GATEWAY_DATA_DIR: ' /tmp/gateway-data ',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(7200);
    expect(config.telegram.token).toBe('bot-token');
    expect(config.synth.baseUrl).toBe('http://synth.local:5000/api/v2');
    expect(config.synth.apiKey).toBe('key');
    expect(config.dataDir).toBe('/tmp/gateway-data');
    expect(config.dryRun).toBe(false);
  });

  it('CLI-флаги переопределяют env', () => {
    const config = load(
      {
        GATEWAY_HOST: '1.2.3.4',
        GATEWAY_PORT: '1',
        TELEGRAM_BOT_TOKEN: 'env',
        SYNTH_URL: 'http://env/api/v2',
        GATEWAY_ALLOWLIST: '1:USER',
      },
      {
        host: 'cli',
        port: 9,
        token: 'cli',
        dataDir: '/cli',
        synthUrl: 'http://cli/api/v2',
        allowlist: '2:ADMIN',
        dryRun: true,
      },
    );
    expect(config.host).toBe('cli');
    expect(config.port).toBe(9);
    expect(config.telegram.token).toBe('cli');
    expect(config.dataDir).toBe('/cli');
    expect(config.synth.baseUrl).toBe('http://cli/api/v2');
    expect(config.allowlist).toEqual({ '2': 'ADMIN' });
    expect(config.dryRun).toBe(true);
  });

  it('GATEWAY_ALLOWLIST из env парсится в объект', () => {
    expect(load({ GATEWAY_ALLOWLIST: '123456789:ADMIN' }).allowlist).toEqual({
      '123456789': 'ADMIN',
    });
  });

  it('dry-run: явный флаг сильнее наличия токена, env GATEWAY_DRY_RUN учитывается', () => {
    expect(load({ TELEGRAM_BOT_TOKEN: 't' }).dryRun).toBe(false);
    expect(load({ TELEGRAM_BOT_TOKEN: 't', GATEWAY_DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(load({ TELEGRAM_BOT_TOKEN: 't', GATEWAY_DRY_RUN: 'false' }).dryRun).toBe(false);
    // Пустое значение env → вычисляется по наличию токена.
    expect(load({ TELEGRAM_BOT_TOKEN: 't', GATEWAY_DRY_RUN: '' }).dryRun).toBe(false);
    expect(load({}).dryRun).toBe(true);
  });

  it('parseMode: html/markdown распознаются, прочее/пусто → plain, CLI приоритетнее', () => {
    expect(load({}).parseMode).toBe('plain');
    expect(load({ GATEWAY_PARSE_MODE: 'HTML' }).parseMode).toBe('html');
    expect(load({ GATEWAY_PARSE_MODE: 'Markdown' }).parseMode).toBe('markdown');
    expect(load({ GATEWAY_PARSE_MODE: 'bogus' }).parseMode).toBe('plain');
    expect(load({ GATEWAY_PARSE_MODE: 'html' }, { parseMode: 'plain' }).parseMode).toBe('plain');
    expect(load({ GATEWAY_PARSE_MODE: 'plain' }, { parseMode: 'markdown' }).parseMode).toBe(
      'markdown',
    );
  });

  it('watch: по умолчанию true; env/флаг выключают', () => {
    expect(load({}).watch).toBe(true);
    expect(load({ GATEWAY_WATCH: 'false' }).watch).toBe(false);
    expect(load({ GATEWAY_WATCH: 'true' }, { watch: false }).watch).toBe(false);
  });

  it('unknownAction: дефолт register, env/CLI, неизвестное → register', () => {
    expect(load({}).unknownAction).toBe('register');
    expect(load({ GATEWAY_UNKNOWN_ACTION: 'hint' }).unknownAction).toBe('hint');
    expect(load({ GATEWAY_UNKNOWN_ACTION: ' REJECT ' }).unknownAction).toBe('reject');
    expect(load({ GATEWAY_UNKNOWN_ACTION: 'bogus' }).unknownAction).toBe('register');
    expect(load({ GATEWAY_UNKNOWN_ACTION: '' }).unknownAction).toBe('register');
    // CLI сильнее env.
    expect(
      load({ GATEWAY_UNKNOWN_ACTION: 'hint' }, { unknownAction: 'reject' }).unknownAction,
    ).toBe('reject');
  });

  it('таймауты: дефолты, env, CLI-приоритет, невалидные значения → дефолт', () => {
    expect(load({}).pollTimeoutSec).toBe(DEFAULT_POLL_TIMEOUT_SEC);
    expect(load({}).requestTimeoutSec).toBe(DEFAULT_REQUEST_TIMEOUT_SEC);

    const fromEnv = load({ GATEWAY_POLL_TIMEOUT_SEC: '45', GATEWAY_REQUEST_TIMEOUT_SEC: '15' });
    expect(fromEnv.pollTimeoutSec).toBe(45);
    expect(fromEnv.requestTimeoutSec).toBe(15);

    // Невалидные/неположительные значения игнорируются.
    expect(load({ GATEWAY_POLL_TIMEOUT_SEC: '0' }).pollTimeoutSec).toBe(DEFAULT_POLL_TIMEOUT_SEC);
    expect(load({ GATEWAY_REQUEST_TIMEOUT_SEC: 'bogus' }).requestTimeoutSec).toBe(
      DEFAULT_REQUEST_TIMEOUT_SEC,
    );

    // CLI сильнее env.
    expect(
      load({ GATEWAY_POLL_TIMEOUT_SEC: '45' }, { pollTimeoutSec: 5 }).pollTimeoutSec,
    ).toBe(5);
    expect(
      load({ GATEWAY_REQUEST_TIMEOUT_SEC: '45' }, { requestTimeoutSec: 7 }).requestTimeoutSec,
    ).toBe(7);
  });
});

describe('loadConfig: секрет-файлы', () => {
  it('читает токен/прокси из secretsDir, если env не задан', () => {
    const secrets = withSecrets({
      telegram_bot_token: 'file-token\n',
      telegram_proxy_url: 'socks5://proxy:9050\n',
    });
    try {
      const config = loadConfig({}, { secretsDir: secrets.dir });
      expect(config.telegram.token).toBe('file-token');
      expect(config.telegram.proxyUrl).toBe('socks5://proxy:9050');
      expect(config.dryRun).toBe(false);
    } finally {
      secrets.cleanup();
    }
  });

  it('env имеет приоритет над секрет-файлом', () => {
    const secrets = withSecrets({ telegram_proxy_url: 'socks5://file:9050' });
    try {
      const config = load(
        { TELEGRAM_PROXY_URL: 'socks5://env:9050' },
        { secretsDir: secrets.dir },
      );
      expect(config.telegram.proxyUrl).toBe('socks5://env:9050');
    } finally {
      secrets.cleanup();
    }
  });

  it('пустой/whitespace-only секрет-файл эквивалентен отсутствию', () => {
    const secrets = withSecrets({ telegram_bot_token: '   \n' });
    try {
      const config = loadConfig({}, { secretsDir: secrets.dir });
      expect(config.telegram.token).toBeUndefined();
      expect(config.dryRun).toBe(true);
    } finally {
      secrets.cleanup();
    }
  });

  it('список доступа читается из secrets/allowlist.json', () => {
    const secrets = withSecrets({ 'allowlist.json': '{"123456789":"admin"}\n' });
    try {
      expect(loadConfig({}, { secretsDir: secrets.dir }).allowlist).toEqual({
        '123456789': 'ADMIN',
      });
    } finally {
      secrets.cleanup();
    }
  });

  it('env GATEWAY_ALLOWLIST имеет приоритет над файлом allowlist.json', () => {
    const secrets = withSecrets({ 'allowlist.json': '{"1":"ADMIN"}' });
    try {
      const config = loadConfig({ GATEWAY_ALLOWLIST: '2:LEAD' }, { secretsDir: secrets.dir });
      expect(config.allowlist).toEqual({ '2': 'LEAD' });
    } finally {
      secrets.cleanup();
    }
  });
});

describe('loadConfig: OIDC и fallback на API-ключ', () => {
  it('дефолт: OIDC не задан, apiKey не задан', () => {
    const config = load({});
    expect(config.synth.oidc).toEqual({
      tokenUrl: undefined,
      discoveryUrl: undefined,
      clientId: undefined,
      clientSecret: undefined,
      scope: undefined,
    });
  });

  it('читает OIDC из env и обрезает значения', () => {
    const config = load({
      SYNTH_OIDC_TOKEN_URL: ' https://idp/token ',
      SYNTH_OIDC_CLIENT_ID: ' gateway ',
      SYNTH_OIDC_CLIENT_SECRET: ' secret ',
      SYNTH_OIDC_SCOPE: ' openid ',
    });
    expect(config.synth.oidc.tokenUrl).toBe('https://idp/token');
    expect(config.synth.oidc.clientId).toBe('gateway');
    expect(config.synth.oidc.clientSecret).toBe('secret');
    expect(config.synth.oidc.scope).toBe('openid');
  });

  it('пустая строка env = отсутствие значения', () => {
    const config = load({ SYNTH_OIDC_CLIENT_ID: '', SYNTH_OIDC_TOKEN_URL: '   ' });
    expect(config.synth.oidc.clientId).toBeUndefined();
    expect(config.synth.oidc.tokenUrl).toBeUndefined();
  });

  it('CLI-флаги приоритетнее env', () => {
    const config = load(
      { SYNTH_OIDC_TOKEN_URL: 'https://env/token', SYNTH_OIDC_CLIENT_ID: 'env' },
      {
        oidcTokenUrl: 'https://cli/token',
        oidcDiscoveryUrl: 'https://cli/.well-known/openid-configuration',
        oidcClientId: 'cli',
        oidcClientSecret: 'cli-secret',
        oidcScope: 'cli-scope',
      },
    );
    expect(config.synth.oidc).toEqual({
      tokenUrl: 'https://cli/token',
      discoveryUrl: 'https://cli/.well-known/openid-configuration',
      clientId: 'cli',
      clientSecret: 'cli-secret',
      scope: 'cli-scope',
    });
  });

  it('fallback на секрет-файлы oidc_*', () => {
    const secrets = withSecrets({
      oidc_token_url: 'https://file/token\n',
      oidc_client_id: 'file-client\n',
      oidc_client_secret: 'file-secret\n',
      oidc_scope: 'file-scope\n',
    });
    try {
      const config = loadConfig({}, { secretsDir: secrets.dir });
      expect(config.synth.oidc.tokenUrl).toBe('https://file/token');
      expect(config.synth.oidc.clientId).toBe('file-client');
      expect(config.synth.oidc.clientSecret).toBe('file-secret');
      expect(config.synth.oidc.scope).toBe('file-scope');
    } finally {
      secrets.cleanup();
    }
  });

  it('--api-key мапится в synth.apiKey (fallback standalone)', () => {
    expect(load({}, { synthApiKey: 'cli-key' }).synth.apiKey).toBe('cli-key');
    expect(load({ SYNTH_API_KEY: 'env-key' }).synth.apiKey).toBe('env-key');
  });

  it('apiKey из секрет-файла synth_api_key, если env/CLI не заданы', () => {
    const secrets = withSecrets({ synth_api_key: 'file-key\n' });
    try {
      expect(loadConfig({}, { secretsDir: secrets.dir }).synth.apiKey).toBe('file-key');
    } finally {
      secrets.cleanup();
    }
  });

  it('apiKey: приоритет CLI > env > файл', () => {
    const secrets = withSecrets({ synth_api_key: 'file-key' });
    try {
      expect(
        loadConfig(
          { SYNTH_API_KEY: 'env-key' },
          { secretsDir: secrets.dir, synthApiKey: 'cli-key' },
        ).synth.apiKey,
      ).toBe('cli-key');
      expect(
        loadConfig({ SYNTH_API_KEY: 'env-key' }, { secretsDir: secrets.dir }).synth.apiKey,
      ).toBe('env-key');
      expect(loadConfig({}, { secretsDir: secrets.dir }).synth.apiKey).toBe('file-key');
    } finally {
      secrets.cleanup();
    }
  });

  it('apiKey: пустой/whitespace-only файл synth_api_key = не задано', () => {
    const secrets = withSecrets({ synth_api_key: '   \n' });
    try {
      expect(loadConfig({}, { secretsDir: secrets.dir }).synth.apiKey).toBeUndefined();
    } finally {
      secrets.cleanup();
    }
  });

  it('apiKey: пустая строка env не перекрывает файл synth_api_key', () => {
    const secrets = withSecrets({ synth_api_key: 'file-key' });
    try {
      expect(loadConfig({ SYNTH_API_KEY: '' }, { secretsDir: secrets.dir }).synth.apiKey).toBe(
        'file-key',
      );
    } finally {
      secrets.cleanup();
    }
  });

  it('serviceKey: env/CLI мапятся в synth.serviceKey', () => {
    expect(load({}, { serviceKey: 'cli-svc' }).synth.serviceKey).toBe('cli-svc');
    expect(load({ SYNTH_SERVICE_KEY: 'env-svc' }).synth.serviceKey).toBe('env-svc');
  });

  it('serviceKey из секрет-файла synth_service_key, если env/CLI не заданы', () => {
    const secrets = withSecrets({ synth_service_key: 'file-svc\n' });
    try {
      expect(loadConfig({}, { secretsDir: secrets.dir }).synth.serviceKey).toBe('file-svc');
    } finally {
      secrets.cleanup();
    }
  });

  it('serviceKey: приоритет CLI > env > файл', () => {
    const secrets = withSecrets({ synth_service_key: 'file-svc' });
    try {
      expect(
        loadConfig(
          { SYNTH_SERVICE_KEY: 'env-svc' },
          { secretsDir: secrets.dir, serviceKey: 'cli-svc' },
        ).synth.serviceKey,
      ).toBe('cli-svc');
      expect(
        loadConfig({ SYNTH_SERVICE_KEY: 'env-svc' }, { secretsDir: secrets.dir }).synth.serviceKey,
      ).toBe('env-svc');
      expect(loadConfig({}, { secretsDir: secrets.dir }).synth.serviceKey).toBe('file-svc');
    } finally {
      secrets.cleanup();
    }
  });

  it('serviceKey: пустой/whitespace env/файл = не задано', () => {
    const secrets = withSecrets({ synth_service_key: '   \n' });
    try {
      expect(loadConfig({}, { secretsDir: secrets.dir }).synth.serviceKey).toBeUndefined();
      expect(
        loadConfig({ SYNTH_SERVICE_KEY: '' }, { secretsDir: secrets.dir }).synth.serviceKey,
      ).toBeUndefined();
    } finally {
      secrets.cleanup();
    }
  });

  it('serviceKey и apiKey независимы (service-key не подменяет legacy-ключ)', () => {
    const config = load({ SYNTH_SERVICE_KEY: 'svc', SYNTH_API_KEY: 'legacy' });
    expect(config.synth.serviceKey).toBe('svc');
    expect(config.synth.apiKey).toBe('legacy');
  });
});

describe('loadConfig: proxyUrl', () => {
  it('приоритет: TELEGRAM_PROXY_URL > ALL_PROXY > HTTPS_PROXY > HTTP_PROXY', () => {
    expect(
      load({ ALL_PROXY: 'b', HTTPS_PROXY: 'c', HTTP_PROXY: 'd' }).telegram.proxyUrl,
    ).toBe('b');
    expect(load({ HTTPS_PROXY: 'c', HTTP_PROXY: 'd' }).telegram.proxyUrl).toBe('c');
    expect(load({ HTTP_PROXY: 'd' }).telegram.proxyUrl).toBe('d');
  });

  it('пустая строка env (${TELEGRAM_PROXY_URL:-}) → как если бы не задано → fallback на файл', () => {
    const secrets = withSecrets({ telegram_proxy_url: 'socks5://file:9050' });
    try {
      const config = load({ TELEGRAM_PROXY_URL: '' }, { secretsDir: secrets.dir });
      expect(config.telegram.proxyUrl).toBe('socks5://file:9050');
    } finally {
      secrets.cleanup();
    }
  });
});
