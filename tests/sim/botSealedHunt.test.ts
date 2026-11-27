import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { MAP, PIECES } from '../../src/sim/constants';
import { forward, v3 } from '../../src/sim/vec';
import type { PieceKind, Snapshot } from '../../src/sim/types';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * User replay a.faereplay (harbor, 4 PRO bots): the last two each stood on the OTHER's island, both bunkers sealed,
 * no bridge home. Each scored 'defend' (clear my plug) with no walk home and "shot" its own plug from ~90 m away:
 * zero movement, hits or builds for 10.7 min, until sudden death. A sealed-out rival who is alive gets hunted.
 */
async function swapped(seed = 1) {
  const m = await Match.create({
    players: [1, 2, 3, 4].map((i) => ({ name: `p${i}`, isBot: true, difficulty: 'pro' as const })), map: 'harbor', seed,
  });
  for (let i = 0; i < 30; i++) m.tick(new Map());
  m.debugEliminate(3);
  m.debugEliminate(4);
  // Plug every doorway of islands 0 (p1's) and 1 (p2's): both sealed.
  const plug = (isl: number, kind: PieceKind) => {
    for (const d of m.map[isl].bunker.doorways) {
      const out = forward(d.yaw), off = MAP.bunker.wall / 2 + PIECES[kind].d / 2 + 0.05;
      m.debugPlacePiece(kind, v3(d.center.x + out.x * off, d.center.y - 0.01, d.center.z + out.z * off), d.yaw, 1);
    }
  };
  plug(0, 'wood');
  plug(1, 'wood');
  // Each stands in front of the other's bunker, armed, with money but no decks, one hook use (as in the replay).
  const front = (isl: number) => {
    const d = m.map[isl].bunker.doorways[0], o = forward(d.yaw);
    return v3(d.center.x + o.x * 8, m.map[isl].groundY, d.center.z + o.z * 8);
  };
  m.debugTeleport(1, front(1));
  m.debugTeleport(2, front(0));
  for (const id of [1, 2]) m.debugGive(id, { cash: 1000, weapons: { smg: { mag: 30, spare: 60 } }, grapples: 1 });
  let snap: Snapshot = m.tick(new Map());
  expect(snap.sealed?.slice(0, 2)).toEqual([true, true]);
  const start = snap.time;
  const last = new Map<number, { x: number; z: number; t: number }>();
  let frozen = 0, hits = 0, kill: number | null = null;
  while (snap.time < start + 180 && kill === null) {
    snap = m.tick(new Map());
    for (const e of snap.events) {
      if (e.type === 'hit') hits++;
      if (e.type === 'kill') kill = snap.time - start;
    }
    for (const p of snap.players) {
      if (!p.alive || p.eliminated) continue;
      const l = last.get(p.id);
      if (!l || Math.hypot(p.pos.x - l.x, p.pos.z - l.z) > 1) last.set(p.id, { x: p.pos.x, z: p.pos.z, t: snap.time });
      else frozen = Math.max(frozen, snap.time - l.t);
    }
    if (ENV.HUNT_TRACE && snap.tick % 150 === 0) {
      const goal = (id: number) => (m.botBrain(id) as unknown as { currentGoal: string } | null)?.currentGoal;
      console.log((snap.time - start).toFixed(0), snap.players.filter((p) => !p.eliminated)
        .map((p) => `${p.id} ${goal(p.id)} ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)} sc${p.inv.pieces.scaffold ?? 0} $${p.inv.cash}`).join(' | '));
    }
  }
  m.dispose();
  return { frozen, hits, kill };
}

describe('sealed out of reach of each other (replay a.faereplay)', () => {
  test('both bunkers sealed, each on the other\'s island: they go and fight instead of standing still', async () => {
    const r = await swapped();
    if (ENV.HUNT_TRACE) console.log(JSON.stringify(r));
    expect(r.frozen).toBeLessThan(45);
    expect(r.hits).toBeGreaterThan(0);
    expect(r.kill).not.toBeNull();
  }, 120_000);
});

/**
 * ffa8-mixed seed 10 (bot-measure): a Hard bot out of ammo, with a charge, sealed out of its home by a wood plug.
 * 'defend' counted on the charge (canClear) but only hard plugs got one; fists can't punch from outside a sealed
 * bunker, so it stood still 9.5 min. The charge goes on the wood plug.
 */
describe('sealed out of my home with only a charge', () => {
  test('a gunless bot blows its soft plug with the charge instead of standing still', async () => {
    const m = await Match.create({ players: [1, 2].map((i) => ({ name: `p${i}`, isBot: true, difficulty: 'hard' as const })), map: 'harbor', seed: 1 });
    for (let i = 0; i < 30; i++) m.tick(new Map());
    for (const d of m.map[0].bunker.doorways) {
      const out = forward(d.yaw), off = MAP.bunker.wall / 2 + PIECES.wood.d / 2 + 0.05;
      m.debugPlacePiece('wood', v3(d.center.x + out.x * off, d.center.y - 0.01, d.center.z + out.z * off), d.yaw, 2);
    }
    const d = m.map[0].bunker.doorways[0], o = forward(d.yaw);
    m.debugTeleport(1, v3(d.center.x + o.x * 8, m.map[0].groundY, d.center.z + o.z * 8));
    m.debugGive(1, { charges: 1 });
    // Out of ammo and cash: no gun, no shop trip.
    const p1 = (m as unknown as { mustPlayer(id: number): { inv: { cash: number; weapons: Record<string, { mag: number; spare: number }> } } }).mustPlayer(1);
    for (const w of Object.values(p1.inv.weapons)) { w.mag = 0; w.spare = 0; }
    p1.inv.cash = 0;
    let snap: Snapshot = m.tick(new Map());
    expect(snap.sealed?.[0]).toBe(true);
    const start = snap.time;
    let charged: number | null = null;
    while (snap.time < start + 60 && charged === null) {
      snap = m.tick(new Map());
      const me = snap.players.find((p) => p.id === 1)!;
      if (me.inv.charges === 0) charged = snap.time - start;
    }
    m.dispose();
    expect(charged).not.toBeNull();
  }, 120_000);
});
