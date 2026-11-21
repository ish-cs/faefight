import { describe, expect, test } from 'vitest';
import { Bot, type Goal } from '../../src/sim/bots/bot';
import { BRAIN_DIGEST_BUDGET, digestBytes, type BrainDigest, type BrainProbe } from '../../src/sim/bots/introspect';
import { TICK_HZ } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const ALL_GOALS: Goal[] = [
  'storm', 'defend', 'disengage', 'fight', 'guard', 'bank', 'seal', 'attack', 'cut', 'raid', 'loot', 'bridge',
  'shop', 'heal', 'contest', 'collect', 'cover', 'fortify', 'assist',
];

/** Everything that matters about where a match got to. */
function fingerprint(s: Snapshot): string {
  return JSON.stringify({
    t: s.tick, w: s.winner, sealed: s.sealed, gen: s.generators,
    p: s.players.map((p) => [p.id, p.alive, p.eliminated, p.hp, p.shield, p.pos, p.yaw, p.pitch, p.inv, p.vault, p.kills]),
    pieces: s.pieces.map((p) => [p.id, p.kind, p.pos, p.hp]),
  });
}

type Run = { fp: string[]; digests: BrainDigest[]; bots: Map<number, Bot> };

/** `inspect`: spectate every bot (probe on, a digest every few ticks) — or none. */
async function run(diffs: Difficulty[], seed: number, seconds: number, inspect: boolean): Promise<Run> {
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  const fp: string[] = [];
  const digests: BrainDigest[] = [];
  let snap = m.tick(new Map());
  for (let i = 0; i < seconds * TICK_HZ && snap.winner === null; i++) {
    snap = m.tick(new Map());
    if (inspect && i % (TICK_HZ / 4) === 0) for (const b of bots.values()) digests.push(b.debugBrain());
    if (i % TICK_HZ === 0) fp.push(fingerprint(snap));
  }
  fp.push(fingerprint(snap));
  return { fp, digests, bots };
}

describe('bot brain introspection', () => {
  test('inspecting bots never changes the match: same seed with and without debugBrain() is identical', async () => {
    const diffs: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
    for (const seed of [3, 11]) {
      const plain = await run(diffs, seed, 150, false);
      const watched = await run(diffs, seed, 150, true);
      expect(watched.digests.length).toBeGreaterThan(100);
      const first = plain.fp.findIndex((f, i) => f !== watched.fp[i]);
      expect(first, `seed ${seed}: diverged at second ${first}`).toBe(-1);
      expect(watched.fp.length).toBe(plain.fp.length);
    }
  }, 240_000);

  test('a reason for every goal type, factors that add up to the score, and a populated digest', async () => {
    const r = await run(['medium', 'hard', 'pro', 'easy'], 5, 120, true);
    // Every decision explains every goal (why it's worth doing, or why it scores nothing).
    const explainedGoals = new Set<Goal>();
    for (const b of r.bots.values()) {
      const probe = (b as unknown as { probe: BrainProbe }).probe;
      expect(probe.rows?.length ?? ALL_GOALS.length).toBe(ALL_GOALS.length);
      for (const [g, e] of probe.explained) {
        expect(e.why, `${g} has no reason`).toMatch(/\S{3,}/);
        explainedGoals.add(g);
      }
    }
    expect([...explainedGoals].sort()).toEqual([...ALL_GOALS].sort());

    let other = 0, rows = 0, zeros = 0, gated = 0;
    const chosen = new Set<Goal>();
    for (const d of r.digests) {
      for (const [goal, score, base, f, gate] of d.scores) {
        // The breakdown is exact: factors (incl. noise/sticky/other) sum to the score.
        const sum = f.reduce((a, [, v]) => a + v, 0);
        expect(Math.abs(sum - score), `${goal}: ${JSON.stringify(f)} vs ${score}`).toBeLessThan(0.05);
        if (base > 0) { rows++; if (f.some(([k]) => k === 'other')) other++; }
        if (base <= 0 && f.length === 0) { zeros++; if (gate) gated++; }
      }
      if (d.scores.length) { chosen.add(d.goal); expect(d.why, `${d.goal}: no reason`).not.toBe(''); }
      expect(d.step).not.toBe('');
      expect(d.traits).toHaveLength(8);
    }
    // introspect.ts mirrors Bot.score term by term: drift shows up as an 'other' factor. If this fails, Bot.score
    // changed: update explain() in src/sim/bots/introspect.ts.
    expect(other / Math.max(1, rows), `'other' in ${other}/${rows} scored rows`).toBeLessThan(0.1);
    expect(chosen.size).toBeGreaterThanOrEqual(4);
    // Goals at 0 say why ("no storm yet", "no scaffolds"), unless a digest had to drop that to fit the budget.
    expect(gated / Math.max(1, zeros), `${gated}/${zeros} zero rows with a reason`).toBeGreaterThan(0.8);
    // Perception, log, plans and state get filled in over a match.
    expect(r.digests.some((d) => d.log.length > 0)).toBe(true);
    expect(r.digests.some((d) => d.seen.length > 0)).toBe(true);
    expect(r.digests.some((d) => d.target !== null)).toBe(true);
    expect(r.digests.some((d) => d.shop !== null)).toBe(true);
    expect(r.digests.some((d) => d.path.length > 1)).toBe(true);
    expect(r.digests.some((d) => d.build !== null)).toBe(true);
    expect(r.digests.every((d) => d.plan.length > 0)).toBe(true);
  }, 120_000);

  test('the goal-switch log reads in plain English, newest first, capped at 10', async () => {
    const r = await run(['hard', 'medium', 'easy', 'pro'], 9, 120, true);
    const d = r.digests.filter((x) => x.log.length).at(-1)!;
    expect(d.log.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < d.log.length; i++) expect(d.log[i - 1][0]).toBeGreaterThanOrEqual(d.log[i][0]);
    for (const [, from, to, why] of d.log) { expect(from).not.toBe(to); expect(why.length).toBeGreaterThan(5); }
    // Seal reasons name the rival, why now, and the kit: "Sealing @3's bunker: … I carry 2 walls for 2 doors".
    const seal = r.digests.find((x) => x.goal === 'seal' && x.why.startsWith('Sealing'));
    if (seal) expect(seal.why).toMatch(/^Sealing @\d+'s bunker: .+, I carry \d+ walls? for \d+ doors?$/);
  }, 120_000);

  test('digests stay within the network budget (8 bots, whole match)', async () => {
    const r = await run(['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'], 21, 240, true);
    const sizes = r.digests.map(digestBytes);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(BRAIN_DIGEST_BUDGET);
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    console.info(`brain digest: avg ${avg.toFixed(0)} B, max ${Math.max(...sizes)} B (budget ${BRAIN_DIGEST_BUDGET} B; ×4 Hz)`);
  }, 240_000);
});
