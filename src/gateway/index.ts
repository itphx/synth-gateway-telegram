#!/usr/bin/env node
import {
  isLegacyTenants,
  loadConfig,
  parseParseMode,
  type ConfigOverrides,
  type TenantConfig,
} from './config.js';
import { GatewayHealthRegistry, type AuthMode } from './health.js';
import { createTenantRuntime, type TenantRuntime } from './runtime.js';
import { createApp, serve } from './server.js';
import { parseUnknownAction } from './unknown-action.js';

interface ParsedArgs {
  overrides: ConfigOverrides;
  once: boolean;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const overrides: ConfigOverrides = {};
  let once = false;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const nextValue = (): string | undefined => inline ?? argv[(i += 1)];

    switch (flag) {
      case '--once':
        once = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--no-watch':
        overrides.watch = false;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
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
      case '--synth-url': {
        const value = nextValue();
        if (value) overrides.synthUrl = value;
        break;
      }
      case '--synth-api-key':
      case '--api-key': {
        const value = nextValue();
        if (value) overrides.synthApiKey = value;
        break;
      }
      case '--service-key': {
        const value = nextValue();
        if (value) overrides.serviceKey = value;
        break;
      }
      case '--oidc-token-url': {
        const value = nextValue();
        if (value) overrides.oidcTokenUrl = value;
        break;
      }
      case '--oidc-discovery-url': {
        const value = nextValue();
        if (value) overrides.oidcDiscoveryUrl = value;
        break;
      }
      case '--oidc-client-id': {
        const value = nextValue();
        if (value) overrides.oidcClientId = value;
        break;
      }
      case '--oidc-client-secret': {
        const value = nextValue();
        if (value) overrides.oidcClientSecret = value;
        break;
      }
      case '--oidc-scope': {
        const value = nextValue();
        if (value) overrides.oidcScope = value;
        break;
      }
      case '--allowlist': {
        const value = nextValue();
        if (value) overrides.allowlist = value;
        break;
      }
      case '--tenants-file': {
        const value = nextValue();
        if (value) overrides.tenantsFile = value;
        break;
      }
      case '--parse-mode': {
        const value = nextValue();
        if (value) overrides.parseMode = parseParseMode(value);
        break;
      }
      case '--unknown-action': {
        const value = nextValue();
        if (value) overrides.unknownAction = parseUnknownAction(value);
        break;
      }
      case '--poll-timeout': {
        const value = nextValue();
        const parsed = value ? Number.parseInt(value, 10) : undefined;
        if (parsed !== undefined && !Number.isNaN(parsed) && parsed > 0) {
          overrides.pollTimeoutSec = parsed;
        }
        break;
      }
      case '--request-timeout': {
        const value = nextValue();
        const parsed = value ? Number.parseInt(value, 10) : undefined;
        if (parsed !== undefined && !Number.isNaN(parsed) && parsed > 0) {
          overrides.requestTimeoutSec = parsed;
        }
        break;
      }
      case '--data-dir': {
        const value = nextValue();
        if (value) overrides.dataDir = value;
        break;
      }
      case '--host': {
        const value = nextValue();
        if (value) overrides.host = value;
        break;
      }
      case '--port': {
        const value = nextValue();
        const parsed = value ? Number.parseInt(value, 10) : undefined;
        if (parsed !== undefined && !Number.isNaN(parsed)) overrides.port = parsed;
        break;
      }
      default:
        break;
    }
  }

  return { overrides, once, dryRun, help };
}

