/**
 * MCP-сервер Telegram-шлюза по **Streamable HTTP** (AD-046/AD-071).
 *
 * Зачем: в K8s stdio-MCP не работает (движок не спавнит процесс шлюза) —
 * Synth подключает MCP-сервер по HTTP (`mcp.servers.<name>.type: http`).
 *
 * Мультитенантность: путь `/mcp/<tenantId>` — контекст инструментов (токен бота,
 * прокси, dataDir, synthUrl/serviceKey) берётся из `tenants.json` **этого**
 * тенанта. Неизвестный тенант → 404. Всё на одном порту.
 *
 * Auth: bearer-токен из env/секрет-файла (`GATEWAY_MCP_TOKEN` /
 * `secrets/mcp_token`); нет/неверный токен → 401. Секрет — параметр чарта
 * (Secret), в git не хранится и в логи не попадает.
 *
 * `GET /health` — без аутентификации (пробы деплоя).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TelegramClient } from '../bot-api/index.js';
import {
  isLegacyTenants,
  tenantStoreDir,
  type GatewayConfig,
  type TenantConfig,
} from '../gateway/config.js';
import { createMcpServer } from './server.js';
import { createSessionChatResolver } from './session-chat.js';
import type { TelegramToolContext } from './tools.js';

/** Порт HTTP-MCP по умолчанию (следующий после health-сервера шлюза). */
export const DEFAULT_MCP_HTTP_PORT = 7101;

/** Префикс пути MCP-эндпоинта: `/mcp/<tenantId>`. */
export const MCP_PATH_PREFIX = '/mcp/';

/** Опции HTTP-MCP-сервера. */
export interface McpHttpOptions {
  /** Конфигурация шлюза: тенанты, dataDir, версия. */
  config: GatewayConfig;
  /** Bearer-токен клиентов MCP (обязателен; пустой → ошибка старта). */
  token: string;
  /** Адрес прослушивания (по умолчанию `0.0.0.0`). */
  host?: string;
  /** Порт (по умолчанию {@link DEFAULT_MCP_HTTP_PORT}). */
  port?: number;
  /** Чат по умолчанию для тулов (env/CLI; у тенантов такого поля нет). */
  defaultChatId?: string;
  /** Получатель `tg_notify` (env/CLI). */
  ownerChatId?: string;
  /** Логгер (по умолчанию — тихий; без секретов). */
  log?: (message: string) => void;
}

/** Хендл запущенного HTTP-MCP-сервера. */
export interface McpHttpServerHandle {
  server: Server;
  /** Фактический порт (для `port: 0` — назначенный ОС). */
  port: number;
  /** Остановка: закрыть сессии и сервер. */
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-ответ с единым форматом ошибки `{ error: { code, message } }`. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Сравнение bearer-токена в постоянном времени (без утечки длины/префикса). */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const provided = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Per-tenant дефолтный чат из списка доступа: чат с ролью `ADMIN`, иначе —
 * первый по порядку ключей. Пустой allowlist → `undefined`.
 */
export function defaultChatFromAllowlist(allowlist: Record<string, string>): string | undefined {
  const entries = Object.entries(allowlist);
  const admin = entries.find(([, role]) => role.toUpperCase() === 'ADMIN');
  return (admin ?? entries[0])?.[0];
}

/**
 * Контекст инструментов тенанта: клиент Bot API (токен/прокси тенанта),
 * per-tenant dataDir и доступ к API v2 Synth для `tg_send_to_user`.
 *
 * Дефолтный/owner-чат: глобальный (`defaults`, env/CLI) в приоритете, иначе —
 * per-tenant дефолт из `allowlist` (чат `ADMIN`, иначе первый). Так в
 * мультитенантном развёртывании без `GATEWAY_DEFAULT_CHAT_ID` тулы не падают с
 * `telegram.chat_id_missing`, если задан allowlist.
 */
export function buildTenantContext(
  config: GatewayConfig,
  tenant: TenantConfig,
  legacy: boolean,
  defaults: { defaultChatId?: string; ownerChatId?: string } = {},
): TelegramToolContext {
  const dryRun = !tenant.telegram.token;
  const client = new TelegramClient({
    token: tenant.telegram.token,
    proxyUrl: tenant.telegram.proxyUrl,
    dryRun,
    requestTimeoutMs: tenant.requestTimeoutSec * 1000,
  });
  const dataDir = tenantStoreDir(config.dataDir, tenant.id, legacy);
  const tenantDefault = defaultChatFromAllowlist(tenant.allowlist);
  const defaultChatId = defaults.defaultChatId ?? tenantDefault;
  const ownerChatId = defaults.ownerChatId ?? tenantDefault ?? defaultChatId;
  return {
    client,
    dataDir,
    resolveSessionChat: createSessionChatResolver(dataDir),
    ...(defaultChatId !== undefined ? { defaultChatId } : {}),
    ...(ownerChatId !== undefined ? { ownerChatId } : {}),
    synth: {
      baseUrl: tenant.synth.baseUrl,
      serviceKey: tenant.synth.serviceKey,
      apiKey: tenant.synth.apiKey,
    },
  };
}

interface SessionEntry {
  tenantId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** Извлекает id тенанта из пути `/mcp/<id>`; иначе `undefined`. */
export function parseTenantPath(path: string, knownIds: ReadonlySet<string>): string | undefined {
  if (!path.startsWith(MCP_PATH_PREFIX)) return undefined;
  const rest = path.slice(MCP_PATH_PREFIX.length);
  if (!rest || rest.includes('/')) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  return knownIds.has(id) ? id : undefined;
}

/** Обработчик запросов HTTP-MCP + освобождение ресурсов. */
export interface McpHttpHandler {
  /** Слушатель `node:http` (seam для тестов без bind порта). */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Закрывает лениво созданные клиенты Bot API тенантов. */
  close: () => void;
}

/**
 * Создаёт обработчик HTTP-запросов HTTP-MCP: маршрутизация по тенанту, auth,
 * health.
 */
export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const { config, token } = options;
  const log = options.log ?? (() => {});
  const legacy = isLegacyTenants(config);
  const tenants = new Map<string, TenantConfig>(
    config.tenants.map((tenant) => [tenant.id, tenant]),
  );
  const contexts = new Map<string, TelegramToolContext>();
  const sessions = new Map<string, SessionEntry>();

