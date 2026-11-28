/// <reference types="node" />
/**
 * Headless bot measurement for CI (.github/workflows/bot-measure.yml). Node only: no browser, no GPU.
 * Imports nothing but src/sim, so it runs against any ref (the workflow copies this file into the checkout).
 *
 *   npx tsx scripts/ci/measure.ts run --tasks ffa8-pro:1,ffa8-pro:2 --out shard.json [--params path.json] [--workers N]
 *   npx tsx scripts/ci/measure.ts aggregate --in <dir of shard jsons> --json measure-summary.json --md summary.md
 *
 * Scenarios: 1v1-hard; the 1v1 skill ladder 1v1-pro-vs-hard, 1v1-hard-vs-medium, 1v1-medium-vs-easy (the higher
 * tier is seat 1 on odd seeds); ffa8-pro, ffa8-hard, ffa8-mixed (also average placement per tier); *-arch.
 * Metrics follow scripts/train/runMatch.ts and tests/sim/shipChecks.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 'userproxy': the human stand-in seat, labelled apart from the tier it plays on. */
type Difficulty = 'easy' | 'medium' | 'hard' | 'pro' | 'userproxy';
export const SCENARIOS = ['1v1-hard', '1v1-pro-vs-hard', '1v1-hard-vs-medium', '1v1-medium-vs-easy', 'ffa8-pro', 'ffa8-hard', 'ffa8-mixed', 'ffa8-pro-arch', 'ffa8-hard-arch', '1v1-pro-arch', 'ffa3-pro', 'ffa4-pro',
  'proxy-1v1-hard', 'proxy-1v1-pro', 'proxy-ffa8-hard',
  '1v1-hard-vs-userproxy', '1v1-pro-vs-userproxy', 'ffa8-userproxy-vs-7hard', 'ffa8-userproxy-vs-7pro', 'ffa8-pro1'] as const;
type Scenario = (typeof SCENARIOS)[number];

const SD = 900; // LIFECYCLE.suddenDeathAt (checked against the sim at runtime)
const ATTACK_GOALS = new Set(['attack', 'seal', 'bridge', 'raid', 'fight']);
const IDLE_M = 8, THREAT_M = 30, SAMPLE_TICKS = 15, HOME_SIT_M = 6;
const USERPROXY = 'userproxy' as Difficulty;
/** The 1v1 skill ladder: each scenario pits the higher tier against the one below. */
const LADDER: Partial<Record<Scenario, [Difficulty, Difficulty]>> = {
  '1v1-pro-vs-hard': ['pro', 'hard'], '1v1-hard-vs-medium': ['hard', 'medium'], '1v1-medium-vs-easy': ['medium', 'easy'],
  // Bot-cognition spec §7.4: the bot tier vs the human stand-in. proxy-*: the fixed PRO-Sniper stand-in (NET 42);
  // *-userproxy: the fitted UserProxy (bot-cognition P0).
  'proxy-1v1-hard': ['hard', USERPROXY], 'proxy-1v1-pro': ['pro', USERPROXY],
  '1v1-hard-vs-userproxy': ['hard', USERPROXY], '1v1-pro-vs-userproxy': ['pro', USERPROXY],
};
const TIERS: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'userproxy'];

/**
 * Human-proxy seat (-1: none), one convention for every proxy scenario (kept from NET 42's proxy-* so their
 * per-seed baselines stay comparable): 1v1, the proxy is seat 0 on odd seeds and seat 1 on even seeds (the bot tier
 * takes the other seat); 8-player FFA, seat (seed - 1) % 8. The seat is labelled 'userproxy' in the results.
 */
export function proxySeat(scenario: Scenario, seed: number): number {
  if (scenario === 'proxy-1v1-hard' || scenario === 'proxy-1v1-pro' || scenario === '1v1-hard-vs-userproxy' || scenario === '1v1-pro-vs-userproxy') return seed % 2 ? 0 : 1;
  if (scenario === 'proxy-ffa8-hard' || scenario === 'ffa8-userproxy-vs-7hard' || scenario === 'ffa8-userproxy-vs-7pro') return (seed - 1) % 8;
  return -1;
}

/**
 * The fitted UserProxy model: private (it comes from the user's replays), so never in the repo. CI: the
 * USERPROXY_MODEL secret (JSON) via env; locally: USERPROXY_MODEL or USERPROXY_MODEL_FILE (default
 * .replays-local/userproxy.json). Fails loudly when a proxy scenario runs without one.
 */
export function proxyModelJson(): unknown {
  const file = process.env.USERPROXY_MODEL_FILE || '.replays-local/userproxy.json';
  const raw = process.env.USERPROXY_MODEL || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  if (!raw.trim()) throw new Error(`measure: a userproxy scenario needs the model: set USERPROXY_MODEL (CI secret) or write ${file} (scripts/replays/userproxy.ts)`);
  return JSON.parse(raw);
}

function seatsFor(scenario: Scenario, seed: number): { diffs: Difficulty[]; maxSec: number } {
  switch (scenario) {
    case '1v1-hard': return { diffs: ['hard', 'hard'], maxSec: 25 * 60 };
    // Same seat rule as tests/sim/botSeries.test.ts: PRO is seat 1 on odd seeds.
    case '1v1-pro-vs-hard': case '1v1-hard-vs-medium': case '1v1-medium-vs-easy': {
      const [hi, lo] = LADDER[scenario]!;
      return { diffs: seed % 2 ? [hi, lo] : [lo, hi], maxSec: 25 * 60 };
    }
    case 'ffa8-pro': return { diffs: Array(8).fill('pro'), maxSec: SD + 180 };
    case 'ffa3-pro': return { diffs: Array(3).fill('pro'), maxSec: SD + 180 };
    case 'ffa4-pro': return { diffs: Array(4).fill('pro'), maxSec: SD + 180 };
    case 'ffa8-hard': return { diffs: Array(8).fill('hard'), maxSec: SD + 180 };
    // One PRO among 7 Hard (the PRO match analysis setup), the PRO in seat (seed - 1) % 8.
    case 'ffa8-pro1': return { diffs: Array.from({ length: 8 }, (_, i) => (i === (seed - 1) % 8 ? 'pro' : 'hard')), maxSec: SD + 180 };
    case 'ffa8-mixed': return { diffs: ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'], maxSec: SD + 180 };
    case 'ffa8-pro-arch': return { diffs: Array(8).fill('pro'), maxSec: SD + 180 };
    case 'ffa8-hard-arch': return { diffs: Array(8).fill('hard'), maxSec: SD + 180 };
    case '1v1-pro-arch': return { diffs: ['pro', 'pro'], maxSec: 25 * 60 };
    case 'proxy-1v1-hard': case 'proxy-1v1-pro': case '1v1-hard-vs-userproxy': case '1v1-pro-vs-userproxy': {
      const d = LADDER[scenario]![0];
      return { diffs: proxySeat(scenario, seed) === 0 ? [USERPROXY, d] : [d, USERPROXY], maxSec: 25 * 60 };
    }
    case 'proxy-ffa8-hard': case 'ffa8-userproxy-vs-7hard': case 'ffa8-userproxy-vs-7pro': {
      const d: Difficulty = scenario === 'ffa8-userproxy-vs-7pro' ? 'pro' : 'hard';
      return { diffs: Array.from({ length: 8 }, (_, i) => (i === proxySeat(scenario, seed) ? USERPROXY : d)), maxSec: SD + 180 };
    }
  }
}

/**
 * Archetype per seat for the *-arch scenarios (null = the bot rolls its own). FFA: seat i gets archetype (i + seed) % 5,
 * so every archetype sits in every seat equally often. 1v1: seeds cycle through the 10 archetype pairs; the seat order
 * flips every 10 seeds, so 20k seeds give each pair 2k games, k in each order.
 */
function archetypesFor(scenario: Scenario, seed: number, names: readonly string[]): (string | null)[] | null {
  if (scenario === 'ffa8-pro-arch' || scenario === 'ffa8-hard-arch') return Array.from({ length: 8 }, (_, i) => names[(i + seed) % names.length]);
  if (scenario === '1v1-pro-arch') {
    const pairs: [string, string][] = [];
    for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) pairs.push([names[a], names[b]]);
    const [x, y] = pairs[(seed - 1) % pairs.length];
    return Math.floor((seed - 1) / pairs.length) % 2 ? [y, x] : [x, y];
  }
  return null;
}