function printHelp(): void {
  console.log(
    [
      'synth-gateway-telegram',
      '',
      'Telegram-шлюз Synth: поллинг Telegram → внешние события API v2 (AD-089),',
      'обратная доставка ответов агента через SSE, локальные команды.',
      'Поддерживает N ботов (тенантов), каждый — своя среда Synth (tenants.json).',
      '',
      'Использование:',
      '  synth-gateway-telegram [--once] [--dry-run] [--no-watch] [--token TOKEN]',
      '                         [--proxy URL] [--synth-url URL] [--service-key KEY]',
      '                         [--api-key KEY]',
      '                         [--oidc-token-url URL] [--oidc-discovery-url URL]',
      '                         [--oidc-client-id ID] [--oidc-client-secret SECRET]',
      '                         [--oidc-scope SCOPE]',
      '                         [--allowlist LIST] [--tenants-file PATH]',
      '                         [--parse-mode plain|html]',
      '                         [--unknown-action register|hint|reject]',
      '                         [--poll-timeout SEC] [--request-timeout SEC]',
      '                         [--data-dir DIR] [--host HOST] [--port N]',
      '',
      'Флаги:',
      '  --once                один проход getUpdates по каждому тенанту и выход',
      '  --dry-run             без токена: один проход getUpdates и выход',
      '  --no-watch            не поднимать watcher ответов агента (SSE)',
      '  --token TOKEN         токен бота (env TELEGRAM_BOT_TOKEN, secrets/telegram_bot_token)',
      '  --proxy URL           прокси Bot API (env TELEGRAM_PROXY_URL, secrets/telegram_proxy_url)',
      '  --synth-url URL       базовый URL API v2 (env SYNTH_URL)',
      '  --service-key KEY     scoped service-key synth_svc_… (AD-052; env SYNTH_SERVICE_KEY, secrets/synth_service_key)',
      '  --api-key KEY         статический Bearer-ключ API v2, legacy-fallback (env SYNTH_API_KEY, файл secrets/synth_api_key)',
      '  --oidc-token-url URL  OIDC token-эндпоинт client-credentials (env SYNTH_OIDC_TOKEN_URL)',
      '  --oidc-discovery-url URL  URL OIDC discovery; token_endpoint берётся из него (env SYNTH_OIDC_DISCOVERY_URL)',
      '  --oidc-client-id ID   OIDC client_id (env SYNTH_OIDC_CLIENT_ID, secrets/oidc_client_id)',
      '  --oidc-client-secret SECRET  OIDC client_secret (env SYNTH_OIDC_CLIENT_SECRET, secrets/oidc_client_secret)',
      '  --oidc-scope SCOPE    OIDC scope (env SYNTH_OIDC_SCOPE)',
      '  --allowlist LIST      список доступа chatId:ROLE через запятую (env GATEWAY_ALLOWLIST)',
      '  --tenants-file PATH   файл тенантов (боты → среды Synth): env GATEWAY_TENANTS_FILE,',
      '                        secrets/tenants.json. Нет файла — один тенант default из env/CLI',
      '  --parse-mode MODE     отправка ответов: plain (дефолт) | html (env GATEWAY_PARSE_MODE)',
      '  --unknown-action ACT  политика неизвестного отправителя: register (дефолт) | hint | reject (env GATEWAY_UNKNOWN_ACTION)',
      '  --poll-timeout SEC    таймаут long-polling getUpdates, сек (env GATEWAY_POLL_TIMEOUT_SEC)',
      '  --request-timeout SEC таймаут обычных запросов Bot API, сек (env GATEWAY_REQUEST_TIMEOUT_SEC)',
      '  --data-dir DIR        каталог JSON-хранилища (env GATEWAY_DATA_DIR, по умолчанию <repo>/data)',
      '  --host HOST           адрес health-сервера (env GATEWAY_HOST, по умолчанию 127.0.0.1)',
      '  --port N              порт health-сервера (env GATEWAY_PORT, по умолчанию 7100)',
      '  --help, -h            эта справка',
    ].join('\n'),
  );
}

/** Человекочитаемая метка режима аутентификации Synth API (без секретов). */
function authLabel(mode: AuthMode): string {
  switch (mode) {
    case 'service-key':
      return 'service-key (scoped)';
    case 'oidc':
      return 'OIDC client-credentials';
    case 'api-key':
      return 'Bearer-ключ';
    default:
      return 'без ключа';
  }
}

/**
 * Логгер с префиксом тенанта: `[gateway][<id>] …`. В legacy-режиме (единственный
 * `default`) префикс не добавляется — вывод идентичен прежнему.
 */
