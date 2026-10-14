#!/usr/bin/env node
import { TelegramClient } from '../bot-api/index.js';

import { loadConfig, type ConfigOverrides } from './config.js';
import { startMcpHttpServer, DEFAULT_MCP_HTTP_PORT } from './http.js';
import { runMcpServer } from './server.js';

interface ParsedArgs {
  overrides: ConfigOverrides;
  /** Режим HTTP-транспорта (`--http`); по умолчанию — stdio. */
  http: boolean;
  host: string;
  port: number;
  /** Путь к `tenants.json` (мультитенантность HTTP-режима). */
  tenantsFile?: string;
  /** Каталог секрет-файлов HTTP-режима. */
  secretsDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const overrides: ConfigOverrides = {};
  let http = false;
  let host = '0.0.0.0';
  let port = DEFAULT_MCP_HTTP_PORT;
  let tenantsFile: string | undefined;
  let secretsDir: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const nextValue = (): string | undefined => inline ?? argv[(i += 1)];

    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--http':
        http = true;
        break;
      case '--host': {
        const value = nextValue();
        if (value) host = value;
        break;
      }
      case '--port': {
        const value = nextValue();
        const parsed = value ? Number.parseInt(value, 10) : undefined;
        if (parsed !== undefined && !Number.isNaN(parsed)) port = parsed;
        break;
      }
      case '--mcp-token': {
        const value = nextValue();
        if (value) overrides.mcpToken = value;
        break;
      }
      case '--tenants-file': {
        const value = nextValue();
        if (value) tenantsFile = value;
        break;
      }
      case '--secrets-dir': {
        const value = nextValue();
        if (value) secretsDir = value;
        break;
      }
      case '--token': {
        const value = nextValue();
        if (value) overrides.token = value;
        break;
      }
      case '--proxy': {
        const value = nextValue();
        if (value) overrides.proxyUrl = value;
        break;
      }
      case '--chat': {
        const value = nextValue();
        if (value) overrides.defaultChatId = value;
        break;
      }
      case '--owner': {
        const value = nextValue();
        if (value) overrides.ownerChatId = value;
        break;
      }
      case '--data-dir': {
        const value = nextValue();
        if (value) overrides.dataDir = value;
        break;
      }
      default:
        break;
    }
  }

  return {
    overrides,
    http,
    host,
    port,
    ...(tenantsFile !== undefined ? { tenantsFile } : {}),
    ...(secretsDir !== undefined ? { secretsDir } : {}),
    help,
  };
}

