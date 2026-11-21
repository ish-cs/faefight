/**
 * Background POST with retry/backoff for the data-capture endpoints (/api/replays, /api/errors).
 * Retries network failures, 5xx and 429; gives up at once on other 4xx (the server rejected the data).
 */
export type UploadDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

export type UploadOpts = { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; keepalive?: boolean };

export type UploadResult = { ok: true; status: number; body: unknown } | { ok: false; status: number | null; reason: string; attempts: number };

export const defaultDeps = (): UploadDeps => ({
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export async function postWithRetry(url: string, body: BodyInit, contentType: string, deps: UploadDeps, opts: UploadOpts = {}): Promise<UploadResult> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 2000;
  const max = opts.maxDelayMs ?? 60_000;
  let last: { status: number | null; reason: string } = { status: null, reason: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await deps.sleep(Math.min(max, base * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5));
    try {
      const res = await deps.fetch(url, { method: 'POST', body, headers: { 'content-type': contentType }, keepalive: opts.keepalive });
      if (res.ok) return { ok: true, status: res.status, body: await res.json().catch(() => null) };
      last = { status: res.status, reason: `HTTP ${res.status}` };
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      last = { status: null, reason: (e as Error)?.message ?? String(e) };
    }
  }
  console.warn(`[upload] ${url} failed: ${last.reason}`);
  return { ok: false, ...last, attempts };
}
