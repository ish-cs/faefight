import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import type { Difficulty } from '../../src/sim/types';

/**
 * Bots under real recoil (the sim climbs the shooter's aim each shot, gunplay.recoilKick) still shoot like
 * humans of their skill: they compensate and burst at range (params.ts gunSkill), so a PRO lands a sane share of
 * its bullets and out-hits a Hard, and nobody turns into an aimbot.
 */
const D: Difficulty[] = ['pro', 'hard', 'medium', 'easy'];

async function hitRates(seed: number, minutes: number) {
  const m = await Match.create({ players: D.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  let snap = m.tick(new Map());
  const skill = new Map(snap.players.map((p, i) => [p.id, D[i]]));
  const shots = new Map<Difficulty, number>(), hits = new Map<Difficulty, number>();
  const add = (mp: Map<Difficulty, number>, d: Difficulty) => mp.set(d, (mp.get(d) ?? 0) + 1);
  for (let i = 0; i < 30 * 60 * minutes && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) {
      const w = e.data.weapon;
      if (w !== 'pistol' && w !== 'smg' && w !== 'rifle') continue; // bullets only (no fists, rockets, shotgun pellets)
      const by = skill.get(e.data.by as number);
      if (!by) continue;
      if (e.type === 'shot') add(shots, by);
      if (e.type === 'hit' && e.data.target !== e.data.by) add(hits, by);
    }
  }
  return { shots, hits };
}

describe('bot hit rate under recoil', () => {
  test('pooled over seeds 1-4: PRO lands a human-pro share, beats Hard, and is no aimbot; easy misses most', async () => {
    // Coordinator's definition (one for every branch, like botBuild): pooled over seeds 1-4. A single 6-minute match
    // flipped on one hit (0.701 vs 0.70) while 15 seeds pooled sat at 0.53.
    const shots = new Map<Difficulty, number>(), hits = new Map<Difficulty, number>();
    for (const seed of [1, 2, 3, 4]) {
      const g = await hitRates(seed, 6);
      for (const d of D) { shots.set(d, (shots.get(d) ?? 0) + (g.shots.get(d) ?? 0)); hits.set(d, (hits.get(d) ?? 0) + (g.hits.get(d) ?? 0)); }
    }
    const r = (d: Difficulty) => ({ shots: shots.get(d) ?? 0, rate: (hits.get(d) ?? 0) / Math.max(1, shots.get(d) ?? 0) });
    const pro = r('pro'), hard = r('hard'), easy = r('easy');
    console.log(`hit rate: pro ${pro.rate.toFixed(2)} (${pro.shots}) hard ${hard.rate.toFixed(2)} (${hard.shots}) easy ${easy.rate.toFixed(2)} (${easy.shots})`);
    expect(pro.shots).toBeGreaterThan(50);
    expect(pro.rate).toBeGreaterThan(0.15);
    expect(pro.rate).toBeLessThan(0.7);
    expect(pro.rate).toBeGreaterThan(hard.rate);
    expect(easy.rate).toBeLessThan(pro.rate);
  }, 1_800_000);
});
