import { describe, expect, test } from 'vitest';
import { Lobby } from '../../src/net/lobby';
import { sanitizeClientMsg } from '../../src/net/sanitize';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/net/snapshotCodec';
import { newPlayer } from '../../src/sim/player';
import type { PieceState, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

describe('reconnect + ping wire messages', () => {
  test('hello may carry a well-formed rejoin token', () => {
    expect(sanitizeClientMsg({ t: 'hello', name: 'Bob', version: 5, rejoin: 'abcd1234-ef' })).toEqual({ t: 'hello', name: 'Bob', version: 5, rejoin: 'abcd1234-ef' });
    expect(sanitizeClientMsg({ t: 'hello', name: 'Bob', version: 5, rejoin: '<x>' })).toEqual({ t: 'hello', name: 'Bob', version: 5 });
    expect(sanitizeClientMsg({ t: 'hello', name: 'Bob', version: 5, rejoin: 'a'.repeat(200) })).toEqual({ t: 'hello', name: 'Bob', version: 5 });
  });
  test('pong needs a positive integer', () => {
    expect(sanitizeClientMsg({ t: 'pong', n: 3 })).toEqual({ t: 'pong', n: 3 });
    expect(sanitizeClientMsg({ t: 'pong', n: -1 })).toBeNull();
    expect(sanitizeClientMsg({ t: 'pong', n: 1.5 })).toBeNull();
  });
});

describe('Lobby.rebind', () => {
  test('moves a friend seat to a new link; never the host or a bot', () => {
    const l = new Lobby('Ann', 'p-ann');
    expect(l.addHuman('Bob', 'p-bob')).toBe(1);
    expect(l.rebind(1, 'p-bob2')).toBe(true);
    expect(l.seatOf('p-bob')).toBeNull();
    expect(l.seatOf('p-bob2')).toBe(1);
    expect(l.slots()[1]).toMatchObject({ kind: 'human', name: 'Bob', peerId: 'p-bob2' });
    expect(l.rebind(0, 'x')).toBe(false);
    l.addSeat();
    l.setSeat(2, { kind: 'bot', difficulty: 'easy' });
    expect(l.rebind(2, 'x')).toBe(false);
    expect(l.rebind(1, 'p-ann')).toBe(false); // already seated elsewhere
  });
});

describe('SnapshotEncoder.resync', () => {
  const snap = (tick: number, pieces: PieceState[]): Snapshot => ({
    time: tick / 30, tick, players: [newPlayer(1, 'a', false, 0, v3(0, 0, 0)), newPlayer(2, 'b', false, 1, v3(9, 0, 0))], pieces, loot: [],
    generators: [], genLevels: [], sealed: [], waterY: 0, suddenDeath: false, winner: null, events: [{ t: tick / 30, type: 'shot', data: { by: 1 } }],
  });
  const steel: PieceState = { id: 5, kind: 'steel', owner: 1, pos: v3(1, 2, 3), rotY: 0, hp: 1200 };
  test('a reconnected client gets every piece again and no backlog of old events', () => {
    const enc = new SnapshotEncoder();
    enc.push(snap(1, [steel]));
    enc.take(2);
    enc.push(snap(2, [steel]));
    enc.push(snap(3, [steel]));
    enc.resync(2);
    enc.push(snap(4, [steel]));
    const out = enc.take(2);
    expect(out.pieces).toHaveLength(1);
    expect(out.events).toHaveLength(1); // tick 4 only
    expect(new SnapshotDecoder().decode(out).pieces).toHaveLength(1);
  });
});
