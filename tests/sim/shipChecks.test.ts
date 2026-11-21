/**
 * Hard checks a trained champion must pass before it ships as the default params (heavy: run with
 * SHIP_CHECK=1 npx vitest run tests/sim/shipChecks.test.ts, under the heavy-test lock).
 * The champion = src/sim/bots/trained-params.json; baselines = hand-tuned params and the run-2 champion.
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_PARAMS, HAND_PARAMS, sanitize } from '../../src/sim/bots/params';
import { LIFECYCLE } from '../../src/sim/constants';
import { ci95 } from '../../scripts/train/generation';
import { median, runMatch, type MatchResult, type SeatSpec } from '../../scripts/train/runMatch';
import run2 from '../fixtures/run2-params.json';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const champ: SeatSpec = { kind: 'new', params: DEFAULT_PARAMS, difficulty: 'pro' };
const hand: SeatSpec = { kind: 'new', params: HAND_PARAMS, difficulty: 'pro' };
const old: SeatSpec = { kind: 'new', params: sanitize((run2 as { params: Record<string, number> }).params), difficulty: 'pro' };

async function duels(a: SeatSpec, b: SeatSpec, games: number) {
  const out: { r: MatchResult; aSeat: number }[] = [];
  for (let k = 0; k < games; k++) {
    const aSeat = k % 2;
    const r = await runMatch({ seed: 7000 + Math.floor(k / 2), maxSec: LIFECYCLE.suddenDeathAt + 120, seats: aSeat ? [b, a] : [a, b] });
    out.push({ r, aSeat });
  }
  return out;
}

const homeShare = (rs: { r: MatchResult; aSeat: number }[]) =>
  rs.reduce((n, { r, aSeat }) => n + r.seats[aSeat].idleHome / Math.max(1, r.seats[aSeat].survived), 0) / rs.length;
const engage = (rs: { r: MatchResult; aSeat: number }[]) => median(rs.flatMap(({ r, aSeat }) => r.seats[aSeat].hitDists));

describe.runIf(env.SHIP_CHECK)('ship checks for a trained champion', () => {
  test('1v1 vs hand-tuned over 100 games: share ≥ 60% with the 95% CI above 50%; ≥ 30% won by seal before 15:00; closer fights and less time at home than run 2', async () => {
    const rs = await duels(champ, hand, 100);
    const scores: number[] = rs.map(({ r, aSeat }) => (r.winner === null ? 0.5 : r.winner === aSeat + 1 ? 1 : 0));
    const share = scores.reduce((a, b) => a + b, 0) / scores.length, ci = ci95(scores);
    const sealWins = rs.filter(({ r, aSeat }) => r.winner === aSeat + 1 && r.decisive && r.seats[aSeat].seals > 0).length;
    const base = await duels(old, hand, 100);
    console.log(`champion vs hand: ${(100 * share).toFixed(0)}% ± ${(100 * ci).toFixed(0)} · seal wins before SD ${sealWins}/100 · ` +
      `engagement median ${engage(rs)} m (run 2: ${engage(base)} m) · home share ${(100 * homeShare(rs)).toFixed(0)}% (run 2: ${(100 * homeShare(base)).toFixed(0)}%)`);
    expect(share).toBeGreaterThanOrEqual(0.6);
    expect(share - ci).toBeGreaterThan(0.5);
    expect(sealWins).toBeGreaterThanOrEqual(30);
    expect(engage(rs)).toBeLessThan(engage(base));
    expect(homeShare(rs)).toBeLessThan(homeShare(base));
  }, 3_600_000);

  test('8-bot PRO FFAs mostly finish before sudden death, and nobody sits at home geared for over 60 s', async () => {
    let decisive = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = await runMatch({ seed: 8100 + seed, maxSec: LIFECYCLE.suddenDeathAt + 180, seats: Array(8).fill(champ) });
      if (r.decisive) decisive++;
      for (const s of r.seats) expect(s.longestHomeIdle ?? 0).toBeLessThanOrEqual(60);
    }
    console.log(`8-bot FFAs decisive before sudden death: ${decisive}/6`);
    expect(decisive).toBeGreaterThanOrEqual(4);
  }, 3_600_000);

  test('skill tiers stay ordered: medium beats easy, hard beats medium, PRO beats hard (1v1, 20 games each)', async () => {
    for (const [hi, lo] of [['medium', 'easy'], ['hard', 'medium'], ['pro', 'hard']] as const) {
      const rs = await duels({ kind: 'new', params: DEFAULT_PARAMS, difficulty: hi }, { kind: 'new', params: DEFAULT_PARAMS, difficulty: lo }, 20);
      const wins = rs.filter(({ r, aSeat }) => r.winner === aSeat + 1).length;
      console.log(`${hi} vs ${lo}: ${wins}/20`);
      expect(wins).toBeGreaterThanOrEqual(13);
    }
  }, 3_600_000);
});
