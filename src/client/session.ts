import { NET_VERSION, type HostMsg, type Slot } from '../net/protocol';
import { sanitizeClientMsg } from '../net/sanitize';
import type { HostRoom, Link, Transport } from '../net/transport';
import { ChatLimiter, cleanChat } from '../net/chat';
import { Lobby } from '../net/lobby';
import { SnapshotEncoder } from '../net/snapshotCodec';
import { InterestManager } from '../net/interest';
import { PeerGuard, type Verdict } from '../net/rateLimit';
import type { Placement } from '../sim/building';
import { resolveMapChoice, type MapChoice, type MapDef, type MapTemplate } from '../sim/map';
import type { MatchSetup } from '../sim/matchApi';
import type { Snapshot } from '../sim/types';
import type { ToWorker } from './protocol';

const HELLO_TIMEOUT_MS = 10_000;
// Lobby key for the host. Contains a NUL so no remote peer id (PeerJS, BroadcastChannel, loopback) can equal it.
const HOST_PEER = '\u0000host';
/** Difficulty of the bot that takes a leaver's seat in a rematch (same as a mid-match takeover). */
const TAKEOVER_DIFFICULTY = 'medium' as const;

export type HostEvents = {
  lobby(slots: Slot[], map: MapChoice): void;
  chat(from: string, text: string): void;
};

/**
 * Host side of an online match: owns the room and every link, seats joiners via the Lobby, and once
 * the match runs relays sanitized remote inputs/previews into the worker and snapshots back out.
 */
const PREVIEWS_PER_SEC = 20;
const WARN_EVERY_MS = 10_000;

export class HostSession {
  readonly lobby: Lobby;
  private links = new Map<string, Link>(); // seated peers only
  private started = false;
  private worker: { postMessage(m: ToWorker): void } | null = null;
  private encoder = new SnapshotEncoder();
  private tickNo = 0;
  private limiter = new ChatLimiter();
  /** Per-peer budgets: build previews (the ghost only re-asks when it moves) and malformed-message warnings. */
  private previewBudget = new Map<string, { windowStart: number; n: number }>();
  private warned = new Map<string, number>();
  /** Host's map pick ('random' is resolved per match), and the last map played: Random never repeats it. */
  private mapChoice: MapChoice = 'harbor';
  private lastMap: MapTemplate | null = null;
  /** Per-client anti-ESP filter; created once the map is known. */
  private interest: InterestManager | null = null;

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
  /** Remove a joined friend from the lobby. */
  kick(seat: number) {
    const slot = this.lobby.slots()[seat];
    if (this.started || slot?.kind !== 'human' || slot.isHost) return;
    const link = this.links.get(slot.peerId);
    this.links.delete(slot.peerId);
    this.lobby.removePeer(slot.peerId);
    this.broadcastLobby();
    if (link) { this.send(link, { t: 'ended', reason: 'kicked' }); setTimeout(() => link.close(), 200); }
  }
  get map(): MapChoice { return this.mapChoice; }
  get lastPlayedMap(): MapTemplate | null { return this.lastMap; }
  setMap(choice: MapChoice) {
    if (this.started) return;
    this.mapChoice = choice;
    this.broadcastLobby();
  }
  /** The template the next match plays: the choice, or for Random any map but the last one played. */
  nextMap(rng: () => number = Math.random): MapTemplate {
    const map = resolveMapChoice(this.mapChoice, this.lastMap, rng);
    this.lastMap = map;
    return map;
  }

  canStart() {
    const s = this.lobby.slots();
    return !this.started && s.length >= 2 && s.every((x) => x.kind !== 'open');
  }

  private broadcastLobby() {
    const slots = this.lobby.slots();
    for (const [peerId, link] of this.links) {
      const you = this.lobby.seatOf(peerId);
      if (you !== null) this.send(link, { t: 'lobby', slots, you, map: this.mapChoice });
    }
    this.ev.lobby(slots, this.mapChoice);
  }

  private send(link: Link, m: HostMsg) {
    try { link.send(m); } catch (err) { console.warn(`[host] send to ${link.peerId} failed`, err); }
  }

  private reject(link: Link, reason: 'full' | 'started' | 'version' | 'flood') {
    console.info(`[host] rejecting ${link.peerId}: ${reason}`);
    this.send(link, { t: 'ended', reason });
    setTimeout(() => link.close(), 200); // let the reason flush first
  }

