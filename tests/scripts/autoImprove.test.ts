import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, runAutoImprove, type CoreDeps, type RunOptions, type State } from '../../scripts/autoimprove/core';
import { emptyHealth, type HealthState } from '../../scripts/autoimprove/health';

type Calls = string[];

function fakeDeps(over: {
  branch?: string; clean?: boolean; locked?: boolean; winRate?: number; seeds?: number; checksOk?: boolean;
  trainThrows?: boolean; checksThrow?: boolean; fixesAccepted?: number; deployOk?: boolean;
} = {}) {
  const calls: Calls = [];
  let state: State = { lastReplayAt: '2026-11-19T00:00:00.000Z' };
  let health: HealthState = emptyHealth();
  const logs: string[] = [];
  let checksRun = 0;
  const deps: CoreDeps = {
    now: () => new Date('2026-11-20T03:00:00Z'),
    log: (m) => logs.push(m),
    lock: () => (over.locked ? null : { release: () => calls.push('unlock') }),
    git: {
      branch: async () => over.branch ?? 'main',
      isClean: async () => over.clean ?? true,
      commitBranchAndMerge: async (b, files) => { calls.push(`merge ${b} ${files.join(',')}`); return 'abc1234'; },
      commitOnMain: async (files, msg) => { calls.push(`commitMain ${files.join(',')} ${msg}`); },
      revert: async (files) => { calls.push(`revert ${files.join(',')}`); },
    },
    state: { load: async () => state, save: async (s) => { state = s; calls.push('saveState'); } },
    health: { load: async () => health, save: async (h) => { health = h; }, write: async () => { calls.push('writeHealth'); return 'docs/auto-health.md'; } },
    sync: {
      replays: async () => ({ newFiles: ['/c/r1.faereplay'], allFiles: ['/c/r0.faereplay', '/c/r1.faereplay'], newest: '2026-11-20T01:00:00.000Z' }),
      errors: async () => ({ reports: [{ build: 'b', kind: 'error', message: 'boom 42', stack: 'Error\n    at foo (https://x/assets/index-abcdefgh.js:1:2)' }], newest: '2026-11-20T02:00:00.000Z' }),
    },
    analyze: async () => ({ replays: 2, scenarios: 3, findings: [], summary: 'ok' }),
    train: async () => { calls.push('train'); if (over.trainThrows) throw new Error('worker crashed'); return { candidatePath: '/s/candidate.json', games: 500, findings: [] }; },
    series: async () => { calls.push('series'); return { winRate: over.winRate ?? 0.65, seeds: over.seeds ?? 40, games: 80 }; },
    installCandidate: async () => { calls.push('install'); return ['src/sim/bots/trained-params.json']; },
    checks: async () => { checksRun++; calls.push('checks'); if (over.checksThrow) throw new Error('vitest exploded'); return over.checksOk === false ? { ok: false, failed: 'pnpm test' } : { ok: true }; },
    autofix: async () => { calls.push('autofix'); return { attempted: over.fixesAccepted ? 1 : 0, accepted: over.fixesAccepted ?? 0, notes: [] }; },
    deploy: async () => { calls.push('deploy'); return { ok: over.deployOk ?? true, detail: 'https://faefight.vercel.app' }; },
    appendTrainingLog: async (row) => { calls.push(`log ${row}`); return 'docs/bot-training-log.md'; },
  };
  return { deps, calls, logs, getState: () => state, getHealth: () => health, checksRun: () => checksRun };
}

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({ ...DEFAULT_OPTIONS, ...o });

