import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, type GatewayConfig } from '../gateway/config.js';

import {
  buildTenantContext,
  createMcpHttpHandler,
  DEFAULT_MCP_HTTP_PORT,
  isAuthorized,
  parseTenantPath,
  startMcpHttpServer,
  type McpHttpServerHandle,
} from './http.js';

const TOKEN = 'test-mcp-token';
const TENANTS = {
  tenants: [
    { id: 'dev', botToken: 'dev-token', synthUrl: 'http://dev.synth/api/v2', serviceKey: 'synth_svc_dev' },
    { id: 'test', botToken: 'test-token', synthUrl: 'http://test.synth/api/v2' },
  ],
};

let secretsDir: string;
let tenantsDir: string;
let config: GatewayConfig;
let handle: McpHttpServerHandle;
let baseUrl: string;

beforeAll(async () => {
  secretsDir = mkdtempSync(join(tmpdir(), 'gateway-mcp-http-secrets-'));
  tenantsDir = mkdtempSync(join(tmpdir(), 'gateway-mcp-http-tenants-'));
  const tenantsFile = join(tenantsDir, 'tenants.json');
  writeFileSync(tenantsFile, JSON.stringify(TENANTS));
  config = loadConfig(
    { GATEWAY_MCP_TOKEN: TOKEN },
    { tenantsFile, secretsDir, dataDir: join(tenantsDir, 'data') },
  );
  handle = await startMcpHttpServer({ config, token: TOKEN, host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
  rmSync(secretsDir, { recursive: true, force: true });
  rmSync(tenantsDir, { recursive: true, force: true });
});

/** Разбор SSE-ответа: возвращает JSON первых `data:`-строк. */
function parseSse(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload) events.push(JSON.parse(payload) as unknown);
  }
  return events;
}

interface JsonRpcResult {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** POST JSON-RPC на MCP-эндпоинт; возвращает ответ + распарсенные SSE-события. */
async function rpc(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; sessionId: string | null; messages: JsonRpcResult[]; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const messages = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
    ? (parseSse(text) as JsonRpcResult[])
    : text
      ? [JSON.parse(text) as JsonRpcResult]
      : [];
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), messages, text };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gateway-test', version: '0.0.0' },
  },
};

describe('isAuthorized / parseTenantPath', () => {
  it('принимает только точный Bearer-токен', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer wrong', TOKEN)).toBe(false);
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
  });

  it('извлекает тенанта из /mcp/<id> и отсекает лишнее', () => {
    const known = new Set(['dev', 'test']);
    expect(parseTenantPath('/mcp/dev', known)).toBe('dev');
    expect(parseTenantPath('/mcp/dev/', known)).toBeUndefined();
    expect(parseTenantPath('/mcp/unknown', known)).toBeUndefined();
    expect(parseTenantPath('/mcp', known)).toBeUndefined();
    expect(parseTenantPath('/mcp/dev/messages', known)).toBeUndefined();
  });
});

describe('buildTenantContext: контекст инструментов из тенанта', () => {
  it('dataDir — per-tenant, синт-настройки и токен бота — тенанта', () => {
    const dev = config.tenants.find((tenant) => tenant.id === 'dev');
    expect(dev).toBeDefined();
    const context = buildTenantContext(config, dev!, false, { defaultChatId: '42' });

    expect(context.dataDir).toBe(join(config.dataDir, 'tenants', 'dev'));
    expect(context.defaultChatId).toBe('42');
    expect(context.synth?.baseUrl).toBe('http://dev.synth/api/v2');
    expect(context.synth?.serviceKey).toBe('synth_svc_dev');
    expect(context.client.dryRun).toBe(false);
  });

  it('без токена бота клиент переходит в dry-run (тенант не делает сетевых вызовов)', () => {
    const tenant = { ...config.tenants[0]!, telegram: {} };
    const context = buildTenantContext(config, tenant, false);
    expect(context.client.dryRun).toBe(true);
  });
});

describe('HTTP-MCP: health / auth / маршрутизация по тенанту', () => {
  it('GET /health — без auth, перечисляет тенантов', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; tenants: string[] };
    expect(body.status).toBe('ok');
    expect(body.tenants).toEqual(['dev', 'test']);
  });

  it('без токена → 401 (до маршрутизации)', async () => {
    for (const path of ['/mcp/dev', '/mcp/unknown']) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(INITIALIZE),
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHORIZED',
      );
    }
  });

  it('неверный токен → 401', async () => {
    const response = await fetch(`${baseUrl}/mcp/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify(INITIALIZE),
    });
    expect(response.status).toBe(401);
  });

  it('неизвестный тенант → 404', async () => {
    const response = await fetch(`${baseUrl}/mcp/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('dev');
  });

  it('посторонний путь → 404', async () => {
    const response = await fetch(`${baseUrl}/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe('HTTP-MCP: MCP-сессия тенанта', () => {
  it('initialize отдаёт serverInfo и session id, tools/list — тулы тенанта', async () => {
    const init = await rpc('/mcp/dev', INITIALIZE);
    expect(init.status).toBe(200);
    const info = init.messages.find((message) => message.id === 1)?.result?.serverInfo as {
      name: string;
    };
    expect(info?.name).toBe('synth-gateway-telegram');
    const sessionId = init.sessionId;
    expect(sessionId).toBeTruthy();

    const initialized = await rpc(
      '/mcp/dev',
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'mcp-session-id': sessionId! },
    );
    expect(initialized.status).toBe(202);
    expect(initialized.messages).toEqual([]);

    const list = await rpc(
      '/mcp/dev',
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { 'mcp-session-id': sessionId! },
    );
    expect(list.status).toBe(200);
    const tools = (list.messages.find((message) => message.id === 2)?.result?.tools ?? []) as {
      name: string;
    }[];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('tg_send_to_user');
    expect(names).toContain('tg_send_message');
  });

  it('сессия одного тенанта не обслуживается по пути другого → 404', async () => {
    const init = await rpc('/mcp/dev', INITIALIZE);
    expect(init.sessionId).toBeTruthy();
    const wrong = await rpc(
      '/mcp/test',
      { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
      { 'mcp-session-id': init.sessionId! },
    );
    expect(wrong.status).toBe(404);
  });

  it('неизвестный session id → 404', async () => {
    const response = await rpc(
      '/mcp/dev',
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { 'mcp-session-id': 'nope' },
    );
    expect(response.status).toBe(404);
  });
});

describe('startMcpHttpServer', () => {
  it('без токена — fail-fast с понятным сообщением', async () => {
    await expect(startMcpHttpServer({ config, token: '  ' })).rejects.toThrow(
      /GATEWAY_MCP_TOKEN/,
    );
  });

  it('порт по умолчанию — 7101', () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(7101);
  });

  it('createMcpHttpHandler возвращает слушатель и close', () => {
    const created = createMcpHttpHandler({ config, token: TOKEN });
    expect(typeof created.handler).toBe('function');
    expect(typeof created.close).toBe('function');
    created.close();
  });
});