type SeatOut = {
  difficulty: Difficulty; kills: number; deaths: number; aliveSec: number; attackSec: number;
  idleHome: number; longestHomeIdle: number; hitDists: number[]; eliminatedAt: number | null;
  /** Heals (medkits, heal/shield potions): got (bought or picked up), used, used mid-fight (an enemy within 30 m or hurt
   * in the last 3 s), and deaths after at least 3 s at hp + shield ≤ 50 (a heal could have saved them). Optional: older shards. */
  healsGot?: number; healsUsed?: number; healsUsedFight?: number; lowHpDeaths?: number;
  /** Combat building (optional: shard files from older measure.ts lack it). */
  build?: BuildOut;
  archetype?: string; traits?: Record<string, number>; damage?: number; seals?: number;
  /** Vault use (read off snapshots, so it works on any ref): deposits, $ banked, shop buys paid from the vault, respawn restocks. */
  deposits?: number; banked?: number; vaultPaid?: number; restocks?: number; interest?: number; vaultLv?: number;
  /**
   * Frozen bot: longest stretch (s) alive with a rival still in the game without moving > FROZEN_M (2D), before sudden
   * death and from it on; frozenAt: when the longest pre-sudden-death one started. Not counted: a breakout countdown,
   * holding inside my own bunker under fire (hurt in the last 3 s or an enemy within 30 m), and in sudden death any
   * bunker (the doorway slabs shut it). Optional: older shards.
   */
  frozenMax?: number; frozenAt?: number; frozenMaxSd?: number;
  /** The longest pre-sudden-death freeze ≥ FROZEN_GATE_SEC, as the brain saw it when it hit that: goal/move layer: why @ x,z. */
  frozenNote?: string;
  /** Longest stretch (s) earning at its own generator or the center's gold, or buying (EARN_M / EARN_SEC): reported on its own; it does NOT reduce frozenMax or the freeze count (coordinator 2026-11-28: exclusions hide bugs). */
  econMax?: number;
  /** When the longest econ stretch started. */
  econAt?: number;
  /** Movement jitter (src/sim/bots/moveStats.ts; refs without it leave this out). */
  jitter?: SeatJitter;
  /** Same-game stats (spec §7.3; optional: older shards): hits dealt, head hits, rifle hits, credited eliminations, s in the game (until out or the end). */
  hits?: number; headshots?: number; rifleHits?: number; elimsBy?: number; inGameSec?: number;
};
/** Flips: walk direction turning > 120° within 0.3 s; episodes: 3+ flips in a row while staying within 1 m. */
type SeatJitter = {
  aliveSec: number; wishFlips: number; velFlips: number; oscSec: number; episodes: number;
  /** Flips within 0.4 s of the one before (back and forth): the jitter rate. */
  rapidFlips?: number; rapidBySrc?: Record<string, number>;
  /** Wish flips / velocity flips by the movement layer driving at that tick (Bot.moveSrc). */
  bySrc: Record<string, number>; velBySrc: Record<string, number>;
  /** The worst few episodes: start time, place, goal, flips and the layers at each flip. */
  worst: { t: number; x: number; z: number; goal: string; flips: number; srcs: string }[];
};
/**
 * Building in fights, per seat. A fight: bullets/blasts exchanged with anyone, closed by 8 s without one, a death or a
 * kill (won = got a kill and lived). Combat pieces: anything but a bridge deck placed during a fight. Blocked: a bullet
 * stopped by one of my own pieces within 4 m of me while I'm in a fight. High: my hits on someone ≥ 1.2 m below me.
 */
export type BuildOut = {
  fights: number; built: number; builtWon: number; plainWon: number; pieces: number; kinds: Record<string, number>;
  bulletsTaken: number; bulletsBlocked: number; hits: number; highHits: number;
};
const FIGHT_GAP = 8, BLOCK_M = 4, HIGH_M = 1.2;
const FROZEN_M = 1, FROZEN_GATE_SEC = 45;
/** Earning at my own generator or the center's gold station (within EARN_M m, carried cash up) or buying (money down, alive) in the last EARN_SEC s: reported as econMax only (still counts as frozen). */
const EARN_M = 3, EARN_SEC = 3.5;
/** Dead air: no hit, kill or build anywhere while ≥ 2 players are still in the game. */
const ACTION_EVENTS = new Set(['hit', 'kill', 'placed']);
export type GameOut = {
  scenario: Scenario; seed: number; winner: number | null; winnerDifficulty: Difficulty | null;
  time: number; decisive: boolean; preSdElims: number; preSdSeals?: number; firstSeal: number | null; msPerTick: number; wallSec: number;
  seats: SeatOut[];
  /** Player kills at or after sudden death (15:00+), eliminations in all, credited ones (refs with elimination rewards) and their spoils. */
  lateKills?: number; elims?: number; credited?: number; spoils?: number;
  /** Longest dead-air stretch (s) and when it started (absent on old shard files). */
  deadAir?: number; deadAirAt?: number;
};

/** What src/sim/bots/params.ts exports, depending on the ref (the trainer branch adds sanitize/toBotParams). */
type ParamsModule = {
  withParams?: (over: Record<string, number>) => unknown;
  sanitize?: (p: Record<string, number>) => Record<string, number>;
  toBotParams?: (flat: Record<string, number>) => unknown;
};

/**
 * A params file (`{ params: { 'drive.push.pro': 0.4, ... } }` or the flat map itself) as the BotParams a Bot takes.
 * Main's params.ts has withParams (flat overrides on the defaults; unknown keys throw); a trainer ref clamps into
 * its search box first (sanitize) and builds with toBotParams. Fails loudly if the module has neither.
 */
export function paramsFromJson(mod: ParamsModule, json: unknown): unknown {
  if (!json || typeof json !== 'object') throw new Error('measure: params file is not a JSON object');
  const j = json as { params?: Record<string, number> } & Record<string, unknown>;
  const flat = (j.params ?? j) as Record<string, number>;
  for (const [k, v] of Object.entries(flat)) if (typeof v !== 'number') throw new Error(`measure: params file: ${k} is not a number`);
  if (mod.sanitize && mod.toBotParams) return mod.toBotParams(mod.sanitize(flat));
  if (mod.withParams) return mod.withParams(flat);
  throw new Error('measure: --params given but src/sim/bots/params.ts exports neither withParams nor sanitize/toBotParams');
}

export async function loadParamsFile(paramsPath: string): Promise<unknown> {
  // Variable specifier: params.ts exists only on refs with the tunable bot (tsc must pass on refs without it).
  const paramsModule = '../../src/sim/bots/params';
  let mod: ParamsModule;
  try { mod = await import(/* @vite-ignore */ paramsModule); } catch (e) {
    throw new Error(`measure: --params given but this ref has no src/sim/bots/params.ts (${(e as Error).message})`);
  }
  return paramsFromJson(mod, JSON.parse(fs.readFileSync(paramsPath, 'utf8')));
}

