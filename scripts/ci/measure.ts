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

type Difficulty = 'easy' | 'medium' | 'hard' | 'pro';
export const SCENARIOS = ['1v1-hard', '1v1-pro-vs-hard', '1v1-hard-vs-medium', '1v1-medium-vs-easy', 'ffa8-pro', 'ffa8-hard', 'ffa8-mixed', 'ffa8-pro-arch', 'ffa8-hard-arch', '1v1-pro-arch', 'ffa3-pro'] as const;
type Scenario = (typeof SCENARIOS)[number];

const SD = 900; // LIFECYCLE.suddenDeathAt (checked against the sim at runtime)
const ATTACK_GOALS = new Set(['attack', 'seal', 'bridge', 'raid', 'fight']);
const IDLE_M = 8, THREAT_M = 30, SAMPLE_TICKS = 15, HOME_SIT_M = 6;
/** The 1v1 skill ladder: each scenario pits the higher tier against the one below. */
const LADDER: Partial<Record<Scenario, [Difficulty, Difficulty]>> = {
  '1v1-pro-vs-hard': ['pro', 'hard'], '1v1-hard-vs-medium': ['hard', 'medium'], '1v1-medium-vs-easy': ['medium', 'easy'],
};
const TIERS: Difficulty[] = ['pro', 'hard', 'medium', 'easy'];

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
    case 'ffa8-hard': return { diffs: Array(8).fill('hard'), maxSec: SD + 180 };
    case 'ffa8-mixed': return { diffs: ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'], maxSec: SD + 180 };
    case 'ffa8-pro-arch': return { diffs: Array(8).fill('pro'), maxSec: SD + 180 };
    case 'ffa8-hard-arch': return { diffs: Array(8).fill('hard'), maxSec: SD + 180 };
    case '1v1-pro-arch': return { diffs: ['pro', 'pro'], maxSec: 25 * 60 };
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
export type GameOut = {
  scenario: Scenario; seed: number; winner: number | null; winnerDifficulty: Difficulty | null;
  time: number; decisive: boolean; preSdElims: number; preSdSeals?: number; firstSeal: number | null; msPerTick: number; wallSec: number;
  seats: SeatOut[];
  /** Player kills at or after sudden death (15:00+), eliminations in all, credited ones (refs with elimination rewards) and their spoils. */
  lateKills?: number; elims?: number; credited?: number; spoils?: number;
  diag?: unknown;
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
  type Brain = { currentGoal?: string; personality?: { archetype: string; traits: Record<string, number> } };
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
  const m = await Match.create(
    { players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
    { makeBot: (id, d, rng) => { const b = new BotCtor(id, d, rng, personalityFor(id - 1, rng), ...(params ? [params] : [])); brains[id - 1] = b; return b as never; } },
  );
  const seats: SeatOut[] = diffs.map((d, i) => ({
    difficulty: d, kills: 0, deaths: 0, aliveSec: 0, attackSec: 0, idleHome: 0, longestHomeIdle: 0, hitDists: [], eliminatedAt: null,
    archetype: brains[i]?.personality?.archetype, traits: brains[i]?.personality?.traits, damage: 0, seals: 0, healsGot: 0, healsUsed: 0, healsUsedFight: 0, lowHpDeaths: 0,
    deposits: 0, banked: 0, vaultPaid: 0, restocks: 0, interest: 0, vaultLv: 1,
  }));
  type HealSeen = { alive: boolean; n: number; healAt: unknown; drinking: { kind: string } | null; lowSince: number | null; hurtAt: number };
  const healSeen: HealSeen[] = diffs.map(() => ({ alive: false, n: 0, healAt: null, drinking: null, lowSince: null, hurtAt: -99 }));
  type HealP = { id: number; alive: boolean; hp: number; shield: number; pos: { x: number; z: number }; healAt?: unknown; drinking?: { kind: string } | null; inv: { medkits: number; potions?: Record<string, number | undefined> } };
  const healN = (p: HealP) => p.inv.medkits + (p.inv.potions?.healPotion ?? 0) + (p.inv.potions?.shieldSmall ?? 0) + (p.inv.potions?.shieldBig ?? 0);
  const lastCash = new Map<number, [number, number]>();
  const bunkers = m.map.map((isl) => isl.bunker.center);
  const homeStreak = new Map<number, number>();
  // DIAG (presd): kill funnel and seal outcomes.
  const dg = { killD: [0, 0, 0, 0], killDLate: [0, 0, 0, 0], killHomeDef: 0, killHomeDefLate: 0, deadSeals: 0, aliveSeals: 0, aliveSealElim: 0, aliveSealUnseal: 0, aliveSealDur: 0,
    deadSealElim: 0, deadSealUnseal: 0, close: { n: 0, kit0: 0, kitShort: 0, kitFull: 0, sealedInWindow: 0, killerDeadIn10: 0 }, brk: { n: 0, sealerNear: 0, sealerAlive: 0, sealerKit: 0, foeNear: 0, sealerGoal: {} as Record<string, number> }, lateGoal: {} as Record<string, number>, sealedAtSd: 0, leftAtSd: 0 };
  const sealEp = new Map<number, { t: number; alive: boolean; by: number }>();
  const closeKills: { t: number; k: number; v: number; isl: number }[] = [];
  const kitOf = (inv: unknown) => { const pc = (inv as { pieces: Record<string, number> }).pieces; return Object.entries(pc).filter(([k]) => k !== 'scaffold').reduce((a, [, n]) => a + n, 0); };
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
  for (; ticks < maxTicks && snap.winner === null; ticks++) {
    snap = m.tick(new Map());
    for (const p of snap.players) {
      const b = lastCash.get(p.id), s = seats[p.id - 1];
      if (b && s) {
        const dv = p.vault.cash - b[1], di = p.inv.cash - b[0];
        if (dv > 0 && di < 0) { s.deposits!++; s.banked! += dv; }
        else if (dv > 0 && di === 0) s.interest! += dv; // vault interest (refs with it)
        else if (dv < 0 && di <= 0) s.vaultPaid!++;
        s.vaultLv = Math.max(s.vaultLv ?? 1, (p as { vaultLevel?: number }).vaultLevel ?? 1);
      }
      lastCash.set(p.id, [p.inv.cash, p.vault.cash]);
    }
    if (dg.leftAtSd === 0 && snap.time >= SD - 1) {
      for (const p of snap.players) if (!p.eliminated) { dg.leftAtSd++; if (snap.sealed[p.island]) dg.sealedAtSd++; }
    }
    if (ticks % SAMPLE_TICKS === 0) {
      const dt = SAMPLE_TICKS / TICK_HZ;
      for (const p of snap.players) {
        if (!p.alive || p.breakoutUntil !== null) continue;
        const s = seats[p.id - 1];
        s.aliveSec += dt;
        const goal = brains[p.id - 1]?.currentGoal;
        if (goal && ATTACK_GOALS.has(goal)) s.attackSec += dt;
        if (goal && snap.time >= 600 && snap.time < SD) dg.lateGoal[goal] = (dg.lateGoal[goal] ?? 0) + dt;
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
        touch(by - 1, e.t); touch(target - 1, e.t);
        bo[by - 1].hits++;
        if (a.y - t.y >= HIGH_M) bo[by - 1].highHits++;
        const w = e.data.weapon as string | undefined;
        if (w && w !== 'fists' && w !== 'rocket' && w !== 'grenade' && w !== 'charge') bo[target - 1].bulletsTaken++;
      } else if (e.type === 'kill') {
        const v = e.data.victim as number, k = e.data.killer as number | null;
        seats[v - 1].deaths++;
        for (const ck of closeKills) if (ck.k === v && e.t - ck.t <= 10 && e.t >= ck.t) { dg.close.killerDeadIn10++; ck.k = -1; }
        const ls = healSeen[v - 1].lowSince;
        if (ls !== null && e.t - ls >= 3) seats[v - 1].lowHpDeaths!++;
        healSeen[v - 1].lowSince = null;
        if (k != null && k !== v) { seats[k - 1].kills++; if (e.t >= SD) lateKills++; }
        if (k != null && k !== v && e.t < SD && !snap.sealed[snap.players[v - 1].island]) {
          const kp = snap.players[k - 1].pos, vb = bunkers[snap.players[v - 1].island], kb = bunkers[snap.players[k - 1].island];
          const d = Math.hypot(kp.x - vb.x, kp.z - vb.z), bin = d < 30 ? 0 : d < 60 ? 1 : d < 120 ? 2 : 3;
          const homeDef = Math.hypot(kp.x - kb.x, kp.z - kb.z) < 30;
          dg.killD[bin]++; if (homeDef) dg.killHomeDef++;
          if (bin === 0) {
            const vi = snap.players[v - 1].island, kit = kitOf(snap.players[k - 1].inv), open = m.map[vi].bunker.doorways.length;
            dg.close.n++; if (kit === 0) dg.close.kit0++; else if (kit < open) dg.close.kitShort++; else dg.close.kitFull++;
            closeKills.push({ t: e.t, k, v, isl: vi });
          }
          if (e.t >= 600) { dg.killDLate[bin]++; if (homeDef) dg.killHomeDefLate++; }
        }
        if (k != null && k !== v && fight[k - 1]) { fight[k - 1]!.kill = true; endFight(k - 1, false); }
        endFight(v - 1, true);
      } else if (e.type === 'sealed') {
        const by = e.data.by as number | null | undefined;
        if (by != null && by !== e.data.owner && seats[by - 1]) seats[by - 1].seals!++;
        if (firstSeal === null && by != null && by !== e.data.owner && e.t < SD) firstSeal = e.t;
        if (by != null && by !== e.data.owner && e.t < SD) preSdSeals++;
        if (by != null && by !== e.data.owner && e.t < SD) {
          const o = snap.players[(e.data.owner as number) - 1];
          const alive = !!o?.alive && o.breakoutUntil === null;
          sealEp.set(e.data.island as number, { t: e.t, alive, by });
          for (const ck of closeKills) if (ck.isl === e.data.island && e.t - ck.t <= 12 && !alive) { dg.close.sealedInWindow++; ck.t = -99; }
          if (alive) dg.aliveSeals++; else dg.deadSeals++;
        }
      } else if (e.type === 'unsealed') {
        const ep = sealEp.get(e.data.island as number);
        if (ep && e.t < SD) { sealEp.delete(e.data.island as number); if (ep.alive) { dg.aliveSealUnseal++; dg.aliveSealDur += e.t - ep.t; } else {
          dg.deadSealUnseal++;
          const sp = snap.players[ep.by - 1], bc = bunkers[e.data.island as number];
          dg.brk.n++; if (sp.alive) dg.brk.sealerAlive++;
          if (sp.alive && Math.hypot(sp.pos.x - bc.x, sp.pos.z - bc.z) < 15) dg.brk.sealerNear++;
          if (sp.alive && kitOf(sp.inv) > 0) dg.brk.sealerKit++;
          if (snap.players.some((o) => o.alive && o.island !== (e.data.island as number) && Math.hypot(o.pos.x - bc.x, o.pos.z - bc.z) < 15)) dg.brk.foeNear++;
          const g = brains[ep.by - 1]?.currentGoal ?? '-'; dg.brk.sealerGoal[g] = (dg.brk.sealerGoal[g] ?? 0) + 1;
        } }
      } else if ((e.type as string) === 'elimination') {
        if (e.data.by != null) { credited++; spoils += Number(e.data.spoils) || 0; }
      } else if ((e.type as string) === 'restock') {
        const s = seats[(e.data.player as number) - 1];
        if (s) s.restocks!++;
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (seats[id - 1].eliminatedAt === null) {
          seats[id - 1].eliminatedAt = e.t;
          if (e.t < SD) preSdElims++;
          const ep = sealEp.get(snap.players[id - 1].island);
          if (ep && e.t < SD) { sealEp.delete(snap.players[id - 1].island); if (ep.alive) { dg.aliveSealElim++; dg.aliveSealDur += e.t - ep.t; } else dg.deadSealElim++; }
          elims++;
        }
      }
    }
  }
  for (let i = 0; i < fight.length; i++) endFight(i, false);
  seats.forEach((s, i) => { s.build = bo[i]; });
  const msPerTick = (performance.now() - w0) / Math.max(1, ticks);
  // Rapier worlds live in WASM memory and are never garbage collected.
  (m as unknown as { physics?: { world?: { free?: () => void } } }).physics?.world?.free?.();
  const winner = snap.winner !== null && snap.winner > 0 ? snap.winner : null;
  return {
    scenario, seed, winner, winnerDifficulty: winner ? diffs[winner - 1] : null, time: snap.time,
    diag: dg, decisive: winner !== null && snap.time < SD, preSdElims, preSdSeals, lateKills, elims, credited, spoils, firstSeal, msPerTick, wallSec: (performance.now() - w0) / 1000, seats,
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
  ladder: (Share & { higher: Difficulty; lower: Difficulty }) | null;
  /** FFAs with more than one tier: mean final placement per tier (1 = won), its 95% CI and number of seats. */
  placementByTier: Partial<Record<Difficulty, { mean: number; ci95: number; n: number }>> | null;
  /** Per game (all seats): heals got, used, used mid-fight, deaths after ≥ 3 s at ≤ 50 hp + shield. Null: shards without heal data. */
  heals: { got: number; used: number; usedFight: number; lowHpDeaths: number; deaths: number } | null;
  /** Combat building per skill (absent when the shards predate it). */
  build?: Record<string, BuildSummary>;
  /** Vault use per game (all seats together). */
  vault: { deposits: number; banked: number; vaultPaid: number; restocks: number; interest: number; upgrades: number };
  shipCheck: { pass: boolean | null; checks: Check[] };
  /** Means per game (absent on old shard files): kills at 15:00+, eliminations, credited eliminations, spoils paid. */
  perGame?: { lateKills: number; elims: number; credited: number; spoils: number };
};

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
    ladder = { higher: pair[0], lower: pair[1], share: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length), ci95: ci95(scores), games: scores.length };
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
  };
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
      ...sums.filter((s) => s.ladder).map((s) => `| ${s.ladder!.higher} vs ${s.ladder!.lower} | ${(100 * s.ladder!.share).toFixed(0)}% | ± ${(100 * s.ladder!.ci95).toFixed(0)} | ${s.ladder!.games} |`), ''] : []),
    ...sums.filter((s) => s.placementByTier).flatMap((s) => [`### ${s.scenario}: average placement by tier (1 = won)`, '',
      '| tier | mean placement | 95% CI | seats |', '|---|---|---|---|',
      ...Object.entries(s.placementByTier!).map(([d, p]) => `| ${d} | ${p!.mean.toFixed(2)} | ± ${p!.ci95.toFixed(2)} | ${p!.n} |`), '']),
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
