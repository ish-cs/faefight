import { countOf, HOTBAR_ITEMS, isGunItem } from '../sim/hotbar';
import type { HotbarItem, Inventory, Loadout, VaultAction } from '../sim/types';
import { isUnit, LOADOUT_MAX_KINDS, loadoutMax, stackRequest } from '../sim/vault';

/**
 * Pure helpers behind the vault panel (vaultPanel.ts): how much a click/drag moves, the vault grid's sort order,
 * loadout editing, the paced send queue and the hold-E timer.
 */

/** Modifiers of a vault drag or click. `exact`: the amount box (0/blank = none). */
export type MoveMods = { shift: boolean; one: boolean; exact: number; drag: boolean };

/**
 * Units a move takes out of a stack of `have`:
 * - an exact amount typed in (or scrolled to) wins, capped at the stack;
 * - drag: Shift = half (rounded up), Ctrl/Alt = one, plain = the whole stack;
 * - click: the whole stack (Shift-click is the explicit quick-move of the whole stack).
 * Guns and the hook always move whole.
 */
export function moveCount(kind: HotbarItem, have: number, m: MoveMods): number {
  if (have <= 0) return 0;
  if (isUnit(kind)) return have;
  if (m.exact > 0) return Math.min(have, Math.floor(m.exact));
  if (!m.drag) return have;
  if (m.one) return 1;
  if (m.shift) return Math.ceil(have / 2);
  return have;
}

/** The vault move for `n` of `kind` from one side to the other (null when nothing moves). */
export function moveAction(kind: HotbarItem, n: number, from: 'carried' | 'stored', inv: Inventory): VaultAction | null {
  if (n <= 0 || countOf(inv, kind) <= 0) return null;
  const req = stackRequest(kind, n, inv);
  return from === 'carried' ? { deposit: req } : { withdraw: req };
}

const ORDER = new Map(HOTBAR_ITEMS.map((k, i) => [k, i]));
/** Auto-sort: what's in the vault, guns → pieces → gear → potions → hook (canonical order). */
export function vaultCells(inv: Inventory): { kind: HotbarItem; count: number }[] {
  return HOTBAR_ITEMS.filter((k) => countOf(inv, k) > 0).map((kind) => ({ kind, count: countOf(inv, kind) }));
}

/** Kinds worth a loadout row: anything you carry, store or already restock (canonical order). */
export function loadoutKinds(inv: Inventory, vault: Inventory, l: Loadout | undefined): HotbarItem[] {
  const ks = new Set<HotbarItem>();
  for (const k of HOTBAR_ITEMS) if (countOf(inv, k) > 0 || countOf(vault, k) > 0 || (l?.items[k] ?? 0) > 0) ks.add(k);
  return [...ks].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}

/**
 * The loadout with `kind` changed by `delta` (clamped 0..its max). Null when it would add a kind past
 * LOADOUT_MAX_KINDS (or nothing changes).
 */
export function bumpLoadout(l: Loadout, kind: HotbarItem, delta: number): Loadout | null {
  const now = l.items[kind] ?? 0;
  const next = Math.max(0, Math.min(loadoutMax(kind), now + delta));
  if (next === now) return null;
  if (now === 0 && Object.values(l.items).filter((n) => (n ?? 0) > 0).length >= LOADOUT_MAX_KINDS) return null;
  const items = { ...l.items };
  if (next > 0) items[kind] = next; else delete items[kind];
  return { ...l, items };
}

/** Keep $keep on me: deposit the excess or withdraw the shortfall (as far as the vault goes). */
export function keepCashAction(carried: number, banked: number, keep: number): VaultAction | null {
  const k = Math.max(0, Math.floor(keep));
  if (carried > k) return { deposit: { cash: Math.floor(carried - k) } };
  const want = Math.min(k - carried, Math.floor(banked));
  return want > 0 ? { withdraw: { cash: want } } : null;
}

/** Short count for a grid cell: guns show mag/spare, the rest ×n. */
export function cellCount(kind: HotbarItem, inv: Inventory): string {
  if (isGunItem(kind)) { const a = inv.weapons[kind]; return a ? `${a.mag}/${a.spare}` : ''; }
  const n = countOf(inv, kind);
  return n > 0 ? `×${n}` : '';
}

/** Gap between vault moves sent from the panel (a sim tick is 33 ms; inputs merge per tick). */
export const VAULT_PACE_MS = 70;

/** Vault moves from the panel go out one per tick, in order (two in one tick would overwrite each other). */
export class VaultQueue {
  private q: VaultAction[] = [];
  private nextAt = 0;
  add(a: VaultAction) { this.q.push(a); }
  get size() { return this.q.length; }
  take(nowMs: number): VaultAction | null {
    if (!this.q.length || nowMs < this.nextAt) return null;
    this.nextAt = nowMs + VAULT_PACE_MS;
    return this.q.shift()!;
  }
  clear() { this.q = []; }
}

/** Hold E at the vault this long to quick-bank instead of opening the panel. */
export const HOLD_BANK_MS = 450;

/** Tap vs hold of one key: tap fires on release before `ms`, hold fires once when `ms` passes with the key down. */
export class HoldTap {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  constructor(private ms = HOLD_BANK_MS) {}
  get pending() { return this.timer !== null; }
  start(onHold: () => void) {
    this.cancel();
    this.held = false;
    this.timer = setTimeout(() => { this.timer = null; this.held = true; onHold(); }, this.ms);
  }
  /** Key up: runs `onTap` if the hold didn't fire. */
  release(onTap: () => void) {
    if (this.timer === null) { this.held = false; return; }
    this.cancel();
    if (!this.held) onTap();
  }
  cancel() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
}