async function runOne(scenario: Scenario, seed: number, paramsPath: string | null): Promise<GameOut> {
  const { Match } = await import('../../src/sim/match');
  const { Bot } = await import('../../src/sim/bots/bot');
  const { LIFECYCLE, TICK_HZ } = await import('../../src/sim/constants');
  if (LIFECYCLE.suddenDeathAt !== SD) throw new Error(`measure: sudden death is at ${LIFECYCLE.suddenDeathAt}s, script assumes ${SD}s — update SD`);
  const params = paramsPath ? await loadParamsFile(paramsPath) : undefined;
  const { diffs } = seatsFor(scenario, seed);
  // MEASURE_MAX_SEC: cut games short (smoke tests of this script only; real measurements never set it).
  const maxSec = Number(process.env.MEASURE_MAX_SEC) || seatsFor(scenario, seed).maxSec;
  type Brain = { currentGoal?: string; personality?: { archetype: string; traits: Record<string, number> }; moveDir?: { x: number; z: number } | null; moveSrc?: string };
  type MoveSample = { alive: boolean; wx: number; wz: number; vx: number; vz: number; x: number; z: number };
  type MS = { moveStats: (t: MoveSample[], dt: number) => { aliveSec: number; wishFlips: number[]; velFlips: number[]; rapidFlips?: number[]; oscSec: number; episodes: { i0: number; i1: number; flips: number[] }[] } };
  // Variable specifier: moveStats.ts exists only on refs with the jitter diagnostics.
  const moveStatsModule = '../../src/sim/bots/moveStats';
  const ms = await import(/* @vite-ignore */ moveStatsModule).catch(() => null) as MS | null;
  const brains: Brain[] = [];
  const BotCtor = Bot as unknown as new (...a: unknown[]) => Brain;
  const pers = await import('../../src/sim/bots/personality') as unknown as { ARCHETYPES: readonly string[]; PRESETS: Record<string, Record<string, number>> };
  const arch = archetypesFor(scenario, seed, pers.ARCHETYPES);
  // Same jitter as rollPersonality (±0.15 per trait, from the bot's seeded rng), but with the archetype fixed.
  const personalityFor = (i: number, rng: () => number) => {
    const a = arch?.[i];
    if (!a) return undefined;
    const traits: Record<string, number> = {};
    for (const [k, v] of Object.entries(pers.PRESETS[a])) traits[k] = Math.min(1, Math.max(0, v + (rng() * 2 - 1) * 0.15));
    return { archetype: a, traits };
  };
  const pSeat = proxySeat(scenario, seed);
  // proxy-*: the fixed stand-in, a PRO Sniper on PRE_STRENGTH_PARAMS where the ref has them (plays the same on main and a branch).
  const standIn = pSeat >= 0 && scenario.startsWith('proxy-');
  const proxyParams = standIn ? ((await import('../../src/sim/bots/params')) as unknown as { PRE_STRENGTH_PARAMS?: unknown }).PRE_STRENGTH_PARAMS : undefined;
  const sniper = () => ({ archetype: 'Sniper', traits: { ...pers.PRESETS.Sniper } });
  // *-userproxy: the fitted UserProxy model.
  type UP = { isUserProxyModel: (v: unknown) => boolean; proxyPersonality: (m: unknown) => unknown; goalBiasFor: (m: unknown) => unknown };
  let proxy: { model: { difficulty: Exclude<Difficulty, 'userproxy'> }; up: UP } | null = null;
  if (pSeat >= 0 && !standIn) {
    // Variable specifier: userProxy.ts exists only on refs from bot-cognition P0 on.
    const upModule = '../../src/sim/bots/userProxy';
    const up = await import(/* @vite-ignore */ upModule) as UP;
    const model = proxyModelJson();
    if (!up.isUserProxyModel(model)) throw new Error('measure: the UserProxy model is malformed');
    proxy = { model: model as { difficulty: Exclude<Difficulty, 'userproxy'> }, up };
  }
  const proxyTier = (): Exclude<Difficulty, 'userproxy'> => (proxy ? proxy.model.difficulty : 'pro');
  const m = await Match.create(
    { players: diffs.map((d) => ({ name: '', isBot: true, difficulty: (d === USERPROXY ? proxyTier() : d) as Exclude<Difficulty, 'userproxy'> })), seed },
    { makeBot: (id, d, rng) => {
      if (id - 1 === pSeat && standIn) {
        const b = new BotCtor(id, 'pro', rng, sniper(), ...(proxyParams ? [proxyParams] : []));
        brains[id - 1] = b; return b as never;
      }
      if (id - 1 === pSeat && proxy) {
        // The proxy plays on its own params (defaults), never the --params under test.
        const b = new BotCtor(id, proxy.model.difficulty, rng, proxy.up.proxyPersonality(proxy.model)) as Brain & { goalBias?: unknown };
        b.goalBias = proxy.up.goalBiasFor(proxy.model);
        brains[id - 1] = b; return b as never;
      }
      const b = new BotCtor(id, d, rng, personalityFor(id - 1, rng), ...(params ? [params] : [])); brains[id - 1] = b; return b as never;
    } },
  );
  const seats: SeatOut[] = diffs.map((d, i) => ({
    difficulty: d, kills: 0, deaths: 0, aliveSec: 0, attackSec: 0, idleHome: 0, longestHomeIdle: 0, hitDists: [], eliminatedAt: null,
    archetype: brains[i]?.personality?.archetype, traits: brains[i]?.personality?.traits, damage: 0, seals: 0, healsGot: 0, healsUsed: 0, healsUsedFight: 0, lowHpDeaths: 0,
    deposits: 0, banked: 0, vaultPaid: 0, restocks: 0, interest: 0, vaultLv: 1, frozenMax: 0, frozenAt: 0, frozenMaxSd: 0,
    hits: 0, headshots: 0, rifleHits: 0, elimsBy: 0, inGameSec: 0,
  }));
  const still = new Map<number, { x: number; z: number; t: number; note?: string }>();
  let lastAction = 0, deadAir = 0, deadAirAt = 0;
  type HealSeen = { alive: boolean; n: number; healAt: unknown; drinking: { kind: string } | null; lowSince: number | null; hurtAt: number };
  const healSeen: HealSeen[] = diffs.map(() => ({ alive: false, n: 0, healAt: null, drinking: null, lowSince: null, hurtAt: -99 }));
  type HealP = { id: number; alive: boolean; hp: number; shield: number; pos: { x: number; z: number }; healAt?: unknown; drinking?: { kind: string } | null; inv: { medkits: number; potions?: Record<string, number | undefined> } };
  const healN = (p: HealP) => p.inv.medkits + (p.inv.potions?.healPotion ?? 0) + (p.inv.potions?.shieldSmall ?? 0) + (p.inv.potions?.shieldBig ?? 0);
  const lastCash = new Map<number, [number, number]>();
  const bunkers = m.map.map((isl) => isl.bunker.center);
  const gens = m.map.map((isl) => isl.generator);
  const gold = m.def.center?.goldGen ?? null;
  /**
   * Last time each player's carried cash rose while at its own generator (it pays them there) or its money (carried +
   * vault) fell while alive (a purchase), and since when it has been doing that (econMax).
   */
  const earnAt = new Map<number, number>(), earnSince = new Map<number, number>();
  const homeStreak = new Map<number, number>();
  let preSdElims = 0, preSdSeals = 0, firstSeal: number | null = null, lateKills = 0, elims = 0, credited = 0, spoils = 0;
  const bo: BuildOut[] = diffs.map(() => ({ fights: 0, built: 0, builtWon: 0, plainWon: 0, pieces: 0, kinds: {}, bulletsTaken: 0, bulletsBlocked: 0, hits: 0, highHits: 0 }));
  const fight: ({ last: number; pieces: number; kill: boolean } | null)[] = diffs.map(() => null);
  const pieceOwner = new Map<number, number>();
  const endFight = (i: number, died: boolean) => {
    const f = fight[i];
    if (!f) return;
    const b = bo[i];
    b.fights++;
    if (f.pieces > 0) b.built++;
    if (f.kill && !died) { if (f.pieces > 0) b.builtWon++; else b.plainWon++; }
    fight[i] = null;
  };
  const touch = (i: number, t: number) => { fight[i] ??= { last: t, pieces: 0, kill: false }; fight[i]!.last = t; };
  const maxTicks = Math.round(maxSec * TICK_HZ);
  const w0 = performance.now();
  let snap = m.tick(new Map());
  let ticks = 0;
  const moves = diffs.map(() => [] as MoveSample[]), srcs = diffs.map(() => [] as string[]), goals = diffs.map(() => [] as string[]);
  const trackMoves = !!ms && brains.some((b) => b && 'moveDir' in b);
  for (; ticks < maxTicks && snap.winner === null; ticks++) {
    snap = m.tick(new Map());
    for (const p of snap.players) {
      const b = lastCash.get(p.id), s = seats[p.id - 1];
      if (b && s) {
        const dv = p.vault.cash - b[1], di = p.inv.cash - b[0];
        const g = gens[p.island];
        const atGen = Math.hypot(p.pos.x - g.x, p.pos.z - g.z) <= EARN_M || (!!gold && Math.hypot(p.pos.x - gold.x, p.pos.z - gold.z) <= EARN_M);
        if (p.alive && ((di > 0 && atGen) || di + dv < 0)) earnAt.set(p.id, snap.time);
        if (dv > 0 && di < 0) { s.deposits!++; s.banked! += dv; }
        else if (dv > 0 && di === 0) s.interest! += dv; // vault interest (refs with it)
        else if (dv < 0 && di <= 0) s.vaultPaid!++;
        s.vaultLv = Math.max(s.vaultLv ?? 1, (p as { vaultLevel?: number }).vaultLevel ?? 1);
      }
      lastCash.set(p.id, [p.inv.cash, p.vault.cash]);
    }
    if (trackMoves) for (const p of snap.players) {
      const b = brains[p.id - 1], d = p.alive && p.breakoutUntil === null ? b?.moveDir : null;
      moves[p.id - 1].push({ alive: p.alive && p.breakoutUntil === null, wx: d?.x ?? 0, wz: d?.z ?? 0, vx: p.vel.x, vz: p.vel.z, x: p.pos.x, z: p.pos.z });
      srcs[p.id - 1].push(b?.moveSrc ?? '?');
      goals[p.id - 1].push(b?.currentGoal ?? '?');
    }
    if ((snap.events as { type: string }[]).some((e) => ACTION_EVENTS.has(e.type))) lastAction = snap.time;
    if (snap.players.filter((p) => !p.eliminated).length >= 2 && snap.time - lastAction > deadAir) { deadAir = snap.time - lastAction; deadAirAt = lastAction; }
    if (ticks % SAMPLE_TICKS === 0) {
      const rivals = snap.players.filter((p) => !p.eliminated).length >= 2;
      const sd = snap.time >= SD;
      for (const p of snap.players) {
        const b = bunkers[p.island];
        const inOwn = Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= HOME_SIT_M;
        const underFire = snap.time - (healSeen[p.id - 1]?.hurtAt ?? -99) < 3 ||
          snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) < THREAT_M);
        const shutIn = sd && bunkers.some((c) => Math.hypot(p.pos.x - c.x, p.pos.z - c.z) <= HOME_SIT_M);
        // Earning or buying: at my own generator while it pays me, or paying at a shop, within the last EARN_SEC (the
        // slowest tier buys one item per 3 s): waiting for the price of the next buy, or buying it, not frozen.
        // Reported on its own (econMax).
        const earning = p.alive && snap.time - (earnAt.get(p.id) ?? -99) < EARN_SEC;
        if (earning) { const e0 = earnSince.get(p.id) ?? snap.time; earnSince.set(p.id, e0); const se = seats[p.id - 1]; if (snap.time - e0 > (se.econMax ?? 0)) { se.econMax = snap.time - e0; se.econAt = e0; } }
        else earnSince.delete(p.id);
        const a = still.get(p.id);
        if (!p.alive || p.eliminated || !rivals || p.breakoutUntil !== null || (inOwn && underFire) || shutIn || !a ||
            Math.hypot(p.pos.x - a.x, p.pos.z - a.z) > FROZEN_M || (a.t < SD && sd)) {
          still.set(p.id, { x: p.pos.x, z: p.pos.z, t: snap.time });
          continue;
        }
        const s = seats[p.id - 1], held = snap.time - a.t;
        // The brain probe records only while watched: switch it on 5 s before the gate, read it at the gate, then off.
        const wb = brains[p.id - 1] as (Brain & { watch?: (on: boolean) => void; debugBrain?: () => { goal?: string; why?: string } }) | undefined;
        if (!sd && held >= FROZEN_GATE_SEC - 5 && a.note === undefined) {
          if (held < FROZEN_GATE_SEC) wb?.watch?.(true);
          else {
            const d = wb?.debugBrain?.();
            wb?.watch?.(false);
            a.note = `${d?.goal ?? '?'}/${wb?.moveSrc ?? '?'}: ${d?.why ?? '?'} @ ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)}`;
          }
        }
        if (sd) s.frozenMaxSd = Math.max(s.frozenMaxSd ?? 0, held);
        else if (held > (s.frozenMax ?? 0)) { s.frozenMax = held; s.frozenAt = a.t; s.frozenNote = a.note; }
      }
      const dt = SAMPLE_TICKS / TICK_HZ;
      for (const p of snap.players) {
        if (!p.alive || p.breakoutUntil !== null) continue;
        const s = seats[p.id - 1];
        s.aliveSec += dt;
        const goal = brains[p.id - 1]?.currentGoal;
        if (goal && ATTACK_GOALS.has(goal)) s.attackSec += dt;
        const b = bunkers[p.island];
        const nearBunker = snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - b.x, o.pos.z - b.z) < THREAT_M);
        const armed = Object.keys(p.inv.weapons).length > 0 && p.inv.cash + p.vault.cash > 0;
        const sitting = armed && !nearBunker && !snap.sealed[p.island] && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= HOME_SIT_M;
        const st = sitting ? (homeStreak.get(p.id) ?? 0) + dt : 0;
        homeStreak.set(p.id, st);
        s.longestHomeIdle = Math.max(s.longestHomeIdle, st);
        const w = p.inv.weapons as Record<string, unknown>;
        const geared = !!(w.smg || w.rifle || w.shotgun) || p.inv.cash + p.vault.cash >= 150;
        if (geared && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= IDLE_M && !nearBunker && !snap.sealed[p.island]) s.idleHome += dt;
      }
    }
    // Heals: per tick (a drink or medkit starts and finishes within a sample interval).
    for (const p of snap.players as unknown as HealP[]) {
      const h = healSeen[p.id - 1], s = seats[p.id - 1];
      const n = healN(p), drinking = p.drinking ?? null, healAt = p.healAt ?? null;
      if (p.alive && h.alive) {
        const started = (healAt !== null && h.healAt === null) || (!!drinking && !h.drinking && drinking.kind !== 'speedPotion');
        if (started) {
          s.healsUsed!++;
          const foe = (snap.players as unknown as HealP[]).some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) < THREAT_M);
          if (foe || snap.time - h.hurtAt < 3) s.healsUsedFight!++;
        }
        const got = n - h.n + (started ? 1 : 0);
        if (got > 0) s.healsGot! += got;
      }
      if (p.alive && p.hp + p.shield <= 50) h.lowSince ??= snap.time; else if (p.alive) h.lowSince = null;
      h.alive = p.alive; h.n = n; h.healAt = healAt; h.drinking = drinking;
    }
    for (let i = 0; i < fight.length; i++) if (fight[i] && snap.time - fight[i]!.last > FIGHT_GAP) endFight(i, false);
    for (const e of snap.events) {
      if (e.type === 'placed') {
        const by = e.data.by as number, kind = e.data.kind as string;
        pieceOwner.set(e.data.piece as number, by);
        const f = fight[by - 1];
        if (f && kind !== 'scaffold') { f.pieces++; bo[by - 1].pieces++; bo[by - 1].kinds[kind] = (bo[by - 1].kinds[kind] ?? 0) + 1; }
      } else if (e.type === 'pieceHit') {
        const owner = pieceOwner.get(e.data.piece as number), by = e.data.by as number | null, at = e.data.pos as { x: number; z: number } | undefined;
        if (owner === undefined || by == null || by === owner || e.data.source !== 'bullet' || !at || !fight[owner - 1]) continue;
        const o = snap.players[owner - 1];
        if (o?.alive && Math.hypot(o.pos.x - at.x, o.pos.z - at.z) < BLOCK_M) bo[owner - 1].bulletsBlocked++;
      }
      if (e.type === 'hit') {
        const by = e.data.by as number | null, target = e.data.target as number;
        if (by != null && by !== target && healSeen[target - 1]) healSeen[target - 1].hurtAt = e.t;
        const a = by != null ? snap.players[by - 1]?.pos : undefined, t = snap.players[target - 1]?.pos;
        if (by == null || by === target || !a || !t) continue;
        seats[by - 1].damage! += Number(e.data.amount) || 0;
        seats[by - 1].hitDists.push(Math.round(Math.hypot(a.x - t.x, a.z - t.z)));
        seats[by - 1].hits!++;
        if (e.data.part === 'head') seats[by - 1].headshots!++;
        if (e.data.weapon === 'rifle') seats[by - 1].rifleHits!++;
        touch(by - 1, e.t); touch(target - 1, e.t);
        bo[by - 1].hits++;
        if (a.y - t.y >= HIGH_M) bo[by - 1].highHits++;
        const w = e.data.weapon as string | undefined;
        if (w && w !== 'fists' && w !== 'rocket' && w !== 'grenade' && w !== 'charge') bo[target - 1].bulletsTaken++;
      } else if (e.type === 'kill') {
        const v = e.data.victim as number, k = e.data.killer as number | null;
        seats[v - 1].deaths++;
        const ls = healSeen[v - 1].lowSince;
        if (ls !== null && e.t - ls >= 3) seats[v - 1].lowHpDeaths!++;
        healSeen[v - 1].lowSince = null;
        if (k != null && k !== v) { seats[k - 1].kills++; if (e.t >= SD) lateKills++; }
        if (k != null && k !== v && fight[k - 1]) { fight[k - 1]!.kill = true; endFight(k - 1, false); }
        endFight(v - 1, true);
      } else if (e.type === 'sealed') {
        const by = e.data.by as number | null | undefined;
        if (by != null && by !== e.data.owner && seats[by - 1]) seats[by - 1].seals!++;
        if (firstSeal === null && by != null && by !== e.data.owner && e.t < SD) firstSeal = e.t;
        if (by != null && by !== e.data.owner && e.t < SD) preSdSeals++;
      } else if ((e.type as string) === 'elimination') {
        if (e.data.by != null) { credited++; spoils += Number(e.data.spoils) || 0; const s = seats[(e.data.by as number) - 1]; if (s) s.elimsBy!++; }
      } else if ((e.type as string) === 'restock') {
        const s = seats[(e.data.player as number) - 1];
        if (s) s.restocks!++;
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (seats[id - 1].eliminatedAt === null) {
          seats[id - 1].eliminatedAt = e.t;
          if (e.t < SD) preSdElims++;
          elims++;
        }
      }
    }
  }
  for (let i = 0; i < fight.length; i++) endFight(i, false);
  seats.forEach((s, i) => { s.build = bo[i]; });
  const msPerTick = (performance.now() - w0) / Math.max(1, ticks);
  if (trackMoves) seats.forEach((s, k) => {
    const st = ms!.moveStats(moves[k], 1 / TICK_HZ);
    const count = (ix: number[]) => { const o: Record<string, number> = {}; for (const i of ix) o[srcs[k][i]] = (o[srcs[k][i]] ?? 0) + 1; return o; };
    s.jitter = {
      aliveSec: st.aliveSec, wishFlips: st.wishFlips.length, velFlips: st.velFlips.length, oscSec: st.oscSec, episodes: st.episodes.length,
      bySrc: count(st.wishFlips), velBySrc: count(st.velFlips),
      ...(st.rapidFlips ? { rapidFlips: st.rapidFlips.length, rapidBySrc: count(st.rapidFlips) } : {}),
      worst: [...st.episodes].sort((a, b) => b.flips.length - a.flips.length).slice(0, 3).map((e) => ({
        t: Math.round(e.i0 / TICK_HZ * 10) / 10, x: Math.round(moves[k][e.i0].x * 10) / 10, z: Math.round(moves[k][e.i0].z * 10) / 10,
        goal: goals[k][e.i0], flips: e.flips.length, srcs: [...new Set(e.flips.map((i) => srcs[k][i]))].join(' '),
      })),
    };
  });
  // Rapier worlds live in WASM memory and are never garbage collected.
  (m as unknown as { physics?: { world?: { free?: () => void } } }).physics?.world?.free?.();
  const winner = snap.winner !== null && snap.winner > 0 ? snap.winner : null;
  for (const s of seats) s.inGameSec = s.eliminatedAt ?? snap.time;
  return {
    scenario, seed, winner, winnerDifficulty: winner ? diffs[winner - 1] : null, time: snap.time,
    decisive: winner !== null && snap.time < SD, preSdElims, preSdSeals, lateKills, elims, credited, spoils, firstSeal, msPerTick, wallSec: (performance.now() - w0) / 1000, seats,
    deadAir, deadAirAt,
  };
}

