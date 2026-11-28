import { describe, expect, test } from 'vitest';
import { wrapAngle } from '../../src/sim/bots/aim';
import { Bot } from '../../src/sim/bots/bot';
import { Gaze } from '../../src/sim/bots/gaze';
import { gazeStats, type GazeSample } from '../../src/sim/bots/gazeStats';
import { GAZE } from '../../src/sim/bots/params';
import { DT } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { mulberry32 } from '../../src/sim/rng';
import type { Difficulty, PlayerInput, PlayerState } from '../../src/sim/types';
import { yawOf } from '../../src/sim/vec';

const DEG = Math.PI / 180;
const eye = { x: 0, y: 1.6, z: 0 };
const foe = (id: number, x: number, z: number, yaw = 0): PlayerState => ({ id, pos: { x, y: 0, z }, yaw, equipped: 'rifle' } as PlayerState);

describe('gaze controller (gaze.ts)', () => {
  test('calm: looks along the walk, within the drift', () => {
    const g = new Gaze(GAZE.skill.pro, { ...GAZE, skill: GAZE.skill }, mulberry32(3));
    const walk = { x: 1, y: 0, z: 0 }, want = yawOf(walk);
    let off = 0, n = 0;
    for (let i = 0; i < 30 * 30; i++) {
      const a = g.calm(i * DT, DT, eye, { yaw: want, pitch: 0 }, walk, [], null, null);
      if (g.mode === 'path') { off += Math.abs(wrapAngle(a.yaw - want)); n++; }
    }
    expect(n).toBeGreaterThan(30 * 20); // mostly the path; the odd look-around
    expect(off / n / DEG).toBeLessThan(GAZE.skill.pro.driftDeg * 2);
  });

  test.each(['pro', 'easy'] as Difficulty[])('%s: a newly sighted enemy gets a short first look, then back to the path', (d) => {
    const S = GAZE.skill[d];
    const g = new Gaze(S, { ...GAZE, skill: GAZE.skill }, mulberry32(5));
    const walk = { x: 0, y: 0, z: -1 }, e = foe(2, 20, 0);
    let first = 0;
    for (let i = 0; i < 30 * 4; i++) {
      const a = g.calm(i * DT, DT, eye, { yaw: 0, pitch: 0 }, walk, [e], null, null);
      if (i === 0) expect(Math.abs(wrapAngle(a.yaw - yawOf({ x: 20, z: 0 })))).toBeLessThan(1e-6);
      if (g.mode === 'first') first++;
    }
    expect(first * DT).toBeGreaterThanOrEqual(S.firstLookSec * 0.6 - DT);
    expect(first * DT).toBeLessThanOrEqual(S.firstLookSec * 1.4 + DT);
  });

  test('a hit from someone out of sight turns the view to where they were', () => {
    const g = new Gaze(GAZE.skill.hard, GAZE, mulberry32(9));
    const at = { x: -10, y: 1.2, z: 0 };
    const a = g.calm(1, DT, eye, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: -1 }, [], null, at);
    expect(g.mode).toBe('hurt');
    expect(Math.abs(wrapAngle(a.yaw - yawOf({ x: -10, z: 0 })))).toBeLessThan(1e-6);
  });

  test('engagement holds for engageHoldSec; threats: hit lately, or aimed at from close', () => {
    const g = new Gaze(GAZE.skill.pro, GAZE, mulberry32(1));
    expect(g.engaged(0, true)).toBe(true);
    expect(g.engaged(GAZE.engageHoldSec - 0.05, false)).toBe(true);
    expect(g.engaged(GAZE.engageHoldSec + 0.05, false)).toBe(false);
    const me = foe(1, 0, 0);
    const toMe = yawOf({ x: -20, z: 0 }); // from (20, 0) toward me
    expect(g.threat(5, me, foe(2, 20, 0, toMe), null, -Infinity)).toBe(true);
    expect(g.threat(5, me, foe(2, 20, 0, toMe + 40 * DEG), null, -Infinity)).toBe(false);
    expect(g.threat(5, me, foe(2, 20, 0, toMe + 40 * DEG), 2, 4)).toBe(true);
    expect(g.threat(5, me, { ...foe(2, 20, 0, toMe), equipped: 'fists' } as PlayerState, null, -Infinity)).toBe(false);
  });
});

describe('bot gaze in a match', () => {
  test('bots mostly look where they walk when not fighting, and still track who they shoot at', async () => {
    const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy'];
    const out = new Map<number, PlayerInput>();
    const bots = new Map<number, Bot>();
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed: 4 }, {
      makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return { think: (v) => { const i = b.think(v); out.set(id, i); return i; } }; },
    });
    // Ticks where the brain is on a 'fight' goal (an enemy in sight it chose to fight), and how many with eyes on the nearest enemy.
    let fightTicks = 0, fightOnFoe = 0;
    const tracks = new Map<number, GazeSample[]>(diffs.map((_, i) => [i + 1, []]));
    let snap = m.tick(new Map());
    for (let i = 0; i < 150 / DT && snap.winner === null; i++) {
      out.clear();
      snap = m.tick(new Map());
      const hit = new Map<number, number>();
      for (const e of snap.events) if (e.type === 'hit' && typeof e.data.by === 'number') hit.set(e.data.target as number, e.data.by);
      for (const p of snap.players) {
        const inp = out.get(p.id);
        const foes = snap.players.filter((q) => q.id !== p.id && q.alive);
        if (p.alive && inp && bots.get(p.id)?.currentGoal === 'fight' && foes.length) {
          const near = foes.reduce((a, q) => (Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) < Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) ? q : a));
          fightTicks++;
          if (Math.abs(wrapAngle(yawOf({ x: near.pos.x - p.pos.x, z: near.pos.z - p.pos.z }) - p.yaw)) < 20 * DEG) fightOnFoe++;
        }
        tracks.get(p.id)!.push({
          alive: p.alive && !!inp, yaw: p.yaw, fire: !!inp?.fire, hitBy: hit.get(p.id) ?? null,
          moveRel: inp && Math.hypot(inp.moveX, inp.moveZ) > 0.1 ? Math.atan2(inp.moveX, inp.moveZ) : null,
          foes: snap.players.filter((q) => q.id !== p.id && q.alive).map((q) => ({ id: q.id, yaw: yawOf({ x: q.pos.x - p.pos.x, z: q.pos.z - p.pos.z }), dist: Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) })),
        });
      }
    }
    m.dispose();
    const s = gazeStats([...tracks.values()], DT);
    // Before gaze.ts bots walked with the view on an enemy most of the time (calm walk ∥ view ≈ 30%; people ≈ 57%).
    expect(s.alignedCalm).toBeGreaterThan(0.5);
    // When they do fight, the eyes are on the enemy.
    expect(s.onFoeEngaged).toBeGreaterThan(0.7);
    // Deciding to fight turns the eyes onto the enemy at once (gaze never delays or softens an engagement).
    expect(fightTicks).toBeGreaterThan(30 / DT);
    expect(fightOnFoe / fightTicks).toBeGreaterThan(0.8);
  }, 120_000);
});
