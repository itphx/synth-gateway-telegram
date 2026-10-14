import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OidcAuthConfig } from './auth.js';
import { parseUnknownAction, type UnknownAction } from './unknown-action.js';

/**
 * Режим отправки ответов в Telegram: `plain` (по умолчанию), `html` (рендер
 * Markdown в Telegram-HTML) или `markdown` (Bot API 10.1 «Rich Messages»:
 * нативные таблицы/заголовки/списки + стриминг черновика).
 */
export type ParseMode = 'plain' | 'html' | 'markdown';

/**
 * Конфигурация одного тенанта (бот → среда Synth).
 *
 * Шлюз обслуживает N ботов, каждый привязан к своей среде Synth (`synth.baseUrl`
 * + креды). Настройки, не заданные в `tenants.json` для тенанта, берутся из
 * глобальных дефолтов (env/CLI/`secrets/`) — см. {@link loadConfig}.
 */
export interface TenantConfig {
  /** Ключ тенанта (`[a-z0-9][a-z0-9_-]*`); уникален в пределах процесса. */
  id: string;
  telegram: {
    /** Токен бота. Без него тенант уходит в dry-run. */
    token?: string;
    /** URL прокси для Bot API (socks/http). */
    proxyUrl?: string;
  };
  synth: {
    /** Базовый URL API v2 (например, `http://127.0.0.1:5000/api/v2`). */
    baseUrl: string;
    /** Scoped service-key `synth_svc_…` (AD-052) — приоритетная аутентификация. */
    serviceKey?: string;
    /** Служебный Bearer-ключ (`SYNTH_API_KEY`) — legacy-fallback. */
    apiKey?: string;
    /** OIDC client-credentials (managed-режим). */
    oidc: OidcAuthConfig;
  };
  /** Список доступа: `chatId → роль` (`ADMIN`/`USER`/`LEAD`/`AUDITOR`). */
  allowlist: Record<string, string>;
  /** Режим отправки ответов в Telegram. */
  parseMode: ParseMode;
  /** Политика отправителя, не сопоставленного с учётной записью Synth. */
  unknownAction: UnknownAction;
  /** Поднимать ли watcher ответов агента (SSE). */
  watch: boolean;
  /** Таймаут long-polling `getUpdates`, сек. */
  pollTimeoutSec: number;
  /** Таймаут обычных (не long-poll) запросов Bot API, сек. */
  requestTimeoutSec: number;
}

/**
 * Конфигурация процесса Telegram-шлюза (add-on `@itphx/synth-gateway-telegram`).
 *
 * Глобальные поля (`telegram`/`synth`/`allowlist`/`parseMode`/`unknownAction`/
 * `watch`/таймауты) — **дефолты** для тенантов: в legacy-режиме (без
 * `tenants.json`) они образуют единственный тенант `default`. В мульти-режиме
 * per-tenant значения из файла приоритетнее этих дефолтов.
 */