// ---------- aggregation ----------

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
/** Half-width of the 95% CI of a mean of per-game scores (normal approximation, as scripts/train/generation.ts). */
export function ci95(xs: number[]): number {
  if (xs.length < 2) return 1;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return 1.96 * Math.sqrt(v / xs.length);
}

/**
 * Final placement of each seat (1 = best): the winner, then anyone never eliminated (tied), then the eliminated,
 * the later out the better (same elimination time: tied). Ties share the average of their places.
 */
export function placements(g: GameOut): number[] {
  const n = g.seats.length, win = g.winner !== null ? g.winner - 1 : -1;
  const groups: number[][] = [];
  if (win >= 0) groups.push([win]);
  const idx = Array.from({ length: n }, (_, i) => i).filter((i) => i !== win);
  const alive = idx.filter((i) => g.seats[i].eliminatedAt === null);
  if (alive.length) groups.push(alive);
  const out = idx.filter((i) => g.seats[i].eliminatedAt !== null).sort((a, b) => g.seats[b].eliminatedAt! - g.seats[a].eliminatedAt!);
  for (const i of out) {
    const last = groups[groups.length - 1];
    if (last && last[0] !== win && g.seats[last[0]].eliminatedAt === g.seats[i].eliminatedAt) last.push(i); else groups.push([i]);
  }
  const place = new Array<number>(n);
  let next = 1;
  for (const grp of groups) { for (const i of grp) place[i] = next + (grp.length - 1) / 2; next += grp.length; }
  return place;
}

