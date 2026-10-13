import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Конфигурация MCP-сервера Telegram-шлюза (`src/mcp`). */
export interface McpConfig {
  version: string;
  repoRoot: string;
  /** Каталог JSON-хранилища шлюза (`tg_status` читает привязки чатов). */
  dataDir: string;
  telegram: {
    /** Токен бота. Без него клиент работает в dry-run. */
    token?: string;
    /** URL прокси для Bot API (socks/http). */
    proxyUrl?: string;
  };
  /** Чат по умолчанию для `tg_send_message`/`tg_edit_message`/`tg_delete_message`. */
  defaultChatId?: string;
  /** Получатель `tg_notify` (по умолчанию — `defaultChatId`). */
  ownerChatId?: string;
}

/** Переопределения из CLI-флагов (приоритет выше env). */
export interface ConfigOverrides {
  dataDir?: string;
  token?: string;
  proxyUrl?: string;
  defaultChatId?: string;
  ownerChatId?: string;
  /**
   * Каталог секрет-файлов. Приоритет: `overrides.secretsDir` >
   * env `GATEWAY_SECRETS_DIR` > `<repoRoot>/secrets`.
   */
  secretsDir?: string;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Читает переменную окружения, считая пустую/whitespace-only строку отсутствием
 * значения (подстановка `{env:VAR}` при незаданной переменной даёт пустую строку).
 */
export function envOr(env: NodeJS.ProcessEnv, key: string): string | undefined;
export function envOr(env: NodeJS.ProcessEnv, key: string, fallback: string): string;
export function envOr(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback?: string,
): string | undefined {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value.length > 0 ? value : fallback;
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Читает секрет из файла каталога секретов; пустой файл = отсутствие значения. */
function readSecret(name: string, secretsDir: string): string | undefined {
  try {
    const value = readFileSync(join(secretsDir, name), 'utf8').trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Возвращает первое непустое env-значение из списка ключей. */
function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = envOr(env, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Единый порядок поиска URL прокси: env-цепочка, затем секрет-файл. */
const PROXY_ENV = ['TELEGRAM_PROXY_URL', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'];

/**
 * Загружает конфигурацию MCP-сервера. Приоритет: CLI-флаги > env > `secrets/`
 * > значения по умолчанию (те же хелперы, что в `src/gateway`).
 *
 * Поля: `TELEGRAM_BOT_TOKEN` / `secrets/telegram_bot_token`;
 * `TELEGRAM_PROXY_URL` (цепочка) / `secrets/telegram_proxy_url`;
 * `GATEWAY_DEFAULT_CHAT_ID` и `GATEWAY_OWNER_CHAT_ID` /
 * `secrets/telegram_owner_chat_id`; `GATEWAY_DATA_DIR`.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): McpConfig {
  const secretsDir =
    overrides.secretsDir ?? envOr(env, 'GATEWAY_SECRETS_DIR') ?? join(REPO_ROOT, 'secrets');
  const dataDir =
    overrides.dataDir ?? envOr(env, 'GATEWAY_DATA_DIR') ?? join(REPO_ROOT, 'data');

  const token =
    overrides.token ??
    envOr(env, 'TELEGRAM_BOT_TOKEN') ??
    readSecret('telegram_bot_token', secretsDir);
  const proxyUrl =
    overrides.proxyUrl ??
    firstEnv(env, PROXY_ENV) ??
    readSecret('telegram_proxy_url', secretsDir);

  const secretOwnerChat = readSecret('telegram_owner_chat_id', secretsDir);
  const defaultChatId =
    overrides.defaultChatId ?? envOr(env, 'GATEWAY_DEFAULT_CHAT_ID') ?? secretOwnerChat;
  const ownerChatId =
    overrides.ownerChatId ??
    envOr(env, 'GATEWAY_OWNER_CHAT_ID') ??
    secretOwnerChat ??
    defaultChatId;

  return {
    version: readVersion(),
    repoRoot: REPO_ROOT,
    dataDir,
    telegram: { token, proxyUrl },
    defaultChatId,
    ownerChatId,
  };
}
