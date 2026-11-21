import { describe, expect, test } from 'vitest';
import { FIRE, PIECES } from '../../src/sim/constants';
import { burnDownSec, piecesTouch, steerFromFire } from '../../src/sim/fire';
import { Match } from '../../src/sim/match';
import type { IslandLayout } from '../../src/sim/map';
import type { MatchEvent, PieceState, Snapshot } from '../../src/sim/types';
import { add, forward, right, rotateY, scale, v3 } from '../../src/sim/vec';

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };
const idle = () => new Map();

async function setup(seed = 1) {
  const m = await Match.create({ ...humans, seed });
  const isl = m.map[0];
  const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
  /** Island-local spot `d` m toward the enemy side and `side` m to the right, on the ground. */
  const at = (d: number, side: number, up = 0) => { const p = add(add(isl.center, scale(f, d)), scale(r, side)); return v3(p.x, isl.groundY + up, p.z); };
  // Players out of the way (fire damage tests move them in).
  m.debugTeleport(1, at(-10, -12));
  m.debugTeleport(2, m.map[1].spawn);
  return { m, isl, yaw, at };
}

function run(m: Match, sec: number, each?: (s: Snapshot) => void): MatchEvent[] {
  const out: MatchEvent[] = [];
  for (let i = 0; i < Math.round(sec * 30); i++) {
    const s = m.tick(idle());
    out.push(...s.events);
    each?.(s);
  }
  return out;
}

const piece = (m: Match, id: number): PieceState | undefined => m.tick(idle()).pieces.find((p) => p.id === id);