type Check = { name: string; pass: boolean; value: string };
type Share = { share: number; ci95: number; games: number };
export type ScenarioSummary = {
  scenario: Scenario; games: number; seeds: number[]; decisive: number; noWinner: number;
  winsByDifficulty: Record<string, number>; medianPreSdElims: number | null; medianEngagementM: number | null;
  attackPct: number; homePct: number; medianFirstSealSec: number | null; gamesWithSeal: number;
  /** Seals (by a rival, before sudden death) per game: median and mean. */
  medianSeals: number | null; meanSeals: number;
  longestHomeSitSec: number; avgMinutes: number; msPerTick: number; maxWallSec: number;
  /** Kept for older readers: the same as `ladder` on 1v1-pro-vs-hard. */
  proVsHard: Share | null;
  /** 1v1 ladder scenarios: the higher tier's share of games (a game with no winner counts half). */
  ladder: (Share & { higher: Difficulty; lower: Difficulty; wilson?: [number, number] }) | null;
  /** Same-game per-tier stats (spec §7.3), rates per minute in the game. Absent: shards without the fields. */
  tierStats?: Partial<Record<Difficulty, TierStats>>;
  /** Scenarios with a UserProxy seat: its share of wins (Wilson 95% CI). */
  userproxyWins?: { wins: number; games: number; share: number; wilson: [number, number] };
  /** FFAs with more than one tier: mean final placement per tier (1 = won), its 95% CI and number of seats. */
  placementByTier: Partial<Record<Difficulty, { mean: number; ci95: number; n: number }>> | null;
  /** Per game (all seats): heals got, used, used mid-fight, deaths after ≥ 3 s at ≤ 50 hp + shield. Null: shards without heal data. */
  heals: { got: number; used: number; usedFight: number; lowHpDeaths: number; deaths: number } | null;
  /** Combat building per skill (absent when the shards predate it). */
  build?: Record<string, BuildSummary>;
  /** Vault use per game (all seats together). */
  vault: { deposits: number; banked: number; vaultPaid: number; restocks: number; interest: number; upgrades: number };
  shipCheck: { pass: boolean | null; checks: Check[] };
  /**
   * Stalls (absent on old shard files): the longest frozen bot (s) before sudden death, where (seed, seat, start), and
   * from sudden death on; games with a bot frozen ≥ FROZEN_GATE_SEC; longest and median per-game dead air (s).
   */
  stalls?: { frozenMax: number; worst: string; frozenMaxSd: number; gamesFrozen: number; deadAirMax: number; deadAirWorst: string; deadAirMedian: number | null; freezes?: string[]; earnMax?: number; earnWorst?: string };
  /** Means per game (absent on old shard files): kills at 15:00+, eliminations, credited eliminations, spoils paid. */
  perGame?: { lateKills: number; elims: number; credited: number; spoils: number };
  /** Movement jitter per tier (per minute alive), the layers behind the flips, and the worst episodes. */
  jitter?: {
    byTier: Partial<Record<Difficulty, { rapidPerMin: number; flipsPerMin: number; velFlipsPerMin: number; oscSecPer10Min: number; episodesPer10Min: number; worstSeatFlipsPerMin: number; seats: number }>>;
    bySrc: { src: string; rapid: number; flips: number; velFlips: number }[];
    worst: { seed: number; seat: number; difficulty: Difficulty; t: number; x: number; z: number; goal: string; flips: number; srcs: string }[];
  };
};

export type TierStats = {
  seats: number; headshotPct: number; kd: number; killsPerMin: number; sealsPerMin: number; elimsPerMin: number;
  hitsPerMin: number; dmgPerHit: number; medianRangeM: number | null; rifleHitPct: number;
};

/** Wilson score interval (95%) for k successes in n (k may be fractional: a draw counts half). */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, den = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function tierStats(games: GameOut[]): Partial<Record<Difficulty, TierStats>> | undefined {
  const seats = games.flatMap((g) => g.seats);
  if (!seats.length || seats.some((x) => x.hits === undefined)) return undefined;
  const out: Partial<Record<Difficulty, TierStats>> = {};
  for (const d of TIERS) {
    const xs = seats.filter((x) => x.difficulty === d);
    if (!xs.length) continue;
    const sum = (f: (x: SeatOut) => number) => xs.reduce((a, x) => a + f(x), 0);
    const min = sum((x) => x.inGameSec ?? 0) / 60 || 1, hits = sum((x) => x.hits ?? 0);
    out[d] = {
      seats: xs.length, headshotPct: (100 * sum((x) => x.headshots ?? 0)) / Math.max(1, hits), kd: sum((x) => x.kills) / Math.max(1, sum((x) => x.deaths)),
      killsPerMin: sum((x) => x.kills) / min, sealsPerMin: sum((x) => x.seals ?? 0) / min, elimsPerMin: sum((x) => x.elimsBy ?? 0) / min,
      hitsPerMin: hits / min, dmgPerHit: sum((x) => x.damage ?? 0) / Math.max(1, hits), medianRangeM: median(xs.flatMap((x) => x.hitDists)),
      rifleHitPct: (100 * sum((x) => x.rifleHits ?? 0)) / Math.max(1, hits),
    };
  }
  return out;
}

export type BuildSummary = {
  fights: number; piecesPerFight: number; builtShare: number; winBuilt: number | null; winPlain: number | null;
  blockedPct: number; highPct: number; kinds: Record<string, number>;
};
export function buildSummary(outs: BuildOut[]): BuildSummary {
  const sum = (f: (b: BuildOut) => number) => outs.reduce((a, b) => a + f(b), 0);
  const fights = sum((b) => b.fights), built = sum((b) => b.built), taken = sum((b) => b.bulletsTaken), blocked = sum((b) => b.bulletsBlocked);
  const kinds: Record<string, number> = {};
  for (const b of outs) for (const [k, n] of Object.entries(b.kinds)) kinds[k] = (kinds[k] ?? 0) + n;
  return {
    fights, piecesPerFight: sum((b) => b.pieces) / Math.max(1, fights), builtShare: built / Math.max(1, fights),
    winBuilt: built ? sum((b) => b.builtWon) / built : null, winPlain: fights - built ? sum((b) => b.plainWon) / (fights - built) : null,
    blockedPct: (100 * blocked) / Math.max(1, blocked + taken), highPct: (100 * sum((b) => b.highHits)) / Math.max(1, sum((b) => b.hits)), kinds,
  };
}

