import { NET_VERSION, type HostMsg, type Slot } from '../net/protocol';
import { sanitizeClientMsg } from '../net/sanitize';
import type { HostRoom, Link, Transport } from '../net/transport';
import { ChatLimiter, cleanChat } from '../net/chat';
import { Lobby } from '../net/lobby';
import { SnapshotEncoder } from '../net/snapshotCodec';
import { InterestManager } from '../net/interest';
import { WireEncoder, wireHeader } from '../net/wire';
import { SnapRate } from '../net/snapRate';
import { PeerGuard, type Verdict } from '../net/rateLimit';
import type { Placement } from '../sim/building';
import { resolveMapChoice, type MapChoice, type MapDef, type MapTemplate } from '../sim/map';
import type { MatchSetup } from '../sim/matchApi';
import type { Snapshot } from '../sim/types';
import type { ToWorker } from './protocol';
import { MONEY_MAX, MONEY_NOT_IN_MATCH, MONEY_USAGE, moneyGiven } from './commands';
import { PING_EVERY_MS, PingTracker, TickMonitor, type HostTick } from './qol/netQuality';
import { newRejoinToken, REJOIN_GRACE_MS } from './qol/rejoin';

const HELLO_TIMEOUT_MS = 10_000;
// Lobby key for the host. Contains a NUL so no remote peer id (PeerJS, BroadcastChannel, loopback) can equal it.
const HOST_PEER = '\u0000host';
/** Difficulty of the bot that takes a leaver's seat in a rematch (same as a mid-match takeover). */
const TAKEOVER_DIFFICULTY = 'medium' as const;

/** Result of the host's /spectate: a chat line for the host, and whether its player was just handed to a bot. */
export type SpectateResult = { text: string; handoff: boolean };

