/// <reference types="node" />
/**
 * Learning data from recorded matches (.faereplay): human decision statistics, outcomes, and "situations where
 * a bot lost to a human" for the bot trainer. Works on the recorded data alone (no re-simulation), so old
 * replays stay usable after the sim changes.
 *
 *   npx tsx scripts/replays/extract.ts <dir-or-file>... [--out .replays-data]
 *
 * Writes <out>/stats.json (extractStats) and <out>/scenarios.jsonl (mineScenarios). Trainer hooks: import
 * loadReplays / extractStats / mineScenarios from here, and matchFromReplay (src/sim/replay/headless.ts) to
 * start a training match from a mined scenario. See docs/superpowers/specs/2026-11-20-learning-from-replays.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEAL, TICK_HZ } from '../../src/sim/constants';
import type { IslandLayout } from '../../src/sim/map';
import { decodeReplay } from '../../src/sim/replay/codec';
import type { LogEvent, Replay, SecondSummary } from '../../src/sim/replay/format';
import type { PlayerInput } from '../../src/sim/types';
import { unzip } from '../../src/client/replay/zip';

export type LoadedReplay = { file: string; replay: Replay };

/** Every .faereplay under `dirs` (files, folders searched recursively, and .zip exports). Unreadable files are skipped with a warning. */
export async function loadReplays(dirs: string | string[]): Promise<LoadedReplay[]> {
  const out: LoadedReplay[] = [];
  const visit = async (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const f of fs.readdirSync(p).sort()) await visit(path.join(p, f)); return; }
    const lower = p.toLowerCase();
    const entries = lower.endsWith('.zip') ? unzip(new Uint8Array(fs.readFileSync(p))).filter((e) => e.name.endsWith('.faereplay')).map((e) => ({ file: `${p}#${e.name}`, data: e.data }))
      : lower.endsWith('.faereplay') ? [{ file: p, data: new Uint8Array(fs.readFileSync(p)) }] : [];
    for (const e of entries) {
      try { out.push({ file: e.file, replay: await decodeReplay(e.data) }); }
      catch (err) { console.warn(`[replays] skipping ${e.file}: ${(err as Error).message}`); }
    }
  };
  for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
    if (!fs.existsSync(d)) { console.warn(`[replays] ${d} does not exist`); continue; }
    await visit(d);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

/** Engagement distance buckets (m): [0,5), [5,10), [10,20), [20,40), [40,80), [80,∞). */
export const DIST_BUCKETS = [5, 10, 20, 40, 80];

export type PlayerStats = {
  replay: string;
  id: number;
  name: string;
  isBot: boolean;
  /** 1 = winner; eliminated players by elimination order; survivors at the end share the next place. */
  place: number;
  won: boolean;
  kills: number;
  deaths: number;
  /** Seconds survived (match length if never eliminated). */
  survived: number;
  purchases: { t: number; item: string; cost: number }[];
  builds: { t: number; kind: string; bridge: boolean; nearEnemyBunker: number | null }[];
  /** First piece placed off the home island toward another island (s), and which island it headed for. */
  firstBridge: { t: number; toward: number } | null;
  seals: { attempts: number; successes: number; times: number[] };
  /** Hits dealt: count per distance bucket, mean distance, by weapon. */
  engagement: { hits: number; buckets: number[]; meanDist: number; byWeapon: Record<string, number> };
  /** Human inputs only (null for bots: their per-tick choices aren't recorded). */
  movement: null | {
    ticks: number;
    /** Share of alive ticks strafing (moveX ≠ 0), overall and in combat (within 1 s of dealing/taking a hit). */
    strafe: number;
    strafeInCombat: number;
    /** Strafe direction changes per minute in combat (dodging). */
    strafeFlipsPerMin: number;
    jumpsPerMin: number;
    sprint: number;
    /** Share of firing ticks with sights up; share of all ticks with sights up. */
    adsWhenFiring: number;
    ads: number;
  };
};

