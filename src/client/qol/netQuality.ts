/**
 * Connection quality for online play (pure, no DOM):
 * - PingTracker: host-side round-trip times per link (ping → pong), smoothed.
 * - TickMonitor: host-side "is the simulation keeping 30 Hz?" from worker snapshot arrivals.
 * - LinkHealth: client-side "are snapshots arriving smoothly?" (delay spikes) plus the host-measured RTT.
 */

/** Ping every second; a pong older than this is ignored (counts as a spike via LinkHealth instead). */
export const PING_EVERY_MS = 1000;
const PONG_MAX_AGE_MS = 10_000;
/** Smoothing for RTT (new sample weight). */
const RTT_ALPHA = 0.3;

export class PingTracker {
  private sent = new Map<string, { n: number; at: number }>();
  private rtt = new Map<string, number>();
  private seq = 0;

  /** Next ping number for `key` (remember when it went out). */
  ping(key: string, nowMs: number): number {
    const n = ++this.seq;
    this.sent.set(key, { n, at: nowMs });
    return n;
  }

  /** A pong came back: returns the smoothed RTT, or null if it doesn't match the last ping. */
  pong(key: string, n: number, nowMs: number): number | null {
    const s = this.sent.get(key);
    if (!s || s.n !== n || nowMs - s.at > PONG_MAX_AGE_MS || nowMs < s.at) return null;
    this.sent.delete(key);
    const sample = nowMs - s.at;
    const prev = this.rtt.get(key);
    const v = prev === undefined ? sample : prev + (sample - prev) * RTT_ALPHA;
    this.rtt.set(key, v);
    return v;
  }

  /** Smoothed RTT (ms), or null before the first pong. An unanswered ping older than 2 s raises it. */
  get(key: string, nowMs: number): number | null {
    const v = this.rtt.get(key);
    const s = this.sent.get(key);
    const waiting = s ? nowMs - s.at : 0;
    if (waiting > 2000) return Math.max(v ?? 0, waiting);
    return v ?? null;
  }

  forget(key: string) {
    this.sent.delete(key);
    this.rtt.delete(key);
  }
}

export type HostTick = 'ok' | 'strained';

/** Worker snapshots should arrive at 30 Hz; fewer than this over the window, or a long stall, = strained. */
const TICK_WINDOW_MS = 2000;
const TICK_MIN_RATE = 25;
const TICK_MAX_GAP_MS = 200;

export class TickMonitor {
  private at: number[] = [];

  onTick(nowMs: number) {
    this.at.push(nowMs);
    while (this.at.length && this.at[0] < nowMs - TICK_WINDOW_MS) this.at.shift();
  }

  state(nowMs: number): HostTick {
    const xs = this.at.filter((t) => t >= nowMs - TICK_WINDOW_MS);
    if (xs.length < 2) return 'ok'; // just started (or nothing yet): no verdict
    let gap = nowMs - xs[xs.length - 1];
    for (let i = 1; i < xs.length; i++) gap = Math.max(gap, xs[i] - xs[i - 1]);
    const span = Math.min(TICK_WINDOW_MS, nowMs - xs[0]);
    const rate = span > 500 ? ((xs.length - 1) * 1000) / span : TICK_MIN_RATE;
    return rate < TICK_MIN_RATE || gap > TICK_MAX_GAP_MS ? 'strained' : 'ok';
  }
}

/** Snapshots are sent at 15 Hz (~67 ms apart); a gap this long is a visible hitch. */
const SPIKE_MS = 300;
const SPIKE_MEMORY_MS = 3000;
const BAD_RTT_MS = 250;

export class LinkHealth {
  private last: number | null = null;
  private spikeAt = -Infinity;

  onSnapshot(nowMs: number) {
    if (this.last !== null && nowMs - this.last > SPIKE_MS) this.spikeAt = nowMs;
    this.last = nowMs;
  }

  /** Bad = a delay spike in the last few seconds, snapshots stalled right now, or a high RTT. */
  bad(nowMs: number, rttMs: number | null): boolean {
    if (this.last === null) return false;
    if (nowMs - this.last > SPIKE_MS) return true;
    if (nowMs - this.spikeAt < SPIKE_MEMORY_MS) return true;
    return rttMs !== null && rttMs > BAD_RTT_MS;
  }
}

/** Scoreboard text: "42 ms", "host", or "—". */
export function pingLabel(rtt: number | null | undefined, isHost: boolean): string {
  if (isHost) return 'host';
  if (rtt == null) return '—';
  return `${Math.round(rtt)} ms`;
}
