import { describe, expect, it } from 'vitest';
import { HELP_TEXT, MONEY_MAX, MONEY_USAGE, moneyGiven, parseCommand } from '../../src/client/commands';

describe('chat commands', () => {
  it('plain chat is not a command', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('gg / wp')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/ spectate')).toBeNull();
  });

  it('parses known commands case-insensitively, ignoring args and padding', () => {
    expect(parseCommand('/spectate')).toEqual({ kind: 'spectate' });
    expect(parseCommand('  /SPECTATE  ')).toEqual({ kind: 'spectate' });
    expect(parseCommand('/spectate now please')).toEqual({ kind: 'spectate' });
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
  });

  it('unknown commands are reported by name (and still never sent as chat)', () => {
    expect(parseCommand('/Dance')).toEqual({ kind: 'unknown', name: 'dance' });
  });

  it('help lists every command', () => {
    expect(HELP_TEXT).toContain('/spectate');
    expect(HELP_TEXT).toContain('/help');
  });

  it('/money parses a positive whole amount up to the cap', () => {
    expect(parseCommand('/money 500')).toEqual({ kind: 'money', amount: 500 });
    expect(parseCommand('  /MONEY   1 ')).toEqual({ kind: 'money', amount: 1 });
    expect(parseCommand(`/money ${MONEY_MAX}`)).toEqual({ kind: 'money', amount: MONEY_MAX });
  });

  it('/money with a missing or bad amount → amount null (usage)', () => {
    for (const bad of ['/money', '/money 0', '/money -5', '/money 1.5', '/money 1e3', '/money abc', '/money 0x10',
      `/money ${MONEY_MAX + 1}`, '/money 99999999999999999999', '/money 5 6', '/money Infinity']) {
      expect(parseCommand(bad), bad).toEqual({ kind: 'money', amount: null });
    }
    expect(MONEY_USAGE).toContain('/money <amount>');
  });

  it('/money confirmation and help', () => {
    expect(moneyGiven(500)).toBe('+$500 (host command)');
    expect(HELP_TEXT).toContain('/money');
  });
});