export interface GatewayConfig {
  version: string;
  /** Корень репозитория add-on'а (для дефолтов data/secrets). */
  repoRoot: string;
  /** Корневой каталог JSON-хранилища шлюза (тенанты изолируются подкаталогами). */
  dataDir: string;
  /** Адрес прослушивания health-сервера. */
  host: string;
  /** Порт health-сервера. */
  port: number;
  /** Режим без токена: один проход `getUpdates` и выход. */
  dryRun: boolean;
  /**
   * Тенанты процесса (длина ≥ 1). В legacy-режиме — единственный `default`
   * из глобальных env/CLI; в мульти-режиме — из `tenants.json`.
   */
  tenants: TenantConfig[];
  /**
   * Путь к `tenants.json`, если мультитенантность включена файлом; иначе
   * `undefined` (legacy-режим — один тенант `default`, состояние в корне
   * `dataDir` без миграции).
   */
  tenantsFile?: string;
  /** Поднимать ли watcher ответов агента (SSE) — глобальный дефолт. */
  watch: boolean;
  /** Режим отправки ответов в Telegram — глобальный дефолт. */
  parseMode: ParseMode;
  /**
   * Политика для отправителя, не сопоставленного с учётной записью Synth
   * (`GATEWAY_UNKNOWN_ACTION`; «известность» резолвит ядро, этап 3):
   * `register` — публиковать (текущее поведение), `hint` — публиковать и
   * подсказать, `reject` — не публиковать и ответить отказом. Глобальный дефолт.
   */
  unknownAction: UnknownAction;
  /** Таймаут long-polling `getUpdates`, сек — глобальный дефолт. */
  pollTimeoutSec: number;
  /** Таймаут обычных (не long-poll) запросов Bot API, сек — глобальный дефолт. */
  requestTimeoutSec: number;
  telegram: {
    /** Токен бота (глобальный дефолт). Без него клиент уходит в dry-run. */
    token?: string;
    /** URL прокси для Bot API (socks/http) — глобальный дефолт. */
    proxyUrl?: string;
  };
  synth: {
    /** Базовый URL API v2 (глобальный дефолт). */
    baseUrl: string;
    /**
     * Scoped service-key `synth_svc_…` (AD-052, этап IV) — приоритетная машинная
     * аутентификация: CLI `--service-key` > env `SYNTH_SERVICE_KEY` >
     * `secrets/synth_service_key`. Задан явно — он главный (выше OIDC/`apiKey`).
     */
    serviceKey?: string;
    /**
     * Служебный Bearer-ключ для `/events` и управления bindings (standalone/dev,
     * legacy-fallback): CLI `--api-key`/`--synth-api-key` > env `SYNTH_API_KEY` >
     * `secrets/synth_api_key`.
     */
    apiKey?: string;
    /** OIDC client-credentials (managed-режим). */
    oidc: OidcAuthConfig;
  };
  /** Список доступа: `chatId → роль` — глобальный дефолт. */
  allowlist: Record<string, string>;
}

/** Переопределения из CLI-флагов (приоритет выше env). */
export interface ConfigOverrides {
  dataDir?: string;
  host?: string;
  port?: number;
  dryRun?: boolean;
  /** Поднимать ли watcher (флаг `--no-watch` задаёт `false`). */
  watch?: boolean;
  /** Режим отправки ответов (env `GATEWAY_PARSE_MODE`). */
  parseMode?: ParseMode;
  /** Политика неизвестного отправителя (env `GATEWAY_UNKNOWN_ACTION`). */
  unknownAction?: UnknownAction;
  /** Таймаут long-polling `getUpdates`, сек (env `GATEWAY_POLL_TIMEOUT_SEC`). */
  pollTimeoutSec?: number;
  /** Таймаут обычных запросов Bot API, сек (env `GATEWAY_REQUEST_TIMEOUT_SEC`). */
  requestTimeoutSec?: number;
  token?: string;
  proxyUrl?: string;
  synthUrl?: string;
  /** Scoped service-key (env `SYNTH_SERVICE_KEY`, `secrets/synth_service_key`). */
  serviceKey?: string;
  synthApiKey?: string;
  /** OIDC token-эндпоинт (env `SYNTH_OIDC_TOKEN_URL`, `secrets/oidc_token_url`). */
  oidcTokenUrl?: string;
  /** OIDC discovery URL (env `SYNTH_OIDC_DISCOVERY_URL`). */
  oidcDiscoveryUrl?: string;
  /** OIDC client_id (env `SYNTH_OIDC_CLIENT_ID`, `secrets/oidc_client_id`). */
  oidcClientId?: string;
  /** OIDC client_secret (env `SYNTH_OIDC_CLIENT_SECRET`, `secrets/oidc_client_secret`). */
  oidcClientSecret?: string;
  /** OIDC scope (env `SYNTH_OIDC_SCOPE`, `secrets/oidc_scope`). */
  oidcScope?: string;
  /** Список доступа строкой `chatId:ROLE,chatId:ROLE`. */
  allowlist?: string;
  /**
   * Каталог секрет-файлов. Приоритет: `overrides.secretsDir` >
   * env `GATEWAY_SECRETS_DIR` > `<repoRoot>/secrets`.
   */
  secretsDir?: string;
  /**
   * Путь к `tenants.json` (мультитенантность): CLI `--tenants-file` >
   * env `GATEWAY_TENANTS_FILE` > `<secretsDir>/tenants.json` (если существует).
   */
  tenantsFile?: string;
}