export type Stats = {
  replays: number;
  humans: PlayerStats[];
  bots: PlayerStats[];
  /** Pooled over humans. */
  human: {
    players: number;
    winRate: number;
    /** Order of first purchases: item → mean position (0 = first) and how many humans bought it. */
    purchaseOrder: Record<string, { meanRank: number; meanFirstT: number; n: number }>;
    buildsPerMin: Record<string, number>;
    meanFirstBridgeT: number | null;
    sealSuccessRate: number | null;
    engagementBuckets: number[];
    meanEngagementDist: number | null;
    strafe: number | null;
    strafeInCombat: number | null;
    adsWhenFiring: number | null;
  };
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const near2D = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const tSec = (tick: number) => tick / TICK_HZ;

/** Which island (index) a point is on, or null over water. */
function islandAt(map: IslandLayout[], p: { x: number; z: number }): number | null {
  for (const isl of map) if (near2D(isl.center, p) <= isl.radius) return isl.index;
  return null;
}
function nearestIsland(map: IslandLayout[], p: { x: number; z: number }, except: number): number {
  let best = -1, bd = Infinity;
  for (const isl of map) { if (isl.index === except) continue; const d = near2D(isl.center, p); if (d < bd) { bd = d; best = isl.index; } }
  return best;
}

/** Per-player places from the event log (see PlayerStats.place). */
function places(r: Replay): Map<number, number> {
  const ids = r.header.players.map((p) => p.id);
  const out = new Map<number, number>();
  const order: number[] = [];
  for (const [, type, d] of r.events) if (type === 'eliminated' && !order.includes(d.player as number)) order.push(d.player as number);
  order.forEach((id, k) => out.set(id, ids.length - k));
  const left = ids.filter((id) => !order.includes(id));
  const w = r.footer.winner;
  for (const id of left) out.set(id, w === id ? 1 : w !== null ? 2 : (1 + left.length) / 2);
  return out;
}

/** Human per-tick inputs by id (tick index → input), alive ticks only (from the per-second summaries). */
function humanInputs(r: Replay, id: number): { tick: number; input: PlayerInput }[] {
  const out: { tick: number; input: PlayerInput }[] = [];
  r.ticks.forEach((entries, i) => {
    const e = entries.find((x) => x.id === id);
    if (e) out.push({ tick: i + 1, input: e.input });
  });
  return out;
}

function aliveAt(seconds: SecondSummary[], id: number): (tick: number) => boolean {
  return (tick) => {
    // Nearest summary at or before `tick` (binary search).
    let lo = 0, hi = seconds.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (seconds[m].tick <= tick) { at = m; lo = m + 1; } else hi = m - 1; }
    if (at < 0) return true;
    const row = seconds[at].p.find((x) => x[0] === id);
    return !row || row[6] === 1;
  };
}