function jitterSummary(games: GameOut[]): ScenarioSummary['jitter'] {
  const rows = games.flatMap((g) => g.seats.map((s, i) => ({ g, s, i }))).filter((r) => r.s.jitter);
  if (!rows.length) return undefined;
  const byTier: NonNullable<ScenarioSummary['jitter']>['byTier'] = {};
  for (const d of TIERS) {
    const xs = rows.filter((r) => r.s.difficulty === d).map((r) => r.s.jitter!);
    if (!xs.length) continue;
    const min = xs.reduce((a, j) => a + j.aliveSec, 0) / 60 || 1;
    byTier[d] = {
      rapidPerMin: xs.reduce((a, j) => a + (j.rapidFlips ?? 0), 0) / min,
      flipsPerMin: xs.reduce((a, j) => a + j.wishFlips, 0) / min, velFlipsPerMin: xs.reduce((a, j) => a + j.velFlips, 0) / min,
      oscSecPer10Min: (10 * xs.reduce((a, j) => a + j.oscSec, 0)) / min, episodesPer10Min: (10 * xs.reduce((a, j) => a + j.episodes, 0)) / min,
      worstSeatFlipsPerMin: Math.max(...xs.map((j) => (j.rapidFlips ?? 0) / Math.max(1, j.aliveSec / 60))), seats: xs.length,
    };
  }
  const src = new Map<string, { rapid: number; flips: number; velFlips: number }>();
  const at = (k: string) => { let e = src.get(k); if (!e) src.set(k, (e = { rapid: 0, flips: 0, velFlips: 0 })); return e; };
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.s.jitter!.rapidBySrc ?? {})) at(k).rapid += n;
    for (const [k, n] of Object.entries(r.s.jitter!.bySrc)) at(k).flips += n;
    for (const [k, n] of Object.entries(r.s.jitter!.velBySrc)) at(k).velFlips += n;
  }
  return {
    byTier,
    bySrc: [...src].map(([k, v]) => ({ src: k, ...v })).sort((a, b) => b.rapid - a.rapid || b.flips - a.flips),
    worst: rows.flatMap((r) => r.s.jitter!.worst.map((w) => ({ seed: r.g.seed, seat: r.i + 1, difficulty: r.s.difficulty, ...w })))
      .sort((a, b) => b.flips - a.flips).slice(0, 12),
  };
}

export function summarize(scenario: Scenario, games: GameOut[]): ScenarioSummary {
  const seats = games.flatMap((g) => g.seats);
  const alive = seats.reduce((a, s) => a + s.aliveSec, 0) || 1;
  const wins: Record<string, number> = {};
  for (const g of games) if (g.winnerDifficulty) wins[g.winnerDifficulty] = (wins[g.winnerDifficulty] ?? 0) + 1;
  const seals = games.filter((g) => g.firstSeal !== null).map((g) => g.firstSeal!);
  let ladder: ScenarioSummary['ladder'] = null;
  const pair = LADDER[scenario];
  if (pair) {
    const scores: number[] = games.map((g) => (g.winner === null ? 0.5 : g.winnerDifficulty === pair[0] ? 1 : 0));
    const won = scores.reduce((a, b) => a + b, 0);
    ladder = { higher: pair[0], lower: pair[1], share: won / Math.max(1, scores.length), ci95: ci95(scores), games: scores.length, wilson: wilson(won, scores.length) };
  }
  const proVsHard: ScenarioSummary['proVsHard'] = scenario === '1v1-pro-vs-hard' && ladder ? { share: ladder.share, ci95: ladder.ci95, games: ladder.games } : null;
  let placementByTier: ScenarioSummary['placementByTier'] = null;
  if (scenario.startsWith('ffa8') && new Set(games.flatMap((g) => g.seats.map((x) => x.difficulty))).size > 1) {
    const by = new Map<Difficulty, number[]>();
    for (const g of games) placements(g).forEach((p, i) => { const d = g.seats[i].difficulty; by.set(d, [...(by.get(d) ?? []), p]); });
    placementByTier = Object.fromEntries(TIERS.filter((d) => by.has(d)).map((d) => {
      const xs = by.get(d)!;
      return [d, { mean: xs.reduce((a, b) => a + b, 0) / xs.length, ci95: ci95(xs), n: xs.length }];
    }));
  }
  const s: ScenarioSummary = {
    scenario, games: games.length, seeds: games.map((g) => g.seed).sort((a, b) => a - b),
    decisive: games.filter((g) => g.decisive).length, noWinner: games.filter((g) => g.winner === null).length,
    winsByDifficulty: wins,
    medianPreSdElims: median(games.map((g) => g.preSdElims)),
    medianEngagementM: median(seats.flatMap((x) => x.hitDists)),
    attackPct: (100 * seats.reduce((a, x) => a + x.attackSec, 0)) / alive,
    homePct: (100 * seats.reduce((a, x) => a + x.idleHome, 0)) / alive,
    medianFirstSealSec: median(seals), gamesWithSeal: seals.length,
    medianSeals: median(games.map((g) => g.preSdSeals ?? 0)), meanSeals: games.reduce((a, g) => a + (g.preSdSeals ?? 0), 0) / Math.max(1, games.length),
    longestHomeSitSec: Math.max(0, ...seats.map((x) => x.longestHomeIdle)),
    avgMinutes: games.reduce((a, g) => a + g.time, 0) / Math.max(1, games.length) / 60,
    msPerTick: games.reduce((a, g) => a + g.msPerTick, 0) / Math.max(1, games.length),
    maxWallSec: Math.max(0, ...games.map((g) => g.wallSec)),
    proVsHard, ladder, placementByTier,
    tierStats: tierStats(games),
    ...(games.some((g) => g.seats.some((x) => x.difficulty === 'userproxy')) ? { userproxyWins: (() => {
      const w = games.filter((g) => g.winnerDifficulty === 'userproxy').length;
      return { wins: w, games: games.length, share: w / Math.max(1, games.length), wilson: wilson(w, games.length) };
    })() } : {}),
    heals: seats.every((x) => x.healsUsed !== undefined) ? {
      got: seats.reduce((a, x) => a + x.healsGot!, 0) / Math.max(1, games.length),
      used: seats.reduce((a, x) => a + x.healsUsed!, 0) / Math.max(1, games.length),
      usedFight: seats.reduce((a, x) => a + x.healsUsedFight!, 0) / Math.max(1, games.length),
      lowHpDeaths: seats.reduce((a, x) => a + x.lowHpDeaths!, 0) / Math.max(1, games.length),
      deaths: seats.reduce((a, x) => a + x.deaths, 0) / Math.max(1, games.length),
    } : null,
    vault: (() => {
      const per = (k: 'deposits' | 'banked' | 'vaultPaid' | 'restocks' | 'interest') => seats.reduce((a, x) => a + (x[k] ?? 0), 0) / Math.max(1, games.length);
      const upgrades = seats.reduce((a, x) => a + ((x.vaultLv ?? 1) - 1), 0) / Math.max(1, games.length);
      return { deposits: per('deposits'), banked: per('banked'), vaultPaid: per('vaultPaid'), restocks: per('restocks'), interest: per('interest'), upgrades };
    })(),
    shipCheck: { pass: null, checks: [] },
    perGame: (['lateKills', 'elims', 'credited', 'spoils'] as const).reduce((o, k) => ({ ...o, [k]: games.reduce((a, g) => a + (g[k] ?? 0), 0) / Math.max(1, games.length) }),
      {} as { lateKills: number; elims: number; credited: number; spoils: number }),
    jitter: jitterSummary(games),
  };
  if (seats.every((x) => x.frozenMax !== undefined) && games.every((g) => g.deadAir !== undefined)) {
    let worst = '-', frozenMax = 0, frozenMaxSd = 0, gamesFrozen = 0, deadAirMax = 0, deadAirWorst = '-';
    const freezes: [number, string][] = [];
    let earn = 0, earnWorst = '-';
    for (const g of games) {
      g.seats.forEach((x, i) => {
        if ((x.econMax ?? 0) > earn) { earn = x.econMax!; earnWorst = `seed ${g.seed} p${i + 1} ${x.difficulty} from ${secs(x.econAt ?? 0)}`; }
        if (x.frozenMax! >= FROZEN_GATE_SEC) freezes.push([x.frozenMax!, `${x.frozenMax!.toFixed(0)} s seed ${g.seed} p${i + 1} ${x.difficulty} from ${secs(x.frozenAt ?? 0)}: ${x.frozenNote ?? '-'}`]);
        if (x.frozenMax! > frozenMax) { frozenMax = x.frozenMax!; worst = `seed ${g.seed} p${i + 1} ${x.difficulty} from ${secs(x.frozenAt ?? 0)}`; }
        frozenMaxSd = Math.max(frozenMaxSd, x.frozenMaxSd ?? 0);
      });
      if (g.seats.some((x) => Math.max(x.frozenMax!, x.frozenMaxSd ?? 0) >= FROZEN_GATE_SEC)) gamesFrozen++;
      if (g.deadAir! > deadAirMax) { deadAirMax = g.deadAir!; deadAirWorst = `seed ${g.seed} from ${secs(g.deadAirAt ?? 0)}`; }
    }
    s.stalls = { frozenMax, worst, frozenMaxSd, gamesFrozen, deadAirMax, deadAirWorst, deadAirMedian: median(games.map((g) => g.deadAir!)), freezes: freezes.sort((a, b) => b[0] - a[0]).map(([, t]) => t), earnMax: earn, earnWorst };
  }
  const withBuild = seats.filter((x) => x.build);
  if (withBuild.length) {
    s.build = {};
    for (const d of ['pro', 'hard', 'medium', 'easy']) {
      const outs = withBuild.filter((x) => x.difficulty === d).map((x) => x.build!);
      if (outs.length) s.build[d] = buildSummary(outs);
    }
  }
  // Gates from tests/sim/shipChecks.test.ts (8-bot FFA) and tests/sim/botSeries.test.ts (PRO beats hard ≥ 70%; the ladder bar here is 80% per step, the steward hand-off rule).
  // The shipChecks comparisons against the hand-tuned params need a second series and are not run here.
  const checks: Check[] = [];
  if (scenario.startsWith('ffa8')) {
    checks.push({ name: 'decisive before sudden death ≥ 60%', pass: s.decisive >= 0.6 * s.games, value: `${s.decisive}/${s.games}` });
    checks.push({ name: 'median engagement < 25 m', pass: s.medianEngagementM !== null && s.medianEngagementM < 25, value: `${s.medianEngagementM ?? '-'} m` });
    checks.push({ name: 'nobody sits at home geared > 60 s', pass: s.longestHomeSitSec <= 60, value: `${s.longestHomeSitSec.toFixed(0)} s` });
  } else if (ladder) {
    const name = scenario === '1v1-pro-vs-hard' ? 'PRO beats hard' : `${ladder.higher} beats ${ladder.lower}`;
    checks.push({ name: `${name} ≥ 80%`, pass: ladder.share >= 0.8, value: `${(100 * ladder.share).toFixed(0)}%` });
  }
  // Frozen bots (replay a.faereplay: two PROs stood still 10.7 min): the mixed FFA and the 4-PRO game.
  if ((scenario === 'ffa8-mixed' || scenario === 'ffa4-pro') && s.stalls) {
    const worst = Math.max(s.stalls.frozenMax, s.stalls.frozenMaxSd);
    checks.push({ name: `no bot frozen ≥ ${FROZEN_GATE_SEC} s`, pass: worst < FROZEN_GATE_SEC, value: `${worst.toFixed(0)} s (${s.stalls.gamesFrozen} games)` });
  }
  s.shipCheck = { pass: checks.length ? checks.every((c) => c.pass) : null, checks };
  return s;
}