/** Порт health-сервера по умолчанию. */
export const DEFAULT_PORT = 7100;

/** Базовый URL API v2 по умолчанию (локальный dev-инстанс Synth). */
export const DEFAULT_SYNTH_URL = 'http://127.0.0.1:5000/api/v2';

/** Режим отправки ответов по умолчанию. */
export const DEFAULT_PARSE_MODE: ParseMode = 'plain';

/** Таймаут long-polling `getUpdates` по умолчанию, сек. */
export const DEFAULT_POLL_TIMEOUT_SEC = 30;

/** Таймаут обычных (не long-poll) запросов Bot API по умолчанию, сек. */
export const DEFAULT_REQUEST_TIMEOUT_SEC = 30;

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Читает переменную окружения, считая пустую/whitespace-only строку отсутствием
 * значения. Это важно для opencode: подстановка `{env:VAR}` при незаданной
 * переменной даёт **пустую строку**, а не `undefined`, поэтому голый `??` не
 * срабатывает и значение превращается в `''`.
 *
 * При наличии значения возвращается `trim()`-результат, иначе — `fallback`.
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

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Разбирает строго положительное целое из env; иначе — `undefined`. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** Разбирает булево значение env: `1/true/yes/on` → `true`, `0/false/no/off` → `false`. */
export function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Разбирает строку списка доступа `chatId:ROLE,chatId:ROLE` в объект
 * `chatId → роль`. Пустые элементы и пары без `chatId`/роли игнорируются;
 * роли нормализуются в верхний регистр.
 */
export function parseAllowlist(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const item = entry.trim();
    if (!item) continue;
    const separator = item.lastIndexOf(':');
    if (separator <= 0) continue;
    const chatId = item.slice(0, separator).trim();
    const role = item.slice(separator + 1).trim().toUpperCase();
    if (!chatId || !role) continue;
    result[chatId] = role;
  }
  return result;
}

