import * as dm from './dmath';
import type { MoveCmd } from './movement';
import type { MatchEvent, PlayerInput, PlayerState } from './types';

/**
 * Emote & quick-chat wheel: the catalog, the default 8-slot wheel, the per-player rate limit and the
 * rules that end an emote. Pure data + functions shared by the sim (authoritative), the host session
 * (rate limit before the worker) and the client (wheel UI, avatar poses, speech bubbles).
 *
 * An emote is cosmetic player state (`PlayerState.emote`, with its sim start time) so every client and a
 * replay show the same animation; a quick-chat line is `PlayerState.quip` (the speech bubble) plus a
 * `wheel` event the host turns into a chat line from that player.
 */

export const QUICK_CHAT = {
  gg: 'GG',
  niceShot: 'Nice shot!',
  lol: 'LOL',
  help: 'Help!',
  watchOut: 'Watch out!',
  thanks: 'Thanks!',
} as const;
export type QuipId = keyof typeof QUICK_CHAT;

/** `sec`: how long the emote plays before it ends on its own. */
export const EMOTES = {
  wave: { label: 'Wave', sec: 2.4 },
  dance: { label: 'Dance', sec: 4 },
  salute: { label: 'Salute', sec: 2 },
  laugh: { label: 'Laugh', sec: 2.2 },
  point: { label: 'Point', sec: 1.8 },
} as const;
export type EmoteId = keyof typeof EMOTES;

export type WheelId = QuipId | EmoteId;

export const QUIP_IDS = Object.keys(QUICK_CHAT) as QuipId[];
export const EMOTE_IDS = Object.keys(EMOTES) as EmoteId[];
export const WHEEL_IDS: readonly WheelId[] = [...QUIP_IDS, ...EMOTE_IDS];

export const isQuipId = (x: unknown): x is QuipId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(QUICK_CHAT, x);
export const isEmoteId = (x: unknown): x is EmoteId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(EMOTES, x);
export const isWheelId = (x: unknown): x is WheelId => isQuipId(x) || isEmoteId(x);

/** Label shown on the wheel (and the chat text of a quick-chat line). */
export const wheelLabel = (id: WheelId): string => (isQuipId(id) ? QUICK_CHAT[id] : EMOTES[id].label);

/**
 * The 8 slots, clockwise from the top. Any WHEEL_IDS entry may sit in any slot (configurable later);
 * this default keeps the four most useful lines and four emotes, alternating so neither kind clusters.
 */
export const DEFAULT_WHEEL: readonly WheelId[] = ['gg', 'wave', 'niceShot', 'dance', 'thanks', 'salute', 'help', 'laugh'];

/** One wheel action (quick chat or emote) per player per this many seconds. */
export const WHEEL_COOLDOWN_SEC = 2;
/** Speech bubble time over a player's head after a quick-chat line. */
export const QUIP_SHOW_SEC = 2;
/** Cursor travel (px) from the wheel centre before a slot is picked (inside = nothing, release cancels). */
export const WHEEL_DEADZONE_PX = 28;

/**
 * Wheel slot under a cursor offset (dx right, dy DOWN, screen pixels from the centre): slot 0 is
 * straight up and slots run clockwise, each owning an equal wedge centred on its direction.
 * -1 inside the dead zone.
 */
export function wheelSlot(dx: number, dy: number, slots = DEFAULT_WHEEL.length, deadzone = WHEEL_DEADZONE_PX): number {
  if (!Number.isInteger(slots) || slots < 1) throw new Error(`wheelSlot: bad slot count ${slots}`);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < deadzone) return -1;
  const wedge = (Math.PI * 2) / slots;
  let a = dm.atan2(dx, -dy); // 0 = up, + clockwise
  if (a < 0) a += Math.PI * 2;
  return Math.floor((a + wedge / 2) / wedge) % slots;
}

/**
 * Sliding per-key rate limit: at most one accepted action per `windowSec` (rejected tries don't reset it).
 * Time is in seconds (sim time in the sim, Date.now()/1000 on the host session).
 */
export class WheelLimiter {
  private last = new Map<string | number, number>();
  constructor(private readonly windowSec = WHEEL_COOLDOWN_SEC) {}

  allow(key: string | number, nowSec: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowSec - prev < this.windowSec) return false;
    this.last.set(key, nowSec);
    return true;
  }

  forget(key: string | number) { this.last.delete(key); }
}

export type EmoteEnd = 'done' | 'dead' | 'moved' | 'fired' | 'damaged';

/**
 * Why a running emote ends this tick (null = keeps playing). Moving (any move axis or a jump, in the
 * input or in a movement command), shooting / throwing / building, taking damage after it started,
 * dying, or simply running out of time.
 */
export function emoteEnd(p: Pick<PlayerState, 'alive' | 'lastDamagedAt' | 'emote'>, input: PlayerInput, cmds: readonly MoveCmd[] | undefined, now: number): EmoteEnd | null {
  const e = p.emote;
  if (!e) return null;
  if (!p.alive) return 'dead';
  if (p.lastDamagedAt >= e.at) return 'damaged';
  if (input.fire || input.throwGrenade || input.placeCharge || input.build) return 'fired';
  const moving = (c: { moveX: number; moveZ: number; jump: boolean }) => c.moveX !== 0 || c.moveZ !== 0 || c.jump;
  if (moving(input) || cmds?.some(moving)) return 'moved';
  if (now - e.at >= EMOTES[e.id].sec) return 'done';
  return null;
}

/** Quick-chat lines in a tick's events, as chat lines from their players (the host relays these). */
export function quipLines(events: readonly MatchEvent[], players: readonly Pick<PlayerState, 'id' | 'name'>[]): { from: string; text: string }[] {
  const out: { from: string; text: string }[] = [];
  for (const e of events) {
    if (e.type !== 'wheel' || !isQuipId(e.data.id)) continue;
    const p = players.find((q) => q.id === e.data.by);
    if (p) out.push({ from: p.name, text: QUICK_CHAT[e.data.id] });
  }
  return out;
}
