/// <reference types="node" />
/**
 * Turns uploaded replays (src/sim/replay) into learning data for the bot trainer, and re-simulates them
 * with the sim invariant checker. Nothing here trains: training is run and coordinated elsewhere and
 * reads the dataset this writes (see `analyzeReplays` → `<outDir>/`):
 *
 *   human-target.json  mean/std of human per-minute rates (kills, deaths, seals, eliminations): the
 *                      trainer's imitation target. Absent with fewer than 5 human player-matches.
 *   human-stats.json   decision statistics from `extractStats` (scripts/replays/extract.ts).
 *   scenarios.json     "where a bot lost to a human" starting states from `mineScenarios`.
 *   manifest.json      which replays fed this dataset, and when it was written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../../src/sim/bots/bot';
import { InvariantChecker, violationSignature } from '../../src/sim/invariants';
import { decodeReplay } from '../../src/sim/replay/codec';
import type { Replay } from '../../src/sim/replay/format';
import { ReplayRunner } from '../../src/sim/replay/runner';
import type { PlayerInput } from '../../src/sim/types';
import { extractStats, mineScenarios, type LoadedReplay } from '../replays/extract';
import type { SimFinding } from './health';

/** Per-player, per-match statistics (rates per minute in the match). */
export type PlayStats = { killsPerMin: number; deathsPerMin: number; sealsPerMin: number; elimsPerMin: number };
export const STAT_KEYS: (keyof PlayStats)[] = ['killsPerMin', 'deathsPerMin', 'sealsPerMin', 'elimsPerMin'];
/** Human reference: mean and spread of each statistic. */
export type HumanTarget = { mean: PlayStats; std: PlayStats };

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
  fs.mkdirSync(outDir, { recursive: true });
  const findings: SimFinding[] = [];
  let bad = 0;
  const freshSet = new Set(fresh);
  // A match can be uploaded twice (an unfinished copy when the tab was hidden, then the final one):
  // keep the longest recording per replay id. Decoded one at a time to bound memory.
  const best = new Map<string, { file: string; ticks: number; stats: PlayStats[] }>();
  for (const file of all) {
    let replay: Replay;
    try { replay = await decodeReplay(new Uint8Array(fs.readFileSync(file))); } catch (e) { bad++; log(`skip ${path.basename(file)}: ${(e as Error).message}`); continue; }
    const prev = best.get(replay.header.id);
    if (!prev || replay.ticks.length > prev.ticks) best.set(replay.header.id, { file, ticks: replay.ticks.length, stats: humanStats(replay) });
  }
  const samples = [...best.values()].flatMap((b) => b.stats);
  const ok = best.size;
  for (const { file } of best.values()) {
    if (!freshSet.has(file)) continue;
    try { findings.push(...(await checkReplay(file, await decodeReplay(new Uint8Array(fs.readFileSync(file)))))); } catch (e) { log(`re-sim ${path.basename(file)} failed: ${(e as Error).message}`); }
  }
  const target = humanTarget(samples);
  const targetFile = path.join(outDir, 'human-target.json');
  if (target) fs.writeFileSync(targetFile, JSON.stringify(target, null, 2));
  else if (fs.existsSync(targetFile)) fs.rmSync(targetFile);
  // Decision statistics + "where a bot lost to a human" scenarios (scripts/replays/extract.ts) for the trainer.
  const loaded: LoadedReplay[] = [];
  for (const { file } of best.values()) loaded.push({ file, replay: await decodeReplay(new Uint8Array(fs.readFileSync(file))) });
  const stats = extractStats(loaded);
  const scenarios = mineScenarios(loaded);
  fs.writeFileSync(path.join(outDir, 'human-stats.json'), JSON.stringify(stats.human, null, 2));
  fs.writeFileSync(path.join(outDir, 'scenarios.json'), JSON.stringify(scenarios));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    writtenAt: new Date().toISOString(),
    replays: [...best.values()].map((b) => path.basename(b.file)),
    humanPlayerMatches: samples.length,
    scenarios: scenarios.length,
    humanTarget: target !== null,
  }, null, 2));
  return {
    replays: ok,
    scenarios: scenarios.length,
    findings,
    summary: `${ok} matches from ${all.length} files (${bad} bad), ${stats.human.players} human players, ${scenarios.length} scenarios, ${samples.length} human player-matches${target ? ' → imitation target written' : ' (too few for an imitation target)'}, ${findings.length} invariant findings in ${fresh.length} new replays`,
    targetFile: target ? targetFile : null,
  };
}

/** For generated repro tests: signatures a replay file produces up to `untilTick` (divergence ignored). */
export async function replayViolations(file: string, untilTick: number): Promise<string[]> {
  const replay = await decodeReplay(new Uint8Array(fs.readFileSync(file)));
  return (await checkReplay(file, replay, { untilTick, stopAtDivergence: false })).map((f) => f.signature);
}
