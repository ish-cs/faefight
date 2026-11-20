import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { Match } from '../../src/sim/match';
import type { Snapshot } from '../../src/sim/types';
import { Bot as LegacyBot } from '../fixtures/legacyBots/bot';

const LIMIT = 25 * 60 * 30;

/**
 * Trained Hard vs the frozen pre-training Hard (tests/fixtures/legacyBots: same skill, old strategy/tactics),
 * 1v1, seats alternating by seed. Returns the new bot's wins.
 */
async function newVsOld(seeds: number[]) {
  let wins = 0;
  const lines: string[] = [];
  for (const seed of seeds) {
    const newSeat = seed % 2 ? 1 : 2;
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'hard' }, { name: '', isBot: true, difficulty: 'hard' }], seed }, {
      makeBot: (id, d, rng) => (id === newSeat ? new Bot(id, d, rng) : new LegacyBot(id, d, rng)),
    });
    let snap: Snapshot = m.tick(new Map());
    for (let i = 0; i < LIMIT && snap.winner === null; i++) snap = m.tick(new Map());
    if (snap.winner === newSeat) wins++;
    lines.push(`seed ${seed}: ${snap.winner === newSeat ? 'new' : snap.winner === null || snap.winner < 0 ? 'draw' : 'old'} at ${(snap.time / 60).toFixed(1)} min`);
  }
  console.log(`new hard vs old hard: ${wins}/${seeds.length}\n  ${lines.join('\n  ')}`);
  return wins;
}

describe('trained bots vs the pre-training bots', () => {
  test('new Hard beats old Hard in at least 80% of 1v1s (16 of 20)', async () => {
    expect(await newVsOld(Array.from({ length: 20 }, (_, i) => i + 1))).toBeGreaterThanOrEqual(16);
  }, 900_000);
});
