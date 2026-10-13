import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * JSON-хранилище поверх файловой системы.
 *
 * Соответствует модели хранения Synth (AD-005): запись атомарна — данные пишутся
 * во временный файл `*.tmp.<uuid>` в том же каталоге, затем выполняется
 * `rename()` (атомарна на POSIX). Побочные `.tmp.*` файлы при успешной записи не
 * остаются.
 */
export class FileStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /** Создаёт корневой каталог хранилища. */
  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  /** Абсолютный путь с проверкой containment внутри корня. */
  resolvePath(relativePath: string): string {
    const target = resolve(this.rootDir, relativePath);
    const rel = relative(this.rootDir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Путь вне хранилища: ${relativePath}`);
    }
    return target;
  }

  /** Читает JSON. Возвращает `null`, если файла нет. */
  async read<T>(relativePath: string): Promise<T | null> {
    const target = this.resolvePath(relativePath);
    try {
      const raw = await readFile(target, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Атомарно записывает JSON (tmp → rename). */
  async write<T>(relativePath: string, data: T): Promise<void> {
    const target = this.resolvePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${randomUUID()}`;
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, target);
  }

  /** Удаляет файл. Возвращает `true`, если файл существовал. */
  async remove(relativePath: string): Promise<boolean> {
    try {
      await rm(this.resolvePath(relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Имена `.json`-файлов каталога (без расширения), отсортированные. */
  async listNames(relativeDir: string): Promise<string[]> {
    const dir = this.resolvePath(relativeDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }

  /** Читает все JSON-объекты каталога. */
  async listJson<T>(relativeDir: string): Promise<T[]> {
    const names = await this.listNames(relativeDir);
    const result: T[] = [];
    for (const name of names) {
      const value = await this.read<T>(join(relativeDir, `${name}.json`));
      if (value !== null) result.push(value);
    }
    return result;
  }
}

/** Состояние привязки чата к сессии Synth (ключ — `chatKey`). */
export interface ChatSessionState {
  sessionId: string;
  chatId: string;
  threadId?: number;
  /** id последнего входящего сообщения (для ответа в правильный тред). */
  lastInboundMessageId?: number;
  /** id последнего отправленного ответа. */
  lastOutboundMessageId?: number;
  updatedAt: string;
}

/** Маршрут доставки ответов агента в чат (ключ — `sessionId`). */
export interface SessionRoute {
  chatKey: string;
  chatId: string;
  threadId?: number;
  /** id последнего входящего сообщения — `reply_to_message_id` для ответа. */
  lastInboundMessageId?: number;
  updatedAt: string;
}

/** Максимум хранимых `update_id` в персистентном дедуп-множестве. */
export const SEEN_UPDATES_LIMIT = 1000;

/** Максимум хранимых ключей отправленных сообщений (дедуп исходящих). */
export const SENT_KEYS_LIMIT = 2000;

const OFFSET_PATH = 'state/offset.json';
const SEEN_PATH = 'state/seen-updates.json';
const CHAT_SESSIONS_PATH = 'state/chat-sessions.json';
const SESSION_ROUTES_PATH = 'state/session-routes.json';
const SENT_PATH = 'state/sent.json';

/**
 * Состояние шлюза поверх {@link FileStore}: смещение long-polling (`offset`),
 * дедуп обработанных апдейтов (`seenUpdates`), привязка чатов к сессиям
 * (`chatSessions`, ключ `chatKey`) и обратный индекс `sessionRoutes`
 * (ключ `sessionId` — фильтр доставки ответов агента), плюс персистентный дедуп
 * исходящих сообщений (`sent`).
 */
export class GatewayStore {
  private readonly store: FileStore;
  private seenCache: Set<number> | null = null;
  private sentCache: Set<string> | null = null;

  constructor(dataDir: string) {
    this.store = new FileStore(dataDir);
  }

  /** Создаёт каталог хранилища. */
  async init(): Promise<void> {
    await this.store.init();
  }

  /** Смещение long-polling (`last confirmed update_id + 1`) либо `undefined`. */
  async getOffset(): Promise<number | undefined> {
    const data = await this.store.read<{ offset?: unknown }>(OFFSET_PATH);
    const offset = data?.offset;
    return typeof offset === 'number' && Number.isFinite(offset) ? offset : undefined;
  }

  /** Персистентно сохраняет смещение. */
  async setOffset(offset: number): Promise<void> {
    await this.store.write(OFFSET_PATH, { offset });
  }

  /** Проверяет, обрабатывался ли апдейт (память + диск). */
  async hasSeen(updateId: number): Promise<boolean> {
    const seen = await this.loadSeen();
    return seen.has(updateId);
  }

  /** Помечает апдейт обработанным и сохраняет множество (с ограничением размера). */
  async markSeen(updateId: number): Promise<void> {
    const seen = await this.loadSeen();
    seen.add(updateId);
    await this.persistSeen(seen);
  }

  /** Привязка чата к сессии (по `chatKey`). */
  async getChatSession(chatKey: string): Promise<ChatSessionState | undefined> {
    const map = await this.loadChatSessions();
    return map[chatKey];
  }

  /**
   * Сохраняет привязку чата к сессии и синхронно обновляет обратный индекс
   * `sessionId → route` (для доставки ответов агента).
   */
  async setChatSession(chatKey: string, state: ChatSessionState): Promise<void> {
    const map = await this.loadChatSessions();
    map[chatKey] = state;
    await this.store.write(CHAT_SESSIONS_PATH, map);

    const routes = await this.loadSessionRoutes();
    routes[state.sessionId] = {
      chatKey,
      chatId: state.chatId,
      ...(state.threadId !== undefined ? { threadId: state.threadId } : {}),
      ...(state.lastInboundMessageId !== undefined
        ? { lastInboundMessageId: state.lastInboundMessageId }
        : {}),
      updatedAt: state.updatedAt,
    };
    await this.store.write(SESSION_ROUTES_PATH, routes);
  }

  /** Снимает привязку чата и её обратный индекс. */
  async removeChatSession(chatKey: string): Promise<boolean> {
    const map = await this.loadChatSessions();
    const existing = map[chatKey];
    if (!existing) return false;
    delete map[chatKey];
    await this.store.write(CHAT_SESSIONS_PATH, map);

    const routes = await this.loadSessionRoutes();
    delete routes[existing.sessionId];
    await this.store.write(SESSION_ROUTES_PATH, routes);
    return true;
  }

  /** Все привязки чатов к сессиям. */
  async listChatSessions(): Promise<Record<string, ChatSessionState>> {
    return this.loadChatSessions();
  }

  /** Маршрут доставки ответов агента для сессии. */
  async getSessionRoute(sessionId: string): Promise<SessionRoute | undefined> {
    const routes = await this.loadSessionRoutes();
    return routes[sessionId];
  }

  /** Все маршруты доставки (ключ — `sessionId`). */
  async listSessionRoutes(): Promise<Record<string, SessionRoute>> {
    return this.loadSessionRoutes();
  }

  /** Проверяет, отправляли ли сообщение с данным ключом дедупа. */
  async hasSent(key: string): Promise<boolean> {
    const sent = await this.loadSent();
    return sent.has(key);
  }

  /** Помечает ключ исходящего сообщения отправленным (персистентно). */
  async markSent(key: string): Promise<void> {
    const sent = await this.loadSent();
    sent.add(key);
    const keys = [...sent].slice(-SENT_KEYS_LIMIT);
    this.sentCache = new Set(keys);
    await this.store.write(SENT_PATH, { keys });
  }

  private async loadSeen(): Promise<Set<number>> {
    if (this.seenCache) return this.seenCache;
    const data = await this.store.read<{ updates?: unknown }>(SEEN_PATH);
    const updates = Array.isArray(data?.updates) ? data.updates : [];
    this.seenCache = new Set(
      updates.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
    );
    return this.seenCache;
  }

  private async persistSeen(seen: Set<number>): Promise<void> {
    const updates = [...seen].slice(-SEEN_UPDATES_LIMIT);
    this.seenCache = new Set(updates);
    await this.store.write(SEEN_PATH, { updates });
  }

  private async loadChatSessions(): Promise<Record<string, ChatSessionState>> {
    const data = await this.store.read<Record<string, ChatSessionState>>(CHAT_SESSIONS_PATH);
    return data ?? {};
  }

  private async loadSessionRoutes(): Promise<Record<string, SessionRoute>> {
    const data = await this.store.read<Record<string, SessionRoute>>(SESSION_ROUTES_PATH);
    return data ?? {};
  }

  private async loadSent(): Promise<Set<string>> {
    if (this.sentCache) return this.sentCache;
    const data = await this.store.read<{ keys?: unknown }>(SENT_PATH);
    const keys = Array.isArray(data?.keys) ? data.keys : [];
    this.sentCache = new Set(keys.filter((value): value is string => typeof value === 'string'));
    return this.sentCache;
  }
}