  private onJoin(link: Link) {
    let seated = false;
    let kicked = false;
    const guard = new PeerGuard(Date.now());
    const helloTimer = setTimeout(() => { if (!seated) { console.info(`[host] ${link.peerId} sent no hello`); link.close(); } }, HELLO_TIMEOUT_MS);
    link.onClose(() => { clearTimeout(helloTimer); if (seated) this.onLeave(link.peerId); });
    /** True if the message must be dropped; disconnects the peer once it's clearly flooding. */
    const blocked = (v: Verdict): boolean => {
      if (v === 'ok') return false;
      if (v === 'kick' && !kicked) {
        kicked = true;
        clearTimeout(helloTimer);
        console.warn(`[host] disconnecting ${link.peerId}: message flood (${guard.dropped} dropped)`);
        if (seated) this.onLeave(link.peerId); // a local close() doesn't fire our own onClose
        this.reject(link, 'flood');
      }
      return true;
    };
    link.onMessage((raw) => {
      if (kicked) return;
      const now = Date.now();
      if (blocked(guard.admit(raw, now))) return;
      const msg = sanitizeClientMsg(raw);
      if (!msg) {
        if (now - (this.warned.get(link.peerId) ?? -Infinity) > WARN_EVERY_MS) {
          this.warned.set(link.peerId, now);
          console.warn(`[host] dropping malformed messages from ${link.peerId}`);
        }
        blocked(guard.malformed(now));
        return;
      }
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
          if (blocked(guard.admitInput(now))) return;
          if (this.started) this.worker?.postMessage({ type: 'remoteInput', playerId, input: msg.input, cmds: msg.cmds });
          break;
        case 'preview':
          if (this.started && this.previewAllowed(link.peerId))
            this.worker?.postMessage({ type: 'preview', playerId, req: msg.req, key: msg.key });
          break;
        case 'chat':
          this.relayChat(link.peerId, this.nameOf(seat), msg.text);
          break;
      }
    });
  }

  private previewAllowed(peerId: string) {
    const now = Date.now();
    const b = this.previewBudget.get(peerId);
    if (!b || now - b.windowStart >= 1000) { this.previewBudget.set(peerId, { windowStart: now, n: 1 }); return true; }
    return ++b.n <= PREVIEWS_PER_SEC;
  }

  private nameOf(seat: number) {
    const s = this.lobby.slots()[seat];
    return s?.kind === 'human' ? s.name : `Player ${seat + 1}`;
  }

  private onLeave(peerId: string) {
    const seat = this.lobby.seatOf(peerId);
    this.links.delete(peerId);
    if (seat === null) return;
    this.interest?.forget(seat + 1);
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
    return { setup: { ...this.lobby.toMatchSetup(), map: this.nextMap() }, humanId: 1 };
  }

  /**
   * Rematch: a fresh match on a new worker with the same seats and the same lobby code. Friends who left
   * mid-match get a medium bot (fresh nickname); everyone else keeps their seat, bots their nickname and
   * difficulty. onMap then sends every friend a new 'start', which their client treats as a restart.
   */
  restart(worker: { postMessage(m: ToWorker): void }): { setup: MatchSetup; humanId: number } {
    if (!this.started) throw new Error('HostSession.restart: match not started');
    for (const seat of this.leaverSeats()) {
      const slot = this.lobby.slots()[seat];
      if (slot.kind === 'human') this.lobby.removePeer(slot.peerId);
      this.lobby.setSeat(seat, { kind: 'bot', difficulty: TAKEOVER_DIFFICULTY });
    }
    this.resetStream(worker);
    console.info('[host] rematch');
    // Same map choice as before; Random still never repeats the map just played.
    return { setup: { ...this.lobby.toMatchSetup(), map: this.nextMap() }, humanId: 1 };
  }

  /** End the match and send everyone back to the lobby screen (seats editable, new friends may join). */
  backToLobby() {
    if (!this.started) return;
    for (const seat of this.leaverSeats()) {
      const slot = this.lobby.slots()[seat];
      if (slot.kind === 'human') this.lobby.removePeer(slot.peerId);
    }
    this.started = false;
    this.resetStream(null);
    console.info('[host] back to lobby');
    this.broadcastLobby();
  }

  /** Human seats (not the host) whose friend is no longer connected. */
  private leaverSeats(): number[] {
    return this.lobby.slots().flatMap((s, i) => (s.kind === 'human' && !s.isHost && !this.links.has(s.peerId) ? [i] : []));
  }

  private resetStream(worker: { postMessage(m: ToWorker): void } | null) {
    this.worker = worker;
    this.encoder = new SnapshotEncoder();
    this.tickNo = 0;
    this.previewBudget.clear();
  }

  /** Worker sent the map: tell every remote to start. */
  onMap(map: MapDef, islands: number[]) {
    this.interest = new InterestManager(map.islands, map.statics);
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      if (seat !== null) this.send(link, { t: 'start', map, playerId: seat + 1, island: islands[seat] ?? seat });
    }
  }

  /** Every worker snapshot; broadcast every 2nd tick (15 Hz). */
  onSnapshot(snap: Snapshot) {
    this.encoder.push(snap);
    if (this.tickNo++ % 2 !== 0) return;
    this.interest?.update(snap);
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      if (seat === null) continue;
      const s = this.encoder.take(seat + 1);
      this.send(link, { t: 'snap', s: this.interest ? this.interest.apply(seat + 1, s) : s });
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
  flood: 'The host disconnected you for sending too many messages.',
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
