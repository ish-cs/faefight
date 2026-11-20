import type { HostRoom, Link, Transport } from './transport';

/**
 * Network conditions simulator for testing (dev/e2e: `?net=local&rtt=120&jitter=20&loss=0.02`).
 * Wraps any transport; every message on a wrapped link (both directions) is held for half the RTT
 * plus jitter. Links are reliable and ordered (WebRTC 'reliable' data channels are SCTP), so loss
 * is modelled the way SCTP shows it to the app: a lost message is retransmitted about one RTT
 * later and everything behind it waits (head-of-line blocking). `ordered: false` instead drops
 * lost messages and lets jitter reorder (to exercise the codec's own loss handling).
 */
export type NetConditions = {
  /** Round-trip time added (ms). */
  rttMs: number;
  /** Extra one-way delay, uniform in [0, jitterMs]. */
  jitterMs: number;
  /** Probability a message is lost in flight (0..1). */
  loss: number;
  /** false = unreliable/unordered delivery (loss drops). Default true. */
  ordered?: boolean;
  /** Deterministic randomness for tests. */
  random?: () => number;
  /** Clock + timer (tests inject fakes). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
};

export function conditionsFrom(search: string): NetConditions | null {
  const q = new URLSearchParams(search);
  const rtt = Number(q.get('rtt') ?? 0), jitter = Number(q.get('jitter') ?? 0), loss = Number(q.get('loss') ?? 0);
  if (![rtt, jitter, loss].every(Number.isFinite) || loss >= 1) throw new Error(`netSim: bad conditions rtt=${rtt} jitter=${jitter} loss=${loss}`);
  if (!(rtt > 0 || jitter > 0 || loss > 0)) return null;
  return { rttMs: Math.max(0, rtt), jitterMs: Math.max(0, jitter), loss: Math.max(0, loss) };
}

/** One direction of a simulated pipe: schedules deliveries per the conditions. */
export class SimPipe {
  private lastAt = 0;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly timer: (fn: () => void, ms: number) => void;
  /** Counters (debug / tests). */
  stats = { sent: 0, lost: 0, dropped: 0 };

  constructor(private readonly c: NetConditions, private readonly deliver: (msg: unknown) => void) {
    this.rand = c.random ?? Math.random;
    this.now = c.now ?? (() => performance.now());
    this.timer = c.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  push(msg: unknown): void {
    this.stats.sent++;
    const now = this.now();
    let at = now + this.c.rttMs / 2 + this.rand() * this.c.jitterMs;
    if (this.rand() < this.c.loss) {
      this.stats.lost++;
      if (this.c.ordered === false) { this.stats.dropped++; return; }
      // Retransmitted after ~1 RTT (SCTP fast retransmit / RTO floor), possibly lost again.
      do at += Math.max(this.c.rttMs, 20); while (this.rand() < this.c.loss);
    }
    if (this.c.ordered !== false) at = Math.max(at, this.lastAt); // in-order: wait for everything ahead
    this.lastAt = at;
    this.timer(() => this.deliver(msg), Math.max(0, at - now));
  }
}

class SimLink implements Link {
  private out: SimPipe;
  private cbs: Array<(msg: unknown) => void> = [];
  private pending: unknown[] = [];
  private inbound: SimPipe;

  constructor(private readonly inner: Link, c: NetConditions) {
    this.out = new SimPipe(c, (m) => inner.send(m));
    this.inbound = new SimPipe(c, (m) => {
      if (!this.cbs.length) { this.pending.push(m); return; } // like LinkBase: nothing lost before onMessage
      for (const cb of this.cbs) cb(m);
    });
    inner.onMessage((m) => this.inbound.push(m));
  }
  get peerId() { return this.inner.peerId; }
  send(msg: unknown): void { this.out.push(msg); }
  onMessage(cb: (msg: unknown) => void): void {
    this.cbs.push(cb);
    if (this.cbs.length === 1) for (const m of this.pending.splice(0)) cb(m);
  }
  onClose(cb: () => void): void { this.inner.onClose(cb); }
  close(): void { this.inner.close(); }
}

/**
 * Wrap a transport so the links it makes suffer `c`. Wrapping one side is enough: the delay is applied
 * to both directions of each wrapped link (half the RTT each way).
 */
export function withConditions(t: Transport, c: NetConditions): Transport {
  const wrapRoom = (room: HostRoom): HostRoom => ({
    get code() { return room.code; },
    onJoin: (cb) => room.onJoin((l) => cb(new SimLink(l, c))),
    close: () => room.close(),
  });
  console.info(`[netSim] simulating rtt ${c.rttMs} ms, jitter ${c.jitterMs} ms, loss ${(c.loss * 100).toFixed(1)}%`);
  return {
    host: async () => wrapRoom(await t.host()),
    join: async (code) => new SimLink(await t.join(code), c),
  };
}
