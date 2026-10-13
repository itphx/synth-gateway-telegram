/** Состояние доступности зависимости: `up`/`down`. */
export type HealthStatus = 'up' | 'down';

/** Состояние Telegram-бота: `ok` — getMe успешен, `dry-run` — токена нет. */
export type BotStatus = 'ok' | 'dry-run' | 'unknown';

/** Режим аутентификации вызовов Synth API (AD-052/AD-089, managed/standalone). */
export type AuthMode = 'service-key' | 'oidc' | 'api-key' | 'none';

/** Доступность Bearer-токена: `ok` — получен, `error` — нет токена/ошибка получения. */
export type TokenStatus = 'ok' | 'error';

/** Агрегатный статус процесса/тенанта: `ok` — всё доступно, `degraded`/`down`. */
export type OverallStatus = 'ok' | 'degraded' | 'down';

/** Снимок состояния шлюза для health-эндпоинта. */
export interface HealthSnapshot {
  synth: HealthStatus;
  bot: BotStatus;
  watcher: HealthStatus;
  /** Режим аутентификации Synth API: `service-key` (AD-052) / `oidc` / `api-key` / `none`. */
  auth: AuthMode;
  /** Доступность токена аутентификации (best-effort, не влияет на основной цикл). */
  token: TokenStatus;
}

/** Агрегированный снимок процесса (плоские поля `GET /health`). */
export interface AggregatedHealth extends HealthSnapshot {
  status: OverallStatus;
}

/**
 * Best-effort runtime-состояние шлюза (AD-089). Обновляется клиентами по мере
 * работы; используется только в `GET /health`, ошибки не влияют на основной цикл.
 *
 * В мультитенантном режиме создаётся отдельный экземпляр на тенант (см.
 * {@link GatewayHealthRegistry}).
 */
export class GatewayHealth {
  private synth: HealthStatus = 'down';
  private bot: BotStatus = 'unknown';
  private watcher: HealthStatus = 'down';
  private auth: AuthMode = 'none';
  private token: TokenStatus = 'error';

  setSynth(status: HealthStatus): void {
    this.synth = status;
  }

  setBot(status: BotStatus): void {
    this.bot = status;
  }

  setWatcher(status: HealthStatus): void {
    this.watcher = status;
  }

  setAuth(mode: AuthMode): void {
    this.auth = mode;
  }

  setToken(status: TokenStatus): void {
    this.token = status;
  }

  snapshot(): HealthSnapshot {
    return {
      synth: this.synth,
      bot: this.bot,
      watcher: this.watcher,
      auth: this.auth,
      token: this.token,
    };
  }
}

/** Статус одного тенанта по его снимку (для агрегата процесса). */
export function tenantHealthStatus(snapshot: HealthSnapshot): OverallStatus {
  if (snapshot.synth === 'down') return 'down';
  if (snapshot.bot === 'unknown' || snapshot.watcher === 'down' || snapshot.token === 'error') {
    return 'degraded';
  }
  return 'ok';
}

/** Агрегирует `bot` из набора тенантов: `unknown` важнее `dry-run`, `ok` — при смеси. */
function aggregateBot(bots: BotStatus[]): BotStatus {
  if (bots.some((bot) => bot === 'unknown')) return 'unknown';
  if (bots.every((bot) => bot === 'ok')) return 'ok';
  if (bots.every((bot) => bot === 'dry-run')) return 'dry-run';
  return 'ok';
}

/**
 * Сводный снимок по тенантам (плоские поля `GET /health`).
 *
 * - `synth`/`watcher`/`token` — `up`/`ok`, только если так у **всех** тенантов;
 * - `bot` — `unknown`, если хоть у одного `unknown`; `ok` при смеси `ok`/`dry-run`;
 * - `auth` — режим, если он общий для всех; иначе `none` (смешанный);
 * - `status` — `down`, если хоть один тенант `down`; `degraded`, если хоть один
 *   `degraded`; иначе `ok`.
 */
export function aggregateHealth(snapshots: HealthSnapshot[]): AggregatedHealth {
  if (snapshots.length === 0) {
    return {
      synth: 'down',
      bot: 'unknown',
      watcher: 'down',
      auth: 'none',
      token: 'error',
      status: 'down',
    };
  }
  const synth: HealthStatus = snapshots.every((s) => s.synth === 'up') ? 'up' : 'down';
  const watcher: HealthStatus = snapshots.every((s) => s.watcher === 'up') ? 'up' : 'down';
  const token: TokenStatus = snapshots.every((s) => s.token === 'ok') ? 'ok' : 'error';
  const firstAuth = snapshots[0]?.auth ?? 'none';
  const auth: AuthMode = snapshots.every((s) => s.auth === firstAuth) ? firstAuth : 'none';
  const statuses = snapshots.map(tenantHealthStatus);
  const status: OverallStatus = statuses.includes('down')
    ? 'down'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'ok';
  return { synth, bot: aggregateBot(snapshots.map((s) => s.bot)), watcher, auth, token, status };
}

/**
 * Реестр health-контекстов тенантов: per-tenant состояние + агрегат для
 * `GET /health` (T3). Один экземпляр на процесс.
 */
export class GatewayHealthRegistry {
  private readonly entries = new Map<string, GatewayHealth>();

  /** Регистрирует (или возвращает уже зарегистрированный) контекст тенанта. */
  register(id: string): GatewayHealth {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const health = new GatewayHealth();
    this.entries.set(id, health);
    return health;
  }

  /** Контекст тенанта, если зарегистрирован. */
  get(id: string): GatewayHealth | undefined {
    return this.entries.get(id);
  }

  /** id зарегистрированных тенантов (в порядке регистрации). */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Агрегат процесса + разбивка по тенантам. */
  snapshot(): { aggregate: AggregatedHealth; tenants: Record<string, HealthSnapshot> } {
    const tenants: Record<string, HealthSnapshot> = {};
    for (const [id, health] of this.entries) tenants[id] = health.snapshot();
    return { aggregate: aggregateHealth(Object.values(tenants)), tenants };
  }
}
