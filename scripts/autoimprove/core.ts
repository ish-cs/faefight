/**
 * The nightly data + bug-fix run, as pure decision logic over injected effects (system.ts wires the
 * real ones; tests/scripts/autoImprove.test.ts uses fakes):
 *
 *   lock → on main & clean → download new replays + error reports → learning dataset (human stats,
 *   scenarios; read by the bot trainer, which runs elsewhere) + invariant re-sim → [dry run stops here]
 *   → auto-fix bugs → deploy if a fix merged → log (docs/auto-improve-log.md, docs/auto-health.md) → unlock.
 *
 * Never trains bots and never pushes. Any thrown error aborts with a logged reason.
 */
import { emptyHealth, ingestClient, ingestSim, renderHealth, type ClientReport, type HealthState, type SimFinding } from './health';

export type RunOptions = {
  dryRun: boolean;
  deploy: boolean;
  autofix: boolean;
};

export const DEFAULT_OPTIONS: RunOptions = { dryRun: false, deploy: true, autofix: true };

export type State = { lastReplayAt?: string; lastErrorAt?: string };

export type Analysis = { replays: number; scenarios: number; findings: SimFinding[]; summary: string };
export type FixSummary = { attempted: number; accepted: number; notes: string[] };

export interface CoreDeps {
  now(): Date;
  log(msg: string): void;
  /** Exclusive run lock; null when another run holds it. */
  lock(): { release(): void } | null;
  git: {
    branch(): Promise<string>;
    isClean(): Promise<boolean>;
    /** Commit `files` directly on main (run logs). */
    commitOnMain(files: string[], message: string): Promise<void>;
  };
  state: { load(): Promise<State>; save(s: State): Promise<void> };
  health: { load(): Promise<HealthState>; save(h: HealthState): Promise<void>; write(markdown: string): Promise<string> };
  sync: {
    /** Download replays uploaded after `since` into the local cache; returns new local files and the newest upload time. */
    replays(since?: string): Promise<{ newFiles: string[]; allFiles: string[]; newest?: string }>;
    errors(since?: string): Promise<{ reports: ClientReport[]; newest?: string }>;
  };
  /** All cached replays feed the learning dataset; only `fresh` ones are re-simulated for invariants. */
  analyze(all: string[], fresh: string[]): Promise<Analysis>;
  /** pnpm test + tsc. */
  checks(): Promise<{ ok: boolean; failed?: string }>;
  autofix(health: HealthState): Promise<FixSummary>;
  deploy(): Promise<{ ok: boolean; detail: string }>;
  /** Append one row to docs/auto-improve-log.md; returns its repo path. */
  appendRunLog(row: string): Promise<string>;
}

export type RunResult =
  | { outcome: 'abort'; reason: string }
  | { outcome: 'dry-run'; newReplays: number; newErrors: number; analysis: Analysis }
  | { outcome: 'done'; deployed: boolean; fixes: FixSummary; analysis: Analysis };

export async function runAutoImprove(deps: CoreDeps, opts: RunOptions): Promise<RunResult> {
  const { log } = deps;
  const lock = deps.lock();
  if (!lock) { log('ABORT: another auto-improve run holds the lock'); return { outcome: 'abort', reason: 'locked' }; }
  try {
    // A dry run writes nothing to the repo, so it only warns about these.
    const branch = await deps.git.branch();
    if (branch !== 'main') { if (!opts.dryRun) return abort(log, `not on main (on ${branch})`); log(`warning: not on main (on ${branch})`); }
    if (!(await deps.git.isClean())) { if (!opts.dryRun) return abort(log, 'working tree not clean'); log('warning: working tree not clean'); }

    const state = await deps.state.load();
    const health = await deps.health.load().catch(() => emptyHealth());
    const runAt = deps.now().toISOString();

    const rep = await deps.sync.replays(state.lastReplayAt);
    const errs = await deps.sync.errors(state.lastErrorAt);
    log(`downloaded ${rep.newFiles.length} new replays (${rep.allFiles.length} cached), ${errs.reports.length} new error reports`);

    const analysis = await deps.analyze(rep.allFiles, rep.newFiles);
    log(`analysis: ${analysis.summary}`);
    ingestClient(health, errs.reports, runAt);
    ingestSim(health, analysis.findings, runAt);

    if (opts.dryRun) {
      log(`DRY RUN: learning dataset from ${analysis.replays} replays / ${analysis.scenarios} scenarios written outside the repo; nothing committed`);
      return { outcome: 'dry-run', newReplays: rep.newFiles.length, newErrors: errs.reports.length, analysis };
    }

    // ---- auto-fix ---------------------------------------------------------------------------
    let fixes: FixSummary = { attempted: 0, accepted: 0, notes: [] };
    if (opts.autofix) {
      fixes = await deps.autofix(health);
      log(`auto-fix: ${fixes.accepted}/${fixes.attempted} accepted${fixes.notes.length ? ` (${fixes.notes.join('; ')})` : ''}`);
    }

    // ---- deploy + logs ----------------------------------------------------------------------
    let deployed = false;
    if (fixes.accepted > 0 && opts.deploy) {
      // Fixes were each gated alone; re-check main as merged before shipping it.
      const final = await deps.checks();
      if (!final.ok) log(`deploy skipped: main fails checks after merges (${final.failed ?? 'tests failed'})`);
      else {
        const d = await deps.deploy();
        deployed = d.ok;
        log(`deploy: ${d.ok ? 'ok' : 'FAILED'} ${d.detail}`);
      }
    }
    const date = runAt.slice(0, 10);
    const row = `| ${runAt.slice(0, 16).replace('T', ' ')} | ${rep.newFiles.length} new / ${rep.allFiles.length} total | ${errs.reports.length} | ${analysis.replays} matches, ${analysis.scenarios} scenarios | ${analysis.findings.length} | ${fixes.accepted}/${fixes.attempted} | ${deployed ? 'yes' : 'no'} |`;
    const logFile = await deps.appendRunLog(row);
    await deps.health.save(health);
    const healthFile = await deps.health.write(renderHealth(health, runAt));
    await deps.git.commitOnMain([logFile, healthFile], `auto-improve: log run ${date}`);
    await deps.state.save({ lastReplayAt: rep.newest ?? state.lastReplayAt, lastErrorAt: errs.newest ?? state.lastErrorAt });
    return { outcome: 'done', deployed, fixes, analysis };
  } catch (e) {
    return abort(log, `error: ${(e as Error)?.stack ?? String(e)}`);
  } finally {
    lock.release();
  }
}

function abort(log: (m: string) => void, reason: string): RunResult {
  log(`ABORT: ${reason}`);
  return { outcome: 'abort', reason };
}
