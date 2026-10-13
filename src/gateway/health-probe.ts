import type { GatewayHealth, HealthStatus } from './health.js';

/** Короткий таймаут health-пробы Synth по умолчанию, мс. */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 3000;

/** Интервал периодической health-пробы Synth, мс. */
export const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30_000;

/** Опции {@link SynthHealthProbe}. */
export interface SynthHealthProbeOptions {
  /** Базовый URL API v2 (например, `http://127.0.0.1:5000/api/v2`). */
  baseUrl: string;
  /** Служебный Bearer-ключ (для проб, требующих auth; `/health` публичный). */
  apiKey?: string;
  /** Реализация fetch (для тестов). По умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Таймаут пробы, мс (по умолчанию {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Интервал периодической пробы, мс (по умолчанию {@link DEFAULT_HEALTH_PROBE_INTERVAL_MS}). */
  intervalMs?: number;
  /** Best-effort состояние для health-эндпоинта. */
  health: GatewayHealth;
  /** Логгер (по умолчанию — тихий). */
  log?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Периодическая/ленивая health-проба Synth API (AD-089).
 *
 * `health.synth` инициализируется `down` и, помимо ингеста, обновляется этой
 * пробой: без неё `GET /health` врёт о доступности Synth, когда событий нет.
 * Проба бьёт по `GET {baseUrl}/health` (в API v2 — `/api/v2/health`) коротким
 * таймаутом и **никогда не бросает**: ошибка отражается только в статусе и не
 * влияет на основной цикл (поллинг/доставку).
 */
export class SynthHealthProbe {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly health: GatewayHealth;
  private readonly log: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: SynthHealthProbeOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/health`;
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS;
    this.health = options.health;
    this.log = options.log ?? (() => {});
  }

  /** Одна проба; обновляет health и возвращает статус. Ошибки не пробрасываются. */
  async probe(): Promise<HealthStatus> {
    const controller = new AbortController();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('synth.health_probe_timeout'));
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetchImpl(this.url, { headers, signal: controller.signal }),
        timeout,
      ]);
      const status: HealthStatus = response.ok ? 'up' : 'down';
      this.health.setSynth(status);
      if (!response.ok) {
        this.log(`[gateway] health-проба Synth: HTTP ${response.status} → down`);
      }
      return status;
    } catch (error) {
      this.health.setSynth('down');
      this.log(`[gateway] health-проба Synth недоступна: ${describeError(error)}`);
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Запускает немедленную пробу и периодический опрос (таймер не держит процесс). */
  start(): void {
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Останавливает периодический опрос. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
