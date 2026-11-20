/// <reference types="node" />
/**
 * Bridges the auto-improve run to the replay pipeline (src/sim/replay) and the self-play trainer
 * (scripts/train): human statistics from uploaded replays (→ the trainer's imitation term), invariant
 * re-simulation of those replays, a bounded training run seeded from the current champion, and the
 * candidate-vs-champion acceptance series.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PARAMS, decode, encode, sanitize, type BotParams } from '../../src/sim/bots/params';
import { Bot } from '../../src/sim/bots/bot';
import { InvariantChecker, violationSignature } from '../../src/sim/invariants';
import { decodeReplay } from '../../src/sim/replay/codec';
import type { Replay } from '../../src/sim/replay/format';
import { ReplayRunner } from '../../src/sim/replay/runner';
import type { PlayerInput } from '../../src/sim/types';
import { DEFAULT_ES, initEs } from '../train/es';
import { headToHead, runGeneration, type TrainConfig } from '../train/generation';
import { STAT_KEYS, type HumanTarget, type PlayStats } from '../train/hooks';
import { Pool } from '../train/pool';
import type { MatchResult, MatchSpec } from '../train/runMatch';
import type { SimFinding } from './health';

// ---------------------------------------------------------------------------------------------
// Human data
// ---------------------------------------------------------------------------------------------

/** Per human player per replay: kill/death/seal/elimination rates per minute in the match. */
export function humanStats(r: Replay): PlayStats[] {
  const out: PlayStats[] = [];
  const sealedBy = new Map<number, number>();
  const humans = r.header.players.filter((p) => !p.isBot);
  const acc = new Map(humans.map((p) => [p.id, { kills: 0, deaths: 0, seals: 0, elims: 0, outAt: null as number | null }]));
  for (const [tick, type, data] of r.events) {
    if (type === 'kill') {
      const v = data.victim as number, k = data.killer as number | null;
      const av = acc.get(v); if (av) av.deaths++;
      const ak = k != null && k !== v ? acc.get(k) : undefined; if (ak) ak.kills++;
    } else if (type === 'sealed') {
      const by = data.by as number | null | undefined;
      if (by != null && by !== data.owner) { const a = acc.get(by); if (a) a.seals++; sealedBy.set(data.island as number, by); }
    } else if (type === 'eliminated') {
      const id = data.player as number;
      const a = acc.get(id); if (a && a.outAt === null) a.outAt = tick / 30;
      const island = r.header.players.find((p) => p.id === id)?.island;
      const by = island !== undefined ? sealedBy.get(island) : undefined;
      const ab = by !== undefined && by !== id ? acc.get(by) : undefined; if (ab) ab.elims++;
    }
  }
  for (const a of acc.values()) {
    const min = Math.max(1, a.outAt ?? r.footer.duration) / 60;
    if (min < 1) continue; // under a minute in the match says nothing about tempo
    out.push({ killsPerMin: a.kills / min, deathsPerMin: a.deaths / min, sealsPerMin: a.seals / min, elimsPerMin: a.elims / min });
  }
  return out;
}

/** Mean/std of human statistics; null with fewer than `min` samples (too little data to steer training). */
export function humanTarget(samples: PlayStats[], min = 5): HumanTarget | null {
  if (samples.length < min) return null;
  const mean = {} as PlayStats, std = {} as PlayStats;
  for (const k of STAT_KEYS) {
    const xs = samples.map((s) => s[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    mean[k] = m;
    std[k] = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  }
  return { mean, std };
}

/**
 * Re-run a replay with the invariant checker. Nightly analysis drops findings after a divergence (a
 * replay from another build); repro tests keep going (a fix is expected to change the run).
 */
export async function checkReplay(file: string, replay: Replay, opts: { untilTick?: number; stopAtDivergence?: boolean } = {}): Promise<SimFinding[]> {
  const stopAtDivergence = opts.stopAtDivergence ?? true;
  const inputs = new Map<number, PlayerInput>();
  const runner = await ReplayRunner.create(replay, {
    checkpointEvery: 0,
    makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); return { think: (v) => { const i = b.think(v); inputs.set(id, i); return i; } }; },
  });
  // Humans hold keys into walls on purpose; give them far longer before calling it "stuck".
  const checker = new InvariantChecker({ map: runner.match.map, stuckSec: 20 });
  const found = new Map<string, SimFinding>();
  try {
    while (!runner.done && (opts.untilTick === undefined || runner.tick < opts.untilTick)) {
      for (const e of replay.ticks[runner.tick] ?? []) inputs.set(e.id, e.input);
      const snap = runner.step();
      if (!snap) break;
      const vs = checker.observe(snap, inputs);
      inputs.clear();
      if (stopAtDivergence && runner.divergedAt !== null) break;
      for (const v of vs) {
        const signature = violationSignature(v);
        if (!found.has(signature)) found.set(signature, { signature, kind: v.kind, detail: v.detail, tick: v.tick, repro: { type: 'replay', file } });
      }
    }
  } finally {
    runner.dispose();
  }
  return [...found.values()];
}

