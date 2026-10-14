import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNKNOWN_ACTION,
  UNKNOWN_ACTION_VALUES,
  UNKNOWN_HINT_TEXT,
  UNKNOWN_REJECT_TEXT,
  buildUnknownHint,
  parseUnknownAction,
  unknownSenderResolver,
} from './unknown-action.js';

describe('parseUnknownAction', () => {
  it('распознаёт register/hint/reject (регистр и пробелы игнорируются)', () => {
    expect(parseUnknownAction('register')).toBe('register');
    expect(parseUnknownAction('HINT')).toBe('hint');
    expect(parseUnknownAction('  Reject ')).toBe('reject');
  });

  it('неизвестное/пустое значение → дефолт register', () => {
    expect(parseUnknownAction(undefined)).toBe(DEFAULT_UNKNOWN_ACTION);
    expect(parseUnknownAction('')).toBe(DEFAULT_UNKNOWN_ACTION);
    expect(parseUnknownAction('   ')).toBe(DEFAULT_UNKNOWN_ACTION);
    expect(parseUnknownAction('allow')).toBe(DEFAULT_UNKNOWN_ACTION);
  });

  it('дефолт — register; список значений полный', () => {
    expect(DEFAULT_UNKNOWN_ACTION).toBe('register');
    expect([...UNKNOWN_ACTION_VALUES]).toEqual(['register', 'hint', 'reject']);
  });
});

describe('unknownSenderResolver (fail-closed до этапа 3)', () => {
  it('дефолтный резолвер всегда возвращает false (отправитель неизвестен)', () => {
    expect(unknownSenderResolver({ principalId: 'tg:1' })).toBe(false);
    expect(unknownSenderResolver({})).toBe(false);
    expect(unknownSenderResolver({ chatKey: 'chat:telegram:1' })).toBe(false);
  });
});

describe('buildUnknownHint (этап 4)', () => {
  it('без кода — текст без инструкции (шлюз коды не генерирует)', () => {
    const text = buildUnknownHint();
    expect(text).toBe(UNKNOWN_HINT_TEXT);
    expect(text).not.toContain('/link');
  });

  it('с кодом от ядра — ведёт в UI Synth (Профиль → Идентичности), а не /link', () => {
    const text = buildUnknownHint('abc123');
    expect(text).toContain('abc123');
    expect(text).toContain('Профиль');
    expect(text).toContain('Идентичности');
    expect(text).not.toContain('/link');
  });
});

describe('тексты', () => {
  it('непустые и различаются', () => {
    expect(UNKNOWN_HINT_TEXT.length).toBeGreaterThan(0);
    expect(UNKNOWN_REJECT_TEXT.length).toBeGreaterThan(0);
    expect(UNKNOWN_HINT_TEXT).not.toBe(UNKNOWN_REJECT_TEXT);
  });
});