const pct = (x: number) => `${x.toFixed(0)}%`;
const secs = (x: number | null) => (x === null ? '-' : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`);

export function markdown(sums: ScenarioSummary[], meta: Record<string, string>): string {
  const overall = sums.map((s) => s.shipCheck.pass).filter((p) => p !== null);
  const lines = [
    `## Bot measurement ${overall.length ? (overall.every(Boolean) ? '✅ ship checks pass' : '❌ ship checks fail') : ''}`,
    '',
    Object.entries(meta).map(([k, v]) => `**${k}** ${v}`).join(' · '),
    '',
    '| scenario | games | decisive < 15:00 | median elims < 15:00 | median engagement | attack | home | median first seal | seals < 15:00 per game (median / mean) | higher tier wins (95% CI) | avg length | ship check |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...sums.map((s) => `| ${s.scenario} | ${s.games} | ${s.decisive}/${s.games} | ${s.medianPreSdElims ?? '-'} | ${s.medianEngagementM ?? '-'} m | ${pct(s.attackPct)} | ${pct(s.homePct)} | ${secs(s.medianFirstSealSec)} (${s.gamesWithSeal}/${s.games} games) | ${s.medianSeals ?? '-'} / ${(s.meanSeals ?? 0).toFixed(1)} | ${s.ladder ? `${(100 * s.ladder.share).toFixed(0)}% ± ${(100 * s.ladder.ci95).toFixed(0)}` : '-'} | ${s.avgMinutes.toFixed(1)} min | ${s.shipCheck.pass === null ? 'n/a' : s.shipCheck.pass ? '✅ pass' : '❌ fail'} |`),
    '',
    '### Ship-check details',
    ...sums.flatMap((s) => s.shipCheck.checks.map((c) => `- ${s.scenario}: ${c.pass ? '✅' : '❌'} ${c.name} (${c.value})`)),
    '',
    '### Heals per game (all seats)',
    '| scenario | heals got | heals used | used mid-fight | low-hp deaths (≥3 s at ≤50) | deaths |',
    '|---|---|---|---|---|---|',
    ...sums.map((s) => s.heals ? `| ${s.scenario} | ${s.heals.got.toFixed(1)} | ${s.heals.used.toFixed(1)} | ${s.heals.usedFight.toFixed(1)} | ${s.heals.lowHpDeaths.toFixed(1)} | ${s.heals.deaths.toFixed(1)} |` : `| ${s.scenario} | - | - | - | - | - |`),
    '',
    ...(sums.some((s) => s.ladder) ? ['### 1v1 ladder', '',
      '| matchup | higher tier wins | 95% CI | games |', '|---|---|---|---|',
      ...sums.filter((s) => s.ladder).map((s) => `| ${s.ladder!.higher} vs ${s.ladder!.lower} | ${(100 * s.ladder!.share).toFixed(0)}% | ± ${(100 * s.ladder!.ci95).toFixed(0)}${s.ladder!.wilson ? ` (Wilson ${(100 * s.ladder!.wilson[0]).toFixed(0)}–${(100 * s.ladder!.wilson[1]).toFixed(0)}%)` : ''} | ${s.ladder!.games} |`), ''] : []),
    ...sums.filter((s) => s.userproxyWins).flatMap((s) => [`### ${s.scenario}: UserProxy wins ${s.userproxyWins!.wins}/${s.userproxyWins!.games} = ${(100 * s.userproxyWins!.share).toFixed(1)}% (Wilson 95% ${(100 * s.userproxyWins!.wilson[0]).toFixed(1)}–${(100 * s.userproxyWins!.wilson[1]).toFixed(1)}%)`, '']),
    ...sums.filter((s) => s.tierStats).flatMap((s) => [`### ${s.scenario}: per-tier stats from the same games (per minute in the game)`, '',
      '| tier | seats | headshot % | K/D | kills/min | seals/min | elims/min | hits/min | dmg/hit | median range | rifle hits |', '|---|---|---|---|---|---|---|---|---|---|---|',
      ...Object.entries(s.tierStats!).map(([d, t]) => `| ${d} | ${t!.seats} | ${t!.headshotPct.toFixed(1)}% | ${t!.kd.toFixed(2)} | ${t!.killsPerMin.toFixed(2)} | ${t!.sealsPerMin.toFixed(3)} | ${t!.elimsPerMin.toFixed(3)} | ${t!.hitsPerMin.toFixed(1)} | ${t!.dmgPerHit.toFixed(1)} | ${t!.medianRangeM ?? '-'} m | ${t!.rifleHitPct.toFixed(0)}% |`), '']),
    ...sums.filter((s) => s.placementByTier).flatMap((s) => [`### ${s.scenario}: average placement by tier (1 = won)`, '',
      '| tier | mean placement | 95% CI | seats |', '|---|---|---|---|',
      ...Object.entries(s.placementByTier!).map(([d, p]) => `| ${d} | ${p!.mean.toFixed(2)} | ± ${p!.ci95.toFixed(2)} | ${p!.n} |`), '']),
    `### Stalls (frozen: alive, a rival in the game, moved ≤ ${FROZEN_M} m; dead air: no hit, kill or build anywhere)`, '',
    '| scenario | frozen max before 15:00 | worst | frozen max 15:00+ | games with a ≥ 45 s freeze | dead air max | worst | dead air median |', '|---|---|---|---|---|---|---|---|',
    ...sums.filter((s) => s.stalls).map((s) => { const x = s.stalls!; return `| ${s.scenario} | ${x.frozenMax.toFixed(0)} s | ${x.worst} | ${x.frozenMaxSd.toFixed(0)} s | ${x.gamesFrozen}/${s.games} | ${x.deadAirMax.toFixed(0)} s | ${x.deadAirWorst} | ${x.deadAirMedian === null ? '-' : x.deadAirMedian.toFixed(0)} s |`; }), '',
    ...sums.filter((s) => s.stalls?.earnMax !== undefined).map((s) => `${s.scenario}: longest stretch earning at a generator (own or the center's gold) or buying (still counted as frozen): ${s.stalls!.earnMax!.toFixed(0)} s (${s.stalls!.earnWorst})`), '',
    ...sums.filter((s) => s.stalls?.freezes?.length).flatMap((s) => [`${s.scenario} freezes ≥ ${FROZEN_GATE_SEC} s (goal/move layer: why, when it hit ${FROZEN_GATE_SEC} s):`, ...s.stalls!.freezes!.slice(0, 25).map((t) => `- ${t}`), '']),
    '### Eliminations per game (means)', '',
    '| scenario | kills 15:00+ | eliminations | credited | spoils paid |', '|---|---|---|---|---|',
    ...sums.filter((s) => s.perGame).map((s) => `| ${s.scenario} | ${s.perGame!.lateKills.toFixed(1)} | ${s.perGame!.elims.toFixed(1)} | ${s.perGame!.credited.toFixed(1)} | $${s.perGame!.spoils.toFixed(0)} |`), '',
    '### Combat building',
    '| scenario | skill | fights | pieces / fight | fights with building | win % building | win % not | bullets blocked by own cover | hits from high ground | pieces |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...sums.flatMap((s) => Object.entries(s.build ?? {}).map(([d, b]) => `| ${s.scenario} | ${d} | ${b.fights} | ${b.piecesPerFight.toFixed(2)} | ${pct(100 * b.builtShare)} | ${b.winBuilt === null ? '-' : pct(100 * b.winBuilt)} | ${b.winPlain === null ? '-' : pct(100 * b.winPlain)} | ${b.blockedPct.toFixed(1)}% | ${b.highPct.toFixed(1)}% | ${Object.entries(b.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || '-'} |`)),
    '',
    '### Vault use per game (all seats)', '',
    '| scenario | deposits | $ banked | shop buys paid from vault | respawn restocks | $ interest | vault levels bought |', '|---|---|---|---|---|---|---|',
    ...sums.map((s) => `| ${s.scenario} | ${(s.vault?.deposits ?? 0).toFixed(1)} | $${Math.round(s.vault?.banked ?? 0)} | ${(s.vault?.vaultPaid ?? 0).toFixed(1)} | ${(s.vault?.restocks ?? 0).toFixed(1)} | $${Math.round(s.vault?.interest ?? 0)} | ${(s.vault?.upgrades ?? 0).toFixed(1)} |`), '',
    ...sums.filter((s) => s.jitter).flatMap((s) => {
      const j = s.jitter!;
      const totalRapid = j.bySrc.reduce((a, x) => a + x.rapid, 0) || 1;
      return [`### ${s.scenario}: movement jitter (flip = walk turns > 120° within 0.3 s; rapid = a flip within 0.4 s of the last; episode = 3+ flips within 1 m)`, '',
        '| tier | rapid flips/min | flips/min | velocity flips/min | jitter s / 10 min | episodes / 10 min | worst seat rapid/min | seats |', '|---|---|---|---|---|---|---|---|',
        ...Object.entries(j.byTier).map(([d, t]) => `| ${d} | ${t!.rapidPerMin.toFixed(2)} | ${t!.flipsPerMin.toFixed(1)} | ${t!.velFlipsPerMin.toFixed(1)} | ${t!.oscSecPer10Min.toFixed(1)} | ${t!.episodesPer10Min.toFixed(2)} | ${t!.worstSeatFlipsPerMin.toFixed(1)} | ${t!.seats} |`), '',
        `Rapid flips by movement layer: ${j.bySrc.slice(0, 14).map((x) => `${x.src} ${(100 * x.rapid / totalRapid).toFixed(0)}% (${x.rapid}; all flips ${x.flips}, vel ${x.velFlips})`).join(' · ')}`, '',
        'Worst episodes: ' + (j.worst.length ? '' : 'none'), ...j.worst.map((w) => `- seed ${w.seed} seat ${w.seat} (${w.difficulty}) t=${w.t}s at (${w.x}, ${w.z}) goal ${w.goal}: ${w.flips} flips · ${w.srcs}`), ''];
    }),
    '### Wins by skill',
    ...sums.map((s) => `- ${s.scenario}: ${Object.entries(s.winsByDifficulty).map(([d, n]) => `${d} ${n}`).join(', ') || 'none'}; no winner ${s.noWinner} · ${s.msPerTick.toFixed(2)} ms/tick · slowest game ${s.maxWallSec.toFixed(0)} s wall`),
  ];
  return lines.join('\n') + '\n';
}

