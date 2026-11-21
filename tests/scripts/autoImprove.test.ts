import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, runAutoImprove, type CoreDeps, type RunOptions, type State } from '../../scripts/autoimprove/core';
import { emptyHealth, type HealthState } from '../../scripts/autoimprove/health';

type Calls = string[];

function fakeDeps(over: {
  branch?: string; clean?: boolean; locked?: boolean; checksOk?: boolean; analyzeThrows?: boolean; fixesAccepted?: number; deployOk?: boolean;
} = {}) {
  const calls: Calls = [];
  let state: State = { lastReplayAt: '2026-11-19T00:00:00.000Z' };
  let health: HealthState = emptyHealth();
  const logs: string[] = [];
  const deps: CoreDeps = {
    now: () => new Date('2026-11-20T03:00:00Z'),
    log: (m) => logs.push(m),
    lock: () => (over.locked ? null : { release: () => calls.push('unlock') }),
    git: {
      branch: async () => over.branch ?? 'main',
      isClean: async () => over.clean ?? true,
      commitOnMain: async (files, msg) => { calls.push(`commitMain ${files.join(',')} ${msg}`); },
    },
    state: { load: async () => state, save: async (s) => { state = s; calls.push('saveState'); } },
    health: { load: async () => health, save: async (h) => { health = h; }, write: async () => { calls.push('writeHealth'); return 'docs/auto-health.md'; } },
    sync: {
      replays: async () => ({ newFiles: ['/c/r1.faereplay'], allFiles: ['/c/r0.faereplay', '/c/r1.faereplay'], newest: '2026-11-20T01:00:00.000Z' }),
      errors: async () => ({ reports: [{ build: 'b', kind: 'error', message: 'boom 42', stack: 'Error\n    at foo (https://x/assets/index-abcdefgh.js:1:2)' }], newest: '2026-11-20T02:00:00.000Z' }),
    },
    analyze: async (all, fresh) => {
      calls.push(`analyze ${all.length}/${fresh.length}`);
      if (over.analyzeThrows) throw new Error('decoder exploded');
      return { replays: 2, scenarios: 3, findings: [], summary: 'ok' };
    },
    checks: async () => { calls.push('checks'); return over.checksOk === false ? { ok: false, failed: 'pnpm test' } : { ok: true }; },
    autofix: async () => { calls.push('autofix'); return { attempted: over.fixesAccepted ? 1 : 0, accepted: over.fixesAccepted ?? 0, notes: [] }; },
    deploy: async () => { calls.push('deploy'); return { ok: over.deployOk ?? true, detail: 'https://faefight.vercel.app' }; },
    appendRunLog: async (row) => { calls.push(`log ${row}`); return 'docs/auto-improve-log.md'; },
  };
  return { deps, calls, logs, getState: () => state, getHealth: () => health };
}

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({ ...DEFAULT_OPTIONS, ...o });

describe('auto-improve decision logic', () => {
  it('pulls data, rebuilds the learning dataset, auto-fixes and logs; never trains', async () => {
    const f = fakeDeps();
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ outcome: 'done', deployed: false });
    expect(f.calls.filter((c) => !c.startsWith('log '))).toEqual([
      'analyze 2/1', 'autofix', 'writeHealth', 'commitMain docs/auto-improve-log.md,docs/auto-health.md auto-improve: log run 2026-11-20', 'saveState', 'unlock',
    ]);
    const row = f.calls.find((c) => c.startsWith('log '))!;
    expect(row).toContain('1 new / 2 total');
    expect(row).toContain('2 matches, 3 scenarios');
    expect(f.getState()).toEqual({ lastReplayAt: '2026-11-20T01:00:00.000Z', lastErrorAt: '2026-11-20T02:00:00.000Z' });
    expect(Object.keys(f.getHealth().signatures)).toEqual(['client:error:boom N foo@index-*.js']);
  });

  it('deploys accepted auto-fixes after re-checking main', async () => {
    const f = fakeDeps({ fixesAccepted: 1 });
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ outcome: 'done', deployed: true });
    expect(f.calls.indexOf('checks')).toBeLessThan(f.calls.indexOf('deploy'));
  });

  it('skips the deploy when main fails checks after fix merges', async () => {
    const f = fakeDeps({ fixesAccepted: 1, checksOk: false });
    const r = await runAutoImprove(f.deps, opts());
    expect(r).toMatchObject({ deployed: false });
    expect(f.calls).not.toContain('deploy');
  });

  it('honours --no-deploy and --no-autofix', async () => {
    const f = fakeDeps({ fixesAccepted: 1 });
    expect(await runAutoImprove(f.deps, opts({ deploy: false }))).toMatchObject({ deployed: false });
    expect(f.calls).not.toContain('deploy');
    const g = fakeDeps();
    await runAutoImprove(g.deps, opts({ autofix: false }));
    expect(g.calls).not.toContain('autofix');
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

  it('aborts cleanly on an error, releasing the lock without advancing state', async () => {
    const f = fakeDeps({ analyzeThrows: true });
    const r = await runAutoImprove(f.deps, opts());
    expect(r.outcome).toBe('abort');
    expect((r as { reason: string }).reason).toContain('decoder exploded');
    expect(f.calls[f.calls.length - 1]).toBe('unlock');
    expect(f.calls).not.toContain('saveState');
  });

  it('dry run downloads and analyzes but fixes, writes and commits nothing (git issues are warnings)', async () => {
    const f = fakeDeps({ branch: 'feature', clean: false });
    const r = await runAutoImprove(f.deps, opts({ dryRun: true }));
    expect(r).toMatchObject({ outcome: 'dry-run', newReplays: 1, newErrors: 1 });
    expect(f.calls).toEqual(['analyze 2/1', 'unlock']);
    expect(f.logs.some((l) => l.includes('warning: not on main'))).toBe(true);
  });
});
