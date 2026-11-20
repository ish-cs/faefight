/**
 * Auto-fix: for the most frequent new bug signatures, write a failing reproduction test, let Claude
 * Code (headless, in a fresh git worktree) make a minimal fix, and merge it only if a strict gate
 * passes. Every attempt is logged into the health state (→ docs/auto-health.md).
 */
import { fixCandidates, type HealthState, type Signature } from './health';

export const MAX_FIX_ATTEMPTS = 3;
export const MAX_DIFF_LINES = 200;

/** Paths an automatic fix must never touch (the improvement machinery itself, deps, CI/deploy config). */
export const FORBIDDEN = [/^scripts\/auto-improve\.ts$/, /^scripts\/autoimprove\//, /^scripts\/launchd\//, /^package\.json$/, /^pnpm-lock\.yaml$/, /^vercel\.json$/, /^\.vercelignore$/, /^api\//, /^docs\/auto-health\.md$/, /^docs\/bot-training-log\.md$/, /^\.github\//];

export type FileChange = { path: string; status: 'A' | 'M' | 'D' | 'R'; added: number; removed: number };

export type GateInput = {
  claudeOk: boolean;
  reproPath: string;
  /** The repro test failed on the base commit (it really reproduces the bug). */
  reproFailedOnBase: boolean;
  /** The repro test passes with the fix. */
  reproPassesWithFix: boolean;
  changes: FileChange[];
  tests: boolean;
  tsc: boolean;
  e2e: boolean;
};

export type GateVerdict = { accept: boolean; reason: string; lines: number };

export function evaluateFixGate(g: GateInput): GateVerdict {
  const code = g.changes.filter((c) => c.path !== g.reproPath);
  const lines = code.reduce((s, c) => s + c.added + c.removed, 0);
  const no = (reason: string): GateVerdict => ({ accept: false, reason, lines });
  if (!g.claudeOk) return no('claude run failed');
  if (!g.reproFailedOnBase) return no('repro test did not fail on base (not a reproduction)');
  if (!g.changes.some((c) => c.path === g.reproPath)) return no('repro test missing');
  if (code.length === 0) return no('no code change');
  const forbidden = code.find((c) => FORBIDDEN.some((re) => re.test(c.path)));
  if (forbidden) return no(`touches forbidden path ${forbidden.path}`);
  const testEdit = code.find((c) => /^tests\//.test(c.path) && c.status !== 'A');
  if (testEdit) return no(`modifies existing test ${testEdit.path}`);
  if (lines > MAX_DIFF_LINES) return no(`diff too large (${lines} > ${MAX_DIFF_LINES} lines)`);
  if (!g.reproPassesWithFix) return no('repro test still fails');
  if (!g.tests) return no('pnpm test failed');
  if (!g.tsc) return no('tsc failed');
  if (!g.e2e) return no('e2e failed');
  return { accept: true, reason: `gate passed (${lines} lines)`, lines };
}

export interface FixDeps {
  now(): Date;
  log(msg: string): void;
  /** Whether headless Claude Code is usable (`which claude` + a probe). */
  claudeAvailable(): Promise<boolean>;
  createWorktree(slug: string): Promise<{ dir: string; branch: string }>;
  removeWorktree(dir: string, branch: string, keepBranch: boolean): Promise<void>;
  /** Write a generated repro test for a reproducible signature (sim seed/replay); null when not possible. */
  writeRepro(dir: string, sig: Signature, reproPath: string): Promise<boolean>;
  /** Run one vitest file; true = passed. */
  runTest(dir: string, file: string): Promise<boolean>;
  /** Run the repro test with the worktree's non-test changes temporarily reverted to base. */
  reproFailsOnBase(dir: string, reproPath: string): Promise<boolean>;
  runClaude(dir: string, prompt: string): Promise<{ ok: boolean; output: string }>;
  changes(dir: string): Promise<FileChange[]>;
  fullChecks(dir: string): Promise<{ tests: boolean; tsc: boolean; e2e: boolean }>;
  /** Commit everything in the worktree on its branch; returns the commit. */
  commit(dir: string, message: string): Promise<string>;
  /** Merge a branch into main (main checkout); returns the merge commit. Throws (merge aborted) on conflict. */
  mergeToMain(branch: string, message: string): Promise<string>;
}

export const slugOf = (sig: string) => sig.replace(/^(client|sim):/, '$1-').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).toLowerCase();

export function fixPrompt(sig: Signature, reproPath: string, haveRepro: boolean): string {
  const s = sig.sample;
  return [
    'You are fixing one bug in FAEFight (TypeScript browser game; pure simulation in src/sim, client in src/client). It was detected automatically.',
    '',
    `Bug signature: ${sig.signature}`,
    `Seen ${sig.count} times (first ${sig.firstSeen}, last ${sig.lastSeen}).`,
    `Detail: ${s.message}`,
    s.stack ? `Stack:\n${s.stack}` : '',
    s.tick !== undefined ? `Tick: ${s.tick}` : '',
    '',
    haveRepro
      ? `A failing reproduction test already exists at ${reproPath}. Run it with: pnpm vitest run ${reproPath}`
      : `First write a focused Vitest reproduction test at ${reproPath} that FAILS because of this bug (run it to confirm it fails), then fix the bug.`,
    '',
    'Rules:',
    '- Minimal fix in the game code. Keep every existing test green (pnpm test) and npx tsc --noEmit clean.',
    `- Do not edit or delete existing tests; do not weaken ${reproPath} once it fails for the right reason.`,
    '- Do not touch scripts/auto-improve.ts, scripts/autoimprove/, api/, package.json, lockfiles or docs/auto-health.md.',
    '- Do not run git commands, do not commit, do not install packages, do not deploy.',
    `- Keep the diff under ${MAX_DIFF_LINES} changed lines outside the repro test.`,
    '- If you cannot find a real fix, change nothing and say why.',
  ].filter((l) => l !== '').join('\n');
}

export async function runAutoFix(deps: FixDeps, health: HealthState, maxAttempts = MAX_FIX_ATTEMPTS): Promise<{ attempted: number; accepted: number; notes: string[] }> {
  const notes: string[] = [];
  const candidates = fixCandidates(health, deps.now()).slice(0, maxAttempts);
  if (candidates.length === 0) return { attempted: 0, accepted: 0, notes: ['no new signatures'] };
  const claude = await deps.claudeAvailable();
  if (!claude) notes.push('claude CLI unavailable: detection + reproduction tests only');
  let attempted = 0, accepted = 0;
  for (const sig of candidates) {
    const at = deps.now().toISOString();
    const slug = slugOf(sig.signature);
    const reproPath = `tests/${sig.source === 'sim' ? 'sim' : 'client'}/repro/${slug}.test.ts`;
    const record = (outcome: 'accepted' | 'rejected' | 'skipped', reason: string, branch?: string, commit?: string) => {
      health.attempts.push({ at, signature: sig.signature, outcome, reason, branch, commit });
      deps.log(`auto-fix ${sig.signature}: ${outcome} — ${reason}`);
    };
    let wt: { dir: string; branch: string } | null = null;
    let keep = false;
    try {
      wt = await deps.createWorktree(slug);
      const haveRepro = await deps.writeRepro(wt.dir, sig, reproPath);
      if (haveRepro && (await deps.runTest(wt.dir, reproPath))) { record('skipped', 'generated repro passes on current main (already fixed or flaky)'); continue; }
      if (!claude) {
        record('skipped', haveRepro ? `claude unavailable; repro test left on branch ${wt.branch}` : 'claude unavailable; no repro possible', haveRepro ? wt.branch : undefined);
        keep = haveRepro;
        if (haveRepro) await deps.commit(wt.dir, `Repro test (failing, unfixed): ${sig.signature.slice(0, 60)}`);
        continue;
      }
      attempted++;
      const run = await deps.runClaude(wt.dir, fixPrompt(sig, reproPath, haveRepro));
      const changes = await deps.changes(wt.dir);
      const reproExists = changes.some((c) => c.path === reproPath) || haveRepro;
      const reproPassesWithFix = reproExists && (await deps.runTest(wt.dir, reproPath));
      const reproFailedOnBase = reproExists && (await deps.reproFailsOnBase(wt.dir, reproPath));
      // Cheap gate first; only run the full (slow) checks if it could still pass.
      const pre = evaluateFixGate({ claudeOk: run.ok, reproPath, reproFailedOnBase, reproPassesWithFix, changes, tests: true, tsc: true, e2e: true });
      if (!pre.accept) { record('rejected', pre.reason, wt.branch); continue; }
      const full = await deps.fullChecks(wt.dir);
      const verdict = evaluateFixGate({ claudeOk: run.ok, reproPath, reproFailedOnBase, reproPassesWithFix, changes, ...full });
      if (!verdict.accept) { record('rejected', verdict.reason, wt.branch); continue; }
      await deps.commit(wt.dir, `Auto-fix: ${sig.signature.slice(0, 60)}`);
      const commit = await deps.mergeToMain(wt.branch, `Merge auto-fix for ${sig.signature.slice(0, 60)}`);
      keep = true;
      accepted++;
      record('accepted', verdict.reason, wt.branch, commit);
    } catch (e) {
      record('rejected', `error: ${(e as Error)?.message ?? e}`, wt?.branch);
    } finally {
      if (wt) await deps.removeWorktree(wt.dir, wt.branch, keep).catch((e) => deps.log(`could not remove worktree ${wt!.dir}: ${e}`));
    }
  }
  return { attempted, accepted, notes };
}