export function playerStats(file: string, r: Replay): PlayerStats[] {
  const map = r.header.map;
  const place = places(r);
  const ev = r.events;
  const elimT = new Map<number, number>();
  for (const [tick, type, d] of ev) if (type === 'eliminated' && !elimT.has(d.player as number)) elimT.set(d.player as number, tSec(tick));
  return r.header.players.map((pl) => {
    const mine = (e: LogEvent, key: string) => e[2][key] === pl.id;
    const purchases = ev.filter((e) => e[1] === 'bought' && mine(e, 'by')).map(([tick, , d]) => ({ t: tSec(tick), item: d.item as string, cost: d.cost as number }));
    const builds = ev.filter((e) => e[1] === 'placed' && mine(e, 'by')).map(([tick, , d]) => {
      const pos = d.pos as { x: number; z: number } | undefined;
      const on = pos ? islandAt(map, pos) : pl.island;
      const enemyBunker = pos ? map.find((isl) => isl.index !== pl.island && near2D(isl.bunker.center, pos) <= SEAL.half) : undefined;
      return { t: tSec(tick), kind: d.kind as string, bridge: !!pos && on !== pl.island && !enemyBunker, nearEnemyBunker: enemyBunker?.index ?? null, pos };
    });
    const firstBridgeB = builds.find((b) => b.bridge && b.pos);
    const firstBridge = firstBridgeB?.pos ? { t: firstBridgeB.t, toward: nearestIsland(map, firstBridgeB.pos, pl.island) } : null;

    // Seal attempts: bursts of pieces at an enemy bunker (gaps < 15 s); success = that bunker sealed by us during the burst (+5 s).
    const sealedBy = ev.filter((e) => e[1] === 'sealed' && mine(e, 'by') && e[2].owner !== pl.id).map(([tick, , d]) => ({ t: tSec(tick), island: d.island as number }));
    let attempts = 0, successes = 0;
    const bursts: { island: number; from: number; to: number }[] = [];
    for (const b of builds) {
      if (b.nearEnemyBunker === null) continue;
      const last = bursts.find((x) => x.island === b.nearEnemyBunker && b.t - x.to < 15);
      if (last) last.to = b.t; else bursts.push({ island: b.nearEnemyBunker, from: b.t, to: b.t });
    }
    for (const b of bursts) {
      attempts++;
      if (sealedBy.some((s) => s.island === b.island && s.t >= b.from && s.t <= b.to + 5)) successes++;
    }
    // A seal without pieces we placed right at the bunker (e.g. finished someone's wall) still counts.
    const unmatched = sealedBy.filter((s) => !bursts.some((b) => b.island === s.island && s.t >= b.from && s.t <= b.to + 5)).length;
    attempts += unmatched; successes += unmatched;

    const hits = ev.filter((e) => e[1] === 'hit' && mine(e, 'by') && e[2].target !== pl.id);
    const buckets = DIST_BUCKETS.map(() => 0).concat(0);
    const byWeapon: Record<string, number> = {};
    const dists: number[] = [];
    for (const [, , d] of hits) {
      if (typeof d.dist === 'number') { dists.push(d.dist); let i = DIST_BUCKETS.findIndex((b) => d.dist as number < b); if (i < 0) i = DIST_BUCKETS.length; buckets[i]++; }
      const w = String(d.weapon ?? 'other');
      byWeapon[w] = (byWeapon[w] ?? 0) + 1;
    }

    let movement: PlayerStats['movement'] = null;
    if (!pl.isBot) {
      const alive = aliveAt(r.seconds, pl.id);
      const combatTicks = new Set<number>();
      for (const [tick, type, d] of ev) if (type === 'hit' && (d.by === pl.id || d.target === pl.id)) for (let k = 0; k < TICK_HZ; k++) combatTicks.add(tick + k);
      const ins = humanInputs(r, pl.id).filter((x) => alive(x.tick));
      let strafe = 0, cStrafe = 0, cTicks = 0, flips = 0, jumps = 0, sprint = 0, fire = 0, fireAds = 0, ads = 0;
      let lastDir = 0;
      for (const { tick, input } of ins) {
        const dir = Math.sign(input.moveX);
        if (dir) strafe++;
        if (input.jump) jumps++;
        if (input.sprint) sprint++;
        if (input.ads) ads++;
        if (input.fire) { fire++; if (input.ads) fireAds++; }
        if (combatTicks.has(tick)) {
          cTicks++;
          if (dir) cStrafe++;
          if (dir && lastDir && dir !== lastDir) flips++;
        }
        if (dir) lastDir = dir;
      }
      const n = Math.max(1, ins.length), min = ins.length / TICK_HZ / 60;
      movement = {
        ticks: ins.length, strafe: strafe / n, strafeInCombat: cTicks ? cStrafe / cTicks : 0,
        strafeFlipsPerMin: cTicks ? flips / (cTicks / TICK_HZ / 60) : 0, jumpsPerMin: min ? jumps / min : 0, sprint: sprint / n,
        adsWhenFiring: fire ? fireAds / fire : 0, ads: ads / n,
      };
    }
    const kills = ev.filter((e) => e[1] === 'kill' && mine(e, 'killer') && e[2].victim !== pl.id).length;
    const deaths = ev.filter((e) => e[1] === 'kill' && mine(e, 'victim')).length;
    return {
      replay: file, id: pl.id, name: pl.name, isBot: pl.isBot, place: place.get(pl.id) ?? 0, won: r.footer.winner === pl.id,
      kills, deaths, survived: elimT.get(pl.id) ?? r.footer.duration, purchases,
      builds: builds.map(({ pos: _p, ...b }) => b), firstBridge,
      seals: { attempts, successes, times: sealedBy.map((s) => s.t) },
      engagement: { hits: hits.length, buckets, meanDist: mean(dists) ?? 0, byWeapon },
      movement,
    };
  });
}

