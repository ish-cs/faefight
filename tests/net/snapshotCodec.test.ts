import { describe, expect, test } from 'vitest';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/net/snapshotCodec';
import { emptyInventory } from '../../src/sim/economy';
import { newPlayer } from '../../src/sim/player';
import type { PieceState, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

function snap(tick: number, pieces: PieceState[], events: Snapshot['events'] = []): Snapshot {
  const a = newPlayer(1, 'a', false, 0, v3(1.23456, 2, 3.98765));
  const b = newPlayer(2, 'b', false, 1, v3(40, 2, 0));
  b.vault.cash = 999;
  b.shield = 37.4;
  b.inv.potions.shieldBig = 3;
  return {
    time: tick / 30, tick, players: [a, b], pieces, loot: [], generators: [{ island: 0, stored: 12.3456 }, { island: 1, stored: 0 }],
    sealed: [false, false], waterY: 0, suddenDeath: false, winner: null, potionShops: [{ id: 0, pos: v3(0, 2, 0) }], events,
  };
}
const steel = (hp = 1200): PieceState => ({ id: 5, kind: 'steel', owner: 1, pos: v3(1, 2, 3), rotY: 0.5, hp });
const shot = (t: number) => ({ t, type: 'shot' as const, data: { by: 1 } });

describe('snapshot codec', () => {
  test('round-trips the latest state', () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    enc.push(snap(1, [steel()]));
    const out = dec.decode(enc.take(1));
    expect(out.tick).toBe(1);
    expect(out.pieces).toEqual([steel()]);
    expect(out.players[0].pos.x).toBeCloseTo(1.23456, 2);
  });
  test("everyone's shield is sent (it is shown on name tags); others' potions are not", () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    enc.push(snap(1, []));
    const forA = dec.decode(enc.take(1));
    expect(forA.players[1].shield).toBe(38);
    expect(forA.players[1].inv.potions).toEqual({});
    expect(forA.potionShops).toEqual([{ id: 0, pos: v3(0, 2, 0) }]);
    const forB = new SnapshotDecoder().decode(enc.take(2));
    expect(forB.players[1].inv.potions).toEqual({ shieldBig: 3 });
  });
  test('events from ticks between sends are merged, not lost', () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    enc.push(snap(1, [], [shot(1)]));
    enc.push(snap(2, [], [shot(2)]));
    expect(dec.decode(enc.take(1)).events.map((e) => e.t)).toEqual([1, 2]);
    enc.push(snap(3, [], [shot(3)]));
    expect(dec.decode(enc.take(1)).events.map((e) => e.t)).toEqual([3]);
  });
  test('each client gets every event even if they take at different times', () => {
    const enc = new SnapshotEncoder();
    enc.push(snap(1, [], [shot(1)]));
    enc.take(1);
    enc.push(snap(2, [], [shot(2)]));
    expect(enc.take(2).events.map((e) => e.t)).toEqual([1, 2]);
  });
  test('pieces are only sent when they change, per client', () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    enc.push(snap(1, [steel()]));
    expect(enc.take(1).pieces).toBeDefined();
    enc.push(snap(2, [steel()]));
    const n = enc.take(1);
    expect(n.pieces).toBeUndefined();
    dec.decode({ ...enc.take(3) });
    enc.push(snap(3, [steel(1100)]));
    expect(enc.take(1).pieces).toEqual([steel(1100)]);
  });
  test('decoder keeps the last pieces list when omitted', () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    enc.push(snap(1, [steel()]));
    dec.decode(enc.take(1));
    enc.push(snap(2, [steel()]));
    expect(dec.decode(enc.take(1)).pieces).toEqual([steel()]);
  });
  test("other players' vaults are hidden, your own is kept", () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    enc.push(snap(1, []));
    expect(enc.take(1).players[1].vault).toBeUndefined(); // not even sent
    const forA = dec.decode(enc.take(1));
    expect(forA.players[1].vault).toEqual(emptyInventory());
    expect(forA.players[1].inv).toEqual(emptyInventory());
    const forB = enc.take(2);
    expect(forB.players[1].vault!.cash).toBe(999);
  });
  test("other players' hotbars are hidden but their equipped gun is sent", () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    const s = snap(1, []);
    for (const p of s.players) { p.hotbar[2] = 'rifle'; p.selected = 2; p.equipped = 'rifle'; }
    enc.push(s);
    const forA = dec.decode(enc.take(1));
    expect(forA.players[0].hotbar[2]).toBe('rifle');
    expect(forA.players[1].hotbar).toEqual(Array(9).fill(null));
    expect(forA.players[1].equipped).toBe('rifle');
  });
  test('an 8-player mid-match update fits the 60 KB/s budget at 15 Hz', () => {
    const enc = new SnapshotEncoder();
    const s = snap(1, Array.from({ length: 60 }, (_, i) => ({ ...steel(), id: i })));
    s.players = Array.from({ length: 8 }, (_, i) => newPlayer(i + 1, 'p' + i, true, i, v3(i * 10.123456, 2, 3.333333)));
    enc.push(s);
    enc.take(1);
    enc.push({ ...s, tick: 2 });
    expect(JSON.stringify(enc.take(1)).length).toBeLessThan((60 * 1024) / 15);
  });
  test("every player's kills and deaths reach every client", () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    const s = snap(1, []);
    s.players[0].kills = 3; s.players[0].deaths = 1;
    s.players[1].kills = 0; s.players[1].deaths = 4;
    enc.push(s);
    for (const viewer of [1, 2]) {
      const out = dec.decode(enc.take(viewer));
      expect(out.players.map((p) => [p.kills, p.deaths])).toEqual([[3, 1], [0, 4]]);
    }
  });
});
