import type { TelegramClient, Update } from '../bot-api/index.js';

import type { CommandHandler } from './command-handler.js';
import { DEFAULT_POLL_TIMEOUT_SEC } from './config.js';
import type { IngestResult, SynthEventsClient } from './ingest.js';
import { normalizeUpdate, type NormalizeContext, type SynthEventInput } from './normalize.js';
import type { GatewayStore } from './store.js';
import {
  buildUnknownHint,
  DEFAULT_UNKNOWN_ACTION,
  unknownSenderResolver,
  UNKNOWN_HINT_KEY,
  UNKNOWN_HINT_NOT_PRIVATE_KEY,
  UNKNOWN_REJECT_KEY,
  UNKNOWN_REJECT_TEXT,
  type SenderKnownResolver,
  type UnknownAction,
} from './unknown-action.js';

/** Типы апдейтов, которые запрашивает шлюз. */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'];

export { DEFAULT_POLL_TIMEOUT_SEC };

/** Базовая пауза между попытками `getUpdates` при ошибке, мс. */
export const ERROR_BACKOFF_MS = 3000;

/** Максимальная пауза backoff между попытками `getUpdates`, мс. */
export const MAX_ERROR_BACKOFF_MS = 30_000;

/** Опции поллера. */
export interface PollerOptions {
  client: TelegramClient;
  events: SynthEventsClient;
  store: GatewayStore;
  allowlist: Record<string, string>;
  /** Обработчик локальных команд (`/help`, `/bind`, …); нет — команды идут как события. */
  commands?: CommandHandler;
  /** Числовой id бота — часть `dedupKey`. */
  botId?: number | string;
  /** Username бота — фоллбек для `dedupKey`. */
  botUsername?: string;
  /** Политика отправителя, не сопоставленного с учётной записью (по умолчанию `register`). */
  unknownAction?: UnknownAction;
  /**
   * AD-089: «известен ли отправитель» (привязка к профилю). Источник — ядро
   * (этап 3); по умолчанию fail-closed (неизвестен) — {@link unknownSenderResolver}.
   */
  isSenderKnown?: SenderKnownResolver;
  pollTimeoutSec?: number;
  /** Базовая пауза backoff при ошибках `getUpdates`, мс (по умолчанию 3000). */
  errorBackoffMs?: number;
  log?: (message: string) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Long-polling воркер шлюза.
 *
 * Получает апдейты Telegram (`getUpdates` с `offset`/`timeout`), дедуплицирует
 * их (в памяти + персистентно через {@link GatewayStore}), нормализует в события
 * Synth и публикует через {@link SynthEventsClient}. Ошибки `getUpdates` не
 * валят процесс — выдерживается backoff. Останов — методом {@link stop}
 * (вызывается по SIGINT/SIGTERM). Без токена — dry-run: один проход и выход.
 */
export class Poller {
  private readonly client: TelegramClient;
  private readonly events: SynthEventsClient;
  private readonly store: GatewayStore;
  private readonly context: NormalizeContext;
  private readonly commands?: CommandHandler;
  private readonly pollTimeoutSec: number;
  private readonly errorBackoffMs: number;
  private readonly log: (message: string) => void;
  private readonly unknownAction: UnknownAction;
  private readonly isSenderKnown: SenderKnownResolver;
  private readonly memorySeen = new Set<number>();
  private controller?: AbortController;
  private stopped = false;

  constructor(options: PollerOptions) {
    this.client = options.client;
    this.events = options.events;
    this.store = options.store;
    this.commands = options.commands;
    this.context = {
      allowlist: options.allowlist,
      ...(options.botId !== undefined ? { botId: options.botId } : {}),
      ...(options.botUsername !== undefined ? { botUsername: options.botUsername } : {}),
    };
    this.pollTimeoutSec = options.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
    this.errorBackoffMs = options.errorBackoffMs ?? ERROR_BACKOFF_MS;
    this.unknownAction = options.unknownAction ?? DEFAULT_UNKNOWN_ACTION;
    this.isSenderKnown = options.isSenderKnown ?? unknownSenderResolver;
    this.log = options.log ?? (() => {});
  }

  /** Просит поллер корректно завершиться и прерывает активный `getUpdates`. */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  /** Один проход: `getUpdates` (без long-polling) + обработка пачки. */
  async runOnce(): Promise<void> {
    const updates = await this.fetchUpdates(0);
    await this.processUpdates(updates);
  }

