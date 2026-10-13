import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { GatewayConfig } from './config.js';
import {
  aggregateHealth,
  GatewayHealthRegistry,
  type AggregatedHealth,
  type GatewayHealth,
  type HealthSnapshot,
} from './health.js';

/**
 * Собирает Hono-приложение шлюза.
 *
 * Входящий HTTP-периметр минимален: шлюз работает исходящими запросами
 * (Telegram → API v2), наружу отдаёт только health для проб деплоя. `GET /health`
 * и его алиас `GET /api/health` доступны без аутентификации.
 *
 * Плоские поля (`synth`/`bot`/`watcher`/`auth`/`token`/`status`) — агрегат по
 * тенантам (T3); `tenants` — разбивка по каждому тенанту. `health` — реестр
 * (мультитенантный процесс) либо одиночный контекст (legacy/тесты). Без
 * `health` отдаются безопасные дефолты (без падения).
 */
export function createApp(
  config: GatewayConfig,
  health?: GatewayHealth | GatewayHealthRegistry,
): Hono {
  const app = new Hono();

  app.use('*', cors());
  app.use('*', logger());

  const healthBody = () => {
    let aggregate: AggregatedHealth;
    let tenants: Record<string, HealthSnapshot>;
    if (health instanceof GatewayHealthRegistry) {
      ({ aggregate, tenants } = health.snapshot());
    } else if (health) {
      const snapshot = health.snapshot();
      tenants = { [config.tenants[0]?.id ?? 'default']: snapshot };
      aggregate = aggregateHealth([snapshot]);
    } else {
      // Без health-контекста — безопасные дефолты (в т.ч. для single/legacy).
      const snapshot: HealthSnapshot = {
        synth: 'down',
        bot: config.dryRun ? 'dry-run' : 'unknown',
        watcher: 'down',
        auth: 'none',
        token: 'error',
      };
      tenants = {};
      for (const tenant of config.tenants) tenants[tenant.id] = snapshot;
      // Явный `ok`, как в легаси-ответе (health-контекст отсутствует).
      aggregate = { ...snapshot, status: 'ok' as const };
    }

    return {
      status: aggregate.status,
      version: config.version,
      source: 'telegram',
      synth: aggregate.synth,
      bot: aggregate.bot,
      watcher: aggregate.watcher,
      auth: aggregate.auth,
      token: aggregate.token,
      tenants,
    };
  };

  app.get('/health', (c) => c.json(healthBody()));
  app.get('/api/health', (c) => c.json(healthBody()));

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Маршрут не найден' } }, 404));

  app.onError((error, c) => {
    console.error('[gateway] необработанная ошибка:', error);
    return c.json({ error: { code: 'internal_error', message: 'Внутренняя ошибка' } }, 500);
  });

  return app;
}

/** Запускает HTTP health-сервер на `config.host:config.port`. */
export function serve(app: Hono, config: GatewayConfig): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void handleRequest(app, req, res);
    });
    server.listen(config.port, config.host, () => resolve(server));
  });
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: 'half',
  } as RequestInit);
}

async function handleRequest(
  app: Hono,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const response = await app.fetch(toWebRequest(req), {});
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    console.error('[gateway] ошибка обработки запроса:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Внутренняя ошибка' } }));
  }
}
