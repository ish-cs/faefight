/**
 * One headless bot match for training/evaluation: no rendering, no network, just Match.tick in a loop.
 * Deterministic for a given spec (the sim is seeded; bots draw from the match rng).
 */
import { LIFECYCLE, TICK_HZ } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { sanitize, type BotParams } from '../../src/sim/bots/params';
import { Match, type BotBrain } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';
import { Bot as LegacyBot } from '../../tests/fixtures/legacyBots/bot';

/** A seat: the current bot with some params, or the frozen pre-training bot. */
export type SeatSpec = { kind: 'new'; params: BotParams; difficulty: Difficulty } | { kind: 'legacy'; difficulty: Difficulty };
export type MatchSpec = { seed: number; seats: SeatSpec[]; maxSec: number };

export type SeatResult = {
  /** 1 = winner; eliminated players ranked by elimination order; survivors at the time limit share the top places. */
  place: number;
  kills: number;
  deaths: number;
  /** Bunkers this player sealed (before sudden death). */
  seals: number;
  /** Seconds until eliminated (match length if never). */
  survived: number;
};
export type MatchResult = {
  seed: number;
  winner: number | null;
  /** Match time at the end (s). */
  time: number;
  /** A winner before sudden death. */
  decisive: boolean;
  seats: SeatResult[];
  msPerTick: number;
};

export function makeBrain(spec: SeatSpec, id: number, rng: () => number): BotBrain {
  if (spec.kind === 'legacy') return new LegacyBot(id, spec.difficulty, rng);
  return new Bot(id, spec.difficulty, rng, undefined, sanitize(spec.params));
}

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  const n = spec.seats.length;
  const m = await Match.create(
    { players: spec.seats.map((s) => ({ name: '', isBot: true, difficulty: s.difficulty })), seed: spec.seed },
    { makeBot: (id, _d, rng) => makeBrain(spec.seats[id - 1], id, rng) },
  );
  const seats: SeatResult[] = spec.seats.map(() => ({ place: 0, kills: 0, deaths: 0, seals: 0, survived: 0 }));
  const outOrder: number[] = [];
  const maxTicks = Math.round(spec.maxSec * TICK_HZ);
  let snap: Snapshot = m.tick(new Map());
  const t0 = performance.now();
  let ticks = 0;
  for (; ticks < maxTicks && snap.winner === null; ticks++) {
    snap = m.tick(new Map());
    for (const e of snap.events) {
      if (e.type === 'kill') {
        const v = e.data.victim as number, k = e.data.killer as number | null;
        seats[v - 1].deaths++;
        if (k != null && k !== v) seats[k - 1].kills++;
      } else if (e.type === 'sealed' && e.t < LIFECYCLE.suddenDeathAt) {
        const by = e.data.by as number | null | undefined;
        if (by != null && by !== e.data.owner) seats[by - 1].seals++;
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (!outOrder.includes(id)) { outOrder.push(id); seats[id - 1].survived = e.t; }
      }
    }
  }
  const ms = (performance.now() - t0) / Math.max(1, ticks);
  freePhysics(m);
  const time = snap.time;
  // Places: the k-th eliminated player gets place n - k + 1; the rest share the remaining top places.
  outOrder.forEach((id, k) => { seats[id - 1].place = n - k; });
  const left = seats.map((_, i) => i + 1).filter((id) => !outOrder.includes(id));
  const winner = snap.winner !== null && snap.winner > 0 ? snap.winner : null;
  if (winner !== null) {
    seats[winner - 1].place = 1;
    for (const id of left) if (id !== winner) seats[id - 1].place = 2;
  } else {
    const shared = (1 + left.length) / 2;
    for (const id of left) seats[id - 1].place = shared;
  }
  for (const id of left) seats[id - 1].survived = time;
  return { seed: spec.seed, winner, time, decisive: winner !== null && time < LIFECYCLE.suddenDeathAt, seats, msPerTick: ms };
}

/** Rapier worlds live in WASM memory and are never garbage collected: free it after a headless match. */
function freePhysics(m: Match) {
  const ph = (m as unknown as { physics?: { world?: { free?: () => void } } }).physics;
  ph?.world?.free?.();
}

/**
 * Fitness of one seat in [~0, ~1.5]: placement dominates (winning is the point), plus a little for
 * kills and seals (what sets up eliminations), survival time, and winning before sudden death.
 */
export function seatFitness(r: MatchResult, seat: number): number {
  const s = r.seats[seat];
  const n = r.seats.length;
  const placement = (n - s.place) / (n - 1);
  const won = r.winner === seat + 1;
  return placement + 0.02 * s.kills + 0.06 * s.seals + 0.15 * (s.survived / Math.max(1, r.time)) + (won && r.decisive ? 0.2 : 0);
}
