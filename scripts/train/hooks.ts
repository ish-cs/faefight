/// <reference types="node" />
/**
 * Hooks for learning from recorded data (the replay pipeline: scripts/replays/*, landing separately).
 *
 * - Imitation: `imitationPenalty` compares a seat's per-match statistics with human statistics
 *   (from `extractStats(loadReplays(dir))`) and is subtracted from fitness with weight `TrainConfig.imitation.weight`,
 *   so training prefers params that win AND play at a human-like tempo.
 * - Scenarios: `MatchSpec.scenario` names a mined starting state (`mineScenarios`); runMatch refuses it until the
 *   replay module can restore states (fails loudly rather than silently training from a fresh start).
 * - Replays: `loadRecorder()` finds `recordHeadlessMatch` when the replay module exists, so the trainer can save
 *   each generation's champion games.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MatchResult } from './runMatch';

/** Per-player, per-match statistics a human dataset can provide (rates per minute alive in the match). */
export type PlayStats = { killsPerMin: number; deathsPerMin: number; sealsPerMin: number; elimsPerMin: number };
export const STAT_KEYS: (keyof PlayStats)[] = ['killsPerMin', 'deathsPerMin', 'sealsPerMin', 'elimsPerMin'];

export function seatStats(r: MatchResult, seat: number): PlayStats {
  const s = r.seats[seat];
  const min = Math.max(1 / 60, s.survived / 60);
  return { killsPerMin: s.kills / min, deathsPerMin: s.deaths / min, sealsPerMin: s.seals / min, elimsPerMin: s.elims / min };
}

/** Human reference: mean and spread of each statistic. */
export type HumanTarget = { mean: PlayStats; std: PlayStats };

/** Squared z-distance from the human reference, averaged over the statistics (0 = plays like the humans). */
export function imitationPenalty(st: PlayStats, target: HumanTarget): number {
  let sum = 0;
  for (const k of STAT_KEYS) {
    const z = (st[k] - target.mean[k]) / Math.max(1e-3, target.std[k]);
    sum += Math.min(9, z * z);
  }
  return sum / STAT_KEYS.length;
}

/** Load a HumanTarget JSON (written from extractStats output); throws with the path on a malformed file. */
export function loadHumanTarget(file: string): HumanTarget {
  const t = JSON.parse(fs.readFileSync(file, 'utf8')) as HumanTarget;
  for (const k of STAT_KEYS)
    if (typeof t?.mean?.[k] !== 'number' || typeof t?.std?.[k] !== 'number') throw new Error(`${file}: human target missing ${k} (mean/std)`);
  return t;
}

export type Recorder = (setup: unknown, seed: number, maxTicks: number) => Promise<unknown>;

/** The replay recorder if scripts/replays is present, else null (callers decide whether that's fatal). */
export async function loadRecorder(): Promise<Recorder | null> {
  for (const f of ['../replays/record.ts', '../replays/extract.ts']) {
    const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), f);
    if (!fs.existsSync(p)) continue;
    const mod = (await import(p)) as { recordHeadlessMatch?: Recorder };
    if (mod.recordHeadlessMatch) return mod.recordHeadlessMatch;
  }
  return null;
}
