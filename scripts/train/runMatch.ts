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
export type MatchSpec = {
  seed: number; seats: SeatSpec[]; maxSec: number;
  /** Start from a mined scenario (replay pipeline) instead of a fresh match; see hooks.ts. */
  scenario?: string;
};

export type SeatResult = {
  /** 1 = winner; eliminated players ranked by elimination order; survivors at the time limit share the top places. */
  place: number;
  kills: number;
  deaths: number;
  /** Bunkers this player sealed (before sudden death). */
  seals: number;
  /** Rivals eliminated whose bunker I sealed (the seal is what makes a death final). */
  elims: number;
  /** Seconds until eliminated (match length if never). */
  survived: number;
  /** Damage dealt to players within CLOSE_M (real fights, not plinking). */
  closeDmg: number;
  /** Shots fired with no rival within LONG_M, and hits landed at that range. */
  longShots: number;
  longHits: number;
  /** Scaffolds laid (bridging toward a goal) and plugs placed at rivals' bunkers (sealing work). */
  scaffolds: number;
  plugs: number;
  /** Seconds alive within IDLE_M of my own bunker with nobody near it (hiding, no defensive reason). */
  idleHome: number;
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
  if (spec.scenario) throw new Error(`runMatch: scenario starts (${spec.scenario}) need state restore from scripts/replays, which isn't available yet`);
  const n = spec.seats.length;
  const m = await Match.create(
    { players: spec.seats.map((s) => ({ name: '', isBot: true, difficulty: s.difficulty })), seed: spec.seed },
    { makeBot: (id, _d, rng) => makeBrain(spec.seats[id - 1], id, rng) },
  );
  const seats: SeatResult[] = spec.seats.map(() => ({ place: 0, kills: 0, deaths: 0, seals: 0, elims: 0, survived: 0, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0 }));
  const outOrder: number[] = [];
  /** Who sealed each island's bunker last (player i+1 lives on island i). */
  const sealedBy = new Map<number, number>();
  const maxTicks = Math.round(spec.maxSec * TICK_HZ);
  let snap: Snapshot = m.tick(new Map());
  const t0 = performance.now();
  let ticks = 0;
  const bunkers = m.map.map((isl) => isl.bunker.center);
  for (; ticks < maxTicks && snap.winner === null; ticks++) {
    snap = m.tick(new Map());
    const pos = (id: number) => snap.players[id - 1]?.pos;
    // Behaviour sampling twice a second: hanging around my own bunker with nobody near it.
    if (ticks % SAMPLE_TICKS === 0)
      for (const p of snap.players) {
        if (!p.alive || p.breakoutUntil !== null) continue;
        const b = bunkers[p.island];
        if (Math.hypot(p.pos.x - b.x, p.pos.z - b.z) > IDLE_M) continue;
        const threat = snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - b.x, o.pos.z - b.z) < THREAT_M);
        if (!threat && !snap.sealed[p.island]) seats[p.id - 1].idleHome += SAMPLE_TICKS / TICK_HZ;
      }
    for (const e of snap.events) {
      if (e.type === 'shot') {
        const by = e.data.by as number, at = pos(by);
        if (at && !snap.players.some((o) => o.id !== by && o.alive && dist(o.pos, at) <= LONG_M)) seats[by - 1].longShots++;
        continue;
      }
      if (e.type === 'hit') {
        const by = e.data.by as number | null, target = e.data.target as number;
        if (by == null || by === target || !pos(by) || !pos(target)) continue;
        const d = dist(pos(by)!, pos(target)!);
        if (d <= CLOSE_M) seats[by - 1].closeDmg += Number(e.data.amount) || 0;
        else if (d > LONG_M) seats[by - 1].longHits++;
        continue;
      }
      if (e.type === 'placed') {
        const by = e.data.by as number, kind = e.data.kind as string;
        if (kind === 'scaffold') seats[by - 1].scaffolds++;
        else {
          const pc = snap.pieces.find((x) => x.id === e.data.piece);
          if (pc && bunkers.some((b, i) => i !== snap.players[by - 1].island && Math.hypot(pc.pos.x - b.x, pc.pos.z - b.z) <= 4)) seats[by - 1].plugs++;
        }
        continue;
      }
      if (e.type === 'kill') {
        const v = e.data.victim as number, k = e.data.killer as number | null;
        seats[v - 1].deaths++;
        if (k != null && k !== v) seats[k - 1].kills++;
      } else if (e.type === 'sealed' && e.t < LIFECYCLE.suddenDeathAt) {
        const by = e.data.by as number | null | undefined;
        if (by != null && by !== e.data.owner) { seats[by - 1].seals++; sealedBy.set(e.data.island as number, by); }
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (!outOrder.includes(id)) {
          outOrder.push(id);
          seats[id - 1].survived = e.t;
          const by = sealedBy.get(id - 1);
          if (by !== undefined && by !== id) seats[by - 1].elims++;
        }
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

const CLOSE_M = 25, LONG_M = 40, IDLE_M = 8, THREAT_M = 30, SAMPLE_TICKS = 15;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Rapier worlds live in WASM memory and are never garbage collected: free it after a headless match. */
function freePhysics(m: Match) {
  const ph = (m as unknown as { physics?: { world?: { free?: () => void } } }).physics;
  ph?.world?.free?.();
}

/**
 * Fitness of one seat. Outcome first: placement, then eliminations I set up with a seal ≫ seals ≫ kills, and a
 * winner gets more the sooner they win. Then shaping toward playing like a person with a mission: real fights
 * (damage dealt within 25 m), bridging and plugging work; penalties for plinking across the map (shots with nobody
 * within 40 m that miss) and for hanging around my own bunker with no reason.
 */
export function seatFitness(r: MatchResult, seat: number, maxSec = 18 * 60): number {
  const s = r.seats[seat];
  const n = r.seats.length;
  const placement = (n - s.place) / (n - 1);
  const won = r.winner === seat + 1;
  const outcome = placement + 0.5 * s.elims + 0.15 * s.seals + 0.01 * s.kills + 0.05 * (s.survived / Math.max(1, r.time)) +
    (won ? 0.4 * Math.max(0, 1 - r.time / maxSec) : 0);
  const alive = Math.max(30, s.survived);
  const shaping = Math.min(0.25, 0.0015 * (s.closeDmg ?? 0)) + Math.min(0.1, 0.008 * (s.scaffolds ?? 0)) + Math.min(0.15, 0.03 * (s.plugs ?? 0)) -
    Math.min(0.2, 0.002 * Math.max(0, (s.longShots ?? 0) - 2 * (s.longHits ?? 0))) - 0.3 * Math.min(1, (s.idleHome ?? 0) / alive);
  return outcome + shaping;
}
