import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { ELIM, LIFECYCLE, PLAYER } from '../../src/sim/constants';
import { creditFor, newElimLedger, splitSpoils } from '../../src/sim/elimination';
import type { MatchStateCore } from '../../src/sim/lifecycle';
import { newPlayer } from '../../src/sim/player';
import { speedMult } from '../../src/sim/potions';
import type { MatchEvent, PlayerState, Snapshot } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

const humans = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i + 1}`, isBot: false }));
const state = (m: Match) => (m as unknown as { s: MatchStateCore }).s;

async function setup() {
  const m = await Match.create({ players: humans(3), seed: 4 });
  const events: MatchEvent[] = [];
  let snap: Snapshot = m.tick(new Map());
  const run = (sec: number) => {
    for (let i = 0; i < Math.round(sec * 30); i++) { snap = m.tick(new Map()); events.push(...snap.events); }
    return snap;
  };
  const p = (id: number) => state(m).players.get(id)!;
  /** Victim (2) out on its own island, off the bunker. */
  const outside = () => {
    const isl = m.map[p(2).island];
    const at = add(add(isl.center, scale(forward(isl.bunker.facingYaw), 5)), scale(right(isl.bunker.facingYaw), 3));
    m.debugTeleport(2, v3(at.x, isl.groundY, at.z));
  };
  const seal = (owners: number[]) => owners.forEach((o, door) => m.debugPlugDoor(p(2).island, door, o));
  const elims = () => events.filter((e) => e.type === 'elimination');
  return { m, run, p, outside, seal, elims, events, snap: () => snap };
}

describe('elimination credit', () => {
  test('killed while the bunker was already sealed (then failed to break out) → the killer; the sealer assists', async () => {
    const { m, run, p, outside, seal, elims } = await setup();
    outside();
    seal([1, 1, 1]);
    run(0.2);
    m.debugKill(2, 3);
    run(LIFECYCLE.respawnSec + LIFECYCLE.breakoutSec + 1);
    expect(p(2).eliminated).toBe(true);
    expect(elims().map((e) => e.data)).toEqual([expect.objectContaining({ victim: 2, by: 3, assists: [1], how: 'killed' })]);
  });

  test('sealed while dead and failed to break out → the last plug placer; other placers assist', async () => {
    const { m, run, p, outside, seal, elims } = await setup();
    outside();
    run(0.2);
    m.debugKill(2, 3);
    run(1);
    seal([3, 3, 1]); // player 1 closes it
    run(LIFECYCLE.respawnSec + LIFECYCLE.breakoutSec);
    expect(p(2).eliminated).toBe(true);
    expect(elims().map((e) => e.data)).toEqual([expect.objectContaining({ victim: 2, by: 1, assists: [3], how: 'trapped' })]);
  });

  test('killed during the breakout window → the killer at once; the sealer assists', async () => {
    const { m, run, p, seal, elims } = await setup();
    seal([1, 1, 1]); // victim at spawn, inside: trapped
    run(2);
    expect(p(2).breakoutUntil).not.toBeNull();
    m.debugKill(2, 3);
    run(0.1);
    expect(p(2).eliminated).toBe(true);
    expect(elims().map((e) => e.data)).toEqual([expect.objectContaining({ victim: 2, by: 3, assists: [1], how: 'killed' })]);
  });

  test('pure credit rules: teammates never get credit, a recent hitter is the fallback, nobody → null', () => {
    const v = newPlayer(2, 'v', false, 1, v3()), a = newPlayer(1, 'a', false, 0, v3()), b = newPlayer(3, 'b', false, 2, v3());
    const players = new Map<number, PlayerState>([[1, a], [2, v], [3, b]]);
    const led = newElimLedger(3);
    expect(creditFor(v, players, led, null, 100, true)).toEqual({ by: null, assists: [], how: 'other' });
    led.lastHit[2] = { by: 3, at: 95 };
    expect(creditFor(v, players, led, null, 100, true).by).toBe(3);
    expect(creditFor(v, players, led, null, 95 + ELIM.creditHitSec + 1, true).by).toBeNull();
    v.team = 0; b.team = 0;
    expect(creditFor(v, players, led, 3, 100, false).by).toBeNull();
  });
});

describe('spoils of war and victory surge', () => {
  test('spoils = vault + share of the drop + generator, 75 / 25 split, surge on the eliminator, shield on the assist', async () => {
    const { m, run, p, seal, elims } = await setup();
    const g = state(m).generators.find((x) => x.island === p(2).island)!;
    p(2).vault.cash = 300;
    m.debugGive(2, { cash: 200 });
    seal([1, 1, 1]);
    run(1);
    m.debugSetGenerator(p(2).island, 100);
    const cash1 = p(1).inv.cash, cash3 = p(3).inv.cash, carried = p(2).inv.cash;
    m.debugSetHp(3, 20);
    m.debugSetShield(1, 0);
    m.debugKill(2, 3);
    run(1 / 30);
    const e = elims()[0];
    const stored = 100; // the generator ticks on before the kill lands: whatever it held went into the spoils
    expect(g.stored).toBeLessThan(1);
    const total = e.data.spoils as number;
    expect(total).toBeGreaterThanOrEqual(300 + Math.floor(carried * ELIM.carriedShare) + stored);
    expect(total).toBeLessThan(300 + Math.floor(carried * ELIM.carriedShare) + stored + 2);
    expect(e.data.shares).toEqual(splitSpoils(total, 3, [1]));
    expect(p(3).inv.cash - cash3).toBe(total - Math.floor(total * (1 - ELIM.eliminatorShare)));
    expect(p(1).inv.cash - cash1).toBe(Math.floor(total * (1 - ELIM.eliminatorShare)));
    expect(p(2).vault.cash).toBe(0);
    // The rest of the drop stays in the bag on the ground.
    const bag = [...state(m).loot.values()].at(-1)!;
    expect(bag.inv.cash).toBe(carried - Math.floor(carried * ELIM.carriedShare));
    // Surge: full hp, +50 shield, faster for 10 s.
    expect(p(3).hp).toBe(PLAYER.hp);
    expect(p(3).shield).toBe(ELIM.surgeShield);
    expect(p(1).shield).toBe(ELIM.assistShield);
    const now = state(m).time;
    expect(speedMult(p(3), now)).toBeCloseTo(ELIM.surgeSpeed);
    expect(speedMult(p(1), now)).toBe(1);
    run(ELIM.surgeSec - 0.5);
    expect(speedMult(p(3), state(m).time)).toBeCloseTo(ELIM.surgeSpeed);
    run(1);
    expect(speedMult(p(3), state(m).time)).toBe(1);
    // End-screen totals.
    m.debugEliminate(1);
    run(0.2);
    const stats = m.tick(new Map()).stats!;
    const row = (id: number) => stats.find((s) => s.id === id)!;
    expect(row(3)).toMatchObject({ elims: 1, spoils: (e.data.shares as [number, number][])[0][1] });
    expect(row(1)).toMatchObject({ assists: 1 });
  });

  test('split: alone takes all; assists share 25 % evenly; integers that sum to the total', () => {
    expect(splitSpoils(401, 5, [])).toEqual([[5, 401]]);
    expect(splitSpoils(400, 5, [1, 2])).toEqual([[5, 300], [1, 50], [2, 50]]);
    const s = splitSpoils(333, 5, [1, 2, 3]);
    expect(s.reduce((a, [, x]) => a + x, 0)).toBe(333);
  });

  test('deterministic: a fork replays the same eliminations and spoils', async () => {
    const { m, run, seal } = await setup();
    seal([1, 1, 1]);
    run(1);
    const f = m.fork();
    m.debugKill(2, 3); f.debugKill(2, 3);
    const a: unknown[] = [], b: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      a.push(...m.tick(new Map()).events.filter((e) => e.type === 'elimination'));
      b.push(...f.tick(new Map()).events.filter((e) => e.type === 'elimination'));
    }
    expect(a.length).toBe(1);
    expect(b).toEqual(a);
    run(0);
  });
});
