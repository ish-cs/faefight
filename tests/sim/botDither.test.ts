import { expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { Match } from '../../src/sim/match';
import type { Snapshot } from '../../src/sim/types';

/**
 * ffa8-pro seed 20 (scripts/ci/measure.ts rules): PRO #1, down to 9 hp at its bunker door, backed off every time a
 * rival showed up 45-60 m across the water (one that had stopped shooting) and went back to collecting when it was
 * out of sight: 65 s of pacing at home. Low on health it should back off from a real threat only.
 */
test('ffa8-pro seed 20: a low bot at its door does not pace between its errand and backing off from a far rival', async () => {
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: Array.from({ length: 8 }, () => ({ name: '', isBot: true, difficulty: 'pro' as const })), seed: 20 },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  const SEAT = 1, SAMPLE = 15, dt = SAMPLE / 30;
  let snap: Snapshot = m.tick(new Map());
  let streak = 0, longest = 0;
  for (let i = 0; i < 30 * 420 && snap.winner === null; i++) {
    snap = m.tick(new Map());
    if (i % SAMPLE) continue;
    const p = snap.players[SEAT - 1];
    if (!p.alive || p.breakoutUntil !== null) { streak = 0; continue; }
    const b = m.map[p.island].bunker.center;
    const nearBunker = snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - b.x, o.pos.z - b.z) < 30);
    const armed = Object.keys(p.inv.weapons).length > 0 && p.inv.cash + p.vault.cash > 0;
    const sitting = armed && !nearBunker && !snap.sealed[p.island] && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= 6;
    streak = sitting ? streak + dt : 0;
    longest = Math.max(longest, streak);
  }
  expect(bots.size).toBe(8);
  expect(longest).toBeLessThan(45);
}, 300_000);
