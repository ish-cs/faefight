import { describe, expect, test } from 'vitest';
import { cleanName, sanitizeClientMsg } from '../../src/net/sanitize';
import { Lobby } from '../../src/net/lobby';
import { NET_VERSION } from '../../src/net/protocol';

describe('cleanName', () => {
  test('strips zero-width, bidi and control characters, collapses spaces', () => {
    expect(cleanName('Al\u200bice')).toBe('Alice');
    expect(cleanName('\u202eecilA')).toBe('ecilA');
    expect(cleanName('  Bob \n\t  Ross ')).toBe('Bob Ross');
    expect(cleanName('a\u2066b\u2069c\ufeff')).toBe('abc');
  });
  test('NFKC folds look-alike compatibility forms', () => {
    expect(cleanName('\uff28\uff4f\uff53\uff54\uff59')).toBe('Hosty'); // fullwidth
  });
  test('reserved names become Player', () => {
    for (const n of ['Host', 'host', ' HOST ', 'System', 'admin', 'Bot', 'You', 'H\u200bost']) expect(cleanName(n)).toBe('Player');
  });
  test('caps at 16 code points without splitting emoji', () => {
    expect([...cleanName('\u{1F642}'.repeat(30))!].length).toBe(16);
    expect(cleanName('x'.repeat(40))).toBe('x'.repeat(16));
  });
  test('empty after cleaning -> null', () => {
    expect(cleanName('\u200b\u200c  ')).toBeNull();
    expect(cleanName(5)).toBeNull();
  });
  test('hello uses it', () => {
    expect(sanitizeClientMsg({ t: 'hello', name: 'Ho\u200dst', version: NET_VERSION })).toEqual({ t: 'hello', name: 'Player', version: NET_VERSION });
  });
});

describe('Lobby name uniqueness', () => {
  test("a joiner cannot take the host's name or another joiner's (case-insensitive)", () => {
    const l = new Lobby('Alice', 'host-peer');
    l.addHuman('alice', 'p1');
    l.addHuman('Bob', 'p2');
    l.addHuman('BOB', 'p3');
    const names = l.slots().map((s) => (s.kind === 'human' ? s.name : ''));
    expect(names).toEqual(['Alice', 'alice 2', 'Bob', 'BOB 2']);
  });
  test("a joiner cannot take a bot's nickname", () => {
    const l = new Lobby('Alice', 'host-peer');
    l.setSeat(1, { kind: 'bot', difficulty: 'easy' });
    const bot = l.slots()[1];
    const botName = bot.kind === 'bot' ? bot.name! : '';
    l.addHuman(botName.toUpperCase(), 'p1');
    const joined = l.slots()[2];
    expect(joined.kind).toBe('human');
    expect(joined.kind === 'human' && joined.name.toLowerCase()).not.toBe(botName.toLowerCase());
  });
  test('bot nicknames never collide with a human name in another case', () => {
    // nickname() compares lowercase; the lobby must hand it lowercase names too.
    const l = new Lobby('Alice', 'host-peer');
    const taken = (l as any).takenNames() as Set<string>;
    expect(taken.has('alice')).toBe(true);
  });
  test('suffix keeps the name within 16 chars', () => {
    const l = new Lobby('x'.repeat(16), 'host-peer');
    l.addHuman('x'.repeat(16), 'p1');
    const s = l.slots()[1];
    expect(s.kind === 'human' && s.name).toBe(`${'x'.repeat(14)} 2`);
  });
});
