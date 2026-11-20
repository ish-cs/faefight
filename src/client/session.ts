import { NET_VERSION, type HostMsg, type Slot } from '../net/protocol';
import { sanitizeClientMsg } from '../net/sanitize';
import type { HostRoom, Link, Transport } from '../net/transport';
import { ChatLimiter, cleanChat } from '../net/chat';
import { Lobby } from '../net/lobby';
import { SnapshotEncoder } from '../net/snapshotCodec';
import type { Placement } from '../sim/building';
import type { IslandLayout } from '../sim/map';
import type { MatchSetup } from '../sim/matchApi';
import type { Snapshot } from '../sim/types';
import type { ToWorker } from './protocol';

const HELLO_TIMEOUT_MS = 10_000;
const HOST_PEER = 'host';

export type HostEvents = {
  lobby(slots: Slot[]): void;
  chat(from: string, text: string): void;
};

/**
 * Host side of an online match: owns the room and every link, seats joiners via the Lobby, and once
 * the match runs relays sanitized remote inputs/previews into the worker and snapshots back out.
 */
export class HostSession {
  readonly lobby: Lobby;
  private links = new Map<string, Link>(); // seated peers only
  private started = false;
  private worker: { postMessage(m: ToWorker): void } | null = null;
  private encoder = new SnapshotEncoder();
  private tickNo = 0;
  private limiter = new ChatLimiter();

  private constructor(private room: HostRoom, readonly hostName: string, private ev: HostEvents) {
    this.lobby = new Lobby(hostName, HOST_PEER);
    room.onJoin((link) => this.onJoin(link));
    addEventListener('pagehide', () => this.close());
  }

  static async create(transport: Transport, hostName: string, ev: HostEvents): Promise<HostSession> {
    return new HostSession(await transport.host(), hostName, ev);
  }

  get code() { return this.room.code; }

  // ---- lobby (host UI) ----
  setSeat(i: number, slot: Slot) { if (this.lobby.setSeat(i, slot)) this.broadcastLobby(); }
  addSeat() { if (this.lobby.addSeat()) this.broadcastLobby(); }
  removeSeat(i: number) { if (this.lobby.removeSeat(i)) this.broadcastLobby(); }
  canStart() {
    const s = this.lobby.slots();
    return !this.started && s.length >= 2 && s.every((x) => x.kind !== 'open');
  }

  private broadcastLobby() {
    const slots = this.lobby.slots();
    for (const [peerId, link] of this.links) {
      const you = this.lobby.seatOf(peerId);
      if (you !== null) this.send(link, { t: 'lobby', slots, you });
    }
    this.ev.lobby(slots);
  }

  private send(link: Link, m: HostMsg) {
    try { link.send(m); } catch (err) { console.warn(`[host] send to ${link.peerId} failed`, err); }
  }

  private reject(link: Link, reason: 'full' | 'started' | 'version') {
    console.info(`[host] rejecting ${link.peerId}: ${reason}`);
    this.send(link, { t: 'ended', reason });
    setTimeout(() => link.close(), 200); // let the reason flush first
  }

  private onJoin(link: Link) {
    let seated = false;
    const helloTimer = setTimeout(() => { if (!seated) { console.info(`[host] ${link.peerId} sent no hello`); link.close(); } }, HELLO_TIMEOUT_MS);
    link.onClose(() => { clearTimeout(helloTimer); if (seated) this.onLeave(link.peerId); });
    link.onMessage((raw) => {
      const msg = sanitizeClientMsg(raw);
      if (!msg) { console.warn(`[host] dropped malformed message from ${link.peerId}`); return; }
      if (!seated) {
        if (msg.t !== 'hello') return;
        clearTimeout(helloTimer);
        if (msg.version !== NET_VERSION) return this.reject(link, 'version');
        if (this.started) return this.reject(link, 'started');
        if (this.links.has(link.peerId)) return this.reject(link, 'full');
        const seat = this.lobby.addHuman(msg.name, link.peerId);
        if (seat === null) return this.reject(link, 'full');
        seated = true;
        this.links.set(link.peerId, link);
        this.broadcastLobby();
        return;
      }
      const seat = this.lobby.seatOf(link.peerId);
      if (seat === null) return;
      const playerId = seat + 1;
      switch (msg.t) {
        case 'input':
          if (this.started) this.worker?.postMessage({ type: 'remoteInput', playerId, input: msg.input });
          break;
        case 'preview':
          if (this.started) this.worker?.postMessage({ type: 'preview', playerId, req: msg.req, key: msg.key });
          break;
        case 'chat':
          this.relayChat(link.peerId, this.nameOf(seat), msg.text);
          break;
      }
    });
  }

