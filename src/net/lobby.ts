import type { MatchSetup } from '../sim/matchApi';
import { MAX_PLAYERS, type Slot } from './protocol';

const MIN_SEATS = 2;

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
    const slot: Slot = { kind: 'human', name, peerId, isHost: false };
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

  /**
   * Host edits a seat. Seat 0 is locked. A human seat may only be set to 'open' (kick).
   * Open/bot seats may become open or bot. Humans arrive only via addHuman.
   */
  setSeat(i: number, slot: Slot): boolean {
    if (!Number.isInteger(i) || i <= 0 || i >= this.seats.length) return false;
    if (slot.kind === 'human') return false;
    if (this.seats[i].kind === 'human' && slot.kind !== 'open') return false;
    this.seats[i] = slot.kind === 'open' ? { kind: 'open' } : { kind: 'bot', difficulty: slot.difficulty };
    return true;
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

  /** Seat i → players[i]. Throws if any seat is still open or there are fewer than 2 seats. */
  toMatchSetup(): MatchSetup {
    if (this.seats.length < MIN_SEATS) throw new Error(`Need at least ${MIN_SEATS} seats to start`);
    const open = this.seats.findIndex((s) => s.kind === 'open');
    if (open >= 0) throw new Error(`Seat ${open + 1} is still open; fill it with a bot or wait for a player`);
    return {
      players: this.seats.map((s) => {
        if (s.kind === 'human') return { name: s.name, isBot: false };
        if (s.kind === 'bot') return { name: `Bot (${s.difficulty})`, isBot: true, difficulty: s.difficulty };
        throw new Error('unreachable: open seat');
      }),
    };
  }
}
