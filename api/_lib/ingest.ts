/**
 * Pure request handling for the data-capture endpoints (api/replays.ts, api/errors.ts). Everything
 * environment-specific (blob store, clock, admin key, ids) is injected so it can be unit-tested.
 */
import { listAll, pruneToCap, type BlobStore } from './store.js';

export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;
/** Prune the oldest blobs beyond this (Hobby Blob storage is 1 GB). */
export const STORE_CAP_BYTES = 800 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Rate limiting: per-IP token bucket, in memory (per function instance; good enough).
// ---------------------------------------------------------------------------------------------

export class TokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number, private now: () => number = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (this.buckets.size > 10_000) this.buckets.clear(); // bound memory under a flood
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd?.split(',')[0] ?? req.headers.get('x-real-ip') ?? 'unknown').trim();
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** Read at most `max` bytes; null when the body is larger (checked before and while reading). */
export async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** Constant-time-ish compare of the bearer token against the admin key. */
export function isAdmin(req: Request, adminKey: string | undefined): boolean {
  if (!adminKey || adminKey.length < 16) return false;
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (got.length !== adminKey.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ adminKey.charCodeAt(i);
  return diff === 0;
}

export type Deps = {
  store: BlobStore;
  adminKey: string | undefined;
  limiter: TokenBucket;
  now?: () => Date;
  uuid?: () => string;
  /** Prune every Nth successful upload (0 = never); listing costs Blob operations, so keep it rare. */
  pruneEvery?: number;
};

let uploadsSincePrune = 0;

function dayPath(prefix: string, now: Date, id: string, ext: string) {
  return `${prefix}/${now.toISOString().slice(0, 10)}/${id}${ext}`;
}

/** Shared admin GET: `?list=1[&since=ISO]` lists, `?path=...` downloads one blob under the prefix. */
async function adminGet(req: Request, deps: Deps, prefix: string, downloadType: string): Promise<Response> {
  if (!isAdmin(req, deps.adminKey)) return json(401, { error: 'unauthorized' });
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (path) {
    if (!path.startsWith(`${prefix}/`) || path.includes('..')) return json(400, { error: 'bad path' });
    const body = await deps.store.get(path);
    if (!body) return json(404, { error: 'not found' });
    return new Response(body.slice(), { status: 200, headers: { 'content-type': downloadType, 'cache-control': 'no-store' } });
  }
  const since = url.searchParams.get('since');
  const sinceMs = since ? Date.parse(since) : 0;
  if (Number.isNaN(sinceMs)) return json(400, { error: 'bad since' });
  const blobs = (await listAll(deps.store, `${prefix}/`))
    .filter((b) => b.uploadedAt.getTime() > sinceMs)
    .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
    .map((b) => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt.toISOString() }));
  return json(200, { blobs });
}

async function adminPrune(req: Request, deps: Deps): Promise<Response> {
  if (!isAdmin(req, deps.adminKey)) return json(401, { error: 'unauthorized' });
  return json(200, await pruneToCap(deps.store, STORE_CAP_BYTES));
}

async function maybePrune(deps: Deps) {
  if (!deps.pruneEvery) return;
  if (++uploadsSincePrune < deps.pruneEvery) return;
  uploadsSincePrune = 0;
  try { await pruneToCap(deps.store, STORE_CAP_BYTES); } catch (e) { console.error('[ingest] prune failed', e); }
}

// ---------------------------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------------------------

export type ReplayValidator = (bytes: Uint8Array) => string | null;

export async function handleReplays(req: Request, deps: Deps, validate: ReplayValidator): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET') return adminGet(req, deps, 'replays', 'application/octet-stream');
  if (req.method === 'POST' && url.searchParams.get('action') === 'prune') return adminPrune(req, deps);
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream' && type !== 'application/x-faereplay') return json(415, { error: 'content-type must be application/octet-stream' });
  if (!deps.limiter.take(clientIp(req))) return json(429, { error: 'rate limited' });
  const body = await readLimited(req, MAX_REPLAY_BYTES);
  if (!body) return json(413, { error: `replay larger than ${MAX_REPLAY_BYTES} bytes` });
  const bad = validate(body);
  if (bad) return json(422, { error: `invalid replay: ${bad}` });

  const now = (deps.now ?? (() => new Date()))();
  const id = (deps.uuid ?? (() => crypto.randomUUID()))();
  const pathname = dayPath('replays', now, id, '.faereplay');
  await deps.store.put(pathname, body, 'application/octet-stream');
  await maybePrune(deps);
  return json(201, { id, pathname });
}

// ---------------------------------------------------------------------------------------------
// Client error reports
// ---------------------------------------------------------------------------------------------

export type ErrorReport = {
  build: string;
  /** error | rejection | worker | gpu | longframe | fatal */
  kind: string;
  message: string;
  stack?: string;
  replayId?: string;
  tick?: number;
  count?: number;
  ua?: string;
  at?: string;
};
const ERROR_KINDS = new Set(['error', 'rejection', 'worker', 'gpu', 'longframe', 'fatal']);
const MAX_REPORTS_PER_POST = 20;

/** Returns the cleaned reports or an error string. */
export function validateErrorBatch(raw: unknown): ErrorReport[] | string {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { reports?: unknown }).reports)) ? (raw as { reports: unknown[] }).reports : null;
  if (!list) return 'body must be {"reports":[...]}';
  if (list.length === 0 || list.length > MAX_REPORTS_PER_POST) return `1..${MAX_REPORTS_PER_POST} reports per post`;
  const out: ErrorReport[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') return 'report must be an object';
    const o = r as Record<string, unknown>;
    if (typeof o.build !== 'string' || typeof o.kind !== 'string' || typeof o.message !== 'string') return 'build, kind and message are required strings';
    if (!ERROR_KINDS.has(o.kind)) return `unknown kind ${String(o.kind).slice(0, 20)}`;
    const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    out.push({
      build: o.build.slice(0, 64), kind: o.kind, message: o.message.slice(0, 1000), stack: str(o.stack, 4000),
      replayId: str(o.replayId, 64), tick: num(o.tick), count: num(o.count), ua: str(o.ua, 200), at: str(o.at, 40),
    });
  }
  return out;
}

export async function handleErrors(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'GET') return adminGet(req, deps, 'errors', 'application/json');
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/plain') return json(415, { error: 'content-type must be application/json' });
  if (!deps.limiter.take(clientIp(req))) return json(429, { error: 'rate limited' });
  const body = await readLimited(req, MAX_ERROR_BYTES);
  if (!body) return json(413, { error: `error report larger than ${MAX_ERROR_BYTES} bytes` });
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { return json(400, { error: 'invalid JSON' }); }
  const reports = validateErrorBatch(parsed);
  if (typeof reports === 'string') return json(422, { error: reports });

  const now = (deps.now ?? (() => new Date()))();
  const id = (deps.uuid ?? (() => crypto.randomUUID()))();
  const pathname = dayPath('errors', now, id, '.json');
  await deps.store.put(pathname, new TextEncoder().encode(JSON.stringify({ receivedAt: now.toISOString(), reports })), 'application/json');
  await maybePrune(deps);
  return json(201, { id });
}
