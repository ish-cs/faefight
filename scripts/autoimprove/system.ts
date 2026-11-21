/// <reference types="node" />
/**
 * Real effects for the auto-improve run (git, files, lock, child processes, Vercel, Claude Code).
 * Nothing here ever pushes to a git remote.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileChange, FixDeps } from './autofix';
import type { CoreDeps, State } from './core';
import { emptyHealth, type ClientReport, type HealthState } from './health';
import { writeReproTest } from './repro';
import { listLocal, syncPrefix, type DataSource } from './sources';
import { analyzeReplays } from './learning';

/** learning: the dataset the bot trainer (run elsewhere) reads; see learning.ts. */
export type Paths = { repo: string; state: string; logs: string; cache: string; worktrees: string; learning: string };

export function paths(repo: string, stateDir?: string): Paths {
  const state = stateDir ?? path.join(repo, '.autoimprove');
  return { repo, state, logs: path.join(state, 'logs'), cache: path.join(state, 'cache'), worktrees: path.join(state, 'worktrees'), learning: path.join(state, 'learning') };
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

export type ExecResult = { code: number | null; out: string; timedOut: boolean };

/** Run a command (no shell), capture combined output (tail kept), append it to the run log. */
export function run(cmd: string, args: string[], o: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; log?: (m: string) => void; input?: string }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const keep = (b: Buffer) => { out += b.toString(); if (out.length > 200_000) out = out.slice(-100_000); };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    if (o.input !== undefined) { child.stdin!.write(o.input); child.stdin!.end(); }
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000); }, o.timeoutMs) : null;
    child.on('error', (e) => { out += `\n[spawn error] ${e.message}`; });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      o.log?.(`$ ${cmd} ${args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(' ')} → ${timedOut ? 'TIMEOUT' : `exit ${code}`}\n${out.slice(-4000)}`);
      resolve({ code, out, timedOut });
    });
  });
}

async function git(repo: string, args: string[], log?: (m: string) => void): Promise<string> {
  const r = await run('git', args, { cwd: repo, timeoutMs: 120_000 });
  if (r.code !== 0) { log?.(`git ${args.join(' ')} failed:\n${r.out}`); throw new Error(`git ${args.join(' ')} failed: ${r.out.trim().slice(-500)}`); }
  return r.out.trim();
}

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

