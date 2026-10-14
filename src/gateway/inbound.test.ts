import { describe, expect, it } from 'vitest';

import { INBOUND_REGISTRY_LIMIT, InboundRegistry } from './inbound.js';

describe('InboundRegistry', () => {
  it('помнит dedupKey → messageId и отдаёт его обратно', () => {
    const registry = new InboundRegistry();
    registry.rememberInbound('telegram:bot:100', 5);

    expect(registry.inboundMessageId('telegram:bot:100')).toBe(5);
    expect(registry.inboundMessageId('telegram:bot:999')).toBeUndefined();
  });

  it('связывает stream_id с messageId и отдаёт адресат reply', () => {
    const registry = new InboundRegistry();
    registry.linkStream('stream_1', 42);

    expect(registry.replyForStream('stream_1')).toBe(42);
    expect(registry.replyForStream('stream_unknown')).toBeUndefined();
  });

  it('неизвестные/пустые ключи не бросают и дают undefined', () => {
    const registry = new InboundRegistry();
    expect(registry.inboundMessageId(undefined)).toBeUndefined();
    expect(registry.inboundMessageId('')).toBeUndefined();
    expect(registry.replyForStream(undefined)).toBeUndefined();
    expect(registry.replyForStream('')).toBeUndefined();
    // Пустые ключи не пишутся.
    registry.rememberInbound('', 1);
    registry.linkStream('', 1);
    expect(registry.inboundMessageId('')).toBeUndefined();
    expect(registry.replyForStream('')).toBeUndefined();
  });

  it('вытесняет самые старые записи при превышении лимита', () => {
    const registry = new InboundRegistry(2);
    registry.rememberInbound('a', 1);
    registry.rememberInbound('b', 2);
    registry.rememberInbound('c', 3);

    expect(registry.inboundMessageId('a')).toBeUndefined();
    expect(registry.inboundMessageId('b')).toBe(2);
    expect(registry.inboundMessageId('c')).toBe(3);

    registry.linkStream('s1', 1);
    registry.linkStream('s2', 2);
    registry.linkStream('s3', 3);
    expect(registry.replyForStream('s1')).toBeUndefined();
    expect(registry.replyForStream('s2')).toBe(2);
    expect(registry.replyForStream('s3')).toBe(3);
  });

  it('повторная запись освежает ключ (LRU): вытесняется действительно старый', () => {
    const registry = new InboundRegistry(2);
    registry.rememberInbound('a', 1);
    registry.rememberInbound('b', 2);
    registry.rememberInbound('a', 10); // «a» снова самый свежий
    registry.rememberInbound('c', 3); // вытесняется «b», а не «a»

    expect(registry.inboundMessageId('a')).toBe(10);
    expect(registry.inboundMessageId('b')).toBeUndefined();
    expect(registry.inboundMessageId('c')).toBe(3);
  });

  it('не растёт бесконечно: размер ограничен при потоке входящих', () => {
    const registry = new InboundRegistry(INBOUND_REGISTRY_LIMIT);
    for (let i = 0; i < INBOUND_REGISTRY_LIMIT * 5; i += 1) {
      registry.rememberInbound(`telegram:bot:${i}`, 1000 + i);
      registry.linkStream(`stream_${i}`, 1000 + i);
    }
    // Последние записи живы…
    const last = INBOUND_REGISTRY_LIMIT * 5 - 1;
    expect(registry.inboundMessageId(`telegram:bot:${last}`)).toBe(1000 + last);
    expect(registry.replyForStream(`stream_${last}`)).toBe(1000 + last);
    // …а первые — вытеснены (без утечек и падений).
    expect(registry.inboundMessageId('telegram:bot:0')).toBeUndefined();
    expect(registry.replyForStream('stream_0')).toBeUndefined();
  });
});
