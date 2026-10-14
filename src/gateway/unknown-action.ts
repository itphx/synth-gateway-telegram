import type { EventIdentity } from './normalize.js';

/**
 * Политика шлюза для отправителя, не сопоставленного с учётной записью Synth
 * (AD-089: чат — routing, человек — ownership/attribution).
 *
 * «Известность» отправителя резолвится **на стороне ядра** (профиль, этап 3):
 * шлюз не ведёт собственный реестр пользователей и не генерирует коды линковки.
 * Опция задаёт, что делать с входящим апдейтом до/после публикации события.
 */
export type UnknownAction = 'register' | 'hint' | 'reject';

/** Значение по умолчанию: событие публикуется, владельца/автора решает ядро. */
export const DEFAULT_UNKNOWN_ACTION: UnknownAction = 'register';

/** Допустимые значения опции `GATEWAY_UNKNOWN_ACTION`. */
export const UNKNOWN_ACTION_VALUES: readonly UnknownAction[] = ['register', 'hint', 'reject'];

/**
 * Нормализует значение опции: регистр/пробелы игнорируются, неизвестное значение
 * (в т.ч. пустое/`undefined`) → {@link DEFAULT_UNKNOWN_ACTION}.
 */
export function parseUnknownAction(value: string | undefined): UnknownAction {
  const normalized = value?.trim().toLowerCase();
  return UNKNOWN_ACTION_VALUES.find((action) => action === normalized) ?? DEFAULT_UNKNOWN_ACTION;
}

/**
 * Ключи строк шлюза (терминология AD-041: ключ/константа, а не хардкод в логике).
 * Тексты — русская fallback-локализация шлюза.
 */
export const UNKNOWN_HINT_KEY = 'gateway.unknown_sender_hint';
export const UNKNOWN_REJECT_KEY = 'gateway.unknown_sender_reject';
/**
 * AD-089 (claim-flow): код линковки не отправлен в публичный чат (группа/канал) —
 * в группе его увидели бы все участники и могли «угнать» привязку.
 */
export const UNKNOWN_HINT_NOT_PRIVATE_KEY = 'gateway.identity_hint_not_private';

/** Базовый текст подсказки `hint` (без кода — код придёт от ядра, этап 4). */
export const UNKNOWN_HINT_TEXT =
  'Вы не сопоставлены с учётной записью Synth. Сообщение будет обработано, ' +
  'но автор может быть не определён.';

/** Текст отказа `reject`. */
export const UNKNOWN_REJECT_TEXT =
  'Отправитель не сопоставлен с учётной записью Synth — сообщение не принято.';

/**
 * Резолвер «известности» отправителя по его `identity` (AD-089, этап 3).
 *
 * «Известность» (привязка к профилю/владельцу) резолвит **ядро** — шлюз реестр не
 * ведёт. Это seam: в этапе 3 сюда подключается вызов ядра; по умолчанию —
 * fail-closed (отправитель считается неизвестным).
 */
export type SenderKnownResolver = (identity: EventIdentity) => boolean | Promise<boolean>;

/**
 * Дефолтный резолвер: ядро признак ещё не отдаёт → «неизвестен» (fail-closed).
 *
 * TODO(этап 3): заменить на резолвер ядра (профиль). До его появления ветка
 * `reject` отклоняет сообщения, а `hint` не блокирует публикацию и лишь логирует.
 */
export const unknownSenderResolver: SenderKnownResolver = () => false;

/**
 * Собирает текст подсказки `hint` (этап 4, claim-flow). Инструкция по коду
 * добавляется **только** если код пришёл от ядра; шлюз коды не генерирует.
 * Поллер шлёт этот текст в чат, когда ядро вернуло `identityHint`.
 *
 * Привязка идентичности выполняется **только в UI Synth**:
 * `POST /api/v2/me/identities/claim` подтверждает владение идентификатором
 * аутентифицированный человек (AD-089 claim-flow). Команды `/link` у бота нет —
 * бот не может привязать чат к учётной записи за пользователя, поэтому
 * подсказка ведёт в UI, а не в чат.
 */
export function buildUnknownHint(code?: string): string {
  return code
    ? `${UNKNOWN_HINT_TEXT}\nЧтобы привязать этот чат, откройте Synth → ` +
        `Настройки → Профиль → Идентичности и введите код: ${code} (действует 10 минут).`
    : UNKNOWN_HINT_TEXT;
}
