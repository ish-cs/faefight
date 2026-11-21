import { describe, expect, it } from 'vitest';
import { postWithRetry, type UploadDeps } from '../../src/client/telemetry/upload';
import { ErrorReporter } from '../../src/client/telemetry/errors';
import { telemetryEnabled } from '../../src/client/telemetry/config';

function fakeDeps(statuses: (number | 'throw')[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const deps: UploadDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const s = statuses.shift() ?? 500;
      if (s === 'throw') throw new TypeError('network down');
      return new Response(JSON.stringify({ id: 'x' }), { status: s });
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { deps, calls, sleeps };
}

describe('postWithRetry', () => {
  it('retries network errors, 5xx and 429 with growing backoff, then succeeds', async () => {
    const f = fakeDeps(['throw', 503, 429, 201]);
    const r = await postWithRetry('/api/replays', 'b', 'application/octet-stream', f.deps, { attempts: 5, baseDelayMs: 1000 });
    expect(r.ok).toBe(true);
    expect(f.calls.length).toBe(4);
    expect(f.sleeps.length).toBe(3);
    expect(f.sleeps[2]).toBeGreaterThan(f.sleeps[0]);
  });

  it('gives up immediately on a 4xx rejection', async () => {
    const f = fakeDeps([422, 201]);
    const r = await postWithRetry('/api/replays', 'b', 'application/octet-stream', f.deps);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(f.calls.length).toBe(1);
  });

  it('stops after the attempt budget', async () => {
    const f = fakeDeps(['throw', 'throw', 'throw']);
    const r = await postWithRetry('/x', 'b', 'text/plain', f.deps, { attempts: 3 });
    expect(r).toMatchObject({ ok: false, status: null, reason: 'network down' });
    expect(f.calls.length).toBe(3);
  });
});

describe('ErrorReporter', () => {
  it('dedupes repeats into a count and sends one batch', async () => {
    const f = fakeDeps([201]);
    const rep = new ErrorReporter('b1', '/api/errors', f.deps);
    rep.context = { replayId: 'r1', tick: 7 };
    for (let i = 0; i < 50; i++) rep.report('error', 'boom', 'Error: boom\n    at foo (a.js:1:1)');
    rep.report('rejection', 'nope');
    await rep.flush();
    expect(f.calls.length).toBe(1);
    const body = JSON.parse(f.calls[0].init.body as string);
    expect(body.reports).toHaveLength(2);
    expect(body.reports[0]).toMatchObject({ build: 'b1', kind: 'error', message: 'boom', count: 50, replayId: 'r1', tick: 7 });
    // Already-sent signatures are not resent in the same session.
    rep.report('error', 'boom', 'Error: boom\n    at foo (a.js:1:1)');
    await rep.flush();
    expect(f.calls.length).toBe(1);
  });

  it('reports sustained long frames once, ignores a few hitches', async () => {
    const f = fakeDeps([201, 201]);
    const rep = new ErrorReporter('b1', '/api/errors', f.deps);
    rep.frame(16); rep.frame(150); rep.frame(120);
    await rep.flush();
    expect(f.calls.length).toBe(0);
    for (let i = 0; i < 5; i++) rep.frame(200);
    await rep.flush();
    const body = JSON.parse(f.calls[0].init.body as string);
    expect(body.reports[0]).toMatchObject({ kind: 'longframe', count: 7 });
  });
});

describe('telemetryEnabled', () => {
  it('is on for deployed builds, off on localhost unless forced', () => {
    expect(telemetryEnabled({ hostname: 'faefight.vercel.app', search: '' }, true)).toBe(true);
    expect(telemetryEnabled({ hostname: 'localhost', search: '' }, true)).toBe(false);
    expect(telemetryEnabled({ hostname: 'localhost', search: '?telemetry=1' }, false)).toBe(true);
    expect(telemetryEnabled({ hostname: 'faefight.vercel.app', search: '' }, false)).toBe(false);
  });
  it('has no opt-out in deployed builds', () => {
    expect(telemetryEnabled({ hostname: 'faefight.vercel.app', search: '?telemetry=0' }, true)).toBe(true);
  });
});
