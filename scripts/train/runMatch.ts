/**
 * One headless bot match for training/evaluation: no rendering, no network, just Match.tick in a loop.
 * Deterministic for a given spec (the sim is seeded; bots draw from the match rng).
 */
import { LIFECYCLE, TICK_HZ } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { sanitize, toBotParams, type FlatParams } from '../../src/sim/bots/params';
import { Match, type BotBrain } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';
import { Bot as LegacyBot } from '../../tests/fixtures/legacyBots/bot';

/** A seat: the current bot with some params, or the frozen pre-training bot. */
export type SeatSpec = { kind: 'new'; params: FlatParams; difficulty: Difficulty } | { kind: 'legacy'; difficulty: Difficulty };
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
  /** Seconds alive within IDLE_M of my own bunker with nobody near it (hiding, no defensive reason), while geared. */
  idleHome: number;
  /** Earliness-weighted seals and eliminations: each counts 1 + (time left before sudden death) / sudden death. */
  sealScore: number;
  elimScore: number;
  /** Seconds on a rival's island carrying wall pieces (a seal in progress). */
  raidSec: number;
  /** Seconds carrying (cash + banked) > HOARD after the first 2 minutes. */
  hoardSec: number;
  /** Pieces destroyed within WASTE_SEC of being placed (wasted builds). */
  wasted: number;
  /** Distances of my hits on players (engagement range). */
  hitDists: number[];
  /** Seconds alive (sampled) and seconds spent on offensive actions (attack, seal, bridge, raid, fight). */
  aliveSec: number;
  attackSec: number;
  /** Longest stretch (s) in or right behind my own bunker with a gun and cash, nobody near: sitting at home. */
  longestHomeIdle: number;
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
  return new Bot(id, spec.difficulty, rng, undefined, toBotParams(sanitize(spec.params)));
}

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  if (spec.scenario) throw new Error(`runMatch: scenario starts (${spec.scenario}) need state restore from scripts/replays, which isn't available yet`);
  const n = spec.seats.length;
  const brains: BotBrain[] = [];
  const m = await Match.create(
    { players: spec.seats.map((s) => ({ name: '', isBot: true, difficulty: s.difficulty })), seed: spec.seed },
    { makeBot: (id, _d, rng) => { const b = makeBrain(spec.seats[id - 1], id, rng); brains[id - 1] = b; return b; } },
  );
  const seats: SeatResult[] = spec.seats.map(() => ({ place: 0, kills: 0, deaths: 0, seals: 0, elims: 0, survived: 0, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0, sealScore: 0, elimScore: 0, raidSec: 0, hoardSec: 0, wasted: 0, hitDists: [] as number[], longestHomeIdle: 0, aliveSec: 0, attackSec: 0 }));
  const outOrder: number[] = [];
  /** Who sealed each island's bunker last (player i+1 lives on island i). */
  const sealedBy = new Map<number, number>();
  const maxTicks = Math.round(spec.maxSec * TICK_HZ);
  let snap: Snapshot = m.tick(new Map());
  const t0 = performance.now();
  let ticks = 0;
  const bunkers = m.map.map((isl) => isl.bunker.center);
  const placedAt = new Map<number, { t: number; by: number }>();
  const homeStreak = new Map<number, number>();
  const early = (t: number) => 1 + Math.max(0, LIFECYCLE.suddenDeathAt - t) / LIFECYCLE.suddenDeathAt;
  const islandOf = (p: { x: number; z: number }) => m.map.findIndex((isl) => Math.hypot(p.x - isl.center.x, p.z - isl.center.z) <= isl.radius);
  for (; ticks < maxTicks && snap.winner === null; ticks++) {
    snap = m.tick(new Map());
    const pos = (id: number) => snap.players[id - 1]?.pos;
    // Behaviour sampling twice a second: hanging around my own bunker with nobody near it.
    if (ticks % SAMPLE_TICKS === 0)
      for (const p of snap.players) {
        if (!p.alive || p.breakoutUntil !== null) continue;
        const dtS = SAMPLE_TICKS / TICK_HZ;
        seats[p.id - 1].aliveSec += dtS;
        const goal = (brains[p.id - 1] as { currentGoal?: string }).currentGoal;
        if (goal && ATTACK_GOALS.has(goal)) seats[p.id - 1].attackSec += dtS;
        const walls = (p.inv.pieces.wood ?? 0) + (p.inv.pieces.metal ?? 0) + (p.inv.pieces.steel ?? 0);
        const on = islandOf(p.pos);
        if (walls > 0 && on >= 0 && on !== p.island) seats[p.id - 1].raidSec += dtS;
        if (snap.time > 120 && p.inv.cash + p.vault.cash > HOARD) seats[p.id - 1].hoardSec += dtS;
        {
          const b = bunkers[p.island];
          const armed = Object.keys(p.inv.weapons).length > 0 && p.inv.cash + p.vault.cash > 0;
          const nearby = snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - b.x, o.pos.z - b.z) < THREAT_M);
          const sitting = armed && !nearby && !snap.sealed[p.island] && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= 6;
          const st = sitting ? (homeStreak.get(p.id) ?? 0) + dtS : 0;
          homeStreak.set(p.id, st);
          seats[p.id - 1].longestHomeIdle = Math.max(seats[p.id - 1].longestHomeIdle, st);
        }
        const geared = !!(p.inv.weapons.smg || p.inv.weapons.rifle || p.inv.weapons.shotgun) || p.inv.cash + p.vault.cash >= 150;
        if (!geared) continue;
        const b = bunkers[p.island];
        if (Math.hypot(p.pos.x - b.x, p.pos.z - b.z) > IDLE_M) continue;
        const threat = snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - b.x, o.pos.z - b.z) < THREAT_M);
        if (!threat && !snap.sealed[p.island]) seats[p.id - 1].idleHome += dtS;
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
        seats[by - 1].hitDists.push(Math.round(d));
        if (d <= CLOSE_M) seats[by - 1].closeDmg += Number(e.data.amount) || 0;
        else if (d > LONG_M) seats[by - 1].longHits++;
        continue;
      }
      if (e.type === 'placed') {
        const by = e.data.by as number, kind = e.data.kind as string;
        placedAt.set(e.data.piece as number, { t: e.t, by });
        if (kind === 'scaffold') seats[by - 1].scaffolds++;
        else {
          const pc = snap.pieces.find((x) => x.id === e.data.piece);
          if (pc && bunkers.some((b, i) => i !== snap.players[by - 1].island && Math.hypot(pc.pos.x - b.x, pc.pos.z - b.z) <= 4)) seats[by - 1].plugs++;
        }
        continue;
      }
      if (e.type === 'destroyed') {
        const pl = placedAt.get(e.data.piece as number);
        if (pl && e.t - pl.t < WASTE_SEC) seats[pl.by - 1].wasted++;
        continue;
      }
      if (e.type === 'kill') {
        const v = e.data.victim as number, k = e.data.killer as number | null;
        seats[v - 1].deaths++;
        if (k != null && k !== v) seats[k - 1].kills++;
      } else if (e.type === 'sealed' && e.t < LIFECYCLE.suddenDeathAt) {
        const by = e.data.by as number | null | undefined;
        if (by != null && by !== e.data.owner) { seats[by - 1].seals++; seats[by - 1].sealScore += early(e.t); sealedBy.set(e.data.island as number, by); }
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (!outOrder.includes(id)) {
          outOrder.push(id);
          seats[id - 1].survived = e.t;
          const by = sealedBy.get(id - 1);
          if (by !== undefined && by !== id) { seats[by - 1].elims++; seats[by - 1].elimScore += early(e.t); }
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

const HOARD = 600, WASTE_SEC = 5;
const ATTACK_GOALS = new Set(['attack', 'seal', 'bridge', 'raid', 'fight']);
const CLOSE_M = 20, LONG_M = 40, IDLE_M = 8, THREAT_M = 30, SAMPLE_TICKS = 15;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Rapier worlds live in WASM memory and are never garbage collected: free it after a headless match. */
function freePhysics(m: Match) {
  const ph = (m as unknown as { physics?: { world?: { free?: () => void } } }).physics;
  ph?.world?.free?.();
}

/**
 * Fitness of one seat (run 3: play like a good human working toward winning).
 *  1. Outcome: placement; a win by sealing everyone out before sudden death outweighs everything; eliminations and
 *     seals are big and worth more the earlier they happen; kills are small; reaching sudden death costs everyone.
 *  2. Progress toward a seal: plugs placed at rival bunkers, time on rival islands carrying wall pieces, bridging.
 *  3. Buying well: no hoarding cash past 2 minutes.
 *  4. Building well: pieces that are destroyed right after placing are wasted.
 *  5. Fighting up close: damage within 20 m; penalties for plinking from beyond 40 m and for idling at home geared.
 */
export function seatFitness(r: MatchResult, seat: number, maxSec = 18 * 60): number {
  const s = r.seats[seat];
  const n = r.seats.length;
  const placement = (n - s.place) / (n - 1);
  const won = r.winner === seat + 1;
  const outcome = placement + 1.0 * (s.elimScore ?? s.elims) + 0.25 * (s.sealScore ?? s.seals) + 0.01 * s.kills +
    0.05 * (s.survived / Math.max(1, r.time)) + (won ? 0.4 * Math.max(0, 1 - r.time / maxSec) : 0) + (won && r.decisive ? 2 : 0) -
    (r.time >= LIFECYCLE.suddenDeathAt ? 0.4 : 0);
  const alive = Math.max(30, s.survived);
  const progress = Math.min(0.3, 0.05 * (s.plugs ?? 0)) + Math.min(0.2, 0.002 * (s.raidSec ?? 0)) + Math.min(0.1, 0.008 * (s.scaffolds ?? 0));
  const economy = -0.15 * Math.min(1, (s.hoardSec ?? 0) / alive);
  const building = -Math.min(0.15, 0.02 * (s.wasted ?? 0));
  const fighting = Math.min(0.3, 0.002 * (s.closeDmg ?? 0)) - Math.min(0.2, 0.002 * Math.max(0, (s.longShots ?? 0) - 2 * (s.longHits ?? 0))) -
    0.3 * Math.min(1, (s.idleHome ?? 0) / alive);
  return outcome + progress + economy + building + fighting;
}

/** Median of a list (NaN when empty). */
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