export type HostEvents = {
  lobby(slots: Slot[], map: MapChoice): void;
  chat(from: string, text: string): void;
  /** Connection quality (every ~2 s during a match): RTT by seat (host = 0) and the host's tick health. */
  net?(rtt: (number | null)[], host: HostTick): void;
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
  /** Round trips per peer, and whether the worker keeps 30 Hz. */
  private pings = new PingTracker();
  private ticks = new TickMonitor();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingRound = 0;
  /** Reconnect grace: a rejoin token per friend seat, and the seats held for a dropped friend (bot playing). */
  private tokens = new Map<number, string>();
  private reserved = new Map<number, ReturnType<typeof setTimeout>>();
  /** Last map (and island per seat) sent with 'start', for a friend who reconnects mid-match. */
  private startInfo: { map: MapDef; islands: number[] } | null = null;
  /** Per remote player: binary delta encoder (baseline = their last ack) and adaptive send rate. */
  private streams = new Map<number, { wire: WireEncoder; rate: SnapRate }>();
  /** Seat → player id for the running match (frozen at start: /spectate mid-match only affects the next one). */
  private seatIds: (number | null)[] = [];
  /** The host's own player in the running match; null while it spectates (from the start or after a handoff). */
  private hostPlayerId: number | null = null;

  private constructor(private room: HostRoom, readonly hostName: string, private ev: HostEvents) {
    this.lobby = new Lobby(hostName, HOST_PEER);
    room.onJoin((link) => this.onJoin(link));
    addEventListener('pagehide', () => this.close());
  }

  static async create(transport: Transport, hostName: string, ev: HostEvents): Promise<HostSession> {
    return new HostSession(await transport.host(), hostName, ev);
  }

  get code() { return this.room.code; }
  /** The host's player id in the running match (null: spectating, or no match). */
  get hostPlayer() { return this.hostPlayerId; }

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
    return !this.started && this.lobby.playerCount() >= 2 && this.lobby.slots().every((x) => x.kind !== 'open');
  }

  /**
   * Host's /spectate. Lobby: toggle the host's seat between player and spectator. Mid-match while playing:
   * hand the host's player to a medium bot (the caller switches to the free-fly camera); the host stays a
   * spectator for the rematch. Mid-match while spectating: the seat can't be taken back now, so it
   * toggles whether the host plays the next match.
   */
  toggleSpectate(): SpectateResult {
    if (!this.started) {
      const on = !this.lobby.hostSpectating();
      this.lobby.setHostSpectator(on);
      console.info(`[host] host ${on ? 'spectates' : 'plays'}`);
      this.broadcastLobby();
      return { text: on ? 'You are spectating: you host the match without playing. /spectate again to play.' : 'You are back in as a player.', handoff: false };
    }
    if (this.hostPlayerId !== null) {
      const id = this.hostPlayerId;
      this.hostPlayerId = null;
      this.lobby.setHostSpectator(true);
      if (!this.worker) throw new Error('HostSession.toggleSpectate: match started without a worker');
      this.worker.postMessage({ type: 'botify', playerId: id });
      console.info(`[host] host player ${id} handed to a bot; host spectates`);
      this.system(`${this.hostName} is spectating — a bot took over`);
      return { text: 'You are spectating. A bot plays your seat. /spectate again to play next match.', handoff: true };
    }
    const next = !this.lobby.hostSpectating();
    this.lobby.setHostSpectator(next);
    return { text: next ? 'You will keep spectating next match.' : 'You can rejoin as a player next match.', handoff: false };
  }

  /**
   * Host's /money: credit the host's own player in the authoritative sim. `amount` must already be
   * validated (parseCommand); re-checked here so nothing else can push junk into the worker.
   * Returns the chat line for the host. Never reachable from a guest: remote chat is only relayed.
   */
  giveMoney(amount: number): string {
    if (!Number.isInteger(amount) || amount < 1 || amount > MONEY_MAX) return MONEY_USAGE;
    if (!this.started) return MONEY_NOT_IN_MATCH;
    if (this.hostPlayerId === null) return 'You are spectating: no player to give cash to';
    if (!this.worker) throw new Error('HostSession.giveMoney: match started without a worker');
    this.worker.postMessage({ type: 'debug', cmd: 'give', inv: { cash: amount }, id: this.hostPlayerId });
    console.info(`[host] /money +$${amount} to host player ${this.hostPlayerId}`);
    return moneyGiven(amount);
  }

  /** Player id of a seat in the running match (null: the spectating host, or not started). */
  private idOf(seat: number): number | null {
    return this.seatIds[seat] ?? null;
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
        if (this.started && msg.rejoin && this.reclaim(link, msg.rejoin)) { seated = true; return; }
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
      const playerId = this.idOf(seat);
      switch (msg.t) {
        case 'input':
          if (blocked(guard.admitInput(now))) return;
          if (msg.ack !== undefined && playerId !== null) this.streams.get(playerId)?.wire.ack(msg.ack);
          if (this.started && playerId !== null) this.worker?.postMessage({ type: 'remoteInput', playerId, input: msg.input, cmds: msg.cmds });
          break;
        case 'preview':
          if (this.started && playerId !== null && this.previewAllowed(link.peerId))
            this.worker?.postMessage({ type: 'preview', playerId, req: msg.req, key: msg.key });
          break;
        case 'chat':
          this.relayChat(link.peerId, this.nameOf(seat), msg.text);
          break;
        case 'pong':
          this.pings.pong(link.peerId, msg.n, performance.now());
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
    { const gone = this.idOf(seat); if (gone !== null) { this.interest?.forget(gone); this.streams.delete(gone); } }
    if (!this.started) { this.lobby.removePeer(peerId); this.broadcastLobby(); return; }
    const playerId = this.idOf(seat);
    if (playerId === null) throw new Error(`HostSession.onLeave: seat ${seat} has no player`);
    this.interest?.forget(playerId);
    const name = this.nameOf(seat);
    this.pings.forget(peerId);
    console.info(`[host] ${name} (seat ${seat}) dropped mid-match; bot holds the seat for ${REJOIN_GRACE_MS / 1000} s`);
    this.worker?.postMessage({ type: 'botify', playerId });
    this.system(`${name} left — a bot took over (they can rejoin within ${REJOIN_GRACE_MS / 1000} s)`);
    clearTimeout(this.reserved.get(seat));
    this.reserved.set(seat, setTimeout(() => {
      this.reserved.delete(seat);
      this.tokens.delete(seat);
      console.info(`[host] seat ${seat} grace over; the bot keeps it`);
    }, REJOIN_GRACE_MS));
  }

  /**
   * A dropped friend came back with their seat's token: give them the seat (and their player) back from the
   * bot and restart their stream. True if the token matched a seat in this match.
   */
  private reclaim(link: Link, token: string): boolean {
    const seat = [...this.tokens].find(([, t]) => t === token)?.[0];
    if (seat === undefined || !this.startInfo) return false;
    const slot = this.lobby.slots()[seat];
    if (slot?.kind !== 'human') return false;
    const stillLinked = this.links.get(slot.peerId);
    // Still linked (the host hasn't noticed the drop yet): the old link is superseded.
    if (!this.reserved.has(seat) && !stillLinked) return false;
    if (stillLinked) { this.links.delete(slot.peerId); stillLinked.close(); }
    if (!this.lobby.rebind(seat, link.peerId)) return false;
    clearTimeout(this.reserved.get(seat));
    this.reserved.delete(seat);
    this.links.set(link.peerId, link);
    const playerId = this.idOf(seat);
    if (playerId === null) return false;
    this.interest?.forget(playerId);
    this.encoder.resync(playerId);
    this.streams.delete(playerId); // fresh binary stream: the new client has no delta baseline
    this.worker?.postMessage({ type: 'humanize', playerId });
    this.send(link, { t: 'lobby', slots: this.lobby.slots(), you: seat, map: this.mapChoice });
    this.send(link, { t: 'start', map: this.startInfo.map, playerId, island: this.startInfo.islands[playerId - 1] ?? playerId - 1 });
    this.send(link, { t: 'rejoin', token });
    console.info(`[host] ${slot.name} reclaimed seat ${seat}`);
    this.system(`${slot.name} reconnected`);
    return true;
  }

  /** Ping every friend once a second; every second round, tell everyone the RTTs and the host's tick health. */
  private pingTick() {
    const now = performance.now();
    for (const [peerId, link] of this.links) this.send(link, { t: 'ping', n: this.pings.ping(peerId, now) });
    if (this.pingRound++ % 2 !== 0 || !this.started) return;
    // Indexed by player id - 1 (the host's own player, if it has one, is 0 ms).
    const rtt: (number | null)[] = this.seatIds.map(() => null);
    this.lobby.slots().forEach((s, seat) => {
      const id = this.idOf(seat);
      if (id === null || s.kind !== 'human') return;
      const v = s.isHost ? 0 : this.links.has(s.peerId) ? this.pings.get(s.peerId, now) : null;
      rtt[id - 1] = v === null ? null : Math.round(v);
    });
    const host = this.ticks.state(now);
    for (const link of this.links.values()) this.send(link, { t: 'net', rtt, host });
    this.ev.net?.(rtt, host);
  }

  /** New rejoin tokens for every connected friend's seat (match start / rematch). */
  private issueTokens() {
    this.tokens.clear();
    for (const t of this.reserved.values()) clearTimeout(t);
    this.reserved.clear();
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      if (seat === null) continue;
      const token = newRejoinToken();
      this.tokens.set(seat, token);
      this.send(link, { t: 'rejoin', token });
    }
    if (!this.pingTimer) this.pingTimer = setInterval(() => this.pingTick(), PING_EVERY_MS);
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
  /**
   * Lock the lobby and produce the setup for the worker. A playing host is seat 0 → player id 1;
   * a spectating host has no player (humanId 0).
   */
  start(worker: { postMessage(m: ToWorker): void }): { setup: MatchSetup; humanId: number } {
    if (!this.canStart()) throw new Error('HostSession.start: lobby not ready');
    this.started = true;
    this.worker = worker;
    this.ticks = new TickMonitor();
    return this.freezeSeats();
  }

  private freezeSeats(): { setup: MatchSetup; humanId: number } {
    const setup = this.lobby.toMatchSetup();
    this.seatIds = this.lobby.playerIds();
    this.hostPlayerId = this.seatIds[0];
    // Same map choice every match (rematches too); Random never repeats the map just played.
    return { setup: { ...setup, map: this.nextMap() }, humanId: this.hostPlayerId ?? 0 };
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
    if (this.lobby.playerCount() < 2) {
      console.info('[host] rematch: too few seats to keep spectating; host plays');
      this.lobby.setHostSpectator(false);
    }
    this.resetStream(worker);
    this.ticks = new TickMonitor();
    console.info('[host] rematch');
    return this.freezeSeats();
  }

  /** End the match and send everyone back to the lobby screen (seats editable, new friends may join). */
  backToLobby() {
    if (!this.started) return;
    for (const seat of this.leaverSeats()) {
      const slot = this.lobby.slots()[seat];
      if (slot.kind === 'human') this.lobby.removePeer(slot.peerId);
    }
    this.started = false;
    this.seatIds = [];
    this.hostPlayerId = null;
    this.resetStream(null);
    this.tokens.clear();
    for (const t of this.reserved.values()) clearTimeout(t);
    this.reserved.clear();
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
    this.streams.clear();
    this.tickNo = 0;
    this.previewBudget.clear();
  }

  /** Worker sent the map (islands[id - 1] = island of player id): tell every remote to start. */
  onMap(map: MapDef, islands: number[]) {
    this.interest = new InterestManager(map.islands, map.statics);
    this.startInfo = { map, islands };
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      const id = seat === null ? null : this.idOf(seat);
      if (id !== null) this.send(link, { t: 'start', map, playerId: id, island: islands[id - 1] ?? id - 1 });
    }
    this.issueTokens();
  }

  /**
   * Every worker snapshot. Each friend gets it at 30 Hz while their stream fits the bandwidth budget,
   * else every 2nd tick (snapRate.ts), interest-filtered, binary and delta-compressed against the
   * newest snapshot they acknowledged (wire.ts).
   */
  onSnapshot(snap: Snapshot) {
    this.ticks.onTick(performance.now());
    this.encoder.push(snap);
    const tick = this.tickNo++;
    let updated = false;
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      const id = seat === null ? null : this.idOf(seat);
      if (id === null) continue;
      let st = this.streams.get(id);
      if (!st) { st = { wire: new WireEncoder(), rate: new SnapRate() }; this.streams.set(id, st); }
      if (!st.rate.due(tick)) continue;
      if (!updated) { this.interest?.update(snap); updated = true; }
      const s = this.encoder.take(id, true);
      const b = st.wire.encode(snap.tick, this.interest ? this.interest.apply(id, s) : s);
      st.rate.sent(b.byteLength, wireHeader(b).baseSeq === 0);
      this.send(link, { t: 'snap', b });
    }
  }

  /** Debug/bench: per-friend stream stats. */
  streamStats() {
    return [...this.streams].map(([id, st]) => ({ id, fast: st.rate.fast, avgBytes: Math.round(st.rate.avgBytes), acked: st.wire.ackedSeq, ...st.wire.stats }));
  }

  /** Worker preview reply for a remote player. */
  onPreview(playerId: number, result: Placement, key: number) {
    for (const [peerId, link] of this.links) {
      const seat = this.lobby.seatOf(peerId);
      if (seat !== null && this.idOf(seat) === playerId) this.send(link, { t: 'preview', result, key });
    }
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
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
export async function joinRoom(transport: Transport, code: string, name: string, rejoin?: string): Promise<{ link: Link; lobby: Extract<HostMsg, { t: 'lobby' }> }> {
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
    link.send(rejoin ? { t: 'hello', name, version: NET_VERSION, rejoin } : { t: 'hello', name, version: NET_VERSION });
  }), 10_000, 'timeout').catch((err) => { link.close(); throw err; });
  if (first.t === 'ended') { link.close(); throw new JoinError(first.reason); }
  if (first.t !== 'lobby') { link.close(); throw new JoinError('closed', `unexpected first message ${first.t}`); }
  return { link, lobby: first };
}