export async function analyzeReplays(all: string[], fresh: string[], outDir: string, log: (m: string) => void) {
  const samples: PlayStats[] = [];
  const findings: SimFinding[] = [];
  let ok = 0, bad = 0;
  const freshSet = new Set(fresh);
  for (const file of all) {
    let replay: Replay;
    try { replay = await decodeReplay(new Uint8Array(fs.readFileSync(file))); } catch (e) { bad++; log(`skip ${path.basename(file)}: ${(e as Error).message}`); continue; }
    ok++;
    samples.push(...humanStats(replay));
    if (freshSet.has(file)) {
      try { findings.push(...(await checkReplay(file, replay))); } catch (e) { log(`re-sim ${path.basename(file)} failed: ${(e as Error).message}`); }
    }
  }
  const target = humanTarget(samples);
  const targetFile = path.join(outDir, 'human-target.json');
  if (target) fs.writeFileSync(targetFile, JSON.stringify(target, null, 2));
  else if (fs.existsSync(targetFile)) fs.rmSync(targetFile);
  return {
    replays: ok,
    scenarios: samples.length,
    findings,
    summary: `${ok} replays decoded (${bad} bad), ${samples.length} human player-matches${target ? ' → imitation target written' : ' (too few for an imitation target)'}, ${findings.length} invariant findings in ${fresh.length} new replays`,
    targetFile: target ? targetFile : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Training + series
// ---------------------------------------------------------------------------------------------

export type TrainOpts = { budgetMin: number; workers: number; outFile: string; humanTargetFile: string | null; seed: number; log: (m: string) => void; maxGenerations?: number };

/** Findings from self-play results (each reproducible from its MatchSpec). */
function collect(specs: MatchSpec[], results: MatchResult[], into: Map<string, SimFinding>) {
  results.forEach((r, i) => {
    for (const v of r.violations ?? []) {
      if (!into.has(v.signature)) into.set(v.signature, { signature: v.signature, kind: v.signature.split(':')[0], detail: v.detail, tick: v.tick, repro: { type: 'seed', seed: specs[i].seed, setup: specs[i] } });
    }
  });
}

export async function trainCandidate(o: TrainOpts): Promise<{ candidatePath: string; games: number; findings: SimFinding[] }> {
  const cfg: TrainConfig = { es: { ...DEFAULT_ES }, games: 5, candSeats: 5, players: 8, maxSec: 18 * 60, seed: o.seed, duels: 2, duelWeight: 1.5 };
  if (o.humanTargetFile) cfg.imitation = { weight: 0.1, target: JSON.parse(fs.readFileSync(o.humanTargetFile, 'utf8')) as HumanTarget };
  const champion: BotParams = { ...DEFAULT_PARAMS };
  let es = initEs(encode(champion), cfg.es);
  const hall: BotParams[] = [];
  const pool = new Pool(o.workers);
  const findings = new Map<string, SimFinding>();
  const run = async (specs: MatchSpec[]) => { const r = await pool.run(specs); collect(specs, r, findings); return r; };
  let games = 0;
  const deadline = Date.now() + o.budgetMin * 60_000;
  try {
    let genMs = 0;
    while (Date.now() + genMs < deadline && (o.maxGenerations === undefined || es.gen < o.maxGenerations)) {
      const g0 = Date.now();
      const { next, stats } = await runGeneration(es, decode(es.mean), hall, cfg, run);
      if (es.gen % 3 === 0) { hall.push(decode(es.mean)); if (hall.length > 8) hall.shift(); }
      es = next;
      games += stats.games;
      genMs = Date.now() - g0;
      o.log(`gen ${stats.gen}: fit mean ${stats.meanFit.toFixed(3)} best ${stats.bestFit.toFixed(3)} · duels vs old ${stats.duelWinRate === null ? '-' : `${(100 * stats.duelWinRate).toFixed(0)}%`} · ${(genMs / 1000).toFixed(0)} s`);
    }
  } finally {
    await pool.close();
  }
  const out = { note: 'auto-improve candidate (scripts/auto-improve.ts)', trainedAt: new Date().toISOString(), generations: es.gen, games, params: sanitize(decode(es.mean)) };
  fs.writeFileSync(o.outFile, JSON.stringify(out, null, 2) + '\n');
  return { candidatePath: o.outFile, games, findings: [...findings.values()] };
}

/** Candidate vs current champion, 1v1 at PRO, each seed mirrored. Draws count half. */
export async function seriesVsChampion(candidatePath: string, seeds: number, workers: number): Promise<{ winRate: number; seeds: number; games: number }> {
  const cand = sanitize((JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as { params: Record<string, number> }).params);
  const pool = new Pool(workers);
  try {
    const list = Array.from({ length: seeds }, (_, i) => 700_000 + i);
    const h = await headToHead({ kind: 'new', params: cand, difficulty: 'pro' }, { kind: 'new', params: { ...DEFAULT_PARAMS }, difficulty: 'pro' }, list, 2, 25 * 60, pool.run);
    return { winRate: h.share, seeds, games: h.results.length };
  } finally {
    await pool.close();
  }
}

/** For generated repro tests: signatures a replay file produces up to `untilTick` (divergence ignored). */
export async function replayViolations(file: string, untilTick: number): Promise<string[]> {
  const replay = await decodeReplay(new Uint8Array(fs.readFileSync(file)));
  return (await checkReplay(file, replay, { untilTick, stopAtDivergence: false })).map((f) => f.signature);
}
