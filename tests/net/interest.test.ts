import { describe, expect, test } from 'vitest';
import { InterestManager, INTEREST } from '../../src/net/interest';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/net/snapshotCodec';
import { emptyInventory } from '../../src/sim/economy';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { MatchEvent, PieceState, PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { add, rotateY, v3 } from '../../src/sim/vec';

/** Point in island i's bunker frame: local -Z = front door, +Z = solid back wall. */
const bunkerLocal = (map: IslandLayout[], i: number, x: number, z: number): Vec3 => {
  const b = map[i].bunker;
  const p = add(b.center, rotateY(v3(x, 0, z), b.facingYaw));
  return v3(p.x, map[i].groundY, p.z);
};

function snapOf(players: PlayerState[], opts: Partial<Snapshot> = {}): Snapshot {
  return {
    time: 10, tick: 300, players, pieces: [], loot: [],
    generators: players.map((p) => ({ island: p.island, stored: 321 })), genLevels: players.map(() => 1),
    sealed: players.map(() => false), waterY: 0, suddenDeath: false, winner: null, events: [], ...opts,
  };
}

function setup(n = 2) {
  const map = buildMap(n);
  const players = map.map((isl, i) => newPlayer(i + 1, `p${i + 1}`, false, i, isl.center));
  return { map, players };
}

/** Encode → interest → decode, like HostSession + the remote client. */
function view(im: InterestManager, snap: Snapshot, viewer: number, enc = new SnapshotEncoder()) {
  enc.push(snap);
  im.update(snap);
  return new SnapshotDecoder().decode(im.apply(viewer, enc.take(viewer)));
}

describe('interest management', () => {
  test('enemy across open water is visible (exact position)', () => {
    const { map, players } = setup();
    const out = view(new InterestManager(map), snapOf(players), 1);
    expect(out.hidden ?? []).not.toContain(2);
    expect(out.players[1].pos.x).toBeCloseTo(players[1].pos.x, 1);
  });

  test('far enemy hidden in a bunker corner is omitted; its position never leaves the host', () => {
    const { map, players } = setup();
    players[1].pos = bunkerLocal(map, 1, 1.5, 1.5);
    players[1].hp = 37;
    players[1].yaw = 2.2;
    const out = view(new InterestManager(map), snapOf(players), 1);
    expect(out.hidden).toEqual([2]);
    const p2 = out.players.find((p) => p.id === 2)!;
    expect(p2.name).toBe('p2');
    expect(p2.alive).toBe(true);
    expect(Math.hypot(p2.pos.x - players[1].pos.x, p2.pos.z - players[1].pos.z)).toBeGreaterThan(1); // not the real spot
    expect(p2.hp).not.toBe(37);
    expect(p2.yaw).toBe(0);
  });

  test("a hidden enemy's shield and potion state are masked too", () => {
    const { map, players } = setup();
    players[1].pos = bunkerLocal(map, 1, 1.5, 1.5);
    Object.assign(players[1], { shield: 80, healLeft: 20, speedUntil: 99, drinking: { kind: 'shieldBig', doneAt: 11 } });
    const out = view(new InterestManager(map), snapOf(players), 1);
    expect(out.hidden).toEqual([2]);
    expect(out.players.find((p) => p.id === 2)).toMatchObject({ shield: 0, healLeft: 0, speedUntil: 0, drinking: null });
  });

  test('the same enemy is visible to someone looking straight through the doorway', () => {
    const { map, players } = setup();
    players[1].pos = bunkerLocal(map, 1, 0, 0);
    players[0].pos = bunkerLocal(map, 1, 0, -12); // in front of the door, 12 m out
    expect(view(new InterestManager(map), snapOf(players), 1).hidden ?? []).not.toContain(2);
  });

  test('enemy behind a placed steel wall is hidden; next to me (audible) it is revealed', () => {
    const { map, players } = setup();
    const base = map[0].center;
    players[0].pos = v3(base.x, 2, base.z);
    players[1].pos = v3(base.x + 14, 2, base.z);
    players[1].island = 1;
    // A row of steel walls across the line between them (rotY = π/2 → wall spans along z).
    const pieces: PieceState[] = [-4, -2, 0, 2, 4].map((dz, i) => ({
      id: 100 + i, kind: 'steel', owner: 2, pos: v3(base.x + 12, 2, base.z + dz), rotY: Math.PI / 2, hp: 1200,
    }));
    const im = new InterestManager(map);
    expect(view(im, snapOf(players, { pieces }), 1).hidden).toEqual([2]);
    // Same wall, but 5 m away and the enemy just behind it, within earshot.
    const close = pieces.map((p) => ({ ...p, pos: v3(base.x + 5, 2, p.pos.z) }));
    players[1].pos = v3(base.x + INTEREST.nearRadius - 2, 2, base.z);
    expect(view(new InterestManager(map), snapOf(players, { pieces: close }), 1).hidden ?? []).not.toContain(2);
  });

  test('a revealed enemy stays revealed briefly after ducking behind cover (no popping)', () => {
    const { map, players } = setup();
    const im = new InterestManager(map);
    expect(view(im, snapOf(players, { time: 10 }), 1).hidden ?? []).not.toContain(2);
    players[1].pos = bunkerLocal(map, 1, 1.5, 1.5);
    expect(view(im, snapOf(players, { time: 10 + INTEREST.graceSec / 2 }), 1).hidden ?? []).not.toContain(2);
    expect(view(im, snapOf(players, { time: 10 + INTEREST.graceSec + 0.1 }), 1).hidden).toEqual([2]);
  });

  test('other players\' inventories, vaults and hotbars are never sent; own are', () => {
    const { map, players } = setup();
    players[1].inv.cash = 999; players[1].vault.cash = 999; players[1].hotbar[0] = 'rifle';
    players[0].inv.cash = 77;
    const enc = new SnapshotEncoder();
    enc.push(snapOf(players));
    const im = new InterestManager(map);
    im.update(snapOf(players));
    const net = im.apply(1, enc.take(1));
    const other = net.players.find((p) => p.id === 2)!;
    expect(other.inv).toBeUndefined();
    expect(other.vault).toBeUndefined();
    expect(other.hotbar).toBeUndefined();
    expect(net.players.find((p) => p.id === 1)!.inv!.cash).toBe(77);
  });

  test('enemy generator cash is hidden unless you are near it; loot contents only for bags nearby', () => {
    const { map, players } = setup();
    const bag = { id: 9, pos: { ...map[1].center }, inv: { ...emptyInventory(), cash: 500 } };
    const nearBag = { id: 10, pos: v3(players[0].pos.x + 5, players[0].pos.y, players[0].pos.z), inv: { ...emptyInventory(), cash: 70 } };
    const withNear = view(new InterestManager(map), snapOf(players, { loot: [bag, nearBag] }), 1);
    expect(withNear.loot[1].inv.cash).toBe(70);
    const out = view(new InterestManager(map), snapOf(players, { loot: [bag] }), 1);
    expect(out.generators.find((g) => g.island === 0)!.stored).toBe(321);
    expect(out.generators.find((g) => g.island === 1)!.stored).toBe(0);
    expect(out.loot[0].inv.cash).toBe(0);
    expect(out.loot[0].pos).toEqual(bag.pos);
    players[0].pos = { ...map[1].generator };
    const near = view(new InterestManager(map), snapOf(players), 1);
    expect(near.generators.find((g) => g.island === 1)!.stored).toBe(321);
  });

  test('events: hidden shooter far away → coarse sound only; hits on hidden players dropped', () => {
    const { map, players } = setup(2);
    players[1].pos = bunkerLocal(map, 1, 1.5, 1.5);
    players.push(newPlayer(3, 'p3', false, 1, bunkerLocal(map, 1, -1.5, 1.5))); // a bot sharing that bunker
    const from = v3(players[1].pos.x, players[1].pos.y + 1.6, players[1].pos.z);
    const events: MatchEvent[] = [
      { t: 10, type: 'shot', data: { by: 2, weapon: 'rifle', from, to: v3(from.x, from.y, from.z + 1) } },
      { t: 10, type: 'hit', data: { target: 3, by: 2, amount: 30 } },
      { t: 10, type: 'kill', data: { victim: 3, killer: 2, inWater: false } },
    ];
    const out = view(new InterestManager(map), snapOf(players, { events }), 1);
    expect(out.hidden).toEqual([2, 3]);
    const shot = out.events.find((e) => e.type === 'shot');
    const dist = Math.hypot(players[0].pos.x - from.x, players[0].pos.z - from.z);
    if (dist <= INTEREST.hearShotRadius) {
      expect(shot).toBeDefined();
      expect(shot!.data.to).toBeUndefined();
      expect((shot!.data.from as Vec3).x % INTEREST.coarseGrid).toBeCloseTo(0, 5);
    } else {
      expect(shot).toBeUndefined();
    }
    expect(out.events.some((e) => e.type === 'hit')).toBe(false);
    expect(out.events.some((e) => e.type === 'kill')).toBe(true); // kill feed is public
  });

  test('a hidden enemy who shoots me is revealed (hit direction), full shot sent', () => {
    const { map, players } = setup();
    players[1].pos = bunkerLocal(map, 1, 1.5, 1.5);
    const me = players[0].pos;
    const from = v3(players[1].pos.x, 3.6, players[1].pos.z);
    const events: MatchEvent[] = [
      { t: 10, type: 'shot', data: { by: 2, weapon: 'rifle', from, to: v3(me.x, 3.2, me.z) } },
      { t: 10, type: 'hit', data: { target: 1, by: 2, amount: 30 } },
    ];
    const out = view(new InterestManager(map), snapOf(players, { events }), 1);
    expect(out.hidden ?? []).not.toContain(2);
    expect(out.events.find((e) => e.type === 'shot')!.data.to).toBeDefined();
    expect(out.events.some((e) => e.type === 'hit')).toBe(true);
  });

  test('eliminated viewers and finished matches see everyone', () => {
    const { map, players } = setup();
    players[1].pos = bunkerLocal(map, 1, 1.5, 1.5);
    players[0].eliminated = true; players[0].alive = false;
    expect(view(new InterestManager(map), snapOf(players), 1).hidden ?? []).toEqual([]);
    players[0].eliminated = false; players[0].alive = true;
    expect(view(new InterestManager(map), snapOf(players, { winner: 1 }), 1).hidden ?? []).toEqual([]);
  });

  test('perf: 8 players, 200 pieces, every client every broadcast stays cheap', () => {
    const map = buildMap(8);
    const players = map.map((isl, i) => newPlayer(i + 1, `p${i + 1}`, false, i, i % 2 ? bunkerLocal(map, i, 1.5, 1.5) : isl.center));
    const pieces: PieceState[] = [];
    for (let i = 0; i < 200; i++) {
      const isl = map[i % 8], a = i * 0.7;
      pieces.push({ id: 1000 + i, kind: (['wood', 'steel', 'metal', 'ramp', 'container'] as const)[i % 5], owner: 1,
        pos: v3(isl.center.x + Math.cos(a) * 12, 2, isl.center.z + Math.sin(a) * 12), rotY: a, hp: 100 });
    }
    const enc = new SnapshotEncoder();
    const im = new InterestManager(map);
    const N = 60;
    let worst = 0;
    const t0 = performance.now();
    for (let k = 0; k < N; k++) {
      for (const p of players) { p.pos.x += Math.sin(k + p.id) * 0.1; }
      const s = snapOf(players.map((p) => structuredClone(p)), { pieces, time: 10 + k / 15 });
      const a = performance.now();
      enc.push(s);
      im.update(s);
      for (const p of players) im.apply(p.id, enc.take(p.id));
      worst = Math.max(worst, performance.now() - a);
    }
    const avg = (performance.now() - t0) / N;
    console.info(`[perf] interest+encode, 8 viewers, 200 pieces: avg ${avg.toFixed(2)} ms (interest alone ${(im.costMs / N).toFixed(2)} ms), worst ${worst.toFixed(2)} ms per broadcast`);
    expect(avg).toBeLessThan(60); // ~1.2 ms in isolation; generous because other jobs often load this machine
  });
});