/** Decision statistics for every player of every replay, plus pooled human numbers. */
export function extractStats(replays: LoadedReplay[]): Stats {
  const all = replays.flatMap(({ file, replay }) => playerStats(file, replay));
  const humans = all.filter((p) => !p.isBot), bots = all.filter((p) => p.isBot);
  const order: Record<string, { ranks: number[]; ts: number[] }> = {};
  for (const h of humans) {
    const seen: string[] = [];
    for (const p of h.purchases) if (!seen.includes(p.item)) { seen.push(p.item); (order[p.item] ??= { ranks: [], ts: [] }); order[p.item].ranks.push(seen.length - 1); order[p.item].ts.push(p.t); }
  }
  const purchaseOrder = Object.fromEntries(Object.entries(order).map(([k, v]) => [k, { meanRank: mean(v.ranks)!, meanFirstT: mean(v.ts)!, n: v.ranks.length }]));
  const minutes = humans.reduce((s, h) => s + h.survived / 60, 0);
  const buildsPerMin: Record<string, number> = {};
  for (const h of humans) for (const b of h.builds) buildsPerMin[b.kind] = (buildsPerMin[b.kind] ?? 0) + 1;
  for (const k of Object.keys(buildsPerMin)) buildsPerMin[k] = minutes ? buildsPerMin[k] / minutes : 0;
  const att = humans.reduce((s, h) => s + h.seals.attempts, 0), suc = humans.reduce((s, h) => s + h.seals.successes, 0);
  const buckets = DIST_BUCKETS.map(() => 0).concat(0);
  for (const h of humans) h.engagement.buckets.forEach((n, i) => (buckets[i] += n));
  const hitsN = humans.reduce((s, h) => s + h.engagement.hits, 0);
  const mv = humans.map((h) => h.movement).filter((m): m is NonNullable<typeof m> => !!m && m.ticks > 0);
  return {
    replays: replays.length,
    humans,
    bots,
    human: {
      players: humans.length,
      winRate: humans.length ? humans.filter((h) => h.won).length / humans.length : 0,
      purchaseOrder,
      buildsPerMin,
      meanFirstBridgeT: mean(humans.flatMap((h) => (h.firstBridge ? [h.firstBridge.t] : []))),
      sealSuccessRate: att ? suc / att : null,
      engagementBuckets: buckets,
      meanEngagementDist: hitsN ? humans.reduce((s, h) => s + h.engagement.meanDist * h.engagement.hits, 0) / hitsN : null,
      strafe: mean(mv.map((m) => m.strafe)),
      strafeInCombat: mean(mv.map((m) => m.strafeInCombat)),
      adsWhenFiring: mean(mv.map((m) => m.adsWhenFiring)),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export type Scenario = {
  replay: string;
  replayId: string;
  /** kill: a human killed a bot; seal: a human sealed a bot's bunker. */
  kind: 'kill' | 'seal';
  /** Start of the situation (tick to start a training match from) and the decisive moment. */
  startTick: number;
  eventTick: number;
  human: number;
  bot: number;
  /** Per-second state at (or just before) startTick: SecondSummary rows. */
  state: SecondSummary | null;
  /** What the human did between startTick and eventTick. */
  humanDid: {
    events: LogEvent[];
    inputs: null | { ticks: number; strafe: number; fire: number; ads: number; jumps: number; weapons: string[] };
  };
};

/**
 * "Situations where a bot lost to a human": every human kill of a bot (window: `killLookback` s before) and
 * every human seal of a bot's bunker (`sealLookback` s before), with the state at the start and what the
 * human did. Start a training match there with matchFromReplay(replay, startTick, makeBot).
 */
export function mineScenarios(replays: LoadedReplay[], opts: { killLookback?: number; sealLookback?: number } = {}): Scenario[] {
  const killBack = Math.round((opts.killLookback ?? 6) * TICK_HZ), sealBack = Math.round((opts.sealLookback ?? 20) * TICK_HZ);
  const out: Scenario[] = [];
  for (const { file, replay: r } of replays) {
    const isBot = new Map(r.header.players.map((p) => [p.id, p.isBot]));
    const owner = new Map(r.header.players.map((p) => [p.island, p.id]));
    const stateAt = (tick: number) => [...r.seconds].reverse().find((s) => s.tick <= tick) ?? null;
    const add = (kind: Scenario['kind'], eventTick: number, human: number, bot: number, back: number) => {
      const startTick = Math.max(1, eventTick - back);
      const events = r.events.filter(([t, , d]) => t >= startTick && t <= eventTick && (d.by === human || d.killer === human || d.target === human || d.victim === human));
      const ins = r.ticks.slice(startTick - 1, eventTick).map((es) => es.find((e) => e.id === human)?.input).filter((x): x is PlayerInput => !!x);
      const n = Math.max(1, ins.length);
      out.push({
        replay: file, replayId: r.header.id, kind, startTick, eventTick, human, bot, state: stateAt(startTick),
        humanDid: {
          events,
          inputs: ins.length ? {
            ticks: ins.length,
            strafe: ins.filter((i) => i.moveX !== 0).length / n,
            fire: ins.filter((i) => i.fire).length / n,
            ads: ins.filter((i) => i.ads).length / n,
            jumps: ins.filter((i) => i.jump).length,
            weapons: [...new Set(ins.map((i) => i.select).filter((s) => s !== null).map(String))],
          } : null,
        },
      });
    };
    for (const [tick, type, d] of r.events) {
      if (type === 'kill') {
        const k = d.killer as number | null, v = d.victim as number;
        if (k !== null && k !== v && isBot.get(k) === false && isBot.get(v) === true) add('kill', tick, k, v, killBack);
      } else if (type === 'sealed') {
        const by = d.by as number | null, o = (d.owner as number | null) ?? owner.get(d.island as number) ?? null;
        if (by !== null && o !== null && by !== o && isBot.get(by) === false && isBot.get(o) === true) add('seal', tick, by, o, sealBack);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main(argv: string[]) {
  const outAt = argv.indexOf('--out');
  const outDir = outAt >= 0 ? argv[outAt + 1] : '.replays-data';
  const dirs = argv.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  if (!dirs.length) throw new Error('usage: npx tsx scripts/replays/extract.ts <dir-or-file>... [--out .replays-data]');
  const replays = await loadReplays(dirs);
  const stats = extractStats(replays);
  const scenarios = mineScenarios(replays);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 1));
  fs.writeFileSync(path.join(outDir, 'scenarios.jsonl'), scenarios.map((s) => JSON.stringify(s)).join('\n') + (scenarios.length ? '\n' : ''));
  console.info(`[replays] ${replays.length} replays → ${stats.human.players} human / ${stats.bots.length} bot player-games, ${scenarios.length} scenarios → ${outDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
