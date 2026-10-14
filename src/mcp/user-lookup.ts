/**
 * Резолвинг получателя Telegram для тула `tg_send_to_user`.
 *
 * Получатель задаётся одним из способов:
 * - `chatId` — напрямую (без обращения к Synth);
 * - `principalId` (`tg:<id>`, AD-089) — напрямую, id берётся из строки;
 * - `user` (id или username учётной записи Synth) — через **API v2** машинной
 *   кредой инстанса (scoped service-key, нужен scope `users:read`): профиль →
 *   `identities[]` c `provider === 'telegram'` → `externalId` = chat_id.
 *
 * Секреты (service-key) в сообщения об ошибках не попадают.
 */

/** Таймаут запросов к API v2 по умолчанию, мс. */
export const DEFAULT_USER_LOOKUP_TIMEOUT_MS = 10_000;

/** Провайдеры-алиасы Telegram в `identities[].provider`. */
const TELEGRAM_PROVIDERS = new Set(['telegram', 'tg']);

/** Ошибки резолвинга/обращения к API v2 (машиночитаемый код). */
export const TELEGRAM_TARGET_REQUIRED = 'telegram.target_required';
export const TELEGRAM_PRINCIPAL_INVALID = 'telegram.principal_id_invalid';
export const TELEGRAM_USER_LOOKUP_UNAVAILABLE = 'telegram.user_lookup_unavailable';
export const TELEGRAM_USER_NOT_FOUND = 'telegram.user_not_found';
export const TELEGRAM_USER_FORBIDDEN = 'telegram.user_forbidden';
export const TELEGRAM_NO_TELEGRAM_IDENTITY = 'telegram.no_telegram_identity';
export const TELEGRAM_API_UNAVAILABLE = 'telegram.synth_api_unavailable';

/** Ошибка резолвинга получателя (код → понятное сообщение для агента). */
export class SynthUserLookupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SynthUserLookupError';
  }
}

