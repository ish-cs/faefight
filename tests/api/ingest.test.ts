import { describe, expect, it } from 'vitest';
import { handleErrors, handleReplays, MAX_REPLAY_BYTES, TokenBucket, validateErrorBatch, type Deps } from '../../api/_lib/ingest';
import { validateReplay } from '../../api/_lib/replayFormat';
import { MemoryBlobStore, pruneToCap } from '../../api/_lib/store';

const ADMIN = 'k'.repeat(32);
const BASE = 'https://faefight.test';

function replayBytes(n = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b.set([...'FAER'].map((c) => c.charCodeAt(0)));
  b[4] = 1;
  return b;
}

function deps(over: Partial<Deps> = {}): Deps & { store: MemoryBlobStore } {
  const store = new MemoryBlobStore();
  store.now = () => new Date('2026-11-20T03:00:00Z'); // fixed clock: list filters by upload time
  let i = 0;
  return { store, adminKey: ADMIN, limiter: new TokenBucket(100, 0), now: () => new Date('2026-11-20T03:00:00Z'), uuid: () => `id-${++i}`, ...over } as Deps & { store: MemoryBlobStore };
}

function post(body: BodyInit, headers: Record<string, string> = {}, path = '/api/replays') {
  return new Request(BASE + path, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', 'x-forwarded-for': '1.2.3.4', ...headers } });
}

describe('replay upload', () => {
  it('stores a valid replay under a dated, unguessable path', async () => {
    const d = deps();
    const r = await handleReplays(post(replayBytes()), d, validateReplay);
    expect(r.status).toBe(201);
    expect([...d.store.blobs.keys()]).toEqual(['replays/2026-11-20/id-1.faereplay']);
  });

  it('rejects the wrong content type, bad magic, bad version and oversize bodies', async () => {
    const d = deps();
    expect((await handleReplays(post(replayBytes(), { 'content-type': 'text/plain' }), d, validateReplay)).status).toBe(415);
    const bad = replayBytes(); bad[0] = 0;
    expect((await handleReplays(post(bad), d, validateReplay)).status).toBe(422);
    const v9 = replayBytes(); v9[4] = 9;
    expect((await handleReplays(post(v9), d, validateReplay)).status).toBe(422);
    expect((await handleReplays(post(new Uint8Array(4)), d, validateReplay)).status).toBe(422);
    expect((await handleReplays(post(replayBytes(MAX_REPLAY_BYTES + 1)), d, validateReplay)).status).toBe(413);
    // A lying content-length is still caught while streaming.
    const stream = new ReadableStream({ start(c) { c.enqueue(replayBytes(MAX_REPLAY_BYTES)); c.enqueue(new Uint8Array(10)); c.close(); } });
    const req = new Request(BASE + '/api/replays', { method: 'POST', body: stream, headers: { 'content-type': 'application/octet-stream' }, duplex: 'half' } as RequestInit);
    expect((await handleReplays(req, d, validateReplay)).status).toBe(413);
    expect(d.store.blobs.size).toBe(0);
  });

  it('rate-limits per IP', async () => {
    const d = deps({ limiter: new TokenBucket(2, 0) });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await handleReplays(post(replayBytes()), d, validateReplay)).status);
    expect(codes).toEqual([201, 201, 429]);
    expect((await handleReplays(post(replayBytes(), { 'x-forwarded-for': '5.6.7.8' }), d, validateReplay)).status).toBe(201);
  });

  it('token bucket refills over time', () => {
    let t = 0;
    const b = new TokenBucket(1, 1, () => t);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
    t = 1000;
    expect(b.take('a')).toBe(true);
  });

  it('lists and downloads only with the admin key', async () => {
    const d = deps();
    await handleReplays(post(replayBytes()), d, validateReplay);
    expect((await handleReplays(new Request(BASE + '/api/replays?since=2000-01-01'), d, validateReplay)).status).toBe(401);
    const wrong = { authorization: `Bearer ${'x'.repeat(32)}` };
    expect((await handleReplays(new Request(BASE + '/api/replays', { headers: wrong }), d, validateReplay)).status).toBe(401);
    const auth = { authorization: `Bearer ${ADMIN}` };
    const list = await handleReplays(new Request(BASE + '/api/replays?since=2000-01-01T00:00:00Z', { headers: auth }), d, validateReplay);
    const { blobs } = (await list.json()) as { blobs: { pathname: string }[] };
    expect(blobs.map((b) => b.pathname)).toEqual(['replays/2026-11-20/id-1.faereplay']);
    const later = await handleReplays(new Request(BASE + '/api/replays?since=2026-11-21T00:00:00Z', { headers: auth }), d, validateReplay);
    expect(((await later.json()) as { blobs: unknown[] }).blobs).toEqual([]);
    const dl = await handleReplays(new Request(BASE + `/api/replays?path=${blobs[0].pathname}`, { headers: auth }), d, validateReplay);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(replayBytes());
    expect((await handleReplays(new Request(BASE + '/api/replays?path=errors/x.json', { headers: auth }), d, validateReplay)).status).toBe(400);
  });

  it('an unset or short admin key never authorizes', async () => {
    const d = deps({ adminKey: undefined });
    expect((await handleReplays(new Request(BASE + '/api/replays', { headers: { authorization: 'Bearer ' } }), d, validateReplay)).status).toBe(401);
  });
});

