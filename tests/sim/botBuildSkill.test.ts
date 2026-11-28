import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { ARCHETYPES, preset } from '../../src/sim/bots/personality';
import { Match } from '../../src/sim/match';
import type { Difficulty } from '../../src/sim/types';

/**
 * Skill shows in how much bots build: 8-bot mixed FFA (PRO, Hard, Medium, Easy twice), seeds 1–16, pieces placed
 * (not bridge decks) in the first 6 minutes, summed by tier.
 *
 * Was: seeds 2–7, full matches, random archetypes, PRO ≥ 2× Easy (main +13% over the line; a random archetype draw
 * moved it more than any behaviour did). Now the archetypes are fixed and balanced across tiers (seats 1–4 one
 * archetype, seats 5–8 another, rotating with the seed), so the ratio measures skill, not who rolled Turtle.
 *
 * Thresholds from main (0974cc78) over seeds 1–32 (ci/seedstats-measure): pooled ratio R = Σtier/Σeasy and its per-seed
 * spread v (ratio estimator, v = var(tierᵢ − R·easyᵢ)/mean(easy)²); floor = R − 2·sqrt(v/16 + v/32), i.e. a fresh draw of
 * 16 matches with the real gap unchanged falls under it ~2.3% of the time.
 *   PRO/Easy   R 2.79 → floor 1.60   (main seeds 1–16: 186/63 = 2.95)
 *   Hard/Easy  R 3.62 → floor 1.80   (188/63 = 2.98)
 * 6 minutes, not whole matches: 16 full 8-bot matches take ~50 CI minutes; the gap is already clear by 6 min
 * (full matches: PRO/Easy 5.1, floor 2.6 — same verdict, 4× the cost).
 */
const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
const MIN = 6;

describe('skill shows in how much bots build', () => {
  test(`mixed 8-bot FFA, seeds 1–16, first ${MIN} min, fixed archetypes: PRO ≥ 1.6× Easy, Hard ≥ 1.8× Easy`, async () => {
    const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];
    const counts: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0, pro: 0 };
    const lines: string[] = [];
    for (const seed of SEEDS) {
      const A = ARCHETYPES[seed % ARCHETYPES.length], B = ARCHETYPES[(seed + 2) % ARCHETYPES.length];
      const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
        { makeBot: (id, d, rng) => new Bot(id, d, rng, preset(id <= 4 ? A : B)) });
      let snap = m.tick(new Map());
      const per: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0, pro: 0 };
      for (let i = 0; i < MIN * 60 * 30 && snap.winner === null; i++) {
        snap = m.tick(new Map());
        for (const e of snap.events) if (e.type === 'placed' && e.data.kind !== 'scaffold') per[diffs[(e.data.by as number) - 1]]++;
      }
      m.dispose();
      for (const d of diffs.slice(0, 4)) counts[d] += per[d];
      lines.push(`seed ${seed} (${A}/${B}): ${JSON.stringify(per)}`);
    }
    console.log([...lines, `by skill: ${JSON.stringify(counts)}, PRO/Easy ${(counts.pro / counts.easy).toFixed(2)}, Hard/Easy ${(counts.hard / counts.easy).toFixed(2)}`].join('\n'));
    expect(counts.pro).toBeGreaterThanOrEqual(1.6 * counts.easy);
    expect(counts.hard).toBeGreaterThanOrEqual(1.8 * counts.easy);
  }, 1_500_000);
});
