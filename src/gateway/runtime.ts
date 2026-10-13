import { TelegramClient, type TelegramClientOptions } from '../bot-api/index.js';

import {
  AuthTokenProvider,
  isOidcPartial,
  type AuthTokenProviderOptions,
} from './auth.js';
import { CommandHandler, type CommandHandlerOptions } from './command-handler.js';
import { tenantStoreDir, type GatewayConfig, type TenantConfig } from './config.js';
import type { GatewayHealth } from './health.js';
import { SynthHealthProbe, type SynthHealthProbeOptions } from './health-probe.js';
import { SynthEventsClient, type SynthEventsClientOptions } from './ingest.js';
import { Poller, type PollerOptions } from './poller.js';
import { GatewayStore } from './store.js';
import { AgentWatcher, type WatcherOptions } from './watcher.js';

/** Идентичность бота (`getMe`): id/username — часть `dedupKey` и логов. */
export interface BotIdentity {
  botId?: number | string;
  botUsername?: string;
}

/** Резолвер идентичности бота (по умолчанию — реальный `getMe`). */
export type BotIdentityResolver = (
  client: TelegramClient,
  health: GatewayHealth,
  log: (message: string) => void,
) => Promise<BotIdentity>;

/** Runtime-окружение одного тенанта (бот → среда Synth). */
export interface TenantRuntime {
  tenant: TenantConfig;
  /** Режим без токена/сетевых вызовов для этого тенанта. */
  dryRun: boolean;
  store: GatewayStore;
  auth: AuthTokenProvider;
  client: TelegramClient;
  events: SynthEventsClient;
  commands: CommandHandler;
  poller: Poller;
  watcher?: AgentWatcher;
  health: GatewayHealth;
  healthProbe?: SynthHealthProbe;
}

/**
 * Фабрики компонентов тенанта — seam для тестов (fan-out без реальной сети).
 * Каждое поле необязательно: по умолчанию создаётся реальный компонент.
 */
export interface TenantRuntimeDeps {
  /** Health-контекст тенанта (из {@link GatewayHealthRegistry}). */
  health: GatewayHealth;
  /** Логгер тенанта (обычно с префиксом `[gateway][<id>]`). */
  log: (message: string) => void;
  /** Legacy-режим (без `tenants.json`): `default` пишет в корень `dataDir`. */
  isLegacy: boolean;
  createStore?: (dir: string) => GatewayStore;
  createAuth?: (options: AuthTokenProviderOptions) => AuthTokenProvider;
  createClient?: (options: TelegramClientOptions) => TelegramClient;
  createEvents?: (options: SynthEventsClientOptions) => SynthEventsClient;
  createCommands?: (options: CommandHandlerOptions) => CommandHandler;
  createPoller?: (options: PollerOptions) => Poller;
  createWatcher?: (options: WatcherOptions) => AgentWatcher;
  createHealthProbe?: (options: SynthHealthProbeOptions) => SynthHealthProbe;
  resolveIdentity?: BotIdentityResolver;
}

/**
 * Резолвит идентичность бота (`getMe`) и обновляет health-контекст тенанта.
 * Ошибки — best-effort (не валят запуск); в dry-run сетевых вызовов нет.
 */
export async function resolveBotIdentity(
  client: TelegramClient,
  health: GatewayHealth,
  log: (message: string) => void,
): Promise<BotIdentity> {
  if (client.dryRun) {
    health.setBot('dry-run');
    return {};
  }
  try {
    const me = await client.getMe();
    if (!me.ok) {
      log(`[gateway] getMe вернул ошибку: ${me.description ?? 'unknown'}`);
      return {};
    }
    health.setBot('ok');
    return {
      ...(me.result?.id !== undefined ? { botId: me.result.id } : {}),
      ...(me.result?.username ? { botUsername: me.result.username } : {}),
    };
  } catch (error) {
    log(`[gateway] getMe ошибка: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * Собирает runtime одного тенанта: хранилище (namespace по тенанту), клиент
 * Telegram, провайдер Bearer-токена, клиент событий, обработчик команд, поллер и
 * (в демоне) watcher ответов + health-пробу Synth. Сетевых вызовов, кроме
 * best-effort `getMe`/`auth.check`, не делает.
 */
export async function createTenantRuntime(
  config: GatewayConfig,
  tenant: TenantConfig,
  daemon: boolean,
  deps: TenantRuntimeDeps,
): Promise<TenantRuntime> {
  const { health, log } = deps;
  const dryRun = config.dryRun || !tenant.telegram.token;

  const store = (deps.createStore ?? ((dir: string) => new GatewayStore(dir)))(
    tenantStoreDir(config.dataDir, tenant.id, deps.isLegacy),
  );
  await store.init();

  const auth = (deps.createAuth ?? ((options) => new AuthTokenProvider(options)))({
    serviceKey: tenant.synth.serviceKey,
    apiKey: tenant.synth.apiKey,
    oidc: tenant.synth.oidc,
    health,
    log,
  });
  health.setAuth(auth.mode);
  if (!dryRun && !tenant.synth.serviceKey && isOidcPartial(tenant.synth.oidc)) {
    log(
      '[gateway] OIDC настроен неполно (нужны token/discovery URL, client_id, client_secret) — используется API-ключ/без auth',
    );
  }
  // Best-effort прогрев токена: health-поле `token` не должно «врать» до первого
  // события. В dry-run сетевых вызовов нет — прогрев пропускается.
  if (!dryRun) void auth.check();

  const client = (deps.createClient ?? ((options) => new TelegramClient(options)))({
    token: tenant.telegram.token,
    proxyUrl: tenant.telegram.proxyUrl,
    dryRun,
    requestTimeoutMs: tenant.requestTimeoutSec * 1000,
  });

  const events = (deps.createEvents ?? ((options) => new SynthEventsClient(options)))({
    baseUrl: tenant.synth.baseUrl,
    apiKey: tenant.synth.apiKey,
    bearer: auth,
    log,
    health,
  });

  const commands = (deps.createCommands ?? ((options) => new CommandHandler(options)))({
    client,
    synth: events,
    store,
    dryRun,
    log,
  });

  const identity = await (deps.resolveIdentity ?? resolveBotIdentity)(client, health, log);

  const poller = (deps.createPoller ?? ((options) => new Poller(options)))({
    client,
    events,
    store,
    commands,
    allowlist: tenant.allowlist,
    unknownAction: tenant.unknownAction,
    pollTimeoutSec: tenant.pollTimeoutSec,
    ...identity,
    log,
  });

  const watcher =
    daemon && tenant.watch
      ? (deps.createWatcher ?? ((options) => new AgentWatcher(options)))({
          baseUrl: tenant.synth.baseUrl,
          apiKey: tenant.synth.apiKey,
          bearer: auth,
          client,
          store,
          parseMode: tenant.parseMode,
          health,
          log,
        })
      : undefined;

  const healthProbe = daemon
    ? (deps.createHealthProbe ?? ((options) => new SynthHealthProbe(options)))({
        baseUrl: tenant.synth.baseUrl,
        // `/health` публичный, но ключ передаём для единообразия авторизации:
        // приоритет — service-key (AD-052), иначе legacy api-key.
        apiKey: tenant.synth.serviceKey ?? tenant.synth.apiKey,
        health,
        log,
      })
    : undefined;

  return {
    tenant,
    dryRun,
    store,
    auth,
    client,
    events,
    commands,
    poller,
    ...(watcher ? { watcher } : {}),
    health,
    ...(healthProbe ? { healthProbe } : {}),
  };
}
