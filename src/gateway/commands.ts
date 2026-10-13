/** Разобранная slash-команда. */
export interface ParsedCommand {
  /** Имя команды без `/`, в нижнем регистре (напр. `synth`). */
  name: string;
  /** Аргументы после имени команды (триммированные). */
  args: string;
}

/**
 * Разбирает текст сообщения как slash-команду.
 *
 * Возвращает `null`, если текст не начинается с `/`. Служебный суффикс
 * `@botusername` (`/help@my_bot`) отбрасывается. Регистр имени приводится к
 * нижнему.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([A-Za-z0-9_@]+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const rawName = match[1] ?? '';
  const name = rawName.replace(/@.*$/, '').toLowerCase();
  if (!name) return null;
  return { name, args: (match[2] ?? '').trim() };
}

/** Команды, обрабатываемые шлюзом локально (не уходят в LLM). */
export const LOCAL_COMMANDS = new Set(['help', 'start', 'status', 'bind', 'unbind', 'new']);

/** Команды, которые прокидываются в ядро как событие `type:'command'`. */
export const AGENT_COMMANDS = new Set(['synth', 'idea']);

/** Команды управления привязкой — требуют роль ADMIN/LEAD. */
export const BINDING_COMMANDS = new Set(['bind', 'unbind', 'new']);

/** Роли, которым разрешено управление привязками. */
export const BINDING_ROLES = new Set(['ADMIN', 'LEAD']);

/** Локально обрабатывается ли команда шлюзом. */
export function isLocalCommand(name: string): boolean {
  return LOCAL_COMMANDS.has(name);
}

/** Прокидывается ли команда в ядро как событие. */
export function isAgentCommand(name: string): boolean {
  return AGENT_COMMANDS.has(name);
}

/** Разрешено ли роли управление привязками (ADMIN/LEAD). */
export function canManageBindings(role: string | undefined): boolean {
  return role !== undefined && BINDING_ROLES.has(role.toUpperCase());
}
