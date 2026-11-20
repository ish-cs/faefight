import { newInviteCode, normalizeCode } from './code';
import { LinkBase } from './linkBase';
import type { HostRoom, Link, Transport } from './transport';

/**
 * Same-browser transport over BroadcastChannel (dev / e2e via `?net=local`).
 *
 * One channel per room: `faefight-local-<CODE>`. Every tab in the room sees every frame, so frames
 * carry `from`/`to` and each side ignores what isn't addressed to it.
 *
 *   client → {k:'join', from:id}                        (id = fresh random peer id)
 *   host   → {k:'accept', to:id}                        (host fires onJoin with a link to id)
 *   either → {k:'data', from, to, msg}                  (host's id is 'host')
 *   either → {k:'bye', from, to}                        (to:'*' = host closed the whole room)
 *   either → {k:'ping', from}  every 1 s                (host pings once for everyone)
 *
 * A link ends on a bye, or when nothing has been heard from the other side for 3 s (tab killed,
 * crashed, or frozen). Tabs send their byes on `pagehide`.
 */

const HOST_ID = 'host';
const PING_MS = 1000;
const DEAD_MS = 3000;
const JOIN_TIMEOUT_MS = 3000;

type Frame =
  | { k: 'join'; from: string }
  | { k: 'accept'; to: string }
  | { k: 'data'; from: string; to: string; msg: unknown }
  | { k: 'bye'; from: string; to: string }
  | { k: 'ping'; from: string };

function asFrame(raw: unknown): Frame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.k !== 'string') return null;
  if (f.k === 'accept') return typeof f.to === 'string' ? (f as Frame) : null;
  if (typeof f.from !== 'string') return null;
  return f as Frame;
}

const channelName = (code: string) => `faefight-local-${code}`;

function onPageHide(cb: () => void): () => void {
  globalThis.addEventListener?.('pagehide', cb);
  return () => globalThis.removeEventListener?.('pagehide', cb);
}

class BroadcastLink extends LinkBase {
  lastSeen = Date.now();

  constructor(
    peerId: string,
    private readonly selfId: string,
    private readonly ch: BroadcastChannel,
    private readonly onTeardown: () => void,
  ) {
    super(peerId);
  }

  protected transmit(msg: unknown): void {
    this.post({ k: 'data', from: this.selfId, to: this.peerId, msg });
  }

  protected teardown(): void {
    this.post({ k: 'bye', from: this.selfId, to: this.peerId });
    this.onTeardown();
  }

  /** Frame from the other side of this link. */
  receive(f: Frame): void {
    this.lastSeen = Date.now();
    if (f.k === 'data') this.deliver(f.msg);
    else if (f.k === 'bye') this.ended();
  }

  checkAlive(now: number): void {
    if (now - this.lastSeen > DEAD_MS) {
      console.warn(`[net] local link to ${this.peerId} timed out`);
      this.ended();
    }
  }

  private post(f: Frame): void {
    try {
      this.ch.postMessage(f);
    } catch (err) {
      // Channel already closed (room shut down) or msg not cloneable.
      console.error('[net] BroadcastChannel post failed', err);
    }
  }
}

class BroadcastRoom implements HostRoom {
  private ch: BroadcastChannel;
  private links = new Map<string, BroadcastLink>();
  private joinCbs: Array<(link: Link) => void> = [];
  private waiting: Link[] = [];
  private timer: ReturnType<typeof setInterval>;
  private unhookPageHide: () => void;
  private closed = false;

  constructor(readonly code: string) {
    this.ch = new BroadcastChannel(channelName(code));
    this.ch.onmessage = (e) => this.onFrame(asFrame(e.data));
    this.timer = setInterval(() => this.heartbeat(), PING_MS);
    this.unhookPageHide = onPageHide(() => this.close());
  }

  onJoin(cb: (link: Link) => void): void {
    this.joinCbs.push(cb);
    const queued = this.waiting;
    this.waiting = [];
    for (const l of queued) cb(l);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.unhookPageHide();
    for (const l of [...this.links.values()]) l.close();
    this.ch.postMessage({ k: 'bye', from: HOST_ID, to: '*' } satisfies Frame);
    this.ch.close();
  }

  private onFrame(f: Frame | null): void {
    if (!f || this.closed) return;
    if (f.k === 'join') {
      if (this.links.has(f.from)) return;
      const id = f.from;
      const link = new BroadcastLink(id, HOST_ID, this.ch, () => this.links.delete(id));
      this.links.set(id, link);
      this.ch.postMessage({ k: 'accept', to: id } satisfies Frame);
      if (this.joinCbs.length === 0) this.waiting.push(link);
      for (const cb of this.joinCbs) cb(link);
      return;
    }
    if (f.k === 'accept' || f.from === HOST_ID) return;
    if ((f.k === 'data' || f.k === 'bye') && f.to !== HOST_ID) return;
    this.links.get(f.from)?.receive(f);
  }

  private heartbeat(): void {
    this.ch.postMessage({ k: 'ping', from: HOST_ID } satisfies Frame);
    const now = Date.now();
    for (const l of [...this.links.values()]) l.checkAlive(now);
  }
}

export class BroadcastTransport implements Transport {
  async host(): Promise<HostRoom> {
    // 31^6 codes; collisions between a handful of local tabs are not a practical concern.
    return new BroadcastRoom(newInviteCode());
  }

  join(rawCode: string): Promise<Link> {
    const code = normalizeCode(rawCode);
    if (!code) return Promise.reject(new Error('Room not found'));
    const selfId = `local-${Math.random().toString(36).slice(2, 10)}`;
    const ch = new BroadcastChannel(channelName(code));

    return new Promise<Link>((resolve, reject) => {
      let link: BroadcastLink | null = null;
      let timer: ReturnType<typeof setInterval> | undefined;
      let unhookPageHide = () => {};

      const shutdown = () => {
        clearInterval(timer);
        unhookPageHide();
        ch.close();
      };

      const joinTimer = setTimeout(() => {
        shutdown();
        reject(new Error('Room not found'));
      }, JOIN_TIMEOUT_MS);

      ch.onmessage = (e) => {
        const f = asFrame(e.data);
        if (!f) return;
        if (!link) {
          if (f.k !== 'accept' || f.to !== selfId) return;
          clearTimeout(joinTimer);
          link = new BroadcastLink(HOST_ID, selfId, ch, shutdown);
          const l = link;
          timer = setInterval(() => {
            ch.postMessage({ k: 'ping', from: selfId } satisfies Frame);
            l.checkAlive(Date.now());
          }, PING_MS);
          unhookPageHide = onPageHide(() => l.close());
          resolve(l);
          return;
        }
        if (f.k === 'accept' || f.k === 'join' || f.from !== HOST_ID) return;
        if ((f.k === 'data' || f.k === 'bye') && f.to !== selfId && f.to !== '*') return;
        link.receive(f);
      };

      ch.postMessage({ k: 'join', from: selfId } satisfies Frame);
    });
  }
}
