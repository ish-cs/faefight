/**
 * One headless bot match for training/evaluation: no rendering, no network, just Match.tick in a loop.
 * Deterministic for a given spec (the sim is seeded; bots draw from the match rng).
 */
import { LIFECYCLE, TICK_HZ } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { preset } from '../../src/sim/bots/personality';
import { Match, type BotBrain } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';
import { PROXY_BOT_PARAMS, toBotParams, type FlatParams } from './params';

/**
 * A seat: the current bot with some flat params (over the hand defaults), or the human proxy: a PRO Sniper with the
 * pre-strength hand params (the strong human the bots must beat: rifle at range, no seal pressure from the strength knobs).
 */
export type SeatSpec = { kind: 'new'; params: FlatParams; difficulty: Difficulty } | { kind: 'proxy' };
export type MatchSpec = { seed: number; seats: SeatSpec[]; maxSec: number };

export type SeatResult = {
  /** 1 = winner; eliminated players ranked by elimination order; survivors at the time limit share the top places. */
  place: number;
  kills: number;
  deaths: number;
  /** Bunkers this player sealed (before sudden death). */
  seals: number;
  /**
   * Seal → death → eliminated chains I finished: the final kill on a player whose bunker had been sealed (by me or
   * anyone), or, when nobody landed it (storm, water), the elimination of a player I sealed.
   */
  elims: number;
  /** Chains I set up by sealing but someone else finished (the sealer's share). */
  assists?: number;
  assistScore?: number;
  /** Seconds near a rival's open bunker carrying a full seal kit (about to plug it). */
  kitAtDoorSec?: number;
  /** Seconds hunting (attack/fight) a live rival whose bunker a player has sealed (one kill eliminates them). */
  huntSealedSec?: number;
  /** Seconds until eliminated (match length if never). */
  survived: number;
  /** Match time I was eliminated at, null if never (survived to the end). */
  outAt?: number | null;
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
  /** Seats (0-based) of the players I killed, one entry per kill. */
  killed: number[];
  /** Heals started mid-fight (a rival within THREAT_M or hurt in the last 3 s), and deaths after ≥ 3 s at hp + shield ≤ 50. */
  healsFight: number;
  lowHpDeaths: number;
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

export const seatDifficulty = (s: SeatSpec): Difficulty => (s.kind === 'proxy' ? 'pro' : s.difficulty);

export function makeBrain(spec: SeatSpec, id: number, rng: () => number): BotBrain {
  if (spec.kind === 'proxy') return new Bot(id, 'pro', rng, preset('Sniper'), PROXY_BOT_PARAMS);
  return new Bot(id, spec.difficulty, rng, undefined, toBotParams(spec.params));
}

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  const n = spec.seats.length;
  const brains: BotBrain[] = [];
  const m = await Match.create(
    { players: spec.seats.map((s) => ({ name: '', isBot: true, difficulty: seatDifficulty(s) })), seed: spec.seed },
    { makeBot: (id, _d, rng) => { const b = makeBrain(spec.seats[id - 1], id, rng); brains[id - 1] = b; return b; } },
  );
  const seats: SeatResult[] = spec.seats.map(() => ({ place: 0, kills: 0, deaths: 0, seals: 0, elims: 0, survived: 0, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0, sealScore: 0, elimScore: 0, raidSec: 0, hoardSec: 0, wasted: 0, hitDists: [] as number[], longestHomeIdle: 0, aliveSec: 0, attackSec: 0, assists: 0, assistScore: 0, kitAtDoorSec: 0, huntSealedSec: 0, outAt: null, killed: [] as number[], healsFight: 0, lowHpDeaths: 0 }));
  // Heals (as scripts/ci/measure.ts): a medkit or a non-speed potion starting; low hp + shield streaks for low-hp deaths.
  const heal = spec.seats.map(() => ({ alive: false, healAt: null as number | null, drinking: false, lowSince: null as number | null, hurtAt: -99 }));
  const outOrder: number[] = [];
  /** Who sealed each island's bunker last (player i+1 lives on island i). */
  const sealedBy = new Map<number, number>();
  /** Last player to kill each player (the finisher of a seal chain). */
  const lastKiller = new Map<number, number>();
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
    for (const p of snap.players) {
      const h = heal[p.id - 1];
      const drinking = !!p.drinking && p.drinking.kind !== 'speedPotion';
      if (p.alive && h.alive && ((p.healAt !== null && h.healAt === null) || (drinking && !h.drinking))) {
        const foe = snap.players.some((o) => o.id !== p.id && o.alive && dist(o.pos, p.pos) < THREAT_M);
        if (foe || snap.time - h.hurtAt < 3) seats[p.id - 1].healsFight++;
      }
      if (p.alive && p.hp + p.shield <= 50) h.lowSince ??= snap.time; else if (p.alive) h.lowSince = null;
      h.alive = p.alive; h.healAt = p.healAt; h.drinking = drinking;
    }
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
        // A full kit (one plug per doorway; sandbags plug two high) at a rival's open door.
        const kit = walls + Math.floor((p.inv.pieces.sandbags ?? 0) / 2);
        if (kit >= 3 && bunkers.some((b, i) => i !== p.island && !snap.sealed[i] && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= KIT_DOOR_M))
          seats[p.id - 1].kitAtDoorSec! += dtS;
        const target = (brains[p.id - 1] as { currentTarget?: number | null }).currentTarget;
        if (goal && (goal === 'attack' || goal === 'fight') && target != null && sealedBy.has(target - 1) && snap.players[target - 1]?.alive)
          seats[p.id - 1].huntSealedSec! += dtS;
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
        if (by != null && by !== target && heal[target - 1]) heal[target - 1].hurtAt = e.t;
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
        const ls = heal[v - 1].lowSince;
        if (ls !== null && e.t - ls >= 3) seats[v - 1].lowHpDeaths++;
        heal[v - 1].lowSince = null;
        if (k != null && k !== v) { seats[k - 1].kills++; seats[k - 1].killed.push(v - 1); lastKiller.set(v, k); } else lastKiller.delete(v);
      } else if (e.type === 'sealed' && e.t < LIFECYCLE.suddenDeathAt) {
        const by = e.data.by as number | null | undefined;
        if (by != null && by !== e.data.owner) { seats[by - 1].seals++; seats[by - 1].sealScore += early(e.t); sealedBy.set(e.data.island as number, by); }
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (!outOrder.includes(id)) {
          outOrder.push(id);
          seats[id - 1].survived = e.t;
          seats[id - 1].outAt = e.t;
          const sealer = sealedBy.get(id - 1);
          if (sealer !== undefined) {
            // Whoever landed the final kill on a sealed player finishes the chain; the sealer gets an assist share.
            const finisher = lastKiller.get(id) ?? sealer;
            seats[finisher - 1].elims++;
            seats[finisher - 1].elimScore += early(e.t);
            if (finisher !== sealer) { seats[sealer - 1].assists!++; seats[sealer - 1].assistScore! += early(e.t); }
          }
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
const ENGAGE_M = 25;
const CLOSE_M = 20, LONG_M = 40, IDLE_M = 8, THREAT_M = 30, SAMPLE_TICKS = 15, KIT_DOOR_M = 10;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Rapier worlds live in WASM memory and are never garbage collected: free it after a headless match. */
function freePhysics(m: Match) {
  const ph = (m as unknown as { physics?: { world?: { free?: () => void } } }).physics;
  ph?.world?.free?.();
}

/**
 * Fitness of one seat (run 4: the seal → death → eliminated chain dominates; active play wins, passivity can't). Run 3's
 * champion won storm endgames by attacking less and sitting at home, so placement and survival are now small.
 * Every seal/elimination term is earliness-weighted (1 + time left before 15:00 / 15:00, so 1..2 each).
 *  1. Chain (dominant): SEAL_W per bunker I sealed; ELIM_W (larger) per chain I finished (the final kill on a
 *     sealed player, or the elimination of one I sealed when nobody landed it); ASSIST_W when I sealed and someone
 *     else finished (set up and finish together). Shaping toward the chain: plugs at rival doors, time at a rival's
 *     open door with a full kit, time hunting a rival whose bunker is sealed, time on rival islands with wall pieces.
 *  2. Outcome (small): placement; a decisive win; reaching sudden death costs everyone.
 *  3. Activity (run 5: weighted up so it isn't swamped by the seal terms): share of alive time attacking
 *     (attack/seal/bridge/raid/fight); damage dealt within 20 m; the share of my hits landed under 25 m.
 *  4. Penalties: a geared home-sit over 60 s (strong), idling at home, plinking beyond 40 m, hoarding, wasted pieces.
 *  5. Heals (small): heals started mid-fight; deaths after ≥ 3 s at low hp.
 */
export const FITNESS_W = { seal: 2.0, elim: 3.5, assist: 1.5, placement: 0.2, decisiveWin: 1.5, attack: 1.6, close: 1.0 } as const;
export function seatFitness(r: MatchResult, seat: number, maxSec = 18 * 60): number {
  const s = r.seats[seat];
  const n = r.seats.length;
  const W = FITNESS_W;
  const placement = (n - s.place) / (n - 1);
  const won = r.winner === seat + 1;
  const chain = W.seal * (s.sealScore ?? s.seals) + W.elim * (s.elimScore ?? s.elims) + W.assist * (s.assistScore ?? s.assists ?? 0);
  const alive = Math.max(30, s.aliveSec || s.survived);
  const toward = Math.min(0.6, 0.12 * (s.plugs ?? 0)) + Math.min(0.4, 0.004 * (s.kitAtDoorSec ?? 0)) +
    Math.min(0.5, 0.005 * (s.huntSealedSec ?? 0)) + Math.min(0.2, 0.002 * (s.raidSec ?? 0)) + Math.min(0.1, 0.008 * (s.scaffolds ?? 0));
  const outcome = W.placement * placement + 0.01 * s.kills + (won && r.decisive ? W.decisiveWin + Math.max(0, 1 - r.time / maxSec) : 0) -
    (r.time >= LIFECYCLE.suddenDeathAt ? 0.4 : 0);
  // Fights under ENGAGE_M: the share of my hits landed that close, trusted only once I've landed a few.
  const hits = s.hitDists?.length ?? 0;
  const close = hits ? s.hitDists.filter((d) => d < ENGAGE_M).length / hits : 0;
  const activity = W.attack * Math.min(1, (s.attackSec ?? 0) / alive) + Math.min(0.6, 0.004 * (s.closeDmg ?? 0)) +
    W.close * close * Math.min(1, hits / 10);
  const homeSit = Math.min(1, Math.max(0, (s.longestHomeIdle ?? 0) - 60) / 120);
  const penalties = -1.2 * homeSit - 0.5 * Math.min(1, (s.idleHome ?? 0) / alive) -
    Math.min(0.2, 0.002 * Math.max(0, (s.longShots ?? 0) - 2 * (s.longHits ?? 0))) -
    0.15 * Math.min(1, (s.hoardSec ?? 0) / alive) - Math.min(0.15, 0.02 * (s.wasted ?? 0));
  // Heals mid-fight (break off, heal, re-peek) pay a little; dying after sitting at low hp with no heal costs a little.
  const heals = Math.min(0.3, 0.1 * (s.healsFight ?? 0)) - Math.min(0.3, 0.1 * (s.lowHpDeaths ?? 0));
  return chain + toward + outcome + activity + penalties + heals;
}

/**
 * Bonus for beating the human-proxy seats of a game (`proxySeats`, 0-based): placing above each proxy (a tie counts
 * half), averaged over them, and each kill on a proxy (at most 2 count). 0 when the game has no proxy.
 */
export const PROXY_W = { above: 0.6, kill: 0.4 } as const;
export function proxyBonus(r: MatchResult, seat: number, proxySeats: readonly number[]): number {
  if (!proxySeats.length) return 0;
  const me = r.seats[seat];
  const above = proxySeats.reduce((a, p) => a + (me.place < r.seats[p].place ? 1 : me.place === r.seats[p].place ? 0.5 : 0), 0) / proxySeats.length;
  const kills = me.killed.filter((v) => proxySeats.includes(v)).length;
  return PROXY_W.above * above + PROXY_W.kill * Math.min(2, kills);
}

/** Median of a list (NaN when empty). */
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
