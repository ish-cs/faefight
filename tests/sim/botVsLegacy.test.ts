import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { DEFAULT_PARAMS, HAND_PARAMS } from '../../src/sim/bots/params';
import { LIFECYCLE } from '../../src/sim/constants';
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

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

// Ship gates for a trained champion (heavy): SHIP_CHECK=1 npx vitest run tests/sim/botVsLegacy.test.ts
describe.runIf(env.SHIP_CHECK)('trained champion wins by sealing', () => {
  test('PRO champion vs hand-tuned PRO, 1v1 over 20 seeds: wins by seal/elimination before 15:00 in ≥ 30%', async () => {
    let sealWins = 0;
    const lines: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const champSeat = seed % 2 ? 1 : 2;
      const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'pro' }, { name: '', isBot: true, difficulty: 'pro' }], seed }, {
        makeBot: (id, d, rng) => new Bot(id, d, rng, undefined, id === champSeat ? DEFAULT_PARAMS : HAND_PARAMS),
      });
      let snap: Snapshot = m.tick(new Map());
      let sealedByChamp = false;
      for (let i = 0; i < LIFECYCLE.suddenDeathAt * 30 && snap.winner === null; i++) {
        snap = m.tick(new Map());
        for (const e of snap.events) if (e.type === 'sealed' && e.data.by === champSeat) sealedByChamp = true;
      }
      const won = snap.winner === champSeat && snap.time < LIFECYCLE.suddenDeathAt && sealedByChamp;
      if (won) sealWins++;
      lines.push(`seed ${seed}: ${snap.winner === champSeat ? 'champion' : snap.winner === null ? 'none yet' : 'hand'} at ${(snap.time / 60).toFixed(1)} min${won ? ' (by seal)' : ''}`);
    }
    console.log(`champion seal wins before sudden death: ${sealWins}/20\n  ${lines.join('\n  ')}`);
    expect(sealWins).toBeGreaterThanOrEqual(6);
  }, 900_000);
});

describe.runIf(env.SHIP_CHECK)('trained bots vs the pre-training bots', () => {
  test('new Hard beats old Hard in at least 80% of 1v1s (16 of 20)', async () => {
    expect(await newVsOld(Array.from({ length: 20 }, (_, i) => i + 1))).toBeGreaterThanOrEqual(16);
  }, 900_000);
});