describe('fire', () => {
  test('a rocket blast sets wood alight; steel next to it never burns', async () => {
    const { m, yaw, at } = await setup();
    // Two walls side by side 4.2 m behind the blast: the wood survives the blast itself (~100 dmg of 200).
    const wood = m.debugPlacePiece('wood', at(4, -1.2), yaw);
    const steel = m.debugPlacePiece('steel', at(4, 1.2), yaw);
    m.debugExplode('rocket', at(4 - 4.2 - PIECES.wood.d / 2, 0, 0.8), 1);
    m.tick(idle());
    const s = m.tick(idle());
    const w = s.pieces.find((p) => p.id === wood)!, st = s.pieces.find((p) => p.id === steel)!;
    expect(w).toBeDefined();
    expect(w.hp).toBeLessThan(PIECES.wood.hp);
    expect(w.burning).toBe(true);
    expect(st.burning).toBeUndefined();
    expect(m.debugFire().burning).toEqual([wood]);
    // Metal, steel and containers can't be lit at all.
    (['metal', 'steel', 'container'] as const).forEach((k, i) => expect(m.debugIgnite(m.debugPlacePiece(k, at(-3, 6 + 7 * i), yaw))).toBe(false));
  });

  test('burn damage over time destroys a damaged wood wall (13 HP/s)', async () => {
    const { m, yaw, at } = await setup();
    const id = m.debugPlacePiece('wood', at(4, 0), yaw);
    m.debugDamagePiece(id, 100); // 100 HP left → ~7.7 s of burning, well inside the 14 s minimum burn
    expect(m.debugIgnite(id)).toBe(true);
    run(m, 2);
    const hp2 = piece(m, id)!.hp;
    expect(hp2).toBeGreaterThan(100 - 2.2 * FIRE.pieces.wood!.dps);
    expect(hp2).toBeLessThan(100 - 1.8 * FIRE.pieces.wood!.dps);
    const ev = run(m, 7);
    const destroyed = ev.find((e) => e.type === 'destroyed' && e.data.piece === id);
    expect(destroyed?.data.fire).toBe(true);
    expect(piece(m, id)).toBeUndefined();
    // A full-HP wood wall takes ~15.4 s: longer than the shortest burn, shorter than the longest.
    expect(burnDownSec('wood')).toBeCloseTo(200 / 13, 3);
    expect(burnDownSec('wood')).toBeGreaterThan(FIRE.pieces.wood!.burnSec[0]);
    expect(burnDownSec('wood')).toBeLessThan(FIRE.pieces.wood!.burnSec[1]);
    expect(burnDownSec('steel')).toBe(Infinity);
  });

  test('fire spreads to a touching wood wall after a few seconds, not to one standing apart', async () => {
    const { m, yaw, at } = await setup();
    const a = m.debugPlacePiece('wood', at(4, 0), yaw);
    const b = m.debugPlacePiece('wood', at(4, PIECES.wood.w), yaw); // edge to edge
    const far = m.debugPlacePiece('wood', at(4, 2 * PIECES.wood.w + 1.5), yaw); // 1.5 m gap
    m.debugIgnite(a);
    run(m, FIRE.spreadAfterSec - 0.2);
    expect(m.debugFire().burning).toEqual([a]);
    let litAt = -1;
    for (let t = 0; t < 12 * 30 && litAt < 0; t++) { m.tick(idle()); if (m.debugFire().burning.includes(b)) litAt = t; }
    expect(litAt).toBeGreaterThanOrEqual(0);
    expect(m.debugFire().burning).not.toContain(far);
  });

  test('burn-out: sandbags smoulder for 4–6 s and stay standing; nothing burns past its max time', async () => {
    const { m, yaw, at } = await setup();
    const bags = m.debugPlacePiece('sandbags', at(4, 0), yaw);
    const wood = m.debugPlacePiece('wood', at(4, 6), yaw);
    m.debugIgnite(bags);
    m.debugIgnite(wood);
    let outAt = -1;
    for (let t = 1; t <= 8 * 30; t++) { m.tick(idle()); if (outAt < 0 && !m.debugFire().burning.includes(bags)) outAt = t / 30; }
    expect(outAt).toBeGreaterThanOrEqual(FIRE.pieces.sandbags!.burnSec[0]);
    expect(outAt).toBeLessThanOrEqual(FIRE.pieces.sandbags!.burnSec[1] + FIRE.stepSec + 0.05);
    const p = piece(m, bags)!;
    expect(p.burning).toBeUndefined();
    expect(p.hp).toBeGreaterThan(PIECES.sandbags.hp - 6.5 * FIRE.pieces.sandbags!.dps);
    run(m, FIRE.pieces.wood!.burnSec[1] - 8 + 1);
    expect(m.debugFire().burning).toEqual([]);
    // A burnt-out piece is charred: a neighbour can't relight it, an explosion can.
    expect(m.debugIgnite(bags)).toBe(true);
  });

  test('a player against a burning wall takes 6 HP/s, shield first, and the hit says fire', async () => {
    const { m, yaw, at } = await setup();
    const id = m.debugPlacePiece('wood', at(4, 0), yaw);
    m.debugIgnite(id, 2);
    m.debugSetShield(1, 50);
    m.debugTeleport(1, add(at(4, 0), scale(forward(yaw), -(PIECES.wood.d / 2 + 0.4))));
    const hits = run(m, 2).filter((e) => e.type === 'hit' && e.data.target === 1);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.every((h) => h.data.weapon === 'fire' && h.data.by === 2)).toBe(true);
    const me = m.tick(idle()).players.find((p) => p.id === 1)!;
    expect(me.hp).toBe(100);
    expect(50 - me.shield).toBeGreaterThanOrEqual(2 * FIRE.playerDps - FIRE.playerDps * FIRE.stepSec - 1e-6);
    expect(50 - me.shield).toBeLessThanOrEqual(2 * FIRE.playerDps + FIRE.playerDps * FIRE.stepSec + 1e-6);
    // Step away: no more burning.
    m.debugTeleport(1, at(-6, 0));
    expect(run(m, 2).filter((e) => e.type === 'hit' && e.data.target === 1)).toEqual([]);
  });

  test('a wall resting on a burnt-down wall collapses with it', async () => {
    const { m, yaw, at } = await setup();
    const base = m.debugPlacePiece('wood', at(4, 0), yaw);
    const top = m.debugPlacePiece('wood', at(4, 0, PIECES.wood.h), yaw);
    m.debugDamagePiece(base, 170);
    m.debugIgnite(base);
    const ev = run(m, 4);
    expect(ev.find((e) => e.type === 'destroyed' && e.data.piece === base)?.data.fire).toBe(true);
    expect(ev.find((e) => e.type === 'destroyed' && e.data.piece === top)?.data.collapse).toBe(true);
  });

  test('grass catches from a blast on a grass bed, creeps, and dies out', async () => {
    const { m, isl } = await setup();
    // Harbor grass bed at island-local (-12.8, 9.6).
    const g = add(isl.center, rotateY(v3(-12.8, 0, 9.6), isl.bunker.facingYaw));
    m.debugExplode('grenade', v3(g.x, isl.groundY + 0.1, g.z), 1);
    m.tick(idle());
    const s = m.tick(idle());
    expect(s.fires?.length).toBe(1);
    expect(s.fires![0].kind).toBe('grass');
    let most = 0;
    run(m, 10, (x) => { most = Math.max(most, x.fires?.length ?? 0); });
    expect(most).toBeGreaterThan(1);
    run(m, 60);
    expect(m.tick(idle()).fires).toBeUndefined();
  });

  test('same seed, same fire: spread and destruction are deterministic', async () => {
    const trace = async (seed: number) => {
      const { m, yaw, at } = await setup(seed);
      const ids = [-4, -2, 0, 2, 4].map((side) => m.debugPlacePiece('wood', at(4, side), yaw));
      m.debugIgnite(ids[2], 1);
      const log: string[] = [];
      run(m, 30, (s) => { for (const e of s.events) if (e.type === 'destroyed') log.push(`${s.tick}:${e.data.piece}`); log.push(`${s.tick}:${s.pieces.filter((p) => p.burning).map((p) => p.id).join(',')}`); });
      return log.join(' ');
    };
    const a = await trace(7), b = await trace(7);
    expect(a).toBe(b);
    expect(a).toMatch(/:\d+,\d+/); // it did spread at some point
  });
});

