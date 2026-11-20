/**
 * The nightly improvement run, as pure decision logic over injected effects (system.ts wires the real
 * ones; tests/scripts/autoImprove.test.ts uses fakes):
 *
 *   lock → on main & clean → download new replays + error reports → stats/scenarios + invariant
 *   re-sim → [dry run stops here] → train (bounded) → series vs champion (≥ minWinRate over ≥ minSeeds)
 *   → install candidate + all tests → commit on auto-improve/<date>, merge to main → auto-fix bugs
 *   → deploy if anything merged → log (docs/bot-training-log.md, docs/auto-health.md) → unlock.
 *
 * Never pushes. Any thrown error aborts with a logged reason and reverts an installed candidate.
 */
import { emptyHealth, ingestClient, ingestSim, renderHealth, type ClientReport, type HealthState, type SimFinding } from './health';

export type RunOptions = {
  dryRun: boolean;
  budgetMin: number;
  workers: number;
  minSeeds: number;
  minWinRate: number;
  deploy: boolean;
  autofix: boolean;
};

export const DEFAULT_OPTIONS: RunOptions = { dryRun: false, budgetMin: 60, workers: 6, minSeeds: 40, minWinRate: 0.6, deploy: true, autofix: true };

export type State = { lastReplayAt?: string; lastErrorAt?: string };

export type Analysis = { replays: number; scenarios: number; findings: SimFinding[]; summary: string };
export type TrainResult = { candidatePath: string; games: number; findings: SimFinding[] };
export type SeriesResult = { winRate: number; seeds: number; games: number };
export type FixSummary = { attempted: number; accepted: number; notes: string[] };

export interface CoreDeps {
  now(): Date;
  log(msg: string): void;
  /** Exclusive run lock; null when another run holds it. */
  lock(): { release(): void } | null;
  git: {
    branch(): Promise<string>;
    isClean(): Promise<boolean>;
    /** Commit `files` on a new branch off main, merge it back into main (--no-ff), return to main. */
    commitBranchAndMerge(branch: string, files: string[], message: string): Promise<string>;
    /** Commit `files` directly on main (run logs). */
    commitOnMain(files: string[], message: string): Promise<void>;
    /** Discard working-tree changes to `files`. */
    revert(files: string[]): Promise<void>;
  };
  state: { load(): Promise<State>; save(s: State): Promise<void> };
  health: { load(): Promise<HealthState>; save(h: HealthState): Promise<void>; write(markdown: string): Promise<string> };
  sync: {
    /** Download replays uploaded after `since` into the local cache; returns new local files and the newest upload time. */
    replays(since?: string): Promise<{ newFiles: string[]; allFiles: string[]; newest?: string }>;
    errors(since?: string): Promise<{ reports: ClientReport[]; newest?: string }>;
  };
  analyze(files: string[]): Promise<Analysis>;
  train(o: { budgetMin: number; workers: number; replayFiles: string[] }): Promise<TrainResult>;
  series(candidatePath: string, o: { seeds: number; workers: number }): Promise<SeriesResult>;
  /** Write the candidate over the champion; returns the changed repo files. */
  installCandidate(candidatePath: string): Promise<string[]>;
  /** pnpm test + tsc. */
  checks(): Promise<{ ok: boolean; failed?: string }>;
  autofix(health: HealthState): Promise<FixSummary>;
  deploy(): Promise<{ ok: boolean; detail: string }>;
  /** Append one row to docs/bot-training-log.md; returns its repo path. */
  appendTrainingLog(row: string): Promise<string>;
}

export type RunResult =
  | { outcome: 'abort'; reason: string }
  | { outcome: 'dry-run'; newReplays: number; newErrors: number; analysis: Analysis }
  | { outcome: 'accepted' | 'rejected'; reason: string; winRate?: number; games: number; deployed: boolean; fixes: FixSummary };