// ---------- CLI / worker plumbing ----------

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const get = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
  const need = (name: string) => { const v = get(name); if (!v) throw new Error(`measure: --${name} is required`); return v; };
  const cmd = args[0];
  if (cmd === 'run') {
    const tasks = need('tasks').split(',').filter(Boolean).map((t) => {
      const [sc, seed] = t.split(':');
      if (!(SCENARIOS as readonly string[]).includes(sc) || !Number.isInteger(Number(seed))) throw new Error(`measure: bad task "${t}" (want <scenario>:<seed>)`);
      return { scenario: sc as Scenario, seed: Number(seed) };
    });
    const params = get('params') ? path.resolve(get('params')!) : null;
    if (params && !fs.existsSync(params)) throw new Error(`measure: params file ${params} not found`);
    const nWorkers = Math.max(1, Math.min(tasks.length, Number(get('workers') ?? os.availableParallelism())));
    console.log(`measure: ${tasks.length} games on ${nWorkers} workers${params ? ` with params ${params}` : ''}`);
    const out: GameOut[] = [];
    const queue = [...tasks];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
    // One child process per game (same node + tsx loader flags), N at a time: a fresh WASM heap per game.
    await Promise.all(Array.from({ length: nWorkers }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const file = path.join(tmp, `${t.scenario}-${t.seed}.json`);
        const argv = [...process.execArgv, process.argv[1], 'one', '--task', `${t.scenario}:${t.seed}`, '--out', file, ...(params ? ['--params', params] : [])];
        const code = await new Promise<number | null>((resolve, reject) => {
          const c = spawn(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
          c.on('error', reject);
          c.on('exit', resolve);
        });
        if (code !== 0) throw new Error(`measure: ${t.scenario} seed ${t.seed} exited with code ${code}`);
        const r = JSON.parse(fs.readFileSync(file, 'utf8')) as GameOut;
        console.log(`${r.scenario} seed ${r.seed}: winner ${r.winner ?? 'none'}${r.winnerDifficulty ? ` (${r.winnerDifficulty})` : ''} at ${(r.time / 60).toFixed(1)} min · decisive ${r.decisive} · elims<15:00 ${r.preSdElims} · first seal ${secs(r.firstSeal)} · ${r.msPerTick.toFixed(2)} ms/tick · ${r.wallSec.toFixed(0)} s`);
        out.push(r);
      }
    }));
    fs.writeFileSync(need('out'), JSON.stringify({ games: out }));
  } else if (cmd === 'one') {
    const [sc, seed] = need('task').split(':');
    fs.writeFileSync(need('out'), JSON.stringify(await runOne(sc as Scenario, Number(seed), get('params'))));
  } else if (cmd === 'aggregate') {
    const dir = need('in');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json')) files.push(p); } };
    walk(dir);
    if (!files.length) throw new Error(`measure: no shard results under ${dir}`);
    const games = files.flatMap((f) => (JSON.parse(fs.readFileSync(f, 'utf8')) as { games: GameOut[] }).games);
    const expected = Number(get('expect') ?? games.length);
    if (games.length !== expected) throw new Error(`measure: expected ${expected} games, got ${games.length} (a shard failed?)`);
    const byScenario = SCENARIOS.map((sc) => games.filter((g) => g.scenario === sc)).filter((g) => g.length);
    const sums = byScenario.map((g) => summarize(g[0].scenario, g));
    const meta: Record<string, string> = {};
    for (const k of ['ref', 'sha', 'scenario', 'seeds', 'params', 'label', 'run']) if (get(k)) meta[k] = get(k)!;
    const md = markdown(sums, meta);
    const ship = sums.map((s) => s.shipCheck.pass).filter((p) => p !== null);
    fs.writeFileSync(need('json'), JSON.stringify({ meta, shipCheckPass: ship.length ? ship.every(Boolean) : null, scenarios: sums }, null, 2) + '\n');
    fs.writeFileSync(need('md'), md);
    console.log(md);
  } else {
    throw new Error(`measure: unknown command "${cmd}" (run | aggregate)`);
  }
}