/** Читает `secrets/allowlist.json` (`{"123456789":"ADMIN"}`); иначе — пустой объект. */
function readAllowlistFile(secretsDir: string): Record<string, string> | undefined {
  try {
    const raw = readFileSync(join(secretsDir, 'allowlist.json'), 'utf8').trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const result: Record<string, string> = {};
    for (const [chatId, role] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof role === 'string' && role.trim()) {
        result[chatId] = role.trim().toUpperCase();
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Ключ тенанта по умолчанию в legacy-режиме (без `tenants.json`). */
export const DEFAULT_TENANT_ID = 'default';

/** Допустимый id тенанта: `[a-z0-9][a-z0-9_-]*`. */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Допустимые поля записи тенанта в `tenants.json` (строгая валидация). */
const TENANT_ALLOWED_KEYS = new Set([
  'id',
  'botToken',
  'token',
  'synthUrl',
  'synth',
  'serviceKey',
  'apiKey',
  'oidcTokenUrl',
  'oidcDiscoveryUrl',
  'oidcClientId',
  'oidcClientSecret',
  'oidcScope',
  'proxyUrl',
  'allowlist',
  'parseMode',
  'unknownAction',
  'watch',
  'pollTimeoutSec',
  'requestTimeoutSec',
]);

/** Допустимые поля вложенного объекта `synth` в записи тенанта. */
const TENANT_SYNTH_ALLOWED_KEYS = new Set(['url']);

/** Глобальные дефолты (env/CLI/`secrets/`), подставляемые тенантам без своих полей. */
export interface TenantDefaults {
  telegram: { token?: string; proxyUrl?: string };
  synth: { baseUrl: string; serviceKey?: string; apiKey?: string; oidc: OidcAuthConfig };
  allowlist: Record<string, string>;
  parseMode: ParseMode;
  unknownAction: UnknownAction;
  watch: boolean;
  pollTimeoutSec: number;
  requestTimeoutSec: number;
  /** Форсированный dry-run (`--dry-run`/`GATEWAY_DRY_RUN=true`) — снимает требование токена. */
  dryRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Строка-значение поля: `undefined`/`null` — нет значения, пустая строка — нет значения. */
function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${context}: ожидается строка`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Положительное целое из поля: `undefined` — нет значения, иначе строго > 0. */
function optionalPositiveInt(value: unknown, context: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${context}: ожидается положительное целое число`);
  }
  return value;
}

/** Булево поле: `undefined` — нет значения, иначе строго булево. */
function optionalBoolean(value: unknown, context: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${context}: ожидается boolean`);
  return value;
}

/** Список доступа в объектной форме `{ "<chatId>": "ROLE" }`; роли → верхний регистр. */
function parseAllowlistObject(value: Record<string, unknown>, context: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [chatId, role] of Object.entries(value)) {
    if (typeof role !== 'string' || !role.trim()) {
      throw new Error(`${context}: роль чата «${chatId}» должна быть непустой строкой`);
    }
    result[chatId] = role.trim().toUpperCase();
  }
  return result;
}

/**
 * Список доступа тенанта: строковая форма `chatId:ROLE,…` или объектная
 * `{ "<chatId>": "ROLE" }`. Любое иное значение — ошибка конфигурации.
 */
export function parseTenantAllowlist(value: unknown, context: string): Record<string, string> {
  if (typeof value === 'string') return parseAllowlist(value);
  if (isRecord(value)) return parseAllowlistObject(value, context);
  throw new Error(`${context}: allowlist должен быть строкой «chatId:ROLE,…» или объектом`);
}

/**
 * Разбирает и валидирует одну запись тенанта из `tenants.json`.
 *
 * Строгая валидация (fail-fast): неизвестные поля — ошибка (опечатка поля среды
 * — `syntUrl` вместо `synthUrl` — иначе молча увела бы тенант на чужой/dev Synth).
 * Поля, не заданные явно, берутся из переданных глобальных дефолтов.
 */
export function parseTenantEntry(
  raw: unknown,
  index: number,
  globals: TenantDefaults,
): TenantConfig {
  const position = `tenants.json: тенант #${index + 1}`;
  if (!isRecord(raw)) throw new Error(`${position}: ожидается объект`);

  for (const key of Object.keys(raw)) {
    if (!TENANT_ALLOWED_KEYS.has(key)) {
      throw new Error(`${position}: неизвестное поле «${key}»`);
    }
  }

  const id = optionalString(raw.id, `${position}: id`);
  if (!id) throw new Error(`${position}: отсутствует обязательное поле «id»`);
  const context = `тенант «${id}»`;
  if (!TENANT_ID_PATTERN.test(id)) {
    throw new Error(`${context}: недопустимый id (ожидается [a-z0-9][a-z0-9_-]*)`);
  }

  let synthUrlFromObject: string | undefined;
  if (raw.synth !== undefined && raw.synth !== null) {
    if (!isRecord(raw.synth)) throw new Error(`${context}: поле «synth» должно быть объектом { url }`);
    for (const key of Object.keys(raw.synth)) {
      if (!TENANT_SYNTH_ALLOWED_KEYS.has(key)) {
        throw new Error(`${context}: поле «synth»: неизвестное поле «${key}»`);
      }
    }
    synthUrlFromObject = optionalString(raw.synth.url, `${context}: synth.url`);
  }

  const token =
    optionalString(raw.botToken, `${context}: botToken`) ??
    optionalString(raw.token, `${context}: token`) ??
    globals.telegram.token;
  if (!token && !globals.dryRun) {
    throw new Error(`${context}: не задан botToken (и не включён dry-run)`);
  }

  const baseUrl = stripTrailingSlash(
    optionalString(raw.synthUrl, `${context}: synthUrl`) ??
      synthUrlFromObject ??
      globals.synth.baseUrl,
  );

  const oidc: OidcAuthConfig = {
    tokenUrl:
      optionalString(raw.oidcTokenUrl, `${context}: oidcTokenUrl`) ?? globals.synth.oidc.tokenUrl,
    discoveryUrl:
      optionalString(raw.oidcDiscoveryUrl, `${context}: oidcDiscoveryUrl`) ??
      globals.synth.oidc.discoveryUrl,
    clientId:
      optionalString(raw.oidcClientId, `${context}: oidcClientId`) ?? globals.synth.oidc.clientId,
    clientSecret:
      optionalString(raw.oidcClientSecret, `${context}: oidcClientSecret`) ??
      globals.synth.oidc.clientSecret,
    scope: optionalString(raw.oidcScope, `${context}: oidcScope`) ?? globals.synth.oidc.scope,
  };

  const parseMode =
    raw.parseMode !== undefined && raw.parseMode !== null
      ? parseParseMode(optionalString(raw.parseMode, `${context}: parseMode`))
      : globals.parseMode;
  const unknownAction =
    raw.unknownAction !== undefined && raw.unknownAction !== null
      ? parseUnknownAction(optionalString(raw.unknownAction, `${context}: unknownAction`))
      : globals.unknownAction;

  return {
    id,
    telegram: {
      ...(token ? { token } : {}),
      proxyUrl:
        optionalString(raw.proxyUrl, `${context}: proxyUrl`) ?? globals.telegram.proxyUrl,
    },
    synth: {
      baseUrl,
      serviceKey:
        optionalString(raw.serviceKey, `${context}: serviceKey`) ?? globals.synth.serviceKey,
      apiKey: optionalString(raw.apiKey, `${context}: apiKey`) ?? globals.synth.apiKey,
      oidc,
    },
    allowlist:
      raw.allowlist !== undefined && raw.allowlist !== null
        ? parseTenantAllowlist(raw.allowlist, context)
        : globals.allowlist,
    parseMode,
    unknownAction,
    watch: optionalBoolean(raw.watch, `${context}: watch`) ?? globals.watch,
    pollTimeoutSec:
      optionalPositiveInt(raw.pollTimeoutSec, `${context}: pollTimeoutSec`) ?? globals.pollTimeoutSec,
    requestTimeoutSec:
      optionalPositiveInt(raw.requestTimeoutSec, `${context}: requestTimeoutSec`) ??
      globals.requestTimeoutSec,
  };
}

/**
 * Разбирает и валидирует содержимое `tenants.json` (`{ "tenants": [ … ] }`).
 * Ошибки: не объект, лишние поля верхнего уровня, пустой/отсутствующий массив,
 * дублирующийся `id`.
 */
export function parseTenantsFile(raw: unknown, globals: TenantDefaults): TenantConfig[] {
  if (!isRecord(raw)) throw new Error('tenants.json: ожидается объект { "tenants": [ … ] }');
  for (const key of Object.keys(raw)) {
    if (key !== 'tenants') throw new Error(`tenants.json: неизвестное поле «${key}»`);
  }
  const list = raw.tenants;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('tenants.json: поле «tenants» должно быть непустым массивом');
  }
  const tenants = list.map((entry, index) => parseTenantEntry(entry, index, globals));
  const seen = new Set<string>();
  for (const tenant of tenants) {
    if (seen.has(tenant.id)) {
      throw new Error(`tenants.json: повторяющийся id тенанта «${tenant.id}»`);
    }
    seen.add(tenant.id);
  }
  return tenants;
}

