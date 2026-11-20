import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseCommand } from '../../src/client/commands';

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
});
