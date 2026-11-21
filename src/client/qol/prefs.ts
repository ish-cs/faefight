import type { Slot } from '../../net/protocol';
import type { Difficulty, ShopItem } from '../../sim/types';

/**
 * Remembered menu choices (localStorage `faefight.prefs.v1`): last vs-bot difficulty and bot count, last
 * map, the host's lobby seat layout (bots and open seats) and the last shop purchase. Camera mode already
 * lives in Settings. Anything malformed falls back to defaults.
 */
export const PREFS_KEY = 'faefight.prefs.v1';
export const MAX_SOLO_BOTS = 7;

/** A remembered lobby seat (humans can't be remembered: they come back by joining). */
export type SeatPref = { kind: 'open' } | { kind: 'bot'; difficulty: Difficulty };
export type Prefs = { difficulty: Difficulty; bots: number; map: string | null; seats: SeatPref[] | null; lastBuy: ShopItem | null };

const DIFFS: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
const defaults = (): Prefs => ({ difficulty: 'medium', bots: 1, map: null, seats: null, lastBuy: null });

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export function sanitizePrefs(raw: unknown): Prefs {
  const d = defaults();
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bots = typeof r.bots === 'number' && Number.isInteger(r.bots) ? Math.min(MAX_SOLO_BOTS, Math.max(1, r.bots)) : d.bots;
  const seats = Array.isArray(r.seats) && r.seats.length >= 1 && r.seats.length <= 7
    ? r.seats.map((s): SeatPref | null => {
      const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      if (o.kind === 'open') return { kind: 'open' };
      if (o.kind === 'bot' && DIFFS.includes(o.difficulty as Difficulty)) return { kind: 'bot', difficulty: o.difficulty as Difficulty };
      return null;
    }) : null;
  return {
    difficulty: DIFFS.includes(r.difficulty as Difficulty) ? (r.difficulty as Difficulty) : d.difficulty,
    bots,
    map: typeof r.map === 'string' && r.map.length <= 40 ? r.map : null,
    seats: seats && seats.every((s) => s) ? (seats as SeatPref[]) : null,
    lastBuy: typeof r.lastBuy === 'string' && r.lastBuy.length <= 32 ? (r.lastBuy as ShopItem) : null,
  };
}

export function loadPrefs(kv = store()): Prefs {
  try { return sanitizePrefs(JSON.parse(kv?.getItem(PREFS_KEY) ?? 'null')); } catch { return defaults(); }
}

export function savePrefs(patch: Partial<Prefs>, kv = store()) {
  const next = sanitizePrefs({ ...loadPrefs(kv), ...patch });
  try { kv?.setItem(PREFS_KEY, JSON.stringify(next)); } catch (err) { console.warn('[prefs] could not save', err); }
}

/** Seats 1.. of a lobby (seat 0 = host) as remembered prefs: friends' seats are remembered as open. */
export function seatPrefsOf(slots: Slot[]): SeatPref[] {
  return slots.slice(1).map((s): SeatPref => (s.kind === 'bot' ? { kind: 'bot', difficulty: s.difficulty } : { kind: 'open' }));
}
