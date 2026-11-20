import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { newInviteCode, normalizeCode } from './code';
import { LinkBase } from './linkBase';
import type { HostRoom, Link, Transport } from './transport';

/**
 * Internet transport over PeerJS (WebRTC data channels, free public PeerJS signaling server).
 * Invite code K7Q2MX ⇄ host peer id `faefight-K7Q2MX`.
 *
 * Liveness: WebRTC can take ~30 s to notice a killed tab, so each side sends a tiny heartbeat
 * frame every second and drops the link after DEAD_MS of silence. Tabs also close their
 * connections on `pagehide` so normal tab closes are noticed immediately.
 */

const ID_PREFIX = 'faefight-';
const HOST_TRIES = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const PING_MS = 1000;
const DEAD_MS = 8000;
/** Heartbeat frame. App messages are objects with a `t` field, so this key can't collide. */
const HB_KEY = '__faefightHb';

function peerOptions(): PeerOptions {
  const iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const env = import.meta.env;
  const turnUrl = env.VITE_TURN_URL as string | undefined;
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl,
      username: env.VITE_TURN_USER as string | undefined,
      credential: env.VITE_TURN_PASS as string | undefined,
    });
  }
  return { config: { iceServers }, debug: 1 };
}

const isHeartbeat = (d: unknown) => typeof d === 'object' && d !== null && HB_KEY in d;

function errType(err: unknown): string {
  return typeof err === 'object' && err !== null && 'type' in err ? String((err as { type: unknown }).type) : '';
}

function onPageHide(cb: () => void): () => void {
  globalThis.addEventListener?.('pagehide', cb);
  return () => globalThis.removeEventListener?.('pagehide', cb);
}

class PeerLink extends LinkBase {
  private lastSeen = Date.now();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    peerId: string,
    private readonly conn: DataConnection,
    private readonly onTeardown: () => void,
  ) {
    super(peerId);
    conn.on('data', (d) => {
      this.lastSeen = Date.now();
      if (!isHeartbeat(d)) this.deliver(d);
    });
    conn.on('close', () => this.ended());
    conn.on('error', (err) => {
      console.warn(`[net] connection to ${peerId} errored`, errType(err), err);
      if (!conn.open) this.ended();
    });
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) {
        console.warn(`[net] connection to ${peerId} timed out`);
        this.ended();
        return;
      }
      this.transmit({ [HB_KEY]: 1 });
    }, PING_MS);
  }

  protected transmit(msg: unknown): void {
    if (!this.conn.open) return;
    try {
      void this.conn.send(msg);
    } catch (err) {
      console.error('[net] send failed', err);
    }
  }

  protected teardown(): void {
    clearInterval(this.timer);
    // flush: the close is queued behind already-sent messages (e.g. a final {t:'ended'}).
    if (this.conn.open) this.conn.close({ flush: true });
    this.onTeardown();
  }
}

class PeerRoom implements HostRoom {
  private links = new Set<PeerLink>();
  private joinCbs: Array<(link: Link) => void> = [];
  private waiting: Link[] = [];
  private unhookPageHide: () => void;
  private closed = false;

  constructor(
    readonly code: string,
    private readonly peer: Peer,
  ) {
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (this.closed) {
          conn.close();
          return;
        }
        const link: PeerLink = new PeerLink(conn.peer, conn, () => this.links.delete(link));
        this.links.add(link);
        if (this.joinCbs.length === 0) this.waiting.push(link);
        for (const cb of this.joinCbs) cb(link);
      });
    });
    // Losing the signaling socket doesn't affect open data channels, but new friends couldn't join.
    peer.on('disconnected', () => {
      if (!this.closed && !peer.destroyed) {
        console.warn('[net] lost signaling server, reconnecting');
        peer.reconnect();
      }
    });
    peer.on('error', (err) => console.warn('[net] host peer error', errType(err), err));
    peer.on('close', () => this.close());
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
    this.unhookPageHide();
    for (const l of [...this.links]) l.close();
    this.peer.destroy();
  }
}

/** Open a Peer with the given id (or a server-assigned one) and wait for the signaling server. */
function openPeer(id: string | undefined): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error('Could not reach the matchmaking server (timed out)'));
    }, CONNECT_TIMEOUT_MS);
    const onErr = (err: unknown) => {
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    };
    peer.once('error', onErr);
    peer.once('open', () => {
      clearTimeout(timer);
      peer.off('error', onErr);
      resolve(peer);
    });
  });
}

export class PeerTransport implements Transport {
  async host(): Promise<HostRoom> {
    let lastErr: unknown;
    for (let i = 0; i < HOST_TRIES; i++) {
      const code = newInviteCode();
      try {
        const peer = await openPeer(ID_PREFIX + code);
        return new PeerRoom(code, peer);
      } catch (err) {
        lastErr = err;
        if (errType(err) !== 'unavailable-id') break;
        console.warn(`[net] invite code ${code} taken, retrying`);
      }
    }
    throw new Error(`Could not host a game: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  async join(rawCode: string): Promise<Link> {
    const code = normalizeCode(rawCode);
    if (!code) throw new Error('No game with that code');
    const peer = await openPeer(undefined);

    return new Promise<Link>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('Timed out connecting to the game'), CONNECT_TIMEOUT_MS);

      peer.on('error', (err) => {
        if (errType(err) === 'peer-unavailable') fail('No game with that code');
        else if (!settled) fail(`Could not connect: ${err.message}`);
        else console.warn('[net] client peer error', errType(err), err);
      });

      const conn = peer.connect(ID_PREFIX + code, { reliable: true });
      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let unhookPageHide = () => {};
        const link = new PeerLink(ID_PREFIX + code, conn, () => {
          unhookPageHide();
          // Give a flushed close a moment to go out before tearing down the RTCPeerConnection.
          setTimeout(() => peer.destroy(), 500);
        });
        unhookPageHide = onPageHide(() => link.close());
        resolve(link);
      });
    });
  }
}
