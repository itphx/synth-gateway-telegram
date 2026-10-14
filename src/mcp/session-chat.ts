/**
 * Резолвер привязки чата по id сессии Synth для MCP-тулов (`_meta`-контракт
 * `synth/session_id`).
 *
 * Читает обратный индекс `state/session-routes.json` через {@link GatewayStore}
 * (`getSessionRoute`). Стор инстанцируется лениво и один раз на каталог
 * (кэширование — по существующему поведению стора: маршруты читаются с диска).
 * Транспорт задаёт каталог: HTTP — per-tenant `tenantStoreDir`, stdio —
 * `config.dataDir`.
 */

import { GatewayStore } from '../gateway/store.js';

import type { SessionChat } from './tools.js';

/** Создаёт ленивый резолвер `sessionId → SessionChat` для каталога хранилища. */
export function createSessionChatResolver(
  dataDir: string,
): (sessionId: string) => Promise<SessionChat | undefined> {
  let store: GatewayStore | undefined;
  return async (sessionId: string): Promise<SessionChat | undefined> => {
    store ??= new GatewayStore(dataDir);
    const route = await store.getSessionRoute(sessionId);
    if (!route) return undefined;
    return {
      chatId: route.chatId,
      chatKey: route.chatKey,
      ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
      ...(route.lastInboundMessageId !== undefined
        ? { lastInboundMessageId: route.lastInboundMessageId }
        : {}),
    };
  };
}