export function acquireLock(file: string): { release(): void } | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return { release: () => { try { fs.rmSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { /* unreadable = stale */ }
      let alive = false;
      try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* not running */ }
      if (alive) return null;
      fs.rmSync(file, { force: true }); // stale lock from a crashed run
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Core deps
// ---------------------------------------------------------------------------------------------

const readJson = <T>(file: string, def: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return def; } };
const writeJson = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n'); };

const RUN_LOG_HEADER = `# Auto-improve log

One row per nightly \`scripts/auto-improve.ts\` run (launchd \`com.faefight.autoimprove\`): uploaded data pulled, learning dataset rebuilt for the bot trainer, invariant findings, auto-fixes.

| When | Replays | Error reports | Learning dataset | Invariant findings | Fixes merged | Deployed |
|---|---|---|---|---|---|---|
`;

export type SystemOpts = { p: Paths; source: DataSource; log: (m: string) => void; e2ePort?: number };

export function systemDeps(o: SystemOpts): CoreDeps {
  const { p, log } = o;
  const repo = p.repo;
  return {
    now: () => new Date(),
    log,
    lock: () => acquireLock(path.join(p.state, 'lock')),
    git: {
      branch: () => git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      isClean: async () => (await git(repo, ['status', '--porcelain'])) === '',
      async commitOnMain(files, message) {
        await git(repo, ['add', '--', ...files], log);
        if ((await git(repo, ['diff', '--cached', '--name-only'])) === '') return;
        await git(repo, ['commit', '-m', message], log);
      },
    },
    state: {
      load: async () => readJson<State>(path.join(p.state, 'state.json'), {}),
      save: async (s) => writeJson(path.join(p.state, 'state.json'), s),
    },
    health: {
      load: async () => readJson<HealthState>(path.join(p.state, 'health.json'), emptyHealth()),
      save: async (h) => writeJson(path.join(p.state, 'health.json'), h),
      async write(md) { fs.writeFileSync(path.join(repo, 'docs/auto-health.md'), md); return 'docs/auto-health.md'; },
    },
    sync: {
      async replays(since) {
        const r = await syncPrefix(o.source, 'replays', p.cache, since);
        return { newFiles: r.newFiles, allFiles: listLocal(path.join(p.cache, 'replays'), '.faereplay'), newest: r.newest };
      },
      async errors(since) {
        const r = await syncPrefix(o.source, 'errors', p.cache, since);
        const reports: ClientReport[] = [];
        for (const f of r.newFiles) {
          try { reports.push(...(JSON.parse(fs.readFileSync(f, 'utf8')) as { reports: ClientReport[] }).reports); } catch (e) { log(`bad error report ${f}: ${e}`); }
        }
        return { reports, newest: r.newest };
      },
    },
    async analyze(all, fresh) {
      const a = await analyzeReplays(all, fresh, p.learning, log);
      return { replays: a.replays, scenarios: a.scenarios, findings: a.findings, summary: a.summary };
    },
    checks: () => fullChecks(repo, log, { e2e: false }).then((c) => ({ ok: c.tests && c.tsc, failed: !c.tests ? 'pnpm test' : !c.tsc ? 'tsc' : undefined })),
    autofix: async (health) => {
      const { runAutoFix } = await import('./autofix');
      return runAutoFix(fixDeps(o), health);
    },
    async deploy() {
      const sha = await git(repo, ['rev-parse', '--short', 'HEAD']);
      const r = await run('vercel', ['deploy', '--prod', '--yes', '--build-env', `VITE_BUILD_ID=${sha}`], { cwd: repo, timeoutMs: 20 * 60_000, log });
      const url = r.out.match(/https:\/\/\S+\.vercel\.app/g)?.pop() ?? '';
      return { ok: r.code === 0, detail: r.code === 0 ? `${sha} ${url}` : `exit ${r.code}: ${r.out.slice(-300)}` };
    },
    async appendRunLog(row) {
      const rel = 'docs/auto-improve-log.md';
      const file = path.join(repo, rel);
      if (!fs.existsSync(file)) fs.writeFileSync(file, RUN_LOG_HEADER);
      fs.appendFileSync(file, row + '\n');
      return rel;
    },
  };
}

export async function fullChecks(dir: string, log: (m: string) => void, o: { e2e: boolean; e2ePort?: number }) {
  const tests = (await run('pnpm', ['test'], { cwd: dir, timeoutMs: 60 * 60_000, log })).code === 0;
  const tsc = (await run('npx', ['tsc', '--noEmit'], { cwd: dir, timeoutMs: 15 * 60_000, log })).code === 0;
  const e2e = !o.e2e || (await run('pnpm', ['e2e', '--workers=1'], { cwd: dir, timeoutMs: 40 * 60_000, log, env: { E2E_PORT: String(o.e2ePort ?? 5401) } })).code === 0;
  return { tests, tsc, e2e };
}

// ---------------------------------------------------------------------------------------------
// Auto-fix deps
// ---------------------------------------------------------------------------------------------

const CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(pnpm vitest:*)', 'Bash(pnpm test:*)', 'Bash(npx vitest:*)', 'Bash(npx tsc:*)', 'Bash(ls:*)', 'Bash(cat:*)'];

export function fixDeps(o: SystemOpts): FixDeps {
  const { p, log } = o;
  const repo = p.repo;
  return {
    now: () => new Date(),
    log,
    async claudeAvailable() {
      const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
      if (which.status !== 0) { log('claude CLI not on PATH'); return false; }
      const r = await run('claude', ['-p', 'Reply with exactly: OK', '--no-session-persistence', '--strict-mcp-config'], { cwd: p.state, timeoutMs: 180_000 });
      if (r.code !== 0 || !/OK/.test(r.out)) { log(`claude headless probe failed: ${r.out.slice(-300)}`); return false; }
      return true;
    },
    async createWorktree(slug) {
      const branch = `auto-fix/${new Date().toISOString().slice(0, 10)}-${slug}`;
      const dir = path.join(p.worktrees, slug);
      fs.mkdirSync(p.worktrees, { recursive: true });
      if (fs.existsSync(dir)) await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
      await git(repo, ['branch', '-D', branch]).catch(() => {});
      await git(repo, ['worktree', 'add', '-b', branch, dir, 'main'], log);
      fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
      return { dir, branch };
    },
    async removeWorktree(dir, branch, keepBranch) {
      await git(repo, ['worktree', 'remove', '--force', dir], log);
      if (!keepBranch) await git(repo, ['branch', '-D', branch]).catch(() => {});
    },
    async writeRepro(dir, sig, reproPath) { return writeReproTest(dir, sig, reproPath); },
    async runTest(dir, file) { return (await run('pnpm', ['vitest', 'run', file], { cwd: dir, timeoutMs: 20 * 60_000, log })).code === 0; },
    async reproFailsOnBase(dir, reproPath) {
      // Temporarily put every non-repro file back to the base commit, run the repro test, restore.
      const fixtures = reproPath.replace(/[^/]+$/, 'fixtures/');
      const isRepro = (f: string) => f === reproPath || f.startsWith(fixtures);
      await git(dir, ['add', '-A']);
      const entries = (await git(dir, ['diff', '--cached', '--name-status', '--no-renames', 'HEAD'])).split('\n').filter(Boolean)
        .map((l) => { const [st, f] = l.split('\t'); return { st: st[0], f }; }).filter((e) => !isRepro(e.f));
      const stash = fs.mkdtempSync(path.join(p.state, 'base-'));
      for (const e of entries) if (e.st !== 'D') { fs.mkdirSync(path.dirname(path.join(stash, e.f)), { recursive: true }); fs.copyFileSync(path.join(dir, e.f), path.join(stash, e.f)); }
      try {
        for (const e of entries) {
          if (e.st === 'A') { await git(dir, ['rm', '-q', '--cached', '--', e.f]); fs.rmSync(path.join(dir, e.f), { force: true }); }
          else await git(dir, ['checkout', 'HEAD', '--', e.f]);
        }
        return !(await this.runTest(dir, reproPath));
      } finally {
        for (const e of entries) {
          if (e.st === 'D') fs.rmSync(path.join(dir, e.f), { force: true });
          else { fs.mkdirSync(path.dirname(path.join(dir, e.f)), { recursive: true }); fs.copyFileSync(path.join(stash, e.f), path.join(dir, e.f)); }
        }
        await git(dir, ['add', '-A']);
        fs.rmSync(stash, { recursive: true, force: true });
      }
    },
    async runClaude(dir, prompt) {
      const r = await run('claude', ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', ...CLAUDE_TOOLS, '--disallowedTools', 'Bash(git:*)', 'WebFetch', 'WebSearch',
        '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project'], { cwd: dir, timeoutMs: 40 * 60_000, log });
      return { ok: r.code === 0 && !r.timedOut, output: r.out.slice(-4000) };
    },
    async changes(dir) {
      await git(dir, ['add', '-A']);
      const numstat = (await git(dir, ['diff', '--cached', '--numstat', '--no-renames', 'HEAD'])).split('\n').filter(Boolean);
      const status = new Map((await git(dir, ['diff', '--cached', '--name-status', '--no-renames', 'HEAD'])).split('\n').filter(Boolean).map((l) => {
        const [s, ...rest] = l.split('\t');
        return [rest[rest.length - 1], s[0] as FileChange['status']] as const;
      }));
      return numstat.map((l) => {
        const [a, r, ...rest] = l.split('\t');
        const file = rest.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '');
        return { path: file, status: status.get(file) ?? 'M', added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) };
      });
    },
    fullChecks: (dir) => fullChecks(dir, log, { e2e: true, e2ePort: o.e2ePort ?? 5401 }),
    async commit(dir, message) {
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', message], log);
      return git(dir, ['rev-parse', '--short', 'HEAD']);
    },
    async mergeToMain(branch, message) {
      try {
        await git(repo, ['merge', '--no-ff', branch, '-m', message], log);
      } catch (e) {
        await git(repo, ['merge', '--abort']).catch(() => {});
        throw e;
      }
      return git(repo, ['rev-parse', '--short', 'HEAD']);
    },
  };
}
