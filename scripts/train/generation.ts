/**
 * One training generation: seat the candidates in 8-bot FFAs against a mixed field (the current champion,
 * earlier champions from the hall of fame, and the frozen pre-training bot), score, and step the optimizer.
 * Everyone plays at PRO skill so fitness measures strategy, not aim luck.
 */
import { decode, encode, type BotParams } from '../../src/sim/bots/params';
import { mulberry32, sample, update, type EsConfig, type EsState } from './es';
import { imitationPenalty, seatStats, type HumanTarget } from './hooks';
import { seatFitness, type MatchResult, type MatchSpec, type SeatSpec } from './runMatch';

export type TrainConfig = {
  es: EsConfig;
  /** Appearances per candidate per generation. */
  games: number;
  /** Candidate seats per 8-seat game (the rest is the opponent field). */
  candSeats: number;
  players: number;
  maxSec: number;
  seed: number;
  /** 1v1s per generation against the frozen pre-training bot (the endgame and the human-vs-bot case), and their weight. */
  duels?: number;
  duelWeight?: number;
  /** Optional: pull play statistics toward human data (fitness −= weight × imitation penalty). */
  imitation?: { weight: number; target: HumanTarget };
};

export type Runner = (specs: MatchSpec[]) => Promise<MatchResult[]>;

export type GenStats = {
  gen: number;
  games: number;
  /** Candidates' 1v1 win rate against the old bot (null without duels). */
  duelWinRate: number | null;
  /** Mean / best candidate fitness. */
  meanFit: number;
  bestFit: number;
  /** Average fitness of the opponent field by kind (champion, hall of fame, legacy). */
  field: Record<string, number>;
  decisive: number;
  avgMinutes: number;
  msPerTick: number;
  sigma: number;
};

type Seat = { cand: number } | { field: 'champion' | 'hall' | 'legacy' };

/** Shuffle (seeded). */
function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function runGeneration(
  st: EsState, champion: BotParams, hall: BotParams[], cfg: TrainConfig, run: Runner,
): Promise<{ next: EsState; stats: GenStats; candidates: BotParams[]; fitness: number[] }> {
  const rng = mulberry32(cfg.seed * 7919 + st.gen * 104729);
  const xs = sample(st, rng, cfg.es);
  const cands = xs.map(decode);
  const lambda = xs.length;
  const fieldSeats = cfg.players - cfg.candSeats;
  if (fieldSeats < 0) throw new Error(`train: ${cfg.candSeats} candidate seats in a ${cfg.players}-player game`);
  if ((lambda * cfg.games) % cfg.candSeats) throw new Error(`train: λ×games (${lambda}×${cfg.games}) must divide into ${cfg.candSeats}-seat games`);
  // Every candidate appears `games` times, spread over games with different opponents.
  const pool = shuffle(Array.from({ length: lambda * cfg.games }, (_, i) => i % lambda), rng);
  const nGames = pool.length / cfg.candSeats;
  const plans: Seat[][] = [];
  for (let g = 0; g < nGames; g++) {
    const seats: Seat[] = pool.slice(g * cfg.candSeats, (g + 1) * cfg.candSeats).map((cand) => ({ cand }));
    for (let k = 0; k < fieldSeats; k++) seats.push({ field: k === 0 ? 'champion' : k === 1 && hall.length ? 'hall' : 'legacy' });
    plans.push(shuffle(seats, rng));
  }
  const nFfa = plans.length;
  // Duels: each candidate 1v1 against the frozen old bot, seats alternating.
  // Duels (a minority: most real lobbies are full 8-player FFAs): `duels` per generation, round-robin over candidates.
  for (let d = 0; d < (cfg.duels ?? 0); d++) {
    const c = (d + st.gen * 5) % lambda;
    plans.push(d % 2 ? [{ field: 'legacy' }, { cand: c }] : [{ cand: c }, { field: 'legacy' }]);
  }
  const hallPick = plans.map(() => (hall.length ? hall[Math.floor(rng() * hall.length)] : champion));
  const specs: MatchSpec[] = plans.map((seats, g) => ({
    seed: cfg.seed * 100003 + st.gen * 1009 + (g < nFfa ? g : 500 + Math.floor((g - nFfa) / 2)),
    maxSec: g < nFfa ? cfg.maxSec : Math.max(cfg.maxSec, 25 * 60),
    seats: seats.map((s): SeatSpec => {
      if ('cand' in s) return { kind: 'new', params: cands[s.cand], difficulty: 'pro' };
      if (s.field === 'legacy') return { kind: 'legacy', difficulty: 'pro' };
      return { kind: 'new', params: s.field === 'champion' ? champion : hallPick[g], difficulty: 'pro' };
    }),
  }));
  const results = await run(specs);
  const sum = new Array<number>(lambda).fill(0), cnt = new Array<number>(lambda).fill(0);
  const fsum: Record<string, number> = {}, fcnt: Record<string, number> = {};
  let duelWins = 0, duels = 0;
  results.forEach((r, g) => plans[g].forEach((s, seat) => {
    const duel = g >= nFfa;
    const w = duel ? (cfg.duelWeight ?? 1) : 1;
    const f = seatFitness(r, seat, specs[g].maxSec) - (cfg.imitation ? cfg.imitation.weight * imitationPenalty(seatStats(r, seat), cfg.imitation.target) : 0);
    if ('cand' in s) {
      sum[s.cand] += w * f; cnt[s.cand] += w;
      if (duel) { duels++; if (r.winner === seat + 1) duelWins++; }
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
    meanFit: fitness.reduce((a, b) => a + b, 0) / lambda,
    bestFit: Math.max(...fitness),
    field,
    decisive: ffa.filter((r) => r.decisive).length / ffa.length,
    avgMinutes: ffa.reduce((a, r) => a + r.time, 0) / ffa.length / 60,
    msPerTick: ffa.reduce((a, r) => a + r.msPerTick, 0) / ffa.length,
    sigma: next.sigma.reduce((a, b) => a + b, 0) / next.sigma.length,
  };
  return { next, stats, candidates: cands, fitness };
}

/**
 * Head-to-head check: `a` in half the seats, `b` in the other half (alternating so seat/island bias cancels).
 * Returns a's share of the wins (draws count half) and both sides' mean placement fitness.
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
      const f = seatFitness(r, seat);
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

export { encode };
