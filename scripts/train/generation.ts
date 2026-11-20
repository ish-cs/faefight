/**
 * One training generation: seat the candidates in 8-bot FFAs against a mixed field (the current champion,
 * earlier champions from the hall of fame, and the frozen pre-training bot), score, and step the optimizer.
 * Everyone plays at PRO skill so fitness measures strategy, not aim luck.
 */
import { decode, encode, type BotParams } from '../../src/sim/bots/params';
import { mulberry32, sample, update, type EsConfig, type EsState } from './es';
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
};

export type Runner = (specs: MatchSpec[]) => Promise<MatchResult[]>;

export type GenStats = {
  gen: number;
  games: number;
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
  const hallPick = plans.map(() => (hall.length ? hall[Math.floor(rng() * hall.length)] : champion));
  const specs: MatchSpec[] = plans.map((seats, g) => ({
    seed: cfg.seed * 100003 + st.gen * 1009 + g,
    maxSec: cfg.maxSec,
    seats: seats.map((s): SeatSpec => {
      if ('cand' in s) return { kind: 'new', params: cands[s.cand], difficulty: 'pro' };
      if (s.field === 'legacy') return { kind: 'legacy', difficulty: 'pro' };
      return { kind: 'new', params: s.field === 'champion' ? champion : hallPick[g], difficulty: 'pro' };
    }),
  }));
  const results = await run(specs);
  const sum = new Array<number>(lambda).fill(0), cnt = new Array<number>(lambda).fill(0);
  const fsum: Record<string, number> = {}, fcnt: Record<string, number> = {};
  results.forEach((r, g) => plans[g].forEach((s, seat) => {
    const f = seatFitness(r, seat);
    if ('cand' in s) { sum[s.cand] += f; cnt[s.cand]++; } else { fsum[s.field] = (fsum[s.field] ?? 0) + f; fcnt[s.field] = (fcnt[s.field] ?? 0) + 1; }
  }));
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
    meanFit: fitness.reduce((a, b) => a + b, 0) / lambda,
    bestFit: Math.max(...fitness),
    field,
    decisive: results.filter((r) => r.decisive).length / results.length,
    avgMinutes: results.reduce((a, r) => a + r.time, 0) / results.length / 60,
    msPerTick: results.reduce((a, r) => a + r.msPerTick, 0) / results.length,
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
  let winsA = 0, fitA = 0, fitB = 0, nA = 0, nB = 0;
  results.forEach((r, k) => {
    const isA = (seat: number) => (seat + (k % 2)) % 2 === 0;
    if (r.winner === null) winsA += 0.5;
    else if (isA(r.winner - 1)) winsA++;
    r.seats.forEach((_, seat) => {
      const f = seatFitness(r, seat);
      if (isA(seat)) { fitA += f; nA++; } else { fitB += f; nB++; }
    });
  });
  return { share: winsA / results.length, fitA: fitA / nA, fitB: fitB / nB, results };
}

export { encode };
