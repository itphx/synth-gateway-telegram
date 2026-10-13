import { describe, expect, it } from 'vitest';

import {
  AGENT_COMMANDS,
  BINDING_COMMANDS,
  canManageBindings,
  isAgentCommand,
  isLocalCommand,
  LOCAL_COMMANDS,
  parseCommand,
} from './commands.js';

describe('parseCommand', () => {
  it('разбирает команду и аргументы', () => {
    expect(parseCommand('/synth сделай задачу')).toEqual({
      name: 'synth',
      args: 'сделай задачу',
    });
    expect(parseCommand('/status')).toEqual({ name: 'status', args: '' });
    expect(parseCommand('  /help  ')).toEqual({ name: 'help', args: '' });
  });

  it('приводит регистр к нижнему и срезает @botusername', () => {
    expect(parseCommand('/HELP')).toEqual({ name: 'help', args: '' });
    expect(parseCommand('/help@my_gateway_bot')).toEqual({ name: 'help', args: '' });
    expect(parseCommand('/synth@bot текст')).toEqual({ name: 'synth', args: 'текст' });
  });

  it('многострочные аргументы сохраняются', () => {
    expect(parseCommand('/synth первая\nвторая')?.args).toBe('первая\nвторая');
  });

  it('не-команда → null', () => {
    expect(parseCommand('привет')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });
});

describe('наборы команд и права', () => {
  it('локальные/агентские/привязочные наборы согласованы', () => {
    expect([...LOCAL_COMMANDS]).toEqual(['help', 'start', 'status', 'bind', 'unbind', 'new']);
    expect([...AGENT_COMMANDS]).toEqual(['synth', 'idea']);
    expect([...BINDING_COMMANDS]).toEqual(['bind', 'unbind', 'new']);
    expect(isLocalCommand('bind')).toBe(true);
    expect(isLocalCommand('synth')).toBe(false);
    expect(isAgentCommand('synth')).toBe(true);
    expect(isAgentCommand('idea')).toBe(true);
    expect(isAgentCommand('help')).toBe(false);
  });

  it('управление привязками — только ADMIN/LEAD', () => {
    expect(canManageBindings('ADMIN')).toBe(true);
    expect(canManageBindings('lead')).toBe(true);
    expect(canManageBindings('USER')).toBe(false);
    expect(canManageBindings('AUDITOR')).toBe(false);
    expect(canManageBindings(undefined)).toBe(false);
  });
});
