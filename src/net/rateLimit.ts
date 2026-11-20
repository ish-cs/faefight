/**
 * Host-side abuse limits for one remote peer. Everything a peer sends goes through `admit` (size cap
 * + overall message budget) before it is even sanitized; inputs additionally through `admitInput`.
 * Over-budget, oversized and malformed messages are dropped and add "strikes" that decay over time;
 * a peer whose strikes pass the threshold is kicked (a sustained flood, not a hiccup).
 */
export const LIMITS = {
  /** Every message type together. A normal client sends ~30 inputs/s + a few previews/chats. */
  msgRate: 120,
  msgBurst: 240,
  /** Inputs (client sends one per sim tick, 30/s). */
  inputRate: 75,
  inputBurst: 120,
  /** Rough serialized size cap per message (a full input is ~400 B, a max chat ~1 KB). */
  maxMsgBytes: 4096,
  maxDepth: 6,
  strikeDecayPerSec: 30,
  kickAtStrikes: 300,
  oversizeStrikes: 10,
} as const;

export type Verdict = 'ok' | 'drop' | 'kick';

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly ratePerSec: number, private readonly burst: number, nowMs: number) {
    this.tokens = burst;
    this.last = nowMs;
  }

  take(nowMs: number): boolean {
    const dt = Math.max(0, nowMs - this.last) / 1000;
    this.last = Math.max(this.last, nowMs);
    this.tokens = Math.min(this.burst, this.tokens + dt * this.ratePerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Approximate JSON size of an untrusted value, stopping as soon as it passes `limit` or nests deeper
 * than `maxDepth` (returns Infinity then). Work is bounded by ~limit, whatever the input.
 */
export function messageSize(x: unknown, limit: number, maxDepth: number = LIMITS.maxDepth): number {
  let total = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (total > limit) return false;
    if (typeof v === 'string') { total += v.length + 2; return total <= limit; }
    if (v === null || typeof v !== 'object') { total += 8; return total <= limit; }
    if (depth >= maxDepth) return false;
    total += 2;
    if (Array.isArray(v)) {
      if (v.length > limit) return false;
      for (const item of v) if (!walk(item, depth + 1)) return false;
      return true;
    }
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      total += k.length + 3;
      if (total > limit || !walk((v as Record<string, unknown>)[k], depth + 1)) return false;
    }
    return true;
  };
  return walk(x, 0) ? total : Infinity;
}

export class PeerGuard {
  private msgs: TokenBucket;
  private inputs: TokenBucket;
  private strikes = 0;
  private strikesAt: number;
  /** Totals for logging. */
  dropped = 0;

  constructor(nowMs: number) {
    this.msgs = new TokenBucket(LIMITS.msgRate, LIMITS.msgBurst, nowMs);
    this.inputs = new TokenBucket(LIMITS.inputRate, LIMITS.inputBurst, nowMs);
    this.strikesAt = nowMs;
  }

  /** Any message, before sanitizing. */
  admit(raw: unknown, nowMs: number): Verdict {
    if (messageSize(raw, LIMITS.maxMsgBytes) === Infinity) return this.strike(LIMITS.oversizeStrikes, nowMs);
    return this.msgs.take(nowMs) ? 'ok' : this.strike(1, nowMs);
  }

  /** An input message (after admit). */
  admitInput(nowMs: number): Verdict {
    return this.inputs.take(nowMs) ? 'ok' : this.strike(1, nowMs);
  }

  /** A message that failed sanitizing. Dropped by the caller; 'kick' once it's clearly abuse. */
  malformed(nowMs: number): Verdict {
    return this.strike(1, nowMs) === 'kick' ? 'kick' : 'ok';
  }

  private strike(n: number, nowMs: number): Verdict {
    const dt = Math.max(0, nowMs - this.strikesAt) / 1000;
    this.strikesAt = Math.max(this.strikesAt, nowMs);
    this.strikes = Math.max(0, this.strikes - dt * LIMITS.strikeDecayPerSec) + n;
    this.dropped++;
    return this.strikes > LIMITS.kickAtStrikes ? 'kick' : 'drop';
  }
}