  private nameOf(seat: number) {
    const s = this.lobby.slots()[seat];
    return s?.kind === 'human' ? s.name : `Player ${seat + 1}`;
  }

  private onLeave(peerId: string) {
    const seat = this.lobby.seatOf(peerId);
    this.links.delete(peerId);
    if (seat === null) return;
    if (!this.started) { this.lobby.removePeer(peerId); this.broadcastLobby(); return; }
    const name = this.nameOf(seat);
    console.info(`[host] ${name} (seat ${seat}) left mid-match; bot takes over`);
    this.worker?.postMessage({ type: 'botify', playerId: seat + 1 });
    this.system(`${name} left — a bot took over`);
  }

  // ---- chat ----
  private relayChat(sender: string, from: string, raw: unknown) {
    const text = cleanChat(raw);
    if (!text || !this.limiter.allow(sender, Date.now())) return;
    this.broadcastChat(from, text);
  }
  private broadcastChat(from: string, text: string) {
    for (const link of this.links.values()) this.send(link, { t: 'chat', from, text });
    this.ev.chat(from, text);
  }
  /** System line (from = ''). */
  system(text: string) { this.broadcastChat('', text); }
  /** Chat typed by the host player. */
  localChat(text: string) { this.relayChat(HOST_PEER, this.hostName, text); }

  // ---- match ----
  /** Lock the lobby and produce the setup for the worker. Host is always seat 0 → player id 1. */
  start(worker: { postMessage(m: ToWorker): void }): { setup: MatchSetup; humanId: number } {
    if (!this.canStart()) throw new Error('HostSession.start: lobby not ready');
    this.started = true;
    this.worker = worker;
    return { setup: this.lobby.toMatchSetup(), humanId: 1 };
  }

  /** Worker sent the map: tell every remote to start. */
  onMap(map: IslandLayout[], islands: number[]) {
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      if (seat !== null) this.send(link, { t: 'start', map, playerId: seat + 1, island: islands[seat] ?? seat });
    }
  }

  /** Every worker snapshot; broadcast every 2nd tick (15 Hz). */
  onSnapshot(snap: Snapshot) {
    this.encoder.push(snap);
    if (this.tickNo++ % 2 !== 0) return;
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      if (seat !== null) this.send(link, { t: 'snap', s: this.encoder.take(seat + 1) });
    }
  }

  /** Worker preview reply for a remote player. */
  onPreview(playerId: number, result: Placement, key: number) {
    for (const [peerId, link] of this.links) {
      if (this.lobby.seatOf(peerId) === playerId - 1) this.send(link, { t: 'preview', result, key });
    }
  }

  close() {
    for (const link of this.links.values()) { this.send(link, { t: 'ended', reason: 'host-left' }); link.close(); }
    this.links.clear();
    this.room.close();
  }
}

export const JOIN_ERRORS: Record<string, string> = {
  'not-found': 'No game with that code. Check the code and that the host is still in the lobby.',
  'bad-code': 'Invite codes are 6 letters/digits, e.g. K7Q2MX.',
  full: 'That game is full.',
  started: 'That game has already started.',
  version: 'Your game version does not match the host. Reload the page and try again.',
  kicked: 'The host removed you from the game.',
  'host-left': 'The host left.',
  timeout: 'Timed out connecting to the host.',
  closed: 'The connection to the host closed.',
};

export class JoinError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(JOIN_ERRORS[reason] ?? detail ?? reason);
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, reason: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new JoinError(reason)), ms))]);

/**
 * Connect to a host, say hello and wait for the first lobby message (or a rejection). The caller must
 * attach its own onMessage handler synchronously after this resolves.
 */
export async function joinRoom(transport: Transport, code: string, name: string): Promise<{ link: Link; lobby: Extract<HostMsg, { t: 'lobby' }> }> {
  let link: Link;
  try {
    link = await withTimeout(transport.join(code), 15_000, 'timeout');
  } catch (err) {
    if (err instanceof JoinError) throw err;
    console.warn('[join] transport.join failed', err);
    const detail = String((err as Error)?.message ?? err);
    throw new JoinError(/not found|no game/i.test(detail) ? 'not-found' : 'transport', detail);
  }
  const first = await withTimeout(new Promise<HostMsg>((resolve, reject) => {
    link.onClose(() => reject(new JoinError('closed')));
    link.onMessage((m) => resolve(m as HostMsg));
    link.send({ t: 'hello', name, version: NET_VERSION });
  }), 10_000, 'timeout').catch((err) => { link.close(); throw err; });
  if (first.t === 'ended') { link.close(); throw new JoinError(first.reason); }
  if (first.t !== 'lobby') { link.close(); throw new JoinError('closed', `unexpected first message ${first.t}`); }
  return { link, lobby: first };
}