function makeTenantLog(
  id: string,
  legacy: boolean,
  sink: (message: string) => void,
): (message: string) => void {
  if (legacy) return sink;
  const prefix = '[gateway]';
  return (message: string): void => {
    if (message.startsWith(`${prefix} `)) {
      sink(`[gateway][${id}] ${message.slice(prefix.length + 1)}`);
    } else if (message.startsWith(prefix)) {
      sink(`[gateway][${id}]${message.slice(prefix.length)}`);
    } else {
      sink(`[gateway][${id}] ${message}`);
    }
  };
}

/** Логи запуска тенанта (без секретов). */
function logTenantStartup(
  tenant: TenantConfig,
  authMode: AuthMode,
  log: (message: string) => void,
): void {
  log(`[gateway] тенант «${tenant.id}»`);
  log(`[gateway] API v2: ${tenant.synth.baseUrl} (auth: ${authLabel(authMode)})`);
  log(`[gateway] список доступа: ${Object.keys(tenant.allowlist).length} записей`);
  log(`[gateway] отправка ответов: ${tenant.parseMode}`);
  log(`[gateway] политика неизвестного отправителя: ${tenant.unknownAction}`);
  log(`[gateway] таймауты: long-poll ${tenant.pollTimeoutSec} с, запрос ${tenant.requestTimeoutSec} с`);
}

async function main(): Promise<void> {
  const log = (message: string): void => console.log(message);
  const { overrides, once, dryRun, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  const config = loadConfig(process.env, {
    ...overrides,
    ...(dryRun ? { dryRun: true } : {}),
  });
  const legacy = isLegacyTenants(config);

  const registry = new GatewayHealthRegistry();
  const daemon = !config.dryRun && !once;

  log(`[gateway] synth-gateway-telegram ${config.version}`);
  log(`[gateway] тенантов: ${config.tenants.length}${legacy ? ' (legacy default)' : ` (${config.tenantsFile})`}`);
  log(`[gateway] данные: ${config.dataDir}`);
  if (daemon) log(`[gateway] health: http://${config.host}:${config.port}/health`);

  // В демоне health-сервер поднимаем до создания рантаймов: пробы деплоя не
  // должны зависеть от доступности Telegram.
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  if (daemon) server = await serve(createApp(config, registry), config);

  const runtimes: TenantRuntime[] = [];
  for (const tenant of config.tenants) {
    const health = registry.register(tenant.id);
    const tenantLog = makeTenantLog(tenant.id, legacy, log);
    const runtime = await createTenantRuntime(config, tenant, daemon, {
      health,
      log: tenantLog,
      isLegacy: legacy,
    });
    logTenantStartup(tenant, runtime.auth.mode, tenantLog);
    runtime.healthProbe?.start();
    runtimes.push(runtime);
  }

  const stopAll = (): void => {
    for (const runtime of runtimes) {
      runtime.poller.stop();
      runtime.watcher?.stop();
      runtime.healthProbe?.stop();
    }
  };
  const closeAll = (): void => {
    for (const runtime of runtimes) runtime.client.close();
  };

  if (daemon) {
    const shutdown = (signal: string): void => {
      log(`[gateway] получен ${signal} — завершаю работу`);
      stopAll();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // Dry-run (в т.ч. без токена) — один проход по каждому тенанту и выход.
  if (config.dryRun) {
    for (const runtime of runtimes) await runtime.poller.run();
    return;
  }

  if (once) {
    for (const runtime of runtimes) await runtime.poller.runOnce();
    return;
  }

  // Демон: watcher'ы ответов (если включены) + long-polling каждого тенанта.
  const watcherRuns = runtimes.map((runtime) =>
    runtime.watcher ? runtime.watcher.run() : Promise.resolve(),
  );
  await Promise.all(runtimes.map((runtime) => runtime.poller.run()));
  stopAll();
  await Promise.all(watcherRuns);
  closeAll();

  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error('[gateway] фатальная ошибка:', error);
  process.exit(1);
});
