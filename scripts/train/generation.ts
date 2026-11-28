/**
 * One training generation: seat the candidates in FFAs against a mixed field (the current champion, the human proxy,
 * earlier champions from the hall of fame or the hand-tuned params), plus a few 1v1 duels against the human proxy,
 * score, and step the optimizer. Whole games alternate between the Hard and PRO tiers (run 7), so a candidate's
 * `*.hard` keys are judged in Hard games and its `*.pro` keys in PRO games. The human proxy always plays at PRO.
 */
import type { Difficulty } from '../../src/sim/types';
import { mulberry32, sample, update, type EsConfig, type EsState } from './es';
import { HAND_PARAMS, decode, type FlatParams } from './params';
import { proxyBonus, seatFitness, type MatchResult, type MatchSpec, type SeatSpec } from './runMatch';

export const DEFAULT_TIERS: Difficulty[] = ['pro', 'hard'];

export type TrainConfig = {
  es: EsConfig;
  /** Appearances per candidate per generation (FFAs). */
  games: number;
  /** Candidate seats per FFA (the rest is the field). */
  candSeats: number;
  players: number;
  maxSec: number;
  seed: number;
  /** 1v1s per generation against the human proxy (the endgame and the human-vs-bot case), and their weight. */
  duels?: number;
  duelWeight?: number;
  /** Human-proxy seats per FFA (taken from the field, after the champion seat); 0 = off. */
  proxySeats?: number;
  /** Tiers the games rotate through (default DEFAULT_TIERS). */
  tiers?: Difficulty[];
};

export type Runner = (specs: MatchSpec[]) => Promise<MatchResult[]>;

export type GenStats = {
  gen: number;
  games: number;
  /** Candidates' 1v1 win rate against the human proxy (null without duels). */
  duelWinRate: number | null;
  /** Share of FFA candidate seats placing above every proxy seat of their game (null without proxies). */
  beatProxy: number | null;
  /** Mean / best candidate fitness (relative to the field of their games). */
  meanFit: number;
  bestFit: number;
  /** Average raw fitness of the field by kind (champion, proxy, hall, hand). */
  field: Record<string, number>;
  decisive: number;
  avgMinutes: number;
  msPerTick: number;
  sigma: number;
};

