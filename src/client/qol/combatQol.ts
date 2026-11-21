import type { ShopItem } from '../../sim/types';

/**
 * Combat QoL helpers (pure): low-ammo warnings and a paced buy queue (Shift+click buys several pieces; the
 * sim takes one shop action per input, so repeats are spaced out to arrive on separate ticks).
 */

export type AmmoWarn = { kind: 'low' | 'last' | 'empty'; text: string } | null;

/**
 * - empty: nothing in the gun or in reserve
 * - low: a quarter of the magazine or less left (guns with a magazine bigger than 2), spare to reload with
 * - last: low and nothing left to reload with
 * Reloading never warns (the HUD already says so).
 */
export function ammoWarning(mag: number, spare: number, magSize: number, reloading: boolean): AmmoWarn {
  if (reloading) return null;
  if (mag <= 0 && spare <= 0) return { kind: 'empty', text: 'No ammo' };
  if (magSize <= 2) return null;
  if (mag <= Math.max(1, Math.floor(magSize / 4))) return spare > 0 ? { kind: 'low', text: 'Low ammo' } : { kind: 'last', text: 'Last rounds' };
  return null;
}

/** Hotbar slot tint: out of ammo, or no spare magazines left. */
export function slotAmmoState(mag: number, spare: number): 'empty' | 'nospare' | null {
  if (mag <= 0 && spare <= 0) return 'empty';
  if (spare <= 0) return 'nospare';
  return null;
}

/** Shift+click buys this many of a building piece. */
export const BULK_PIECES = 5;
/** Gap between queued buys (a sim tick is 33 ms; inputs are merged per tick). */
export const BUY_PACE_MS = 100;

export class BuyQueue {
  private q: ShopItem[] = [];
  private nextAt = 0;

  add(item: ShopItem, times = 1) {
    for (let i = 0; i < times; i++) this.q.push(item);
  }

  get size() { return this.q.length; }

  /** The next buy to send now, if any (at most one per BUY_PACE_MS). */
  take(nowMs: number): ShopItem | null {
    if (!this.q.length || nowMs < this.nextAt) return null;
    this.nextAt = nowMs + BUY_PACE_MS;
    return this.q.shift()!;
  }

  clear() { this.q = []; }
}
