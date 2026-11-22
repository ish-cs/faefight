import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const LIMIT = 25 * 60 * 30;

type Use = { buys: number; fire: number; latch: number; yank: number; miss: number };

/** One bot match to the end; per-phase counts of every grappling hook event, and hooks bought. */
async function play(diffs: Difficulty[], seed: number) {
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  const use: Use = { buys: 0, fire: 0, latch: 0, yank: 0, miss: 0 };
  let snap: Snapshot = m.tick(new Map());
  const had = new Map<number, number>();
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) if (e.type === 'grapple' && String(e.data.phase) in use) use[String(e.data.phase) as keyof Use]++;
    for (const p of snap.players) {
      const n = p.inv.grapples ?? 0, before = had.get(p.id) ?? 0;
      if (n > before && p.alive) use.buys++;
      had.set(p.id, n);
    }
  }
  m.dispose();
  return { use, winner: snap.winner, min: snap.time / 60 };
}

describe('bots and the grappling hook', () => {
  test('bots buy hooks and use them (cross / escape / yank) in most games', async () => {
    const games: { diffs: Difficulty[]; seed: number }[] = [
      { diffs: ['pro', 'hard'], seed: 1 }, { diffs: ['hard', 'medium'], seed: 2 }, { diffs: ['pro', 'medium'], seed: 3 },
      { diffs: ['hard', 'pro', 'medium', 'hard'], seed: 4 }, { diffs: ['pro', 'hard', 'hard', 'medium'], seed: 5 },
      { diffs: ['medium', 'hard'], seed: 6 },
    ];
    let used = 0;
    const lines: string[] = [];
    for (const g of games) {
      const r = await play(g.diffs, g.seed);
      const latched = r.use.latch + r.use.yank;
      if (latched > 0) used++;
      lines.push(`seed ${g.seed} ${g.diffs.join('/')}: ${JSON.stringify(r.use)} winner ${r.winner} at ${r.min.toFixed(1)} min`);
    }
    console.log(`grappling hook use:\n  ${lines.join('\n  ')}`);
    expect(used).toBeGreaterThanOrEqual(Math.ceil(games.length * 0.6));
  }, 900_000);
});
