import { PIECES } from './constants';
import type { HotbarItem, Inventory, PieceKind, PotionKind, WeaponKind } from './types';

/**
 * The hotbar is the ordered list of item kinds a player holds; the amounts live in `inv`.
 * Invariant: a kind sits in exactly one slot iff the inventory holds some of it.
 */
export const HOTBAR_SIZE = 9;

export type Hotbar = (HotbarItem | null)[];
export type HotbarGun = Exclude<WeaponKind, 'fists'>;

const GUNS: readonly HotbarGun[] = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'];
const PIECE_KINDS = Object.keys(PIECES) as PieceKind[];
export const POTION_KINDS: readonly PotionKind[] = ['shieldSmall', 'shieldBig', 'healPotion', 'speedPotion'];
/** Order used when filling slots for kinds that arrived without a slot (e.g. debug grants). */
export const HOTBAR_ITEMS: readonly HotbarItem[] = [...GUNS, ...PIECE_KINDS, 'grenade', 'charge', 'medkit', 'trap', ...POTION_KINDS, 'grapple'];

export const isGunItem = (k: unknown): k is HotbarGun => (GUNS as readonly unknown[]).includes(k);
export const isPotionItem = (k: unknown): k is PotionKind => (POTION_KINDS as readonly unknown[]).includes(k);
export const isPieceItem = (k: unknown): k is PieceKind => (PIECE_KINDS as readonly unknown[]).includes(k);
export const isHotbarItem = (k: unknown): k is HotbarItem => (HOTBAR_ITEMS as readonly unknown[]).includes(k);

/** Sets the grappling hook uses left, dropping the key at 0 (so an inventory without hooks has none). */
export function setGrapples(inv: Inventory, n: number): void {
  if (n > 0) inv.grapples = n; else delete inv.grapples;
}

export function emptyHotbar(): Hotbar {
  return Array.from({ length: HOTBAR_SIZE }, () => null);
}

/** How many of `kind` the inventory holds (a gun counts as 1). */
export function countOf(inv: Inventory, kind: HotbarItem): number {
  if (isGunItem(kind)) return inv.weapons[kind] ? 1 : 0;
  if (kind === 'grenade') return inv.grenades;
  if (kind === 'charge') return inv.charges;
  if (kind === 'medkit') return inv.medkits;
  if (kind === 'grapple') return inv.grapples ?? 0;
  if (kind === 'trap') return inv.traps;
  if (isPotionItem(kind)) return inv.potions[kind] ?? 0;
  return inv.pieces[kind] ?? 0;
}

/** Every hotbar-worthy kind the inventory holds, in canonical order. */
export function heldKinds(inv: Inventory): HotbarItem[] {
  return HOTBAR_ITEMS.filter((k) => countOf(inv, k) > 0);
}

/** True if `kind` already has a slot or there is an empty one for it. */
export function canAdd(bar: Hotbar, kind: HotbarItem): boolean {
  return bar.includes(kind) || bar.includes(null);
}

/** Puts `kind` in the first empty slot unless it already has one. Returns its slot, or -1 if full. */
export function addKind(bar: Hotbar, kind: HotbarItem): number {
  const at = bar.indexOf(kind);
  if (at >= 0) return at;
  const free = bar.indexOf(null);
  if (free >= 0) bar[free] = kind;
  return free;
}

/** Clears every slot whose kind the inventory no longer holds. */
export function removeIfEmpty(bar: Hotbar, inv: Inventory): void {
  for (let i = 0; i < bar.length; i++) {
    const k = bar[i];
    if (k !== null && countOf(inv, k) <= 0) bar[i] = null;
  }
}

/**
 * Makes the hotbar match the inventory: empties slots of kinds no longer held, then gives a slot to
 * any held kind that lacks one. Returns kinds that did not fit (they stay in `inv`, unslotted).
 */
export function syncFromInventory(bar: Hotbar, inv: Inventory): HotbarItem[] {
  removeIfEmpty(bar, inv);
  const seen = new Set<HotbarItem>();
  for (let i = 0; i < bar.length; i++) {
    const k = bar[i];
    if (k === null) continue;
    if (seen.has(k)) bar[i] = null; // never let a kind occupy two slots
    else seen.add(k);
  }
  return heldKinds(inv).filter((k) => addKind(bar, k) < 0);
}

export function swapSlots(bar: Hotbar, from: number, to: number): boolean {
  if (!validSlot(from) || !validSlot(to)) return false;
  [bar[from], bar[to]] = [bar[to], bar[from]];
  return true;
}

export const validSlot = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < HOTBAR_SIZE;

/** What's in hand for the selected slot: the gun there, else fists. */
export function equippedFor(bar: Hotbar, selected: number): WeaponKind {
  const k = bar[selected];
  return isGunItem(k) ? k : 'fists';
}

/**
 * Splits `kind` out of `inv` into a new inventory: one unit (a gun takes its ammo with it) or the
 * whole stack. Returns null when there is nothing of that kind.
 */
export function takeOut(inv: Inventory, kind: HotbarItem, amount: 'one' | 'stack'): Inventory | null {
  const have = countOf(inv, kind);
  if (have <= 0) return null;
  const out: Inventory = { cash: 0, weapons: {}, pieces: {}, grenades: 0, charges: 0, medkits: 0, potions: {}, traps: 0 };
  if (isGunItem(kind)) {
    out.weapons[kind] = inv.weapons[kind];
    delete inv.weapons[kind];
    return out;
  }
  const n = amount === 'one' && kind !== 'grapple' ? 1 : have; // the hook goes as one item, all its uses with it
  if (kind === 'grenade') { inv.grenades -= n; out.grenades = n; }
  else if (kind === 'charge') { inv.charges -= n; out.charges = n; }
  else if (kind === 'medkit') { inv.medkits -= n; out.medkits = n; }
  else if (kind === 'grapple') { setGrapples(inv, have - n); out.grapples = n; }
  else if (kind === 'trap') { inv.traps -= n; out.traps = n; }
  else if (isPotionItem(kind)) {
    const left = have - n;
    if (left > 0) inv.potions[kind] = left; else delete inv.potions[kind];
    out.potions[kind] = n;
  }
  else {
    const left = have - n;
    if (left > 0) inv.pieces[kind] = left; else delete inv.pieces[kind];
    out.pieces[kind] = n;
  }
  return out;
}
