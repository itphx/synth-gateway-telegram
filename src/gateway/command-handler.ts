import type { TelegramClient } from '../bot-api/index.js';

import {
  BINDING_COMMANDS,
  canManageBindings,
  isAgentCommand,
  isLocalCommand,
} from './commands.js';
import type { SynthEventsClient } from './ingest.js';
import type { SynthEventInput } from './normalize.js';
import type { GatewayStore } from './store.js';

/** Опции {@link CommandHandler}. */
export interface CommandHandlerOptions {
  client: TelegramClient;
  synth: SynthEventsClient;
  store: GatewayStore;
  /** Клиент в dry-run (без токена). */
  dryRun?: boolean;
  log?: (message: string) => void;
}

/** Текст справки `/help` и `/start`. */
export function helpText(): string {
  return [
    'Synth Telegram-шлюз. Команды:',
    '/synth <текст> — отправить задачу агенту',
    '/idea <текст> — передать идею (метка idea)',
    '/bind [sessionId] — привязать чат к новой/существующей сессии (ADMIN/LEAD)',
    '/unbind — снять привязку чата (ADMIN/LEAD)',
    '/new — новая сессия для чата (ADMIN/LEAD)',
    '/status — состояние шлюза',
    '/stop — остановить ответ агента',
    '/help — эта справка',
    'Связка с учётной записью Synth — по коду в UI Synth (Настройки → Профиль → Идентичности).',
  ].join('\n');
}

/**
 * Строка про отправителя для `/status` (диагностика сопоставления): читаемое имя
 * и `principalId`. Имя определяется как `@username` → `displayName` →
 * `Имя Фамилия` → `tg:<id>` (паритет с выводом автора в ядре, AD-089).
 */
export function describeSender(event: SynthEventInput): string {
  const from = event.payload.from;
  const principalId = event.identity.principalId ?? `tg:${from.id}`;
  const name =
    (from.username ? `@${from.username}` : undefined) ??
    (from.displayName ? from.displayName : undefined) ??
    ([from.firstName, from.lastName].filter(Boolean).join(' ') || undefined) ??
    `tg:${from.id}`;
  return `${name} (${principalId})`;
}

/**
 * Обработчик локальных команд шлюза.
 *
 * Возвращает `true`, если команда обработана локально (ответ отправлен и событие
 * в ядро публиковать не нужно), и `false` — если это команда агента (`/synth`,
 * `/idea`), которую должен опубликовать поллер. Неизвестные команды получают
 * короткую подсказку и в ядро не уходят. Команды управления привязками
 * доступны только ролям ADMIN/LEAD.
 */
export class CommandHandler {
  private readonly client: TelegramClient;
  private readonly synth: SynthEventsClient;
  private readonly store: GatewayStore;
  private readonly dryRun: boolean;
  private readonly log: (message: string) => void;

  constructor(options: CommandHandlerOptions) {
    this.client = options.client;
    this.synth = options.synth;
    this.store = options.store;
    this.dryRun = options.dryRun ?? options.client.dryRun;
    this.log = options.log ?? (() => {});
  }

