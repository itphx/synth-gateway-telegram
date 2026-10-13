import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { envOr, loadConfig, type ConfigOverrides } from './config.js';

/** Пустой каталог секретов: изолирует тесты от реального `secrets/`. */
let emptySecretsDir: string;

beforeAll(() => {
  emptySecretsDir = mkdtempSync(join(tmpdir(), 'gateway-mcp-secrets-empty-'));
});

afterAll(() => {
  rmSync(emptySecretsDir, { recursive: true, force: true });
});

function load(env: NodeJS.ProcessEnv, overrides: ConfigOverrides = {}) {
  return loadConfig(env, { secretsDir: emptySecretsDir, ...overrides });
}

function withSecrets(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-mcp-secrets-'));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), value);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('envOr', () => {
  it('пустая/whitespace строка → fallback, иначе trim', () => {
    expect(envOr({}, 'X')).toBeUndefined();
    expect(envOr({ X: '' }, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '  v  ' }, 'X', 'fb')).toBe('v');
  });
});

describe('loadConfig (MCP)', () => {
  it('значения по умолчанию: без токена, чатов нет', () => {
    const config = load({});
    expect(config.telegram.token).toBeUndefined();
    expect(config.telegram.proxyUrl).toBeUndefined();
    expect(config.defaultChatId).toBeUndefined();
    expect(config.ownerChatId).toBeUndefined();
    expect(config.dataDir).toBe(load({}).dataDir);
  });

  it('пустая строка env → отсутствие значения', () => {
    const config = load({
      TELEGRAM_BOT_TOKEN: '',
      GATEWAY_DEFAULT_CHAT_ID: '',
      GATEWAY_OWNER_CHAT_ID: '',
    });
    expect(config.telegram.token).toBeUndefined();
    expect(config.defaultChatId).toBeUndefined();
    expect(config.ownerChatId).toBeUndefined();
  });

  it('CLI-флаги переопределяют env', () => {
    const config = load(
      { TELEGRAM_BOT_TOKEN: 'env', GATEWAY_DEFAULT_CHAT_ID: '1' },
      { token: 'cli', defaultChatId: '2', ownerChatId: '3', dataDir: '/cli' },
    );
    expect(config.telegram.token).toBe('cli');
    expect(config.defaultChatId).toBe('2');
    expect(config.ownerChatId).toBe('3');
    expect(config.dataDir).toBe('/cli');
  });

  it('читает токен/прокси/owner из secretsDir', () => {
    const secrets = withSecrets({
      telegram_bot_token: 'file-token\n',
      telegram_proxy_url: 'socks5://proxy:9050\n',
      telegram_owner_chat_id: '123456789\n',
    });
    try {
      const config = loadConfig({}, { secretsDir: secrets.dir });
      expect(config.telegram.token).toBe('file-token');
      expect(config.telegram.proxyUrl).toBe('socks5://proxy:9050');
      expect(config.defaultChatId).toBe('123456789');
      expect(config.ownerChatId).toBe('123456789');
    } finally {
      secrets.cleanup();
    }
  });

  it('env имеет приоритет над секрет-файлом; owner из секрета при наличии', () => {
    const secrets = withSecrets({ telegram_owner_chat_id: 'secret-owner' });
    try {
      const config = load(
        { TELEGRAM_PROXY_URL: 'socks5://env:9050', GATEWAY_DEFAULT_CHAT_ID: 'env-default' },
        { secretsDir: secrets.dir },
      );
      expect(config.telegram.proxyUrl).toBe('socks5://env:9050');
      expect(config.defaultChatId).toBe('env-default');
      // owner задан секретом — он приоритетнее default.
      expect(config.ownerChatId).toBe('secret-owner');
    } finally {
      secrets.cleanup();
    }
  });

  it('owner наследует defaultChatId, если не задан явно', () => {
    const config = load({ GATEWAY_DEFAULT_CHAT_ID: '42' });
    expect(config.defaultChatId).toBe('42');
    expect(config.ownerChatId).toBe('42');
  });

  it('прокси: TELEGRAM_PROXY_URL > ALL_PROXY > HTTPS_PROXY > HTTP_PROXY', () => {
    expect(load({ ALL_PROXY: 'b', HTTPS_PROXY: 'c' }).telegram.proxyUrl).toBe('b');
    expect(load({ HTTPS_PROXY: 'c' }).telegram.proxyUrl).toBe('c');
  });
});