export async function runAutoImprove(deps: CoreDeps, opts: RunOptions): Promise<RunResult> {
  const { log } = deps;
  const lock = deps.lock();
  if (!lock) { log('ABORT: another auto-improve run holds the lock'); return { outcome: 'abort', reason: 'locked' }; }
  let installed: string[] = [];
  try {
    const branch = await deps.git.branch();
    if (branch !== 'main') return abort(log, `not on main (on ${branch})`);
    if (!(await deps.git.isClean())) return abort(log, 'working tree not clean');

    const state = await deps.state.load();
    const health = await deps.health.load().catch(() => emptyHealth());
    const runAt = deps.now().toISOString();

    const rep = await deps.sync.replays(state.lastReplayAt);
    const errs = await deps.sync.errors(state.lastErrorAt);
    log(`downloaded ${rep.newFiles.length} new replays (${rep.allFiles.length} cached), ${errs.reports.length} new error reports`);

    const analysis = await deps.analyze(rep.allFiles);
    log(`analysis: ${analysis.summary}`);
    ingestClient(health, errs.reports, runAt);
    ingestSim(health, analysis.findings, runAt);

    if (opts.dryRun) {
      log(`DRY RUN: would train ${opts.budgetMin} min on ${opts.workers} workers with ${analysis.replays} replays / ${analysis.scenarios} scenarios; nothing written`);
      return { outcome: 'dry-run', newReplays: rep.newFiles.length, newErrors: errs.reports.length, analysis };
    }

    // ---- train + validate -------------------------------------------------------------------
    const trained = await deps.train({ budgetMin: opts.budgetMin, workers: opts.workers, replayFiles: rep.allFiles });
    ingestSim(health, trained.findings, runAt);
    log(`trained: ${trained.games} games, ${trained.findings.length} invariant findings`);
    const series = await deps.series(trained.candidatePath, { seeds: opts.minSeeds, workers: opts.workers });
    const games = trained.games + series.games;
    log(`series vs champion: ${(series.winRate * 100).toFixed(1)}% over ${series.seeds} seeds`);

    let accepted = false;
    let reason: string;
    if (series.seeds < opts.minSeeds) reason = `only ${series.seeds} series seeds (need ${opts.minSeeds})`;
    else if (series.winRate < opts.minWinRate) reason = `win rate ${(series.winRate * 100).toFixed(1)}% < ${opts.minWinRate * 100}%`;
    else {
      installed = await deps.installCandidate(trained.candidatePath);
      const checks = await deps.checks();
      if (!checks.ok) {
        reason = `regression: ${checks.failed ?? 'tests failed'}`;
        await deps.git.revert(installed);
        installed = [];
      } else {
        reason = 'passed series and tests';
        accepted = true;
      }
    }
    log(`${accepted ? 'ACCEPT' : 'REJECT'}: ${reason}`);

    const date = runAt.slice(0, 10);
    let commit: string | undefined;
    if (accepted) {
      commit = await deps.git.commitBranchAndMerge(`auto-improve/${date}`, installed,
        `Bots: auto-improved champion (${(series.winRate * 100).toFixed(1)}% vs previous over ${series.seeds} seeds)`);
      installed = [];
    }

    // ---- auto-fix ---------------------------------------------------------------------------
    let fixes: FixSummary = { attempted: 0, accepted: 0, notes: [] };
    if (opts.autofix) {
      fixes = await deps.autofix(health);
      log(`auto-fix: ${fixes.accepted}/${fixes.attempted} accepted${fixes.notes.length ? ` (${fixes.notes.join('; ')})` : ''}`);
    }

    // ---- deploy + logs ----------------------------------------------------------------------
    let deployed = false;
    if ((accepted || fixes.accepted > 0) && opts.deploy) {
      // Fixes were each gated alone; re-check main as merged before shipping it.
      const final = fixes.accepted > 0 ? await deps.checks() : { ok: true };
      if (!final.ok) log(`deploy skipped: main fails checks after merges (${final.failed ?? 'tests failed'})`);
      else {
        const d = await deps.deploy();
        deployed = d.ok;
        log(`deploy: ${d.ok ? 'ok' : 'FAILED'} ${d.detail}`);
      }
    }
    const row = `| ${runAt.slice(0, 16).replace('T', ' ')} | ${rep.newFiles.length} new / ${rep.allFiles.length} total | ${games} | ${(series.winRate * 100).toFixed(1)}% (${series.seeds} seeds) | ${deployed ? 'yes' : 'no'} | ${accepted ? 'accepted' : `rejected: ${reason}`}${commit ? ` (${commit})` : ''}${fixes.attempted ? `; fixes ${fixes.accepted}/${fixes.attempted}` : ''} |`;
    const logFile = await deps.appendTrainingLog(row);
    await deps.health.save(health);
    const healthFile = await deps.health.write(renderHealth(health, runAt));
    await deps.git.commitOnMain([logFile, healthFile], `auto-improve: log run ${date} (${accepted ? 'accepted' : 'rejected'})`);
    await deps.state.save({ lastReplayAt: rep.newest ?? state.lastReplayAt, lastErrorAt: errs.newest ?? state.lastErrorAt });
    return { outcome: accepted ? 'accepted' : 'rejected', reason, winRate: series.winRate, games, deployed, fixes };
  } catch (e) {
    const msg = (e as Error)?.stack ?? String(e);
    if (installed.length) await deps.git.revert(installed).catch((r) => log(`could not revert ${installed.join(', ')}: ${r}`));
    return abort(log, `error: ${msg}`);
  } finally {
    lock.release();
  }
}

function abort(log: (m: string) => void, reason: string): RunResult {
  log(`ABORT: ${reason}`);
  return { outcome: 'abort', reason };
}
