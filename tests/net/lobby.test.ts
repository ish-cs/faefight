import { describe, expect, test } from 'vitest';
import { Lobby } from '../../src/net/lobby';
import { MAX_PLAYERS } from '../../src/net/protocol';

describe('Lobby', () => {
  test('starts with host in seat 0 and one open seat', () => {
    const l = new Lobby('Ann', 'p-ann');
    expect(l.slots()).toEqual([{ kind: 'human', name: 'Ann', peerId: 'p-ann', isHost: true }, { kind: 'open' }]);
    expect(l.seatOf('p-ann')).toBe(0);
  });

  test('slots() returns a copy', () => {
    const l = new Lobby('Ann', 'p-ann');
    const s = l.slots();
    s[1] = { kind: 'bot', difficulty: 'hard' };
    (s[0] as { name: string }).name = 'Mallory';
    expect(l.slots()[1]).toEqual({ kind: 'open' });
    expect(l.slots()[0]).toMatchObject({ name: 'Ann' });
  });

  test('addHuman fills the first open seat, then appends until MAX_PLAYERS, then null', () => {
    const l = new Lobby('Ann', 'p0');
    expect(l.addHuman('B', 'p1')).toBe(1);
    expect(l.slots()[1]).toEqual({ kind: 'human', name: 'B', peerId: 'p1', isHost: false });
    for (let i = 2; i < MAX_PLAYERS; i++) expect(l.addHuman(`P${i}`, `p${i}`)).toBe(i);
    expect(l.slots()).toHaveLength(MAX_PLAYERS);
    expect(l.addHuman('Late', 'late')).toBeNull();
    expect(l.slots()).toHaveLength(MAX_PLAYERS);
  });

  test('addHuman prefers an open seat in the middle over appending', () => {
    const l = new Lobby('Ann', 'p0');
    l.addHuman('B', 'p1');
    l.addHuman('C', 'p2');
    expect(l.removePeer('p1')).toBe(1);
    expect(l.addHuman('D', 'p3')).toBe(1);
  });

  test('addHuman skips bot seats and is null when all seats are bots at MAX_PLAYERS', () => {
    const l = new Lobby('Ann', 'p0');
    expect(l.setSeat(1, { kind: 'bot', difficulty: 'easy' })).toBe(true);
    expect(l.addHuman('B', 'p1')).toBe(2);
    while (l.slots().length < MAX_PLAYERS) l.addSeat();
    for (let i = 3; i < MAX_PLAYERS; i++) l.setSeat(i, { kind: 'bot', difficulty: 'medium' });
    expect(l.addHuman('C', 'p2')).toBeNull();
  });

  test('addHuman rejects a peerId already seated', () => {
    const l = new Lobby('Ann', 'p0');
    l.addHuman('B', 'p1');
    expect(l.addHuman('B again', 'p1')).toBeNull();
    expect(l.addHuman('Host copy', 'p0')).toBeNull();
  });

  test('removePeer frees the seat; unknown peer and host give null', () => {
    const l = new Lobby('Ann', 'p0');
    l.addHuman('B', 'p1');
    expect(l.removePeer('p1')).toBe(1);
    expect(l.slots()[1]).toEqual({ kind: 'open' });
    expect(l.seatOf('p1')).toBeNull();
    expect(l.removePeer('nobody')).toBeNull();
    expect(l.removePeer('p0')).toBeNull();
    expect(l.seatOf('p0')).toBe(0);
  });

  test('setSeat rules', () => {
    const l = new Lobby('Ann', 'p0');
    l.addHuman('B', 'p1');
    l.addSeat();
    // seat 0 is locked
    expect(l.setSeat(0, { kind: 'open' })).toBe(false);
    expect(l.setSeat(0, { kind: 'bot', difficulty: 'easy' })).toBe(false);
    // human seat: only 'open' (kick)
    expect(l.setSeat(1, { kind: 'bot', difficulty: 'easy' })).toBe(false);
    expect(l.slots()[1]).toMatchObject({ kind: 'human', peerId: 'p1' });
    expect(l.setSeat(1, { kind: 'open' })).toBe(true);
    expect(l.seatOf('p1')).toBeNull();
    // open <-> bot
    expect(l.setSeat(2, { kind: 'bot', difficulty: 'hard' })).toBe(true);
    expect(l.slots()[2]).toMatchObject({ kind: 'bot', difficulty: 'hard' });
    expect(l.setSeat(2, { kind: 'bot', difficulty: 'easy' })).toBe(true);
    expect(l.setSeat(2, { kind: 'open' })).toBe(true);
    // humans only arrive via addHuman
    expect(l.setSeat(2, { kind: 'human', name: 'X', peerId: 'px', isHost: false })).toBe(false);
    // out of range
    expect(l.setSeat(3, { kind: 'open' })).toBe(false);
    expect(l.setSeat(-1, { kind: 'open' })).toBe(false);
  });

  test('setSeat stores a copy of the slot', () => {
    const l = new Lobby('Ann', 'p0');
    const bot = { kind: 'bot' as const, difficulty: 'easy' as const };
    l.setSeat(1, bot);
    (bot as { difficulty: string }).difficulty = 'hard';
    expect(l.slots()[1]).toMatchObject({ kind: 'bot', difficulty: 'easy' });
  });

  test('addSeat / removeSeat', () => {
    const l = new Lobby('Ann', 'p0');
    expect(l.removeSeat(1)).toBe(false); // min 2 seats
    expect(l.addSeat()).toBe(true);
    expect(l.slots()).toHaveLength(3);
    l.setSeat(2, { kind: 'bot', difficulty: 'medium' });
    l.addHuman('B', 'p1'); // seat 1
    expect(l.removeSeat(0)).toBe(false); // host
    expect(l.removeSeat(1)).toBe(false); // human
    expect(l.removeSeat(5)).toBe(false); // out of range
    expect(l.removeSeat(2)).toBe(true); // bot seat removed
    expect(l.slots()).toHaveLength(2);
    while (l.slots().length < MAX_PLAYERS) expect(l.addSeat()).toBe(true);
    expect(l.addSeat()).toBe(false);
  });

  test('removeSeat shifts later seats down so seatOf stays correct', () => {
    const l = new Lobby('Ann', 'p0');
    l.addSeat();
    l.addHuman('B', 'p1'); // seat 1
    l.addHuman('C', 'p2'); // seat 2
    l.setSeat(1, { kind: 'open' }); // kick B
    expect(l.removeSeat(1)).toBe(true);
    expect(l.seatOf('p2')).toBe(1);
  });

  test('toMatchSetup maps seat i to players[i] with the bots\' nicknames', () => {
    const l = new Lobby('Ann', 'p0');
    l.addHuman('Bob', 'p1');
    l.addSeat();
    l.setSeat(2, { kind: 'bot', difficulty: 'hard' });
    l.addSeat();
    l.setSeat(3, { kind: 'bot', difficulty: 'easy' });
    expect(l.toMatchSetup()).toEqual({
      players: [
        { name: 'Ann', isBot: false },
        { name: 'Bob', isBot: false },
        { name: (l.slots()[2] as { name: string }).name, isBot: true, difficulty: 'hard' },
        { name: (l.slots()[3] as { name: string }).name, isBot: true, difficulty: 'easy' },
      ],
    });
  });

  test('toMatchSetup throws while any seat is open', () => {
    const l = new Lobby('Ann', 'p0');
    expect(() => l.toMatchSetup()).toThrow(/open/i);
    l.setSeat(1, { kind: 'bot', difficulty: 'medium' });
    expect(() => l.toMatchSetup()).not.toThrow();
    l.addSeat();
    expect(() => l.toMatchSetup()).toThrow(/open/i);
  });
});