/** Конфигурация доступа к API v2 Synth (машинная креда тенанта). */
export interface SynthUserLookupOptions {
  /** Базовый URL API v2 (например, `http://synth-backend:5000/api/v2`). */
  baseUrl: string;
  /** Scoped service-key `synth_svc_…` (AD-052) — приоритетная креда. */
  serviceKey?: string;
  /** Статический Bearer-ключ (legacy-fallback; standalone/dev). */
  apiKey?: string;
  /** Реализация fetch (для тестов). По умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Таймаут запроса, мс (по умолчанию {@link DEFAULT_USER_LOOKUP_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Внешняя идентичность профиля Synth (`ProfileData.identities[]`, AD-089). */
export interface SynthExternalIdentity {
  provider?: string;
  externalId?: string;
  /** Snake-case вариант (на случай legacy/другой сериализации). */
  external_id?: string;
  username?: string;
  displayName?: string;
}

/** Профиль пользователя Synth (срез, нужный для резолвинга получателя). */
export interface SynthUserRecord {
  id?: string;
  username?: string;
  identities?: SynthExternalIdentity[];
  [key: string]: unknown;
}

/** Вход резолвинга получателя (`tg_send_to_user`). */
export interface TelegramTargetInput {
  /** id или username пользователя Synth. */
  user?: string;
  /** Внешний идентификатор Synth (`tg:<id>`). */
  principalId?: string;
  /** Chat id Telegram (или `@channelusername`). */
  chatId?: string | number;
}

/** Результат резолвинга получателя. */
export interface ResolvedTelegramTarget {
  /** Итоговый `chat_id` для Bot API. */
  chatId: string;
  /** Как получен адресат (для аудита/ответа тула). */
  via: 'chatId' | 'principalId' | 'user';
  /** id пользователя Synth (если резолвили по `user`). */
  userId?: string;
  /** username пользователя Synth (если известен). */
  username?: string;
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Непустое строковое значение поля (`externalId`/`external_id`). */
export function identityExternalId(identity: SynthExternalIdentity): string | undefined {
  const raw = identity.externalId ?? identity.external_id;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/**
 * Разбирает external id из `principalId` формата `<provider>:<externalId>`
 * (AD-089). Возвращает `null` — нет `:`/пустая часть.
 */
export function parsePrincipalId(principalId: string): { provider: string; externalId: string } | null {
  const value = principalId.trim();
  const idx = value.indexOf(':');
  if (idx <= 0 || idx === value.length - 1) return null;
  const provider = value.slice(0, idx).trim().toLowerCase();
  const externalId = value.slice(idx + 1).trim();
  if (!provider || !externalId) return null;
  return { provider, externalId };
}

/** Первая Telegram-идентичность профиля (или `undefined`). */
export function pickTelegramIdentity(
  user: SynthUserRecord,
): { identity: SynthExternalIdentity; externalId: string } | undefined {
  const list = Array.isArray(user.identities) ? user.identities : [];
  for (const identity of list) {
    const provider =
      typeof identity.provider === 'string' ? identity.provider.trim().toLowerCase() : '';
    if (!TELEGRAM_PROVIDERS.has(provider)) continue;
    const externalId = identityExternalId(identity);
    if (externalId) return { identity, externalId };
  }
  return undefined;
}

/** Нормализует ответ `GET /users/:id` (сам объект или `{ user }`). */
function toUserRecord(data: unknown): SynthUserRecord | undefined {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.user)) return data.user as SynthUserRecord;
  return data as SynthUserRecord;
}

/** Нормализует ответ `GET /users` (`{[users]}` или массив). */
function toUserList(data: unknown): SynthUserRecord[] {
  if (Array.isArray(data)) return data.filter(isRecord) as SynthUserRecord[];
  if (isRecord(data) && Array.isArray(data.users)) {
    return data.users.filter(isRecord) as SynthUserRecord[];
  }
  return [];
}

/** Текст ошибки из тела ответа API v2 (`{ error: { code, message } }`). */
function apiErrorMessage(data: unknown, status: number): string {
  if (isRecord(data) && isRecord(data.error)) {
    const message = data.error.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return `HTTP ${status}`;
}

interface ApiResult {
  status: number;
  data: unknown;
}

/**
 * Вызов API v2 с машинной кредой тенанта. Сетевые ошибки → понятный код
 * {@link TELEGRAM_API_UNAVAILABLE} (baseUrl — без секретов).
 */
async function requestApi(opts: SynthUserLookupOptions, path: string): Promise<ApiResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = opts.serviceKey?.trim() || opts.apiKey?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await (opts.fetchImpl ?? globalThis.fetch)(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_USER_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SynthUserLookupError(
      TELEGRAM_API_UNAVAILABLE,
      `API Synth недоступен (${baseUrl}): ${describeUnknown(error)}`,
    );
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Ошибка по неуспешному ответу API v2 (403/401 → «нет прав»). */
function toApiError(result: ApiResult, baseUrl: string): SynthUserLookupError {
  const detail = apiErrorMessage(result.data, result.status);
  if (result.status === 401 || result.status === 403) {
    return new SynthUserLookupError(
      TELEGRAM_USER_FORBIDDEN,
      `Нет прав на чтение пользователей Synth (нужен scope users:read): HTTP ${result.status} — ${detail}`,
      result.status,
    );
  }
  return new SynthUserLookupError(
    TELEGRAM_API_UNAVAILABLE,
    `API Synth вернул ошибку (${baseUrl}): HTTP ${result.status} — ${detail}`,
    result.status,
  );
}

/**
 * Находит пользователя Synth: сначала `GET /users/:id` (id или username),
 * при 404 — `GET /users` и поиск по `username`/`id`.
 */
export async function findSynthUser(
  opts: SynthUserLookupOptions,
  user: string,
): Promise<SynthUserRecord> {
  const query = user.trim();

  const byId = await requestApi(opts, `/users/${encodeURIComponent(query)}`);
  if (byId.status === 200) {
    const record = toUserRecord(byId.data);
    if (record) return record;
  } else if (byId.status !== 404) {
    throw toApiError(byId, opts.baseUrl);
  }

  const list = await requestApi(opts, '/users');
  if (list.status !== 200) throw toApiError(list, opts.baseUrl);
  const found = toUserList(list.data).find(
    (record) => record.username === query || record.id === query,
  );
  if (!found) {
    throw new SynthUserLookupError(
      TELEGRAM_USER_NOT_FOUND,
      `Пользователь Synth «${query}» не найден`,
    );
  }
  return found;
}

/**
 * Резолвит Telegram-адресата: `chatId` → `principalId` → `user` (через API v2).
 * Ровно один способ обязателен; при нескольких — приоритет в этом порядке.
 */
export async function resolveTelegramChatId(
  opts: SynthUserLookupOptions | undefined,
  target: TelegramTargetInput,
): Promise<ResolvedTelegramTarget> {
  const chatId = target.chatId !== undefined && target.chatId !== null ? String(target.chatId).trim() : '';
  if (chatId) return { chatId, via: 'chatId' };

  const principalId = target.principalId?.trim();
  if (principalId) {
    // Числовая строка без `provider:` — считаем сырым chat id (fallback).
    if (!principalId.includes(':') && /^-?\d+$/.test(principalId)) {
      return { chatId: principalId, via: 'principalId' };
    }
    const parsed = parsePrincipalId(principalId);
    if (!parsed) {
      throw new SynthUserLookupError(
        TELEGRAM_PRINCIPAL_INVALID,
        `principalId «${principalId}» некорректен: ожидается «<provider>:<id>», например «tg:450316139»`,
      );
    }
    if (!TELEGRAM_PROVIDERS.has(parsed.provider)) {
      throw new SynthUserLookupError(
        TELEGRAM_PRINCIPAL_INVALID,
        `principalId «${principalId}» не является Telegram-идентификатором (ожидается provider «tg»)`,
      );
    }
    return { chatId: parsed.externalId, via: 'principalId' };
  }

  const user = target.user?.trim();
  if (!user) {
    throw new SynthUserLookupError(
      TELEGRAM_TARGET_REQUIRED,
      'Укажите адресата: chatId (Telegram-чат), user (id/username учётной записи Synth) ' +
        'или principalId («tg:<id>»). Если адресат неизвестен — id чата показывает тул tg_status.',
    );
  }
  if (!opts?.baseUrl?.trim()) {
    throw new SynthUserLookupError(
      TELEGRAM_USER_LOOKUP_UNAVAILABLE,
      'Резолвинг по user недоступен: не задан API v2 Synth (synthUrl). ' +
        'Используйте principalId («tg:<id>») или chatId',
    );
  }

  const record = await findSynthUser(opts, user);
  const telegram = pickTelegramIdentity(record);
  if (!telegram) {
    throw new SynthUserLookupError(
      TELEGRAM_NO_TELEGRAM_IDENTITY,
      `У пользователя Synth «${record.username ?? user}» нет Telegram-идентичности ` +
        '(привязка — в UI Synth: Настройки → Профиль → Идентичности)',
    );
  }

  return {
    chatId: telegram.externalId,
    via: 'user',
    ...(record.id ? { userId: record.id } : {}),
    ...(record.username ? { username: record.username } : {}),
  };
}