describe('fire helpers', () => {
  const wall = (id: number, x: number, z: number, rotY = 0): PieceState => ({ id, kind: 'wood', owner: 1, pos: v3(x, 2, z), rotY, hp: 200 });
  test('piecesTouch: edge to edge yes, a metre apart no, a corner joint yes', () => {
    expect(piecesTouch(wall(1, 0, 0), wall(2, 2, 0), 0.25)).toBe(true);
    expect(piecesTouch(wall(1, 0, 0), wall(2, 3, 0), 0.25)).toBe(false);
    expect(piecesTouch(wall(1, 0, 0), wall(2, 1.1, 1.0, Math.PI / 2), 0.25)).toBe(true);
    expect(piecesTouch(wall(1, 0, 0), { ...wall(2, 0, 0), pos: v3(0, 4.5, 0) }, 0.25)).toBe(false);
  });
  test('steerFromFire: slides around a fire ahead, walks out of one underfoot, leaves clear paths alone', () => {
    const zones = [{ pos: v3(0, 2, -2), r: 1.5 }];
    const ahead = steerFromFire(v3(0, 2, 0), v3(0, 0, -1), zones)!;
    expect(ahead.z).toBeGreaterThan(-0.95);
    const p2 = v3(ahead.x * 1.2, 2, ahead.z * 1.2);
    expect(Math.hypot(p2.x - 0, p2.z + 2)).toBeGreaterThan(1.2 * 0.5);
    const out = steerFromFire(v3(0.5, 2, -2), null, zones)!;
    expect(out.x).toBeGreaterThan(0.9);
    expect(steerFromFire(v3(0, 2, 0), v3(0, 0, 1), zones)).toEqual(v3(0, 0, 1));
  });
});

describe('bots and fire', () => {
  test('a medium bot with a rocket sets a rival wooden base on fire', async () => {
    const m = await Match.create({ players: [{ name: 'Bot (medium)', isBot: true, difficulty: 'medium' }, { name: 'b', isBot: false }], seed: 3 });
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    const at = (d: number, side: number) => { const p = add(add(isl.center, scale(f, d)), scale(r, side)); return v3(p.x, isl.groundY, p.z); };
    m.debugTeleport(2, m.map[1].spawn);
    m.debugTeleport(1, at(-6, 0));
    m.debugGive(1, { weapons: { rocket: { mag: 1, spare: 2 } } });
    // Player 2's wooden fort 14 m away on the bot's island.
    const fort = [-2, 0, 2].map((side) => m.debugPlacePiece('wood', at(8, side), yaw, 2));
    let shotAt = -1;
    for (let t = 0; t < 8 * 30 && shotAt < 0; t++) {
      const s = m.tick(idle());
      if (s.events.some((e) => e.type === 'shot' && e.data.by === 1 && e.data.weapon === 'rocket')) shotAt = t;
    }
    expect(shotAt).toBeGreaterThanOrEqual(0);
    run(m, 2);
    const s = m.tick(idle());
    const hurt = fort.filter((id) => { const p = s.pieces.find((q) => q.id === id); return !p || p.burning; });
    expect(hurt.length).toBeGreaterThan(0);
  });

  test('an easy bot never torches', async () => {
    const m = await Match.create({ players: [{ name: 'Bot (easy)', isBot: true, difficulty: 'easy' }, { name: 'b', isBot: false }], seed: 3 });
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw);
    m.debugTeleport(2, m.map[1].spawn);
    m.debugGive(1, { weapons: { rocket: { mag: 1, spare: 2 } } });
    [-2, 0, 2].forEach((side) => { const p = add(add(isl.center, scale(f, 8)), scale(right(yaw), side)); m.debugPlacePiece('wood', v3(p.x, isl.groundY, p.z), yaw, 2); });
    expect(run(m, 6).some((e) => e.type === 'shot' && e.data.weapon === 'rocket')).toBe(false);
  });
});