describe('bot nicknames in the lobby', () => {
  test('a bot seat gets a human-style nickname that carries into the match', () => {
    const l = new Lobby('Alice', 'host');
    l.setSeat(1, { kind: 'bot', difficulty: 'easy' });
    const slot = l.slots()[1];
    expect(slot.kind).toBe('bot');
    const name = (slot as { name?: string }).name!;
    expect(name).toBeTruthy();
    expect(name).not.toMatch(/bot/i);
    expect(l.toMatchSetup().players[1].name).toBe(name);
  });
  test('changing only the difficulty keeps the nickname', () => {
    const l = new Lobby('Alice', 'host');
    l.setSeat(1, { kind: 'bot', difficulty: 'easy' });
    const first = (l.slots()[1] as { name?: string }).name;
    l.setSeat(1, { kind: 'bot', difficulty: 'hard' });
    expect((l.slots()[1] as { name?: string }).name).toBe(first);
  });
  test('nicknames are unique in a lobby', () => {
    const l = new Lobby('Alice', 'host');
    for (let i = 0; i < 6; i++) l.addSeat();
    for (let i = 1; i < 8; i++) l.setSeat(i, { kind: 'bot', difficulty: 'medium' });
    const names = l.slots().map((s) => (s.kind === 'bot' ? s.name : s.kind === 'human' ? s.name : ''));
    expect(new Set(names).size).toBe(8);
  });
});