/** Строит единственный legacy-тенант `default` из глобальных дефолтов. */
export function defaultTenant(globals: TenantDefaults): TenantConfig {
  return {
    id: DEFAULT_TENANT_ID,
    telegram: {
      ...(globals.telegram.token ? { token: globals.telegram.token } : {}),
      proxyUrl: globals.telegram.proxyUrl,
    },
    synth: { ...globals.synth },
    allowlist: globals.allowlist,
    parseMode: globals.parseMode,
    unknownAction: globals.unknownAction,
    watch: globals.watch,
    pollTimeoutSec: globals.pollTimeoutSec,
    requestTimeoutSec: globals.requestTimeoutSec,
  };
}

/**
 * Каталог состояния тенанта. Legacy `default` пишет в корень `dataDir` (без
 * миграции существующего состояния); остальные тенанты изолированы подкаталогом
 * `dataDir/tenants/<id>`.
 */
export function tenantStoreDir(dataDir: string, tenantId: string, legacy: boolean): string {
  return legacy && tenantId === DEFAULT_TENANT_ID ? dataDir : join(dataDir, 'tenants', tenantId);
}

/** Тенанты в legacy-режиме (без `tenants.json`) — единственный `default`. */
export function isLegacyTenants(config: GatewayConfig): boolean {
  return config.tenantsFile === undefined;
}

