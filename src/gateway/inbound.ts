/**
 * Реестр входящих сообщений тенанта (in-memory).
 *
 * Проблема, которую он решает. Шлюз отвечает в Telegram reply-ем на
 * «сообщение-источник», но до сих пор брал адресата из
 * `SessionRoute.lastInboundMessageId` — а это поле поллер перезаписывает на
 * **каждое** входящее (`rememberSession`). Пока агент стримит ответ на первое
 * сообщение, приходят второе и третье, и шапка-reply уезжает на последнее, а не
 * на то, на которое реально отвечают.
 *
 * Связь строится по ключам ядра (AD-089):
 *   `dedupKey` (`telegram:<bot>:<update_id>`, известен при публикации события)
 *   → `messageId` (`payload.messageId`) — {@link rememberInbound};
 *   `message.added(user).metadata.dedup_key` + `metadata.stream_id`
 *   → `streamId` → `messageId` — {@link linkStream}.
 *
 * Дальше адресат ответа резолвится по `stream_id` прогона
 * ({@link replyForStream}): все доставки этого стрима (`stream.done`,
 * `stream.error`, `stream.cancelled`, live-сообщение) отвечают на своё
 * сообщение-источник, независимо от того, сколько входящих пришло позже.
 */
export class InboundRegistry {
  /** `dedupKey` → id входящего сообщения Telegram. */
  private readonly byDedupKey = new Map<string, number>();
  /** `streamId` прогона → id входящего сообщения Telegram. */
  private readonly byStreamId = new Map<string, number>();
  private readonly limit: number;

  constructor(limit: number = INBOUND_REGISTRY_LIMIT) {
    this.limit = limit;
  }

  /** Запоминает входящее сообщение по `dedupKey` события (вызывает поллер). */
  rememberInbound(dedupKey: string, messageId: number): void {
    this.write(this.byDedupKey, dedupKey, messageId);
  }

  /** id входящего сообщения по `dedupKey` события (для привязки стрима). */
  inboundMessageId(dedupKey: string | undefined): number | undefined {
    if (!dedupKey) return undefined;
    return this.byDedupKey.get(dedupKey);
  }

  /** Привязывает стрим прогона к сообщению-источнику (`message.id`). */
  linkStream(streamId: string, messageId: number): void {
    this.write(this.byStreamId, streamId, messageId);
  }

  /** Адресат reply для стрима; `undefined` — связь неизвестна (нужен fallback). */
  replyForStream(streamId: string | undefined): number | undefined {
    if (!streamId) return undefined;
    return this.byStreamId.get(streamId);
  }

  /** Пишет запись с обновлением свежести и вытеснением самых старых. */
  private write(map: Map<string, number>, key: string, value: number): void {
    if (!key) return;
    // Повторная запись — ключ становится самым свежим (LRU-семантика).
    map.delete(key);
    map.set(key, value);
    while (map.size > this.limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/**
 * Ограничение реестра (число записей в каждом отображении). Сопоставление
 * живёт ровно на время прогона; 200 записей с запасом покрывают конкурентные
 * чаты одного тенанта, а вытеснение не даёт реестру расти бесконечно.
 */
export const INBOUND_REGISTRY_LIMIT = 200;
