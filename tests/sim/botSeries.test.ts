import { describe, expect, test } from 'vitest';
import { insideBunker } from '../../src/sim/bots/nav';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const LIMIT = 25 * 60 * 30;

/** 1v1 between two bot skill levels; seats alternate by seed so island/seat bias cancels. Returns `a`'s wins. */
async function series(a: Difficulty, b: Difficulty, seeds: number[]) {
  let wins = 0;
  const lines: string[] = [];
  for (const seed of seeds) {
    const aSeat = seed % 2 ? 1 : 2;
    const diffs: Difficulty[] = aSeat === 1 ? [a, b] : [b, a];
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
    let snap: Snapshot = m.tick(new Map());
    for (let i = 0; i < LIMIT && snap.winner === null; i++) snap = m.tick(new Map());
    if (snap.winner === aSeat) wins++;
    lines.push(`seed ${seed}: ${snap.winner === aSeat ? a : b} wins at ${(snap.time / 60).toFixed(1)} min`);
  }
  console.log(`${a} vs ${b}: ${wins}/${seeds.length}\n  ${lines.join('\n  ')}`);
  return wins;
}

/** 20 seeds (≥ 14 wins = the 7-of-10 bar with less luck in it: single 1v1s swing on one early kill). */
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

describe('skill ladder (1v1 series)', () => {
  test('PRO beats hard in at least 70% (14 of 20)', async () => {
    expect(await series('pro', 'hard', SEEDS)).toBeGreaterThanOrEqual(14);
  }, 600_000);

  test('hard beats medium in at least 70% (14 of 20)', async () => {
    expect(await series('hard', 'medium', SEEDS)).toBeGreaterThanOrEqual(14);
  }, 600_000);

  test('bots do not hang around inside their own bunker (sealing it would trap them)', async () => {
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'pro' }, { name: '', isBot: true, difficulty: 'hard' }], seed: 4 });
    let snap = m.tick(new Map());
    let alive = 0, near = 0;
    const spawnedAt = new Map<number, number>();
    for (let i = 0; i < 3 * 60 * 30 && snap.winner === null; i++) {
      snap = m.tick(new Map());
      for (const p of snap.players) {
        if (!p.alive) { spawnedAt.delete(p.id); continue; }
        if (!spawnedAt.has(p.id)) spawnedAt.set(p.id, snap.time);
        // Walking out after a respawn, or breaking out of a sealed bunker, is what being in there is for.
        if (snap.time - spawnedAt.get(p.id)! < 3 || p.breakoutUntil !== null) continue;
        alive++;
        if (insideBunker(m.map[p.island].bunker, p.pos)) near++;
      }
    }
    console.log(`time inside own bunker: ${((100 * near) / alive).toFixed(1)}%`);
    expect(near / alive).toBeLessThan(0.03);
  }, 300_000);
});
