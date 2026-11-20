import { describe, expect, it } from 'vitest';
import { evaluateFixGate, MAX_DIFF_LINES, runAutoFix, slugOf, type FileChange, type FixDeps, type GateInput } from '../../scripts/autoimprove/autofix';
import { emptyHealth, fixCandidates, ingestClient, ingestSim, renderHealth, type HealthState } from '../../scripts/autoimprove/health';
import { reproTestSource } from '../../scripts/autoimprove/repro';

const REPRO = 'tests/sim/repro/sim-stuck.test.ts';
const good: GateInput = {
  claudeOk: true, reproPath: REPRO, reproFailedOnBase: true, reproPassesWithFix: true,
  changes: [{ path: REPRO, status: 'A', added: 20, removed: 0 }, { path: 'src/sim/movement.ts', status: 'M', added: 4, removed: 2 }],
  tests: true, tsc: true, e2e: true,
};

describe('auto-fix gate', () => {
  it('accepts a small fix whose repro now passes with everything green', () => {
    expect(evaluateFixGate(good)).toEqual({ accept: true, reason: 'gate passed (6 lines)', lines: 6 });
  });

  it.each<[string, Partial<GateInput>, RegExp]>([
    ['claude failed', { claudeOk: false }, /claude run failed/],
    ['repro did not fail on base', { reproFailedOnBase: false }, /did not fail on base/],
    ['repro still fails', { reproPassesWithFix: false }, /still fails/],
    ['no code change', { changes: [good.changes[0]] }, /no code change/],
    ['tests red', { tests: false }, /pnpm test failed/],
    ['tsc red', { tsc: false }, /tsc failed/],
    ['e2e red', { e2e: false }, /e2e failed/],
    ['diff too big', { changes: [good.changes[0], { path: 'src/sim/match.ts', status: 'M', added: MAX_DIFF_LINES, removed: 5 }] }, /diff too large/],
    ['touches the auto-improve script', { changes: [...good.changes, { path: 'scripts/auto-improve.ts', status: 'M', added: 1, removed: 0 }] }, /forbidden path scripts\/auto-improve\.ts/],
    ['touches the auto-fix code', { changes: [...good.changes, { path: 'scripts/autoimprove/autofix.ts', status: 'M', added: 1, removed: 1 }] }, /forbidden/],
    ['edits an existing test', { changes: [...good.changes, { path: 'tests/sim/movement.test.ts', status: 'M', added: 1, removed: 1 }] }, /modifies existing test/],
    ['deletes an existing test', { changes: [...good.changes, { path: 'tests/sim/seal.test.ts', status: 'D', added: 0, removed: 80 }] }, /modifies existing test/],
  ])('rejects when %s', (_, over, reason) => {
    const v = evaluateFixGate({ ...good, ...over });
    expect(v.accept).toBe(false);
    expect(v.reason).toMatch(reason);
  });

  it('does not count the repro test or its replay fixture toward the diff budget', () => {
    const v = evaluateFixGate({ ...good, changes: [...good.changes, { path: 'tests/sim/repro/fixtures/sim-stuck.faereplay', status: 'A', added: 0, removed: 0 }] });
    expect(v).toMatchObject({ accept: true, lines: 6 });
  });
});

function healthWith(): HealthState {
  const h = emptyHealth();
  ingestSim(h, [{ signature: 'stuck', kind: 'stuck', detail: 'player 2 stuck', tick: 900, repro: { type: 'seed', seed: 7, setup: { seed: 7, maxSec: 1080, seats: [] } } }], '2026-11-20T03:00:00Z');
  ingestSim(h, [{ signature: 'stuck', kind: 'stuck', detail: 'again', tick: 950, repro: { type: 'seed', seed: 8, setup: { seed: 8, maxSec: 1080, seats: [] } } }], '2026-11-20T03:01:00Z');
  ingestClient(h, [{ build: 'b', kind: 'error', message: 'x is undefined', stack: 'TypeError\n    at hud (https://x/assets/hud-12345678.js:3:4)' }], '2026-11-20T03:00:00Z');
  return h;
}

function fakeFix(over: { claude?: boolean; claudeOk?: boolean; reproPassesOnMain?: boolean; reproAfter?: boolean; failsOnBase?: boolean; changes?: FileChange[]; checks?: Partial<{ tests: boolean; tsc: boolean; e2e: boolean }>; mergeThrows?: boolean } = {}) {
  const calls: string[] = [];
  let ran = 0;
  const deps: FixDeps = {
    now: () => new Date('2026-11-20T04:00:00Z'),
    log: () => {},
    claudeAvailable: async () => over.claude ?? true,
    createWorktree: async (slug) => { calls.push(`wt ${slug}`); return { dir: `/wt/${slug}`, branch: `auto-fix/2026-11-20-${slug}` }; },
    removeWorktree: async (dir, _b, keep) => { calls.push(`rm ${dir} keep=${keep}`); },
    writeRepro: async (_d, sig, p) => { calls.push(`repro ${p}`); return sig.source === 'sim'; },
    runTest: async () => { ran++; return ran === 1 ? (over.reproPassesOnMain ?? false) : (over.reproAfter ?? true); },
    reproFailsOnBase: async () => over.failsOnBase ?? true,
    runClaude: async (_d, prompt) => { calls.push('claude'); expect(prompt).toContain('Minimal fix'); return { ok: over.claudeOk ?? true, output: '' }; },
    changes: async (dir) => over.changes ?? [{ path: dir.includes('client') ? 'tests/client/repro/client-error-x-is-undefined-hud-hud-js.test.ts' : 'tests/sim/repro/sim-stuck.test.ts', status: 'A', added: 30, removed: 0 }, { path: 'src/sim/movement.ts', status: 'M', added: 3, removed: 1 }],
    fullChecks: async () => ({ tests: true, tsc: true, e2e: true, ...over.checks }),
    commit: async () => { calls.push('commit'); return 'c0ffee1'; },
    mergeToMain: async (b) => { calls.push(`mergeMain ${b}`); if (over.mergeThrows) throw new Error('conflict'); return 'beef123'; },
  };
  return { deps, calls };
}