describe('auto-improve decision logic', () => {
  it('accepts a candidate that wins the series and passes tests: commit, merge, deploy, log', async () => {
    const f = fakeDeps();
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ outcome: 'accepted', deployed: true, games: 580 });
    expect(f.calls.filter((c) => !c.startsWith('log '))).toEqual([
      'train', 'series', 'install', 'checks', 'merge auto-improve/2026-11-20 src/sim/bots/trained-params.json', 'autofix', 'deploy',
      'writeHealth', 'commitMain docs/bot-training-log.md,docs/auto-health.md auto-improve: log run 2026-11-20 (accepted)', 'saveState', 'unlock',
    ]);
    const row = f.calls.find((c) => c.startsWith('log '))!;
    expect(row).toContain('1 new / 2 total');
    expect(row).toContain('65.0%');
    expect(row).toContain('| yes |');
    expect(f.getState()).toEqual({ lastReplayAt: '2026-11-20T01:00:00.000Z', lastErrorAt: '2026-11-20T02:00:00.000Z' });
    expect(Object.keys(f.getHealth().signatures)).toEqual(['client:error:boom N foo@index-*.js']);
  });

  it('rejects a candidate under the win-rate bar: nothing installed, merged or deployed', async () => {
    const f = fakeDeps({ winRate: 0.55 });
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ outcome: 'rejected', deployed: false });
    expect((r as { reason: string }).reason).toMatch(/55\.0% < 60%/);
    expect(f.calls.some((c) => c.startsWith('install') || c.startsWith('merge') || c === 'deploy')).toBe(false);
    expect(f.calls.find((c) => c.startsWith('log '))).toContain('rejected: win rate');
  });

  it('rejects a series with too few seeds', async () => {
    const f = fakeDeps({ seeds: 20, winRate: 0.9 });
    const r = await runAutoImprove(f.deps, opts());
    expect((r as { reason: string }).reason).toMatch(/only 20 series seeds/);
    expect(f.calls).not.toContain('install');
  });

  it('rejects and reverts a candidate that breaks tests', async () => {
    const f = fakeDeps({ checksOk: false });
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ outcome: 'rejected', deployed: false });
    expect(f.calls).toContain('revert src/sim/bots/trained-params.json');
    expect(f.calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('deploys accepted auto-fixes even when training is rejected, after re-checking main', async () => {
    const f = fakeDeps({ winRate: 0.5, fixesAccepted: 1 });
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ outcome: 'rejected', deployed: true });
    expect(f.calls.indexOf('checks')).toBeLessThan(f.calls.indexOf('deploy'));
  });

  it('skips the deploy when main fails checks after fix merges', async () => {
    const f = fakeDeps({ winRate: 0.5, fixesAccepted: 1, checksOk: false });
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ deployed: false });
    expect(f.calls).not.toContain('deploy');
  });

  it('honours --no-deploy', async () => {
    const f = fakeDeps();
    const r = await runAutoImprove(f.deps, opts({ deploy: false }));
    expect(r).toMatchObject({ outcome: 'accepted', deployed: false });
    expect(f.calls).not.toContain('deploy');
  });

  it.each([
    ['another run holds the lock', { locked: true }, 'locked'],
    ['not on main', { branch: 'feature' }, 'not on main (on feature)'],
    ['dirty tree', { clean: false }, 'working tree not clean'],
  ])('aborts when %s and changes nothing', async (_, over, reason) => {
    const f = fakeDeps(over);
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toEqual({ outcome: 'abort', reason });
    expect(f.calls.filter((c) => c !== 'unlock')).toEqual([]);
  });

  it('aborts cleanly on an error, reverting an installed candidate and releasing the lock', async () => {
    const f = fakeDeps({ checksThrow: true });
    const r = await runAutoImprove(f.deps, opts());
    expect(r.outcome).toBe('abort');
    expect((r as { reason: string }).reason).toContain('vitest exploded');
    expect(f.calls).toContain('revert src/sim/bots/trained-params.json');
    expect(f.calls[f.calls.length - 1]).toBe('unlock');
    expect(f.calls).not.toContain('saveState');
  });

  it('aborts on a training crash without touching the repo', async () => {
    const f = fakeDeps({ trainThrows: true });
    const r = await runAutoImprove(f.deps, opts());
    expect(r.outcome).toBe('abort');
    expect(f.calls.filter((c) => c !== 'train' && c !== 'unlock')).toEqual([]);
  });

  it('dry run downloads and analyzes but trains, writes and commits nothing (git issues are warnings)', async () => {
    const f = fakeDeps({ branch: 'feature', clean: false });
    const r = await runAutoImprove(f.deps, opts({ dryRun: true }));
    expect(r).toMatchObject({ outcome: 'dry-run', newReplays: 1, newErrors: 1 });
    expect(f.calls).toEqual(['unlock']);
    expect(f.logs.some((l) => l.includes('warning: not on main'))).toBe(true);
  });
});