  const tenantContext = (tenantId: string): TelegramToolContext => {
    const existing = contexts.get(tenantId);
    if (existing) return existing;
    const tenant = tenants.get(tenantId);
    if (!tenant) throw new Error(`неизвестный тенант «${tenantId}»`);
    const context = buildTenantContext(config, tenant, legacy, {
      ...(options.defaultChatId !== undefined ? { defaultChatId: options.defaultChatId } : {}),
      ...(options.ownerChatId !== undefined ? { ownerChatId: options.ownerChatId } : {}),
    });
    contexts.set(tenantId, context);
    return context;
  };

  const dropSession = (sessionId: string): void => {
    sessions.delete(sessionId);
  };

  const handleMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
    tenantId: string,
  ): Promise<void> => {
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (sessionId) {
      const entry = sessions.get(sessionId);
      // Сессия чужого тенанта не должна обслуживаться этим путём.
      if (!entry || entry.tenantId !== tenantId) {
        sendJson(res, 404, {
          error: { code: 'NOT_FOUND', message: `MCP-сессия не найдена для тенанта «${tenantId}»` },
        });
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    const server = createMcpServer(tenantContext(tenantId), config.version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { tenantId, transport, server });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) dropSession(transport.sessionId);
      void server.close().catch(() => {});
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/health') {      sendJson(res, 200, {
        status: 'ok',
        version: config.version,
        transport: 'http',
        tenants: config.tenants.map((tenant) => tenant.id),
      });
      return;
    }

    if (!isAuthorized(req.headers.authorization, token)) {
      log(`[gateway-mcp] отказ 401: ${req.method ?? 'GET'} ${path}`);
      sendJson(res, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Требуется Authorization: Bearer <MCP-токен>' },
      });
      return;
    }

    const tenantId = parseTenantPath(path, new Set(tenants.keys()));
    if (!tenantId) {
      sendJson(res, 404, {
        error: {
          code: 'NOT_FOUND',
          message: `Неизвестный тенант: ожидается /mcp/<tenantId>, известные — ${[...tenants.keys()].join(', ')}`,
        },
      });
      return;
    }

    void handleMcp(req, res, tenantId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`[gateway-mcp][${tenantId}] ошибка обработки запроса: ${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message } });
    });
  };

  return {
    handler,
    close: () => {
      for (const context of contexts.values()) {
        try {
          context.client.close();
        } catch {
          /* noop */
        }
      }
      contexts.clear();
    },
  };
}

/**
 * Запускает HTTP-MCP-сервер (Streamable HTTP) с маршрутизацией `/mcp/<tenantId>`.
 * Пустой токен — ошибка конфигурации (fail-fast).
 */
export async function startMcpHttpServer(options: McpHttpOptions): Promise<McpHttpServerHandle> {
  const token = options.token?.trim();
  if (!token) {
    throw new Error(
      'HTTP-режим MCP требует bearer-токен: задайте GATEWAY_MCP_TOKEN (env) или secrets/mcp_token',
    );
  }
  const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
  const host = options.host ?? '0.0.0.0';

  const mcpHandler = createMcpHttpHandler({
    ...options,
    token,
    host,
    port,
    log: (message) => (options.log ?? (() => {}))(message),
  });

  const server = createServer((req, res) => mcpHandler.handler(req, res));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = isRecord(address) && typeof address.port === 'number' ? address.port : port;

  return {
    server,
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Клиенты Bot API, созданные лениво под тенантов, освобождаются.
      mcpHandler.close();
    },
  };
}