type Field = 'champion' | 'proxy' | 'hall' | 'hand';
type Seat = { cand: number } | { field: Field };

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function runGeneration(
  st: EsState, champion: FlatParams, hall: FlatParams[], cfg: TrainConfig, run: Runner,
): Promise<{ next: EsState; stats: GenStats; candidates: FlatParams[]; fitness: number[] }> {
  const rng = mulberry32(cfg.seed * 7919 + st.gen * 104729);
  const xs = sample(st, rng, cfg.es);
  const cands = xs.map(decode);
  const lambda = xs.length;
  const fieldSeats = cfg.players - cfg.candSeats;
  const nProxy = cfg.proxySeats ?? 0;
  if (fieldSeats < 1) throw new Error(`train: ${cfg.candSeats} candidate seats leave no field seat in a ${cfg.players}-player game`);
  if (nProxy < 0 || nProxy > fieldSeats - 1) throw new Error(`train: proxySeats ${nProxy} must be 0..${fieldSeats - 1} (field ${fieldSeats} seats, one is the champion)`);
  if ((lambda * cfg.games) % cfg.candSeats) throw new Error(`train: λ×games (${lambda}×${cfg.games}) must divide into ${cfg.candSeats}-seat games`);
  // Every candidate appears `games` times, spread over games with different opponents.
  const pool = shuffle(Array.from({ length: lambda * cfg.games }, (_, i) => i % lambda), rng);
  const nGames = pool.length / cfg.candSeats;
  const plans: Seat[][] = [];
  for (let g = 0; g < nGames; g++) {
    const seats: Seat[] = pool.slice(g * cfg.candSeats, (g + 1) * cfg.candSeats).map((cand) => ({ cand }));
    for (let k = 0; k < fieldSeats; k++) seats.push({ field: k === 0 ? 'champion' : k <= nProxy ? 'proxy' : (k - nProxy) % 2 && hall.length ? 'hall' : 'hand' });
    plans.push(shuffle(seats, rng));
  }
  const nFfa = plans.length;
  for (let d = 0; d < (cfg.duels ?? 0); d++) {
    const c = (d + st.gen * 5) % lambda;
    plans.push(d % 2 ? [{ field: 'proxy' }, { cand: c }] : [{ cand: c }, { field: 'proxy' }]);
  }
  const hallPick = plans.map(() => (hall.length ? hall[Math.floor(rng() * hall.length)] : champion));
  const tiers: Difficulty[] = cfg.tiers?.length ? cfg.tiers : DEFAULT_TIERS;
  // FFAs alternate tiers game by game; duels by mirrored pair (so each tier gets both seat orders).
  const tierOf = (g: number): Difficulty => (g < nFfa ? tiers[g % tiers.length] : tiers[Math.floor((g - nFfa) / 2) % tiers.length]);
  const specs: MatchSpec[] = plans.map((seats, g) => ({
    seed: cfg.seed * 100003 + st.gen * 1009 + (g < nFfa ? g : 500 + Math.floor((g - nFfa) / 2)),
    maxSec: g < nFfa ? cfg.maxSec : Math.max(cfg.maxSec, 25 * 60),
    seats: seats.map((s): SeatSpec => {
      if ('cand' in s) return { kind: 'new', params: cands[s.cand], difficulty: tierOf(g) };
      if (s.field === 'proxy') return { kind: 'proxy' };
      const params = s.field === 'champion' ? champion : s.field === 'hall' ? hallPick[g] : HAND_PARAMS;
      return { kind: 'new', params, difficulty: tierOf(g) };
    }),
  }));
  const results = await run(specs);
  if (results.length !== specs.length) throw new Error(`train: runner returned ${results.length} results for ${specs.length} games`);
  const sum = new Array<number>(lambda).fill(0), cnt = new Array<number>(lambda).fill(0);
  const fsum: Record<string, number> = {}, fcnt: Record<string, number> = {};
  let duelWins = 0, duels = 0, beat = 0, beatN = 0;
  const proxiesOf = plans.map((seats) => seats.flatMap((s, i) => ('field' in s && s.field === 'proxy' ? [i] : [])));
  // Control variate: a candidate is scored against the field seats of the same game, so game-level luck
  // (a sudden-death game, a seal-rich map) cancels instead of swamping the signal.
  const fieldMean = results.map((r, g) => {
    const fs = plans[g].flatMap((s, seat) => ('cand' in s ? [] : [seatFitness(r, seat, specs[g].maxSec)]));
    return fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : 0;
  });
  results.forEach((r, g) => plans[g].forEach((s, seat) => {
    const duel = g >= nFfa;
    const w = duel ? (cfg.duelWeight ?? 1) : 1;
    const f = seatFitness(r, seat, specs[g].maxSec);
    if ('cand' in s) {
      sum[s.cand] += w * (f + proxyBonus(r, seat, proxiesOf[g]) - fieldMean[g]); cnt[s.cand] += w;
      if (duel) { duels++; if (r.winner === seat + 1) duelWins++; }
      else if (proxiesOf[g].length) { beatN++; if (proxiesOf[g].every((p) => r.seats[seat].place < r.seats[p].place)) beat++; }
    } else if (!duel) { fsum[s.field] = (fsum[s.field] ?? 0) + f; fcnt[s.field] = (fcnt[s.field] ?? 0) + 1; }
  }));
  const ffa = results.slice(0, nFfa);
  const fitness = sum.map((s, i) => {
    if (!cnt[i]) throw new Error(`train: candidate ${i} played no games`);
    return s / cnt[i];
  });
  const next = update(st, xs, fitness, cfg.es);
  const field: Record<string, number> = {};
  for (const k of Object.keys(fsum)) field[k] = fsum[k] / fcnt[k];
  const stats: GenStats = {
    gen: st.gen,
    games: results.length,
    duelWinRate: duels ? duelWins / duels : null,
    beatProxy: beatN ? beat / beatN : null,
    meanFit: fitness.reduce((a, b) => a + b, 0) / lambda,
    bestFit: Math.max(...fitness),
    field,
    decisive: ffa.filter((r) => r.decisive).length / Math.max(1, ffa.length),
    avgMinutes: ffa.reduce((a, r) => a + r.time, 0) / Math.max(1, ffa.length) / 60,
    msPerTick: ffa.reduce((a, r) => a + r.msPerTick, 0) / Math.max(1, ffa.length),
    sigma: next.sigma.reduce((a, b) => a + b, 0) / next.sigma.length,
  };
  return { next, stats, candidates: cands, fitness };
}

/**
 * Head-to-head check: `a` in half the seats, `b` in the other half (alternating so seat/island bias cancels).
 * Returns a's share of the wins (draws count half) and both sides' mean fitness.
 */
export async function headToHead(a: SeatSpec, b: SeatSpec, seeds: number[], players: number, maxSec: number, run: Runner) {
  // Each seed is played twice with the seats mirrored, so map/seat luck cancels.
  const specs: MatchSpec[] = seeds.flatMap((seed) => [0, 1].map((flip) => ({
    seed, maxSec, seats: Array.from({ length: players }, (_, i) => ((i + flip) % 2 === 0 ? a : b)),
  })));
  const results = await run(specs);
  let fitA = 0, fitB = 0, nA = 0, nB = 0;
  const scores: number[] = [];
  results.forEach((r, k) => {
    const isA = (seat: number) => (seat + (k % 2)) % 2 === 0;
    scores.push(r.winner === null ? 0.5 : isA(r.winner - 1) ? 1 : 0);
    r.seats.forEach((_, seat) => {
      const f = seatFitness(r, seat, maxSec);
      if (isA(seat)) { fitA += f; nA++; } else { fitB += f; nB++; }
    });
  });
  const share = scores.reduce((x, y) => x + y, 0) / scores.length;
  return { share, ci95: ci95(scores), fitA: fitA / nA, fitB: fitB / nB, results, decisive: results.filter((r) => r.decisive).length };
}

/** Half-width of the 95% confidence interval of a mean of per-game scores (normal approximation). */
export function ci95(xs: number[]): number {
  if (xs.length < 2) return 1;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return 1.96 * Math.sqrt(v / xs.length);
}