/** Читает и парсит `tenants.json`; понятные ошибки на отсутствие/битый JSON. */
function readTenantsFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`не удалось прочитать файл тенантов «${path}»: ${describeUnknown(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`файл тенантов «${path}»: некорректный JSON: ${describeUnknown(error)}`);
  }
}

/**
 * Загружает конфигурацию. Приоритет: CLI-флаги (`overrides`) > env > `secrets/`
 * > значения по умолчанию.
 *
 * Поля:
 * - `TELEGRAM_BOT_TOKEN` / `secrets/telegram_bot_token`;
 * - `TELEGRAM_PROXY_URL` (цепочка `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`) /
 *   `secrets/telegram_proxy_url`;
 * - `SYNTH_URL` (дефолт {@link DEFAULT_SYNTH_URL}), `SYNTH_SERVICE_KEY` /
 *   `secrets/synth_service_key` (приоритетная scoped-аутентификация, AD-052),
 *   `SYNTH_API_KEY` / `secrets/synth_api_key` (legacy-fallback standalone/dev);
 *   приоритет аутентификации: service-key > OIDC > api-key;
 * - `SYNTH_OIDC_TOKEN_URL`/`SYNTH_OIDC_DISCOVERY_URL`/`SYNTH_OIDC_CLIENT_ID`/
 *   `SYNTH_OIDC_CLIENT_SECRET`/`SYNTH_OIDC_SCOPE` (fallback-файлы `oidc_*`);
 * - `GATEWAY_ALLOWLIST` / `secrets/allowlist.json`;
 * - `GATEWAY_DATA_DIR`, `GATEWAY_DRY_RUN`.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): GatewayConfig {
  const secretsDir =
    overrides.secretsDir ?? envOr(env, 'GATEWAY_SECRETS_DIR') ?? join(REPO_ROOT, 'secrets');
  const dataDir =
    overrides.dataDir ?? envOr(env, 'GATEWAY_DATA_DIR') ?? join(REPO_ROOT, 'data');
  const host = overrides.host ?? envOr(env, 'GATEWAY_HOST') ?? '127.0.0.1';
  const port = overrides.port ?? parsePort(envOr(env, 'GATEWAY_PORT')) ?? DEFAULT_PORT;

  const token =
    overrides.token ?? envOr(env, 'TELEGRAM_BOT_TOKEN') ?? readSecret('telegram_bot_token', secretsDir);
  const proxyUrl =
    overrides.proxyUrl ?? firstEnv(env, PROXY_ENV) ?? readSecret('telegram_proxy_url', secretsDir);

  const baseUrl = stripTrailingSlash(
    overrides.synthUrl ?? envOr(env, 'SYNTH_URL', DEFAULT_SYNTH_URL),
  );
  const serviceKey =
    overrides.serviceKey ??
    envOr(env, 'SYNTH_SERVICE_KEY') ??
    readSecret('synth_service_key', secretsDir);
  const apiKey =
    overrides.synthApiKey ?? envOr(env, 'SYNTH_API_KEY') ?? readSecret('synth_api_key', secretsDir);
  const oidc: OidcAuthConfig = {
    tokenUrl:
      overrides.oidcTokenUrl ??
      envOr(env, 'SYNTH_OIDC_TOKEN_URL') ??
      readSecret('oidc_token_url', secretsDir),
    discoveryUrl:
      overrides.oidcDiscoveryUrl ??
      envOr(env, 'SYNTH_OIDC_DISCOVERY_URL') ??
      readSecret('oidc_discovery_url', secretsDir),
    clientId:
      overrides.oidcClientId ??
      envOr(env, 'SYNTH_OIDC_CLIENT_ID') ??
      readSecret('oidc_client_id', secretsDir),
    clientSecret:
      overrides.oidcClientSecret ??
      envOr(env, 'SYNTH_OIDC_CLIENT_SECRET') ??
      readSecret('oidc_client_secret', secretsDir),
    scope:
      overrides.oidcScope ?? envOr(env, 'SYNTH_OIDC_SCOPE') ?? readSecret('oidc_scope', secretsDir),
  };

  const allowlistValue = overrides.allowlist ?? envOr(env, 'GATEWAY_ALLOWLIST');
  const allowlist =
    allowlistValue !== undefined ? parseAllowlist(allowlistValue) : (readAllowlistFile(secretsDir) ?? {});

  const forcedDryRun = overrides.dryRun ?? parseBool(envOr(env, 'GATEWAY_DRY_RUN'));
  const watch = overrides.watch ?? parseBool(envOr(env, 'GATEWAY_WATCH')) ?? true;
  const parseMode = overrides.parseMode ?? parseParseMode(envOr(env, 'GATEWAY_PARSE_MODE'));
  const unknownAction =
    overrides.unknownAction ?? parseUnknownAction(envOr(env, 'GATEWAY_UNKNOWN_ACTION'));
  const pollTimeoutSec =
    overrides.pollTimeoutSec ??
    parsePositiveInt(envOr(env, 'GATEWAY_POLL_TIMEOUT_SEC')) ??
    DEFAULT_POLL_TIMEOUT_SEC;
  const requestTimeoutSec =
    overrides.requestTimeoutSec ??
    parsePositiveInt(envOr(env, 'GATEWAY_REQUEST_TIMEOUT_SEC')) ??
    DEFAULT_REQUEST_TIMEOUT_SEC;

  // Глобальные дефолты — база для тенантов без собственных полей.
  const globals: TenantDefaults = {
    telegram: { ...(token ? { token } : {}), proxyUrl },
    synth: { baseUrl, serviceKey, apiKey, oidc },
    allowlist,
    parseMode,
    unknownAction,
    watch,
    pollTimeoutSec,
    requestTimeoutSec,
    dryRun: forcedDryRun === true,
  };

  // Источник мультитенантности: явный путь (CLI/env) либо secrets/tenants.json.
  const explicitTenantsFile = overrides.tenantsFile ?? envOr(env, 'GATEWAY_TENANTS_FILE');
  const tenantsPath = explicitTenantsFile ?? join(secretsDir, 'tenants.json');
  const tenantsFromFile = existsSync(tenantsPath);

  let tenants: TenantConfig[];
  let tenantsFile: string | undefined;
  if (tenantsFromFile) {
    tenants = parseTenantsFile(readTenantsFile(tenantsPath), globals);
    tenantsFile = tenantsPath;
  } else if (explicitTenantsFile !== undefined) {
    throw new Error(`не найден файл тенантов: ${tenantsPath}`);
  } else {
    tenants = [defaultTenant(globals)];
    tenantsFile = undefined;
  }

  // Dry-run: явный флаг/env сильнее; в legacy — вычисляется по наличию токена,
  // в мульти-режиме токены у тенантов, поэтому по умолчанию `false`.
  const dryRun = forcedDryRun ?? (tenantsFile !== undefined ? false : !token);

  return {
    version: readVersion(),
    repoRoot: REPO_ROOT,
    dataDir,
    host,
    port,
    dryRun,
    tenants,
    ...(tenantsFile !== undefined ? { tenantsFile } : {}),
    watch,
    parseMode,
    unknownAction,
    pollTimeoutSec,
    requestTimeoutSec,
    telegram: { token, proxyUrl },
    synth: { baseUrl, serviceKey, apiKey, oidc },
    allowlist,
  };
}

/**
 * Нормализует режим отправки: `html` → `html`, `markdown` → `markdown`,
 * прочее/пусто → дефолт `plain`.
 */
export function parseParseMode(value: string | undefined): ParseMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'html') return 'html';
  if (normalized === 'markdown') return 'markdown';
  return DEFAULT_PARSE_MODE;
}