describe('auto-fix loop', () => {
  it('ranks by count, accepts a gated sim fix and merges it, logging every attempt', async () => {
    const h = healthWith();
    const f = fakeFix({ changes: [{ path: 'tests/sim/repro/sim-stuck.test.ts', status: 'A', added: 30, removed: 0 }, { path: 'src/sim/movement.ts', status: 'M', added: 3, removed: 1 }] });
    const r = await runAutoFix(f.deps, h);
    expect(r.accepted).toBeGreaterThanOrEqual(1);
    expect(f.calls[0]).toBe('wt sim-stuck');
    expect(f.calls).toContain('mergeMain auto-fix/2026-11-20-sim-stuck');
    expect(h.attempts.find((a) => a.signature === 'sim:stuck')).toMatchObject({ outcome: 'accepted', commit: 'beef123' });
    expect(renderHealth(h, '2026-11-20T04:00:00Z')).toContain('| `sim:stuck` | sim | 2 |');
  });

  it('rejects when the repro still fails after the fix and drops the branch', async () => {
    const h = healthWith();
    const f = fakeFix({ reproAfter: false });
    const r = await runAutoFix(f.deps, h, 1);
    expect(r).toMatchObject({ attempted: 1, accepted: 0 });
    expect(h.attempts[0]).toMatchObject({ signature: 'sim:stuck', outcome: 'rejected', reason: 'repro test still fails' });
    expect(f.calls).not.toContain('commit');
    expect(f.calls).toContain('rm /wt/sim-stuck keep=false');
  });

  it('rejects when e2e fails in the full checks', async () => {
    const h = healthWith();
    const f = fakeFix({ checks: { e2e: false } });
    await runAutoFix(f.deps, h, 1);
    expect(h.attempts[0]).toMatchObject({ outcome: 'rejected', reason: 'e2e failed' });
  });

  it('a merge conflict is a rejection, not a crash', async () => {
    const h = healthWith();
    const f = fakeFix({ mergeThrows: true });
    await runAutoFix(f.deps, h, 1);
    expect(h.attempts[0]).toMatchObject({ outcome: 'rejected', reason: 'error: conflict' });
  });

  it('skips a signature whose generated repro already passes on main', async () => {
    const h = healthWith();
    const f = fakeFix({ reproPassesOnMain: true });
    const r = await runAutoFix(f.deps, h, 1);
    expect(r.attempted).toBe(0);
    expect(f.calls).not.toContain('claude');
    expect(h.attempts[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('without the claude CLI: detection + repro tests only, committed on a kept branch', async () => {
    const h = healthWith();
    const f = fakeFix({ claude: false });
    const r = await runAutoFix(f.deps, h, 1);
    expect(r).toMatchObject({ attempted: 0, accepted: 0 });
    expect(r.notes[0]).toMatch(/unavailable/);
    expect(f.calls).toContain('commit');
    expect(f.calls).not.toContain('claude');
    expect(f.calls.some((c) => c.startsWith('mergeMain'))).toBe(false);
    expect(f.calls).toContain('rm /wt/sim-stuck keep=true');
  });

  it('caps attempts and never retries a signature within the cooldown', async () => {
    const h = healthWith();
    const f = fakeFix({ reproAfter: false });
    await runAutoFix(f.deps, h, 3);
    expect(h.attempts.length).toBe(2);
    expect(fixCandidates(h, new Date('2026-11-21T04:00:00Z'))).toEqual([]);
    expect(fixCandidates(h, new Date('2026-12-01T04:00:00Z')).length).toBe(2);
  });
});

describe('repro tests and signatures', () => {
  it('generates a seed repro that replays the exact self-play spec', () => {
    const h = healthWith();
    const src = reproTestSource(h.signatures['sim:stuck'], 'tests/sim/repro/sim-stuck.test.ts')!;
    expect(src).toContain("from '../../../scripts/train/runMatch'");
    expect(src).toContain('const SIG = "stuck"');
    expect(src).toContain('"seed":7');
    expect(src).toContain('"maxSec":40'); // 900 ticks = 30 s, +10 s
  });

  it('client errors have no generated repro', () => {
    const h = healthWith();
    const sig = Object.values(h.signatures).find((s) => s.source === 'client')!;
    expect(reproTestSource(sig, 'tests/client/repro/x.test.ts')).toBeNull();
  });

  it('slugs are filesystem-safe', () => {
    expect(slugOf('client:error:x is undefined hud@hud-*.js')).toBe('client-error-x-is-undefined-hud-hud-js');
  });
});