  /** Обрабатывает событие-команду; `true` — обработано локально. */
  async handle(event: SynthEventInput): Promise<boolean> {
    const name = event.payload.command;
    if (!name) return false;

    if (isAgentCommand(name)) return false;

    if (!isLocalCommand(name)) {
      await this.reply(event, `Неизвестная команда /${name}. Введите /help.`);
      return true;
    }

    const role = event.identity.roles?.[0];
    if (BINDING_COMMANDS.has(name) && !canManageBindings(role)) {
      await this.reply(event, 'Недостаточно прав: управление привязками доступно ролям ADMIN/LEAD.');
      return true;
    }

    try {
      switch (name) {
        case 'help':
        case 'start':
          await this.reply(event, helpText());
          break;
        case 'status':
          await this.status(event);
          break;
        case 'stop':
          await this.stop(event);
          break;
        case 'bind':
          await this.bind(event, event.payload.args ?? '');
          break;
        case 'unbind':
          await this.unbind(event, false);
          break;
        case 'new':
          await this.unbind(event, true);
          break;
        default:
          await this.reply(event, `Неизвестная команда /${name}. Введите /help.`);
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[gateway] команда /${name} ошибка: ${message}`);
      await this.reply(event, `⚠️ Не удалось выполнить /${name}: ${message}`);
    }
    return true;
  }

  /** `/status` — состояние чата, привязки, бота и режима. */
  private async status(event: SynthEventInput): Promise<void> {
    const { chatId, threadId, messageId } = event.payload;
    const chatKey = event.identity.chatKey;
    const state = chatKey ? await this.store.getChatSession(chatKey) : undefined;

    let bot: string;
    if (this.dryRun) {
      bot = 'dry-run (токен не задан)';
    } else {
      try {
        const me = await this.client.getMe();
        bot = me.ok ? `@${me.result?.username ?? me.result?.first_name ?? 'bot'}` : 'ошибка getMe';
      } catch {
        bot = 'ошибка getMe';
      }
    }

    const lines = [
      `Чат: ${chatId}${threadId !== undefined ? ` (тред ${threadId})` : ''}`,
      `Привязка: ${state ? `сессия ${state.sessionId}` : 'нет'}`,
      `Отправитель: ${describeSender(event)}`,
      `Бот: ${bot}`,
      `Режим: ${this.dryRun ? 'dry-run' : 'live'}`,
    ];
    await this.replyTo(chatId, lines.join('\n'), threadId, messageId);
  }

  /** `/stop` — прерывает активный ответ агента в сессии чата. */
  private async stop(event: SynthEventInput): Promise<void> {
    const chatKey = event.identity.chatKey;
    const state = chatKey ? await this.store.getChatSession(chatKey) : undefined;
    if (!state) {
      await this.reply(event, 'Нет активной сессии для этого чата.');
      return;
    }
    await this.synth.abortSession(state.sessionId);
    await this.reply(event, '⏹ Остановлено.');
  }

  /** `/bind [sessionId]` — привязка чата к новой или существующей сессии. */
  private async bind(event: SynthEventInput, rawArgs: string): Promise<void> {
    const chatKey = event.identity.chatKey;
    const threadKey = event.identity.threadKey;
    if (!chatKey) {
      await this.reply(event, 'Не удалось определить чат.');
      return;
    }

    let sessionId = rawArgs.trim();
    if (sessionId) {
      const session = await this.synth.getSession(sessionId);
      if (!session) {
        await this.reply(event, `Сессия ${sessionId} не найдена.`);
        return;
      }
    } else {
      const created = await this.synth.createSession({ name: `Telegram: ${event.payload.chatId}` });
      sessionId = created.id;
    }

    await this.synth.createBinding({
      source: 'telegram',
      ...(threadKey ? { threadKey } : { chatKey }),
      mode: 'bound',
      sessionId,
    });

    await this.store.setChatSession(chatKey, {
      sessionId,
      chatId: event.payload.chatId,
      ...(event.payload.threadId !== undefined ? { threadId: event.payload.threadId } : {}),
      lastInboundMessageId: event.payload.messageId,
      updatedAt: new Date().toISOString(),
    });

    await this.reply(event, `Чат привязан к сессии ${sessionId}.`);
  }

  /**
   * `/unbind` — снимает привязку чата. При `thenBind` (для `/new`) после снятия
   * сразу создаётся и привязывается новая сессия.
   */
  private async unbind(event: SynthEventInput, thenBind: boolean): Promise<void> {
    const chatKey = event.identity.chatKey;
    const threadKey = event.identity.threadKey;
    if (!chatKey) {
      await this.reply(event, 'Не удалось определить чат.');
      return;
    }

    const bindings = await this.synth.listBindings('telegram');
    const match =
      (threadKey ? bindings.find((binding) => binding.threadKey === threadKey) : undefined) ??
      bindings.find((binding) => binding.chatKey === chatKey);
    if (match) {
      await this.synth.deleteBinding(match.id);
      this.log(`[gateway] привязка ${match.id} снята для ${threadKey ?? chatKey}`);
    }
    await this.store.removeChatSession(chatKey);

    if (thenBind) {
      await this.bind(event, '');
      return;
    }
    await this.reply(event, match ? 'Привязка снята.' : 'Активной привязки нет.');
  }

  /** Отправляет ответ в чат команды (с учётом треда и reply). */
  private async reply(event: SynthEventInput, text: string): Promise<void> {
    await this.replyTo(
      event.payload.chatId,
      text,
      event.payload.threadId,
      event.payload.messageId,
    );
  }

  private async replyTo(
    chatId: string,
    text: string,
    threadId: number | undefined,
    replyToMessageId: number | undefined,
  ): Promise<void> {
    await this.client.sendMessage({
      chatId,
      text,
      ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    });
  }
}
