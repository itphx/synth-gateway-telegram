import type { BearerProvider } from './auth.js';
import type { GatewayHealth } from './health.js';
import type { SynthEventInput } from './normalize.js';

/** AD-089: нормализованное событие, как его вернул приём (`POST /events`). */
export interface SynthEvent {
  id: string;
  source: string;
  type: string;
  payload: unknown;
  identity: unknown;
  dedupKey: string;
  ts: string;
}

/** AD-089: решение Router (дискриминант `kind` + диагностическая мета). */
export interface RouteDecision {
  kind: string;
  [key: string]: unknown;
}

/** Ответ `POST /events`: событие, решение Router и id сессии (если создана). */
export interface IngestResult {
  event: SynthEvent;
  decision: RouteDecision;
  sessionId: string | null;
  /**
   * AD-089 (claim-flow): одноразовый код подтверждения владения внешней
   * идентичностью. Заполнен ядром, только если отправитель не сопознан с
   * учётной записью Synth (`identityHint` в ответе `POST /events`).
   */
  identityHint?: { code: string; expiresAt: string };
}

/** AD-089: привязка внешнего адреса к сессии/шаблону. */
export interface EventBinding {
  id: string;
  source: string;
  chatKey?: string;
  threadKey?: string;
  sessionId?: string;
  mode: string;
  agentTemplate?: string;
  project?: string;
}

/** Вход upsert привязки (`POST /events/bindings`). */
export interface EventBindingInput {
  source: string;
  chatKey?: string;
  threadKey?: string;
  sessionId?: string;
  mode: string;
  agentTemplate?: string;
  project?: string;
}

/** Срез сессии Synth (ответ `POST /sessions`, `GET /sessions/:id`). */
export interface SynthSession {
  id: string;
  name?: string | null;
  project_id?: string | null;
  mode?: string;
  [key: string]: unknown;
}

/** Вход создания сессии (`POST /sessions`; схема `sessionCreateSchema`). */
export interface CreateSessionInput {
  name?: string;
  title?: string;
  projectId?: string;
  engine?: 'synth' | 'opencode' | 'cline';
  settings?: Record<string, unknown>;
}

/** Ошибка вызова API v2 с кодом/статусом ответа. */
export class SynthEventsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SynthEventsError';
  }
}

/** Опции {@link SynthEventsClient}. */
export interface SynthEventsClientOptions {
  /** Базовый URL API v2 (например, `http://127.0.0.1:5000/api/v2`). */
  baseUrl: string;
  /** Служебный Bearer-ключ (standalone/dev; без `bearer`). */
  apiKey?: string;
  /** Провайдер Bearer-токена (OIDC/стат. ключ); при задании приоритетнее `apiKey`. */
  bearer?: BearerProvider;
  /** Реализация fetch (для тестов). По умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Число повторных попыток при сетевой ошибке/5xx (по умолчанию 3). */
  maxRetries?: number;
  /** Базовая задержка backoff, мс (по умолчанию 500; удваивается с каждой попыткой). */
  retryBaseDelayMs?: number;
  /** Логгер (по умолчанию — тихий). */
  log?: (message: string) => void;
  /** Best-effort состояние доступности API v2 для health. */
  health?: GatewayHealth;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP-клиент платформы внешних событий Synth (AD-089) и сессий (API v2).
 *
 * Публикует нормализованные события (`POST /events`), управляет привязками
 * (`/events/bindings*`) и сессиями (`/sessions*`). Сетевые ошибки и ответы 5xx
 * повторяются с экспоненциальным backoff; 4xx — окончательная ошибка без повторов.
 */
export class SynthEventsClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly bearer?: BearerProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly log: (message: string) => void;
  private readonly health?: GatewayHealth;

  constructor(options: SynthEventsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.bearer = options.bearer;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.log = options.log ?? (() => {});
    this.health = options.health;
  }

  /** Публикует внешнее событие; логирует решение Router. */
  async postEvent(input: SynthEventInput): Promise<IngestResult> {
    const result = await this.request<IngestResult>('POST', '/events', input);
    const suffix = result.sessionId ? ` (сессия ${result.sessionId})` : '';
    this.log(`[gateway] событие ${result.event.id} → решение «${result.decision.kind}»${suffix}`);
    return result;
  }

  /** Список привязок событий (опционально с фильтром по `source`). */
  async listBindings(source?: string): Promise<EventBinding[]> {
    const data = await this.request<{ bindings?: EventBinding[] }>('GET', '/events/bindings');
    const bindings = data.bindings ?? [];
    return source ? bindings.filter((binding) => binding.source === source) : bindings;
  }

  /** Upsert привязки событий. */
  async createBinding(input: EventBindingInput): Promise<EventBinding> {
    return this.request<EventBinding>('POST', '/events/bindings', input);
  }

  /** Удаляет привязку событий. */
  async deleteBinding(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/events/bindings/${encodeURIComponent(id)}`);
  }

  /** Создаёт сессию (`POST /sessions`; единый funnel ядра). */
  async createSession(input: CreateSessionInput): Promise<SynthSession> {
    return this.request<SynthSession>('POST', '/sessions', input);
  }

  /** Читает сессию; `null` — сессия не найдена (404). */
  async getSession(id: string): Promise<SynthSession | null> {
    try {
      return await this.request<SynthSession>('GET', `/sessions/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof SynthEventsError && error.status === 404) return null;
      throw error;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    // Один раз после `401` принудительно обновляем токен и повторяем без
    // траты бюджета retry (защита от зацикливания — флаг).
    let authRefreshed = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }

      const headers: Record<string, string> = { accept: 'application/json' };
      const token = this.bearer ? await this.bearer.getBearer() : this.apiKey;
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        lastError = error;
        continue;
      }

      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }

      if (response.ok) {
        this.health?.setSynth('up');
        return data as T;
      }

      if (response.status === 401 && this.bearer && !authRefreshed) {
        authRefreshed = true;
        try {
          await this.bearer.refreshBearer();
        } catch {
          /* ошибку получения токена отразит health; повтор покажет итог */
        }
        attempt -= 1; // повтор после refresh — не расходует retry-бюджет
        continue;
      }

      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      const apiError = new SynthEventsError(
        response.status,
        error?.code ?? `http_${response.status}`,
        error?.message ?? response.statusText,
      );

      // 5xx — временная ошибка сервера, повторяем; 4xx — окончательная.
      if (response.status >= 500) {
        lastError = apiError;
        continue;
      }
      this.health?.setSynth('up');
      throw apiError;
    }

    this.health?.setSynth('down');
    if (lastError instanceof SynthEventsError) throw lastError;
    throw new SynthEventsError(
      0,
      'network_error',
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  }
}
