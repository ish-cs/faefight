import { expect } from 'vitest';
import { LIFECYCLE } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

/**
 * Whole 8-bot mixed matches up to sudden death: unexplained water deaths (no hit in the 4 s before, no deck shot out
 * under them, no storm). Used by botDrown.test.ts (seeds 1–3) and botDrownB.test.ts (seeds 4–6).
 *
 * Was: medium 3, medium 7, mixed 2, exactly 0 allowed; it failed 5 times on unrelated branches, a different seed each
 * time. Main (0974cc78) over 56 matches (32 mixed, 24 all-medium, ci/seedstats-measure): 2 unexplained deaths
 * (mixed seeds 15 and 18, both at ~720 s), 0 in seeds 1–8. Rate 2/56 = 0.036 per match → 3 matches expect 0.11;
 * allowing ≤ 1 per 3 matches, an unchanged rate fails ~0.5% of the time (~4% at the rate's 95% upper bound,
 * 0.11/match). The old bug was 10+ per match. Whole matches because both deaths came late; DROWN_SEEDS=1-10 widens it.
 */
export async function drownMatches(seeds: number[]) {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  if (env.DROWN_SEEDS) {
    const [a, b] = env.DROWN_SEEDS.split('-').map(Number);
    seeds = Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
  }
  const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];
  const unexplained: string[] = [];
  for (const seed of seeds) {
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
    let snap: Snapshot = m.tick(new Map());
    const lastHurt = new Map<number, number>();
    const lastPos = new Map<number, { x: number; z: number }>();
    const lost: { t: number; x: number; z: number }[] = [];
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
        if (e.t - (lastHurt.get(v) ?? -Infinity) > 4 && !cut) unexplained.push(`seed ${seed} #${v} (${diffs[v - 1]}) at ${e.t.toFixed(0)} s`);
      }
    }
    m.dispose();
  }
  console.log(`unexplained water deaths over seeds ${seeds.join(',')}: ${unexplained.length ? unexplained.join(', ') : 'none'}`);
  expect(unexplained.length, unexplained.join(', ')).toBeLessThanOrEqual(Math.ceil(seeds.length / 3));
}