  /** Основной цикл long-polling. В dry-run — один проход и выход. */
  async run(): Promise<void> {
    if (this.client.dryRun) {
      this.log('[gateway] нет токена → dry-run: один проход getUpdates и выход');
      await this.runOnce();
      return;
    }

    this.log('[gateway] поллер запущен (long-polling)');
    let errorStreak = 0;
    const controller = new AbortController();
    this.controller = controller;

    try {
      while (!this.stopped) {
        let updates: Update[];
        try {
          updates = await this.fetchUpdates(this.pollTimeoutSec, controller.signal);
          errorStreak = 0;
        } catch (error) {
          if (this.stopped) break;
          errorStreak += 1;
          const wait = Math.min(this.errorBackoffMs * 2 ** (errorStreak - 1), MAX_ERROR_BACKOFF_MS);
          this.log(
            `[gateway] getUpdates ошибка (${errorStreak}): ${describeError(error)} — пауза ${wait} мс`,
          );
          await delay(wait, controller.signal);
          continue;
        }
        await this.processUpdates(updates);
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }

    this.log('[gateway] поллер остановлен');
  }

  /** Обрабатывает пачку апдейтов: дедуп, нормализация, публикация, сдвиг offset. */
  async processUpdates(updates: Update[]): Promise<void> {
    for (const update of updates) {
      const updateId = update.update_id;
      if (this.memorySeen.has(updateId) || (await this.store.hasSeen(updateId))) {
        await this.advanceOffset(updateId);
        continue;
      }
      this.memorySeen.add(updateId);
      await this.store.markSeen(updateId);

      const event = normalizeUpdate(update, this.context);
      if (!event) {
        this.log(`[gateway] апдейт ${updateId} пропущен (нет в списке доступа или не поддержан)`);
        await this.advanceOffset(updateId);
        continue;
      }

      // Локальные команды шлюза обрабатываются без публикации в ядро.
      if (event.type === 'command' && this.commands) {
        const handled = await this.commands.handle(event);
        if (handled) {
          await this.advanceOffset(updateId);
          continue;
        }
      }

      // callback_query подтверждаем сразу, чтобы у клиента не «крутились часики».
      if (update.callback_query) {
        await this.answerCallback(update.callback_query.id);
      }

      // Политика `reject`: отправитель, не сопоставленный с учётной записью,
      // **не публикуется** (fail-closed). «Известность» резолвит ядро — здесь
      // используется инъектируемый резолвер (этап 3).
      if (this.unknownAction === 'reject' && !(await this.isSenderKnown(event.identity))) {
        await this.replyText(event, UNKNOWN_REJECT_TEXT);
        this.log(`[gateway] апдейт ${updateId} отклонён (${UNKNOWN_REJECT_KEY})`);
        await this.advanceOffset(updateId);
        continue;
      }

      const result = await this.postEvent(event, updateId);
      if (result) {
        await this.rememberSession(event, result.sessionId);
        // Политика `hint`: событие уже опубликовано; сопоставление отправителя
        // резолвит ядро. Публикацию **не** блокируем. Если ядро вернуло
        // `identityHint` (отправитель не сопознан) — отвечаем кодом линковки
        // **только в приватном чате**: в группе/канале код увидели бы все
        // участники и могли «угнать» привязку (AD-089 claim-flow). В публичном
        // чате код не показываем — он истечёт по TTL.
        if (this.unknownAction === 'hint') {
          if (result.identityHint?.code) {
            if (event.payload.chatType === 'private') {
              await this.replyText(event, buildUnknownHint(result.identityHint.code));
            } else {
              this.log(
                `[gateway] апдейт ${updateId}: код линковки не отправлен ` +
                  `(чат не приватный: ${event.payload.chatType ?? 'unknown'}; ` +
                  `${UNKNOWN_HINT_NOT_PRIVATE_KEY})`,
              );
            }
          } else if (!(await this.isSenderKnown(event.identity))) {
            this.log(
              `[gateway] апдейт ${updateId}: сопоставление отправителя не подтверждено (${UNKNOWN_HINT_KEY})`,
            );
          }
        }
      }

      await this.advanceOffset(updateId);
    }
  }

  /** Публикует событие, логируя (но не пробрасывая) ошибку; `null` при сбое. */
  private async postEvent(
    event: SynthEventInput,
    updateId: number,
  ): Promise<IngestResult | null> {
    try {
      return await this.events.postEvent(event);
    } catch (error) {
      this.log(`[gateway] не удалось опубликовать апдейт ${updateId}: ${describeError(error)}`);
      return null;
    }
  }

  /** Best-effort ответ в чат по событию (с учётом треда/`reply`); ошибка — в лог. */
  private async replyText(event: SynthEventInput, text: string): Promise<void> {
    try {
      await this.client.sendMessage({
        chatId: event.payload.chatId,
        text,
        ...(event.payload.threadId !== undefined
          ? { messageThreadId: event.payload.threadId }
          : {}),
        replyToMessageId: event.payload.messageId,
      });
    } catch (error) {
      this.log(`[gateway] не удалось ответить в чат: ${describeError(error)}`);
    }
  }

  /** Best-effort ответ на callback-запрос (ошибка не валит поллер). */
  private async answerCallback(callbackQueryId: string): Promise<void> {
    try {
      await this.client.answerCallbackQuery({ callbackQueryId, text: 'принято' });
    } catch (error) {
      this.log(`[gateway] answerCallbackQuery ошибка: ${describeError(error)}`);
    }
  }

  /** Сохраняет привязку чата к сессии и последнее входящее сообщение. */
  private async rememberSession(event: SynthEventInput, sessionId: string | null): Promise<void> {
    const chatKey = event.identity.chatKey;
    if (!chatKey || !sessionId) return;
    await this.store.setChatSession(chatKey, {
      sessionId,
      chatId: event.payload.chatId,
      ...(event.payload.threadId !== undefined ? { threadId: event.payload.threadId } : {}),
      lastInboundMessageId: event.payload.messageId,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Сдвигает персистентное смещение на `update_id + 1`. */
  private async advanceOffset(updateId: number): Promise<void> {
    await this.store.setOffset(updateId + 1);
  }

  private async fetchUpdates(timeoutSec: number, signal?: AbortSignal): Promise<Update[]> {
    const response = await this.client.getUpdates({
      offset: await this.store.getOffset(),
      timeout: timeoutSec,
      allowedUpdates: [...ALLOWED_UPDATES],
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`getUpdates вернул ошибку: ${response.description ?? 'unknown'}`);
    }
    return response.result ?? [];
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
