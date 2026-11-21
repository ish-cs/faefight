/**
 * Reconnect grace (guest side). The host hands each guest a rejoin token for its seat; we keep it in
 * sessionStorage (this tab only, survives a reload) with a heartbeat time. If the link drops or the tab
 * reloads mid-match, joining the same code with the token reclaims the seat within the host's grace window.
 */

export const REJOIN_KEY = 'faefight.rejoin';
/** Host keeps a dropped guest's seat this long (the bot plays it meanwhile). */
export const REJOIN_GRACE_MS = 20_000;
/** Set just before an automatic reload after a drop: boot joins straight away. */
const AUTO_KEY = 'faefight.rejoin.auto';

export type RejoinRecord = { code: string; token: string; name: string; at: number };

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): KV | null => {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
};

const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;
export const validToken = (t: unknown): t is string => typeof t === 'string' && TOKEN_RE.test(t);

export function newRejoinToken(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('-');
}

export function saveRejoin(r: Omit<RejoinRecord, 'at'>, nowMs = Date.now(), kv = store()) {
  if (!validToken(r.token)) { console.warn('[rejoin] ignoring a malformed token from the host'); return; }
  kv?.setItem(REJOIN_KEY, JSON.stringify({ ...r, at: nowMs }));
}

/** Still in the match: refresh the heartbeat (a record goes stale REJOIN_GRACE_MS after the last one). */
export function touchRejoin(nowMs = Date.now(), kv = store()) {
  const r = loadRejoin(nowMs, kv);
  if (r) kv?.setItem(REJOIN_KEY, JSON.stringify({ ...r, at: nowMs }));
}

/** The record if it's fresh enough to be worth a rejoin, else null (and a stale one is dropped). */
export function loadRejoin(nowMs = Date.now(), kv = store()): RejoinRecord | null {
  const raw = kv?.getItem(REJOIN_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as RejoinRecord;
    if (typeof r.code === 'string' && validToken(r.token) && typeof r.name === 'string' && typeof r.at === 'number'
      && nowMs - r.at >= 0 && nowMs - r.at < REJOIN_GRACE_MS) return r;
  } catch { /* fall through */ }
  kv?.removeItem(REJOIN_KEY);
  return null;
}

/** Left on purpose (Leave / Back to menu / match over): no rejoin offer. */
export function clearRejoin(kv = store()) {
  kv?.removeItem(REJOIN_KEY);
  kv?.removeItem(AUTO_KEY);
}

/** Lost the link mid-match: reload and rejoin automatically. */
export function markAutoRejoin(kv = store()) {
  kv?.setItem(AUTO_KEY, '1');
}

/** Consume the auto-rejoin flag (true once). */
export function takeAutoRejoin(kv = store()): boolean {
  const on = kv?.getItem(AUTO_KEY) === '1';
  kv?.removeItem(AUTO_KEY);
  return on;
}
