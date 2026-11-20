import { CENTER } from './constants';
import { addKind, canAdd, countOf } from './hotbar';
import type { CenterIsland } from './map';
import type { PlayerState, Vec3 } from './types';
import { dist2D } from './vec';

/** Live state of the center island's bonus stations (part of every snapshot). */
export type CenterState = {
  /** Cash waiting at the gold generator. */
  gold: number;
  /** Free pieces waiting at the supply generator. */
  bags: number;
  steel: number;
  /** Seconds accumulated toward the next sandbag / steel plate. */
  bagT: number;
  steelT: number;
};

export function newCenterState(): CenterState {
  return { gold: 0, bags: 0, steel: 0, bagT: 0, steelT: 0 };
}

/** Advance the bonus stations by dt. Like home generators they stop in sudden death (`active` false). */
export function tickCenter(c: CenterState, dt: number, active: boolean): void {
  if (!active) return;
  c.gold = Math.min(CENTER.goldCap, c.gold + CENTER.goldRate * dt);
  if (c.bags < CENTER.supplyBagCap) {
    c.bagT += dt;
    if (c.bagT >= CENTER.supplyBagSec) { c.bagT -= CENTER.supplyBagSec; c.bags++; }
  } else c.bagT = 0;
  if (c.steel < CENTER.supplySteelCap) {
    c.steelT += dt;
    if (c.steelT >= CENTER.supplySteelSec) { c.steelT -= CENTER.supplySteelSec; c.steel++; }
  } else c.steelT = 0;
}

/** Anyone takes the whole dollars waiting at the gold generator. Returns the amount. */
export function collectGold(p: PlayerState, c: CenterState): number {
  const amount = Math.floor(c.gold);
  p.inv.cash += amount;
  c.gold -= amount;
  return amount;
}

/**
 * Anyone takes the waiting pieces. A kind the player doesn't hold yet needs a free hotbar slot; what
 * doesn't fit stays at the generator. Returns what was taken.
 */
export function collectSupply(p: PlayerState, c: CenterState): { sandbags: number; steel: number } {
  const took = { sandbags: 0, steel: 0 };
  for (const [kind, key] of [['sandbags', 'bags'], ['steel', 'steel']] as const) {
    const n = c[key];
    if (n <= 0) continue;
    if (countOf(p.inv, kind) === 0) {
      if (!canAdd(p.hotbar, kind)) continue;
      addKind(p.hotbar, kind);
    }
    p.inv.pieces[kind] = (p.inv.pieces[kind] ?? 0) + n;
    c[key] = 0;
    took[kind] = n;
  }
  return took;
}

export const inShieldWell = (center: CenterIsland, pos: Vec3) =>
  dist2D(pos, center.shieldWell) <= CENTER.wellRadius && Math.abs(pos.y - center.shieldWell.y) < 1.5;

/**
 * Shield well hook. Shields are being added by another change; until PlayerState has a numeric `shield`,
 * this is a no-op. Once it exists, standing in the well refills it up to CENTER.wellCap.
 */
export function refillShield(p: PlayerState, dt: number): void {
  const s = p as PlayerState & { shield?: number };
  if (typeof s.shield !== 'number' || s.shield >= CENTER.wellCap) return;
  s.shield = Math.min(CENTER.wellCap, s.shield + CENTER.wellPerSec * dt);
}
