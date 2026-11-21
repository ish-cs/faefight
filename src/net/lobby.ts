import type { MatchSetup } from '../sim/matchApi';
import { nickname } from '../sim/names';
import { isColor, resolveColors } from '../sim/settings';
import { MAX_PLAYERS, type Slot } from './protocol';

const MIN_SEATS = 2;
const NAME_MAX = 16;

/** `name`, or `name 2`, `name 3`… so no two seats share a name (case-insensitive; `taken` is lowercase). */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${[...name].slice(0, NAME_MAX - suffix.length).join('').trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Host-side lobby seating. Pure state, no networking.
 * Seat 0 is always the host. Seat index = island index once the match starts.
 */
export class Lobby {
  private seats: Slot[];

  constructor(hostName: string, hostPeerId: string) {
    this.seats = [{ kind: 'human', name: hostName, peerId: hostPeerId, isHost: true }, { kind: 'open' }];
  }

  slots(): Slot[] {
    return this.seats.map((s) => ({ ...s }));
  }

  seatOf(peerId: string): number | null {
    const i = this.seats.findIndex((s) => s.kind === 'human' && s.peerId === peerId);
    return i < 0 ? null : i;
  }

  /** Seat a joining human: first open seat, else a new seat while under MAX_PLAYERS. Null if full or already seated. */
  addHuman(name: string, peerId: string): number | null {
    if (this.seatOf(peerId) !== null) return null;
    const slot: Slot = { kind: 'human', name: uniqueName(name, this.takenNames()), peerId, isHost: false };
    const open = this.seats.findIndex((s) => s.kind === 'open');
    if (open >= 0) {
      this.seats[open] = slot;
      return open;
    }
    if (this.seats.length >= MAX_PLAYERS) return null;
    this.seats.push(slot);
    return this.seats.length - 1;
  }

  /** A human left: their seat becomes open. Returns the freed seat, or null (unknown peer or the host). */
  removePeer(peerId: string): number | null {
    const i = this.seatOf(peerId);
    if (i === null || i === 0) return null;
    this.seats[i] = { kind: 'open' };
    return i;
  }

  /** A reconnecting friend's seat now belongs to their new link. False unless seat i is a (non-host) human. */
  rebind(i: number, peerId: string): boolean {
    const s = this.seats[i];
    if (!s || s.kind !== 'human' || s.isHost || this.seatOf(peerId) !== null) return false;
    this.seats[i] = { ...s, peerId };
    return true;
  }

  /**
   * Host edits a seat. Seat 0 is locked. A human seat may only be set to 'open' (kick).
   * Open/bot seats may become open or bot. Humans arrive only via addHuman.
   */
  setSeat(i: number, slot: Slot): boolean {
    if (!Number.isInteger(i) || i <= 0 || i >= this.seats.length) return false;
    if (slot.kind === 'human') return false;
    if (this.seats[i].kind === 'human' && slot.kind !== 'open') return false;
    if (slot.kind === 'open') { this.seats[i] = { kind: 'open' }; return true; }
    const prev = this.seats[i];
    // Keep a bot's nickname when only its difficulty changes; otherwise give it a fresh, unique one.
    const name = prev.kind === 'bot' && prev.name ? prev.name : nickname(Math.random, this.takenNames());
    this.seats[i] = { kind: 'bot', difficulty: slot.difficulty, name };
    return true;
  }

  private takenNames(): Set<string> {
    return new Set(this.seats.flatMap((s) => (s.kind === 'human' || (s.kind === 'bot' && s.name) ? [(s.name as string).toLowerCase()] : [])));
  }

  /** Append an open seat (up to MAX_PLAYERS). */
  addSeat(): boolean {
    if (this.seats.length >= MAX_PLAYERS) return false;
    this.seats.push({ kind: 'open' });
    return true;
  }

  /** Remove an open or bot seat (never the host or a human; keeps at least 2 seats). Later seats shift down. */
  removeSeat(i: number): boolean {
    if (!Number.isInteger(i) || i <= 0 || i >= this.seats.length) return false;
    if (this.seats.length <= MIN_SEATS) return false;
    if (this.seats[i].kind === 'human') return false;
    this.seats.splice(i, 1);
    return true;
  }

  /** A guest's Ready toggle. False for an unknown peer or the host (always ready). */
  setReady(peerId: string, ready: boolean): boolean {
    const i = this.seatOf(peerId);
    const s = i === null ? null : this.seats[i];
    if (!s || s.kind !== 'human' || s.isHost) return false;
    if (ready) s.ready = true; else delete s.ready;
    return true;
  }

  /** Everyone unready again (back to the lobby after a match). */
  resetReady() {
    for (const s of this.seats) if (s.kind === 'human') delete s.ready;
  }

  /** Guests (not the host) who haven't pressed Ready. Bots are always ready. */
  notReady(): number {
    return this.seats.filter((s) => s.kind === 'human' && !s.isHost && !s.ready).length;
  }

  /** A human seat picks a palette colour. False if out of range, not a human seat, or another human picked it. */
  setColor(i: number, color: number): boolean {
    const s = this.seats[i];
    if (!s || s.kind !== 'human' || !isColor(color)) return false;
    if (this.seats.some((o, j) => j !== i && o.kind === 'human' && o.color === color)) return false;
    s.color = color;
    return true;
  }

  /** Host watches instead of playing (still hosts and runs the sim): its seat gets no player/island. */
  setHostSpectator(on: boolean) {
    const h = this.seats[0];
    if (h.kind !== 'human') throw new Error('Lobby: seat 0 is not the host');
    if (on) h.spectator = true; else delete h.spectator;
  }

  hostSpectating(): boolean {
    const h = this.seats[0];
    return h.kind === 'human' && !!h.spectator;
  }

  /**
   * Player id per seat once the match starts (null = the spectating host, who has no player).
   * Seats that play are numbered 1, 2, … in seat order, so a spectating host shifts everyone down one.
   */
  playerIds(): (number | null)[] {
    let next = 1;
    return this.seats.map((s) => (s.kind === 'human' && s.spectator ? null : next++));
  }

  /**
   * Host migration: the seating of a match already running, as the old host last had it. The host's seat
   * need not be 0 here; the result is only used to route a running match (never edited as a lobby).
   */
  static fromSlots(slots: Slot[]): Lobby {
    if (slots.filter((s) => s.kind === 'human' && s.isHost).length !== 1) throw new Error('Lobby.fromSlots: need exactly one host seat');
    const l = new Lobby('', '');
    l.seats = slots.map((s) => ({ ...s }));
    return l;
  }

  /** Seats that will get a player (every seat except a spectating host). */
  playerCount(): number {
    return this.seats.length - (this.hostSpectating() ? 1 : 0);
  }

  /** Playing seat k → players[k] (a spectating host is skipped). Throws if any seat is still open or fewer than 2 would play. */
  toMatchSetup(): MatchSetup {
    if (this.playerCount() < MIN_SEATS) throw new Error(`Need at least ${MIN_SEATS} players to start`);
    const open = this.seats.findIndex((s) => s.kind === 'open');
    if (open >= 0) throw new Error(`Seat ${open + 1} is still open; fill it with a bot or wait for a player`);
    return {
      players: this.seats.filter((s) => !(s.kind === 'human' && s.spectator)).map((s) => {
        if (s.kind === 'human') return s.color === undefined ? { name: s.name, isBot: false } : { name: s.name, isBot: false, color: s.color };
        if (s.kind === 'bot') return { name: s.name ?? '', isBot: true, difficulty: s.difficulty };
        throw new Error('unreachable: open seat');
      }),
    };
  }
}

/**
 * The colour each seat plays in (palette index; null for the spectating host): picks are kept, everyone
 * else gets the lowest free colour in seat order. Same rule the sim applies (resolveColors), so the lobby
 * shows exactly what the match uses.
 */
export function seatColors(slots: Slot[]): (number | null)[] {
  const playing = slots.map((s, i) => [s, i] as const).filter(([s]) => !(s.kind === 'human' && s.spectator));
  const colors = resolveColors(playing.map(([s]) => (s.kind === 'human' ? s.color : undefined)));
  const out: (number | null)[] = slots.map(() => null);
  playing.forEach(([, i], k) => { out[i] = colors[k]; });
  return out;
}
