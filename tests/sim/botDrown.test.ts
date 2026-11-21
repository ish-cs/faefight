import { describe, expect, test } from 'vitest';
import { LIFECYCLE } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * Bots used to drown 10-13 times a match (medium) without anyone touching them: stuck-recovery hops sideways off
 * decks and island rims, and standing on a rim with nothing under the centre. A water death with no hit in the
 * 4 s before it, no deck shot out under them and no storm is unexplained. DROWN_SEEDS=1-10 widens the sweep.
 */
const cases: [Difficulty | 'mixed', number][] = (env.DROWN_SEEDS ?? '').length
  ? (env.DROWN_SEEDS as string).split(',').flatMap((r) => {
    const [a, b] = r.split('-').map(Number);
    return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => [['medium', 'hard', 'mixed'][i % 3] as Difficulty | 'mixed', a + i] as [Difficulty | 'mixed', number]);
  })
  : [['medium', 3], ['medium', 7], ['mixed', 2]];

describe('bots stay out of the water', () => {
  test.each(cases)('8 %s bots, seed %i: no unexplained water deaths before sudden death', async (kind, seed) => {
    const mix: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];
    const diffs = kind === 'mixed' ? mix : Array<Difficulty>(8).fill(kind);
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
    let snap: Snapshot = m.tick(new Map());
    const lastHurt = new Map<number, number>();
    const lastPos = new Map<number, { x: number; z: number }>();
    const lost: { t: number; x: number; z: number }[] = [];
    const unexplained: string[] = [];
    for (let i = 0; i < 30 * LIFECYCLE.suddenDeathAt && snap.winner === null; i++) {
      for (const p of snap.players) if (p.alive) lastPos.set(p.id, { x: p.pos.x, z: p.pos.z });
      snap = m.tick(new Map());
      for (const e of snap.events) {
        if (e.type === 'hit') lastHurt.set(e.data.target as number, e.t);
        // A deck shot out (or collapsing) under someone drops them in the water: that's the shooter's doing.
        if (e.type === 'destroyed') { const q = e.data.pos as { x: number; z: number }; lost.push({ t: e.t, x: q.x, z: q.z }); }
        if (e.type !== 'kill' || !e.data.inWater || e.data.killer != null || e.data.cause) continue;
        const v = e.data.victim as number, at = lastPos.get(v);
        const cut = !!at && lost.some((q) => e.t - q.t < 4 && Math.hypot(q.x - at.x, q.z - at.z) < 6);
        if (e.t - (lastHurt.get(v) ?? -Infinity) > 4 && !cut) unexplained.push(`#${v} (${diffs[v - 1]}) at ${e.t.toFixed(0)} s`);
      }
    }
    expect(unexplained, unexplained.join(', ')).toEqual([]);
  }, 300_000);
});