function printHelp(): void {
  console.log(
    [
      'synth-gateway-tg — MCP-сервер Telegram-шлюза Synth',
      '',
      'Использование (stdio — по умолчанию):',
      '  synth-gateway-tg [--token T] [--proxy URL] [--chat ID] [--owner ID] [--data-dir DIR]',
      '',
      'Использование (Streamable HTTP; для K8s, где stdio недоступен):',
      '  synth-gateway-tg --http [--host 0.0.0.0] [--port 7101]',
      '                    [--mcp-token TOKEN] [--tenants-file PATH] [--secrets-dir DIR]',
      '                    [--data-dir DIR] [--chat ID] [--owner ID]',
      '',
      'Инструменты MCP (неймспейс synth-gateway-telegram_*):',
      '  tg_send_message   { text, chatId?, replyToMessageId? }',
      '  tg_send_to_user   { text, user? | principalId? | chatId?, replyToMessageId? }',
      '  tg_edit_message   { messageId, text, chatId? }',
      '  tg_delete_message { messageId, chatId? }',
      '  tg_notify         { text }',
      '  tg_send_buttons   { text, buttons: [{ text, data }], chatId? }',
      '  tg_get_me         {}',
      '  tg_status         { chatId? }',
      '',
      'Флаги:',
      '  --http        поднять Streamable HTTP-транспорт вместо stdio',
      '  --host HOST   адрес HTTP-сервера (env GATEWAY_HOST, дефолт 0.0.0.0)',
      '  --port N      порт HTTP-сервера (env GATEWAY_PORT, дефолт 7101)',
      '  --mcp-token T bearer-токен клиентов MCP (env GATEWAY_MCP_TOKEN, secrets/mcp_token)',
      '  --tenants-file PATH  файл тенантов «боты → среды Synth» (env GATEWAY_TENANTS_FILE,',
      '                secrets/tenants.json); путь запроса — /mcp/<tenantId>',
      '  --secrets-dir DIR    каталог секрет-файлов (env GATEWAY_SECRETS_DIR)',
      '  --token T     токен бота (env TELEGRAM_BOT_TOKEN, secrets/telegram_bot_token)',
      '  --proxy URL   прокси Bot API (env TELEGRAM_PROXY_URL, secrets/telegram_proxy_url)',
      '  --chat ID     чат по умолчанию (env GATEWAY_DEFAULT_CHAT_ID, secrets/telegram_owner_chat_id)',
      '  --owner ID    получатель tg_notify (env GATEWAY_OWNER_CHAT_ID)',
      '  --data-dir DIR каталог хранилища шлюза (env GATEWAY_DATA_DIR) для tg_status',
      '  --help, -h    эта справка',
      '',
      'Без токена сервер работает в dry-run: тулы не делают сетевых вызовов.',
      'HTTP-режим: GET /health — без auth; /mcp/<tenantId> — Authorization: Bearer <mcp-token>.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig(process.env, {
    ...args.overrides,
    ...(args.secretsDir !== undefined ? { secretsDir: args.secretsDir } : {}),
  });

  if (args.http) {
    // HTTP-режим: тенанты (токен бота, прокси, synthUrl/serviceKey) берутся из
    // tenants.json — тем же загрузчиком, что у сервиса шлюза.
    const { loadConfig: loadGatewayConfig } = await import('../gateway/config.js');
    const gateway = loadGatewayConfig(process.env, {
      host: args.host,
      port: args.port,
      ...(args.overrides.dataDir !== undefined ? { dataDir: args.overrides.dataDir } : {}),
      ...(args.tenantsFile !== undefined ? { tenantsFile: args.tenantsFile } : {}),
      ...(args.secretsDir !== undefined ? { secretsDir: args.secretsDir } : {}),
      ...(args.overrides.token !== undefined ? { token: args.overrides.token } : {}),
      ...(args.overrides.proxyUrl !== undefined ? { proxyUrl: args.overrides.proxyUrl } : {}),
    });

    console.error(
      `[gateway-mcp] synth-gateway-tg ${config.version}: HTTP-MCP на ` +
        `http://${args.host}:${args.port}/mcp/<tenantId>; ` +
        `тенантов: ${gateway.tenants.length}` +
        `${gateway.tenantsFile ? ` (${gateway.tenantsFile})` : ' (legacy default)'}`,
    );

    const handle = await startMcpHttpServer({
      config: gateway,
      token: config.mcpToken ?? '',
      host: args.host,
      port: args.port,
      ...(config.defaultChatId !== undefined ? { defaultChatId: config.defaultChatId } : {}),
      ...(config.ownerChatId !== undefined ? { ownerChatId: config.ownerChatId } : {}),
      log: (message) => console.error(message),
    });

    const shutdown = (signal: string): void => {
      console.error(`[gateway-mcp] получен ${signal} — останавливаю HTTP-MCP`);
      void handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  const client = new TelegramClient({
    token: config.telegram.token,
    proxyUrl: config.telegram.proxyUrl,
    ...(config.defaultChatId !== undefined ? { channelId: config.defaultChatId } : {}),
  });

  // stdout занят протоколом MCP — диагностика идёт в stderr.
  console.error(
    `[gateway-mcp] synth-gateway-tg ${config.version}: ` +
      `${client.dryRun ? 'dry-run (TELEGRAM_BOT_TOKEN не задан)' : 'реальный режим'}; ` +
      `data-dir ${config.dataDir}`,
  );

  await runMcpServer(
    {
      client,
      ...(config.defaultChatId !== undefined ? { defaultChatId: config.defaultChatId } : {}),
      ...(config.ownerChatId !== undefined ? { ownerChatId: config.ownerChatId } : {}),
      dataDir: config.dataDir,
    },
    config.version,
  );
  client.close();
}

main().catch((error: unknown) => {
  console.error('[gateway-mcp] фатальная ошибка:', error);
  process.exit(1);
});