describe('pruning', () => {
  it('deletes the oldest blobs beyond the cap', async () => {
    const s = new MemoryBlobStore();
    let t = 0;
    s.now = () => new Date(++t * 1000);
    for (let i = 0; i < 5; i++) await s.put(`replays/r${i}`, new Uint8Array(100), 'x');
    const r = await pruneToCap(s, 250);
    expect(r.deleted).toBe(3);
    expect([...s.blobs.keys()].sort()).toEqual(['replays/r3', 'replays/r4']);
  });
});

describe('error reports', () => {
  const report = { build: 'abc123', kind: 'error', message: 'boom', stack: 'at x', tick: 42 };
  const postJson = (b: unknown, h: Record<string, string> = {}) => post(JSON.stringify(b), { 'content-type': 'application/json', ...h }, '/api/errors');

  it('stores a valid batch', async () => {
    const d = deps();
    const r = await handleErrors(postJson({ reports: [report] }), d);
    expect(r.status).toBe(201);
    const [path, blob] = [...d.store.blobs.entries()][0];
    expect(path).toBe('errors/2026-11-20/id-1.json');
    expect(JSON.parse(new TextDecoder().decode(blob.body)).reports[0]).toMatchObject(report);
  });

  it('rejects bad JSON, bad shapes, unknown kinds, oversize and wrong type', async () => {
    const d = deps();
    expect((await handleErrors(post('{nope', { 'content-type': 'application/json' }, '/api/errors'), d)).status).toBe(400);
    expect((await handleErrors(postJson({ reports: [] }), d)).status).toBe(422);
    expect((await handleErrors(postJson({ reports: [{ ...report, kind: 'evil' }] }), d)).status).toBe(422);
    expect((await handleErrors(postJson({ reports: [{ kind: 'error' }] }), d)).status).toBe(422);
    expect((await handleErrors(postJson({ reports: [{ ...report, stack: 'x'.repeat(70_000) }] }), d)).status).toBe(413);
    expect((await handleErrors(post('x', { 'content-type': 'image/png' }, '/api/errors'), d)).status).toBe(415);
    expect(d.store.blobs.size).toBe(0);
  });

  it('truncates long fields and drops unknown ones', () => {
    const out = validateErrorBatch({ reports: [{ ...report, message: 'm'.repeat(5000), ip: '9.9.9.9' }] });
    expect(typeof out).not.toBe('string');
    const r = (out as Record<string, unknown>[])[0];
    expect((r.message as string).length).toBe(1000);
    expect(r).not.toHaveProperty('ip');
  });

  it('rate-limits per IP', async () => {
    const d = deps({ limiter: new TokenBucket(1, 0) });
    expect((await handleErrors(postJson({ reports: [report] }), d)).status).toBe(201);
    expect((await handleErrors(postJson({ reports: [report] }), d)).status).toBe(429);
  });
});
