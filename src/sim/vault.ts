import { VAULT_INTEREST_SEC, VAULT_LEVELS, VAULT_MAX_LEVEL } from './constants';
import { buy, funds, pay, vaultTransfer, type Result } from './economy';
export { funds, pay } from './economy';
import { countOf, HOTBAR_ITEMS, isGunItem, isHotbarItem } from './hotbar';
import type { IslandLayout } from './map';
import type { HotbarItem, Inventory, Loadout, PlayerState, VaultAction } from './types';
import { dist2D } from './vec';

/**
 * The vault beyond plain deposit/withdraw:
 * - shops pay from carried cash first, then vault cash (`pay`, used by economy.buy), so banked money is
 *   spendable anywhere without a trip home;
 * - a restock loadout refills the hotbar from the vault on respawn (`restockFromVault`), optionally buying
 *   what the vault lacks with vault cash;
 * - quick-bank (`bankAboveLoadout`): everything carried above the loadout goes in (hold E at the vault);
 * - spoils (`takeVaultCash`): the elimination-rewards code takes a victim's vault cash through this;
 * - levels (VAULT_LEVELS, bought at the vault): interest on banked cash, more storage and loadout kinds, and
 *   deposits from anywhere on your own island.
 * Carried cash and items drop as a loot bag on death (lifecycle.killPlayer); the vault is never touched by a death.
 */

/** Most item kinds a loadout may list at vault level 1 (higher levels allow more: VAULT_LEVELS.kinds). */
export const LOADOUT_MAX_KINDS: number = VAULT_LEVELS[0].kinds;
/** Most kinds at the top level: what the wire accepts (the sim then holds you to your level's). */
export const LOADOUT_ABS_MAX_KINDS: number = VAULT_LEVELS[VAULT_MAX_LEVEL - 1].kinds;
/** Most of one kind a loadout may ask for (pieces / other stackables); guns and the hook count as 1. */
export const LOADOUT_MAX_PIECES = 50;
export const LOADOUT_MAX_OTHER = 10;
/** Most carried cash a loadout may keep on you. */
export const LOADOUT_MAX_KEEP = 5000;

/** Guns and the grappling hook are single units: a loadout wants one or none. */
export const isUnit = (k: HotbarItem) => isGunItem(k) || k === 'grapple';
export const loadoutMax = (k: HotbarItem) => (isUnit(k) ? 1 : k in PIECE_MAX ? LOADOUT_MAX_PIECES : LOADOUT_MAX_OTHER);
const PIECE_MAX: Record<string, true> = { sandbags: true, wood: true, metal: true, steel: true, scaffold: true, ramp: true, container: true };

export function emptyLoadout(): Loadout {
  return { items: {}, keep: 0, buy: false };
}

/** Validates an untrusted loadout (wire, replays): known kinds, integer counts clamped, at most `maxKinds` kinds. */
export function sanitizeLoadout(x: unknown, maxKinds: number = LOADOUT_ABS_MAX_KINDS): Loadout | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.items !== 'object' || o.items === null) return null;
  const items: Loadout['items'] = {};
  let n = 0;
  for (const k of HOTBAR_ITEMS) {
    const v = (o.items as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const c = Math.min(loadoutMax(k), Math.max(0, Math.floor(v)));
    if (c === 0) continue;
    if (++n > maxKinds) return null;
    items[k] = c;
  }
  for (const k of Object.keys(o.items)) if (!isHotbarItem(k)) return null;
  const keep = typeof o.keep === 'number' && Number.isFinite(o.keep) ? Math.min(LOADOUT_MAX_KEEP, Math.max(0, Math.floor(o.keep))) : 0;
  return { items, keep, buy: o.buy === true };
}

/** Removes up to `max` whole dollars of vault cash (spoils of war) and returns how much was taken. */
export function takeVaultCash(p: PlayerState, max = Infinity): number {
  const n = Math.max(0, Math.min(Math.floor(p.vault.cash), Math.floor(max)));
  p.vault.cash -= n;
  return n;
}

/** Inventory request for one `kind` of `n` units (a gun by key; the hook as all its uses). */
export function stackRequest(kind: HotbarItem, n: number, from: Inventory): Partial<Inventory> {
  if (isGunItem(kind)) return { weapons: { [kind]: from.weapons[kind] } };
  if (kind === 'grenade') return { grenades: n };
  if (kind === 'charge') return { charges: n };
  if (kind === 'medkit') return { medkits: n };
  if (kind === 'trap') return { traps: n };
  if (kind === 'smoke') return { smokes: n };
  if (kind === 'flash') return { flashes: n };
  if (kind === 'grapple') return { grapples: from.grapples ?? 0 };
  if (kind in PIECE_MAX) return { pieces: { [kind]: n } };
  return { potions: { [kind]: n } };
}

export type RestockResult = { moved: number; bought: number; spent: number; cash: number };

/**
 * Respawn: refills the hotbar to the loadout from the vault (kinds in canonical order), buys what the vault
 * lacks with vault cash when `buy` is on, then tops carried cash up to `keep` from the vault. Kinds that find
 * no free hotbar slot are skipped. Returns what happened (null with no loadout).
 */
export function restockFromVault(p: PlayerState): RestockResult | null {
  const l = p.loadout;
  if (!l) return null;
  const out: RestockResult = { moved: 0, bought: 0, spent: 0, cash: 0 };
  for (const kind of HOTBAR_ITEMS) {
    const want = l.items[kind] ?? 0;
    if (want <= 0) continue;
    let need = isUnit(kind) ? (countOf(p.inv, kind) > 0 ? 0 : 1) : want - countOf(p.inv, kind);
    if (need <= 0) continue;
    const stored = countOf(p.vault, kind);
    if (stored > 0) {
      const n = isUnit(kind) ? 1 : Math.min(need, stored);
      if (vaultTransfer(p, { withdraw: stackRequest(kind, n, p.vault) }).ok) { need -= n; out.moved += n; }
      else continue; // no hotbar room: buying wouldn't fit either
    }
    for (; need > 0 && l.buy; need--) {
      const before = funds(p);
      // Carried cash is gone at a respawn, so this is vault money (economy.buy pays carried first, then vault).
      if (!buy(p, { buy: kind }).ok) break;
      out.bought++;
      out.spent += before - funds(p);
      // The hook comes with several uses in one buy.
      if (isUnit(kind)) break;
    }
  }
  if (l.keep > p.inv.cash && p.vault.cash > 0) {
    const n = Math.min(l.keep - p.inv.cash, Math.floor(p.vault.cash));
    if (n > 0 && vaultTransfer(p, { withdraw: { cash: n } }).ok) out.cash = n;
  }
  return out;
}

/**
 * Quick-bank (hold E at the vault): a deposit of everything carried above the loadout: cash above `keep`,
 * stackables above their loadout count (as far as the vault has room). Guns and the hook stay on you. Null when
 * there is nothing to bank.
 */
export function bankAboveLoadout(p: PlayerState): Partial<Inventory> | null {
  const l = p.loadout ?? emptyLoadout();
  const dep: Partial<Inventory> = {};
  let any = false;
  let room = vaultSpec(p).storage - itemUnits(p.vault);
  const cash = Math.floor(p.inv.cash) - l.keep;
  if (cash > 0) { dep.cash = cash; any = true; }
  for (const kind of HOTBAR_ITEMS) {
    if (isUnit(kind)) continue;
    const extra = Math.min(countOf(p.inv, kind) - (l.items[kind] ?? 0), room);
    if (extra <= 0) continue;
    room -= extra;
    const r = stackRequest(kind, extra, p.inv);
    if (r.pieces) dep.pieces = { ...dep.pieces, ...r.pieces };
    else if (r.potions) dep.potions = { ...dep.potions, ...r.potions };
    else Object.assign(dep, r);
    any = true;
  }
  return any ? dep : null;
}

/** A player's vault level (1..VAULT_MAX_LEVEL) and what it gives. */
export const vaultLevel = (p: PlayerState): number => Math.max(1, Math.min(VAULT_MAX_LEVEL, Math.floor(p.vaultLevel ?? 1) || 1));
export const vaultSpec = (p: PlayerState) => VAULT_LEVELS[vaultLevel(p) - 1];
/** Price of the next vault level, or null at max. */
export function vaultUpgradePrice(level: number): number | null {
  return level >= VAULT_MAX_LEVEL ? null : VAULT_LEVELS[level].price;
}

/** Buys the next vault level (carried cash first, then vault cash). */
export function upgradeVault(p: PlayerState): Result {
  const lv = vaultLevel(p), price = vaultUpgradePrice(lv);
  if (price === null) return { ok: false, reason: 'vault already at max level' };
  if (funds(p) < price) return { ok: false, reason: `need $${price}, have $${funds(p)} (carried + vault)` };
  pay(p, price);
  p.vaultLevel = lv + 1;
  return { ok: true };
}

/** Interest for one payout (every VAULT_INTEREST_SEC × `mult`, the host's economy speed), whole dollars. */
export function interestDue(p: PlayerState, mult = 1): number {
  const { rate, base } = vaultSpec(p);
  return Math.floor(Math.min(p.vault.cash, base) * rate * (VAULT_INTEREST_SEC / 60) * mult);
}

/** Pays interest into the vault; returns the amount. */
export function payInterest(p: PlayerState, mult = 1): number {
  const n = interestDue(p, mult);
  p.vault.cash += n;
  return n;
}

/** Item units in an inventory (cash aside; a gun or the hook is one). */
export function itemUnits(inv: Inventory): number {
  let n = 0;
  for (const k of HOTBAR_ITEMS) { const c = countOf(inv, k); if (c > 0) n += isUnit(k) ? 1 : c; }
  return n;
}

/** Item units a deposit request adds. */
function requestUnits(req: Partial<Inventory>): number {
  const pieces = Object.values(req.pieces ?? {}).reduce<number>((a, n) => a + (n ?? 0), 0);
  const potions = Object.values(req.potions ?? {}).reduce<number>((a, n) => a + (n ?? 0), 0);
  return pieces + potions + (req.grenades ?? 0) + (req.charges ?? 0) + (req.medkits ?? 0) + (req.traps ?? 0) + (req.smokes ?? 0) + (req.flashes ?? 0) +
    (req.grapples ? 1 : 0) + Object.keys(req.weapons ?? {}).length;
}

/** Whether `p` may deposit here: at their own vault, or (remote levels) anywhere on their own island. */
export function canDepositAt(p: PlayerState, isl: IslandLayout, atVault: boolean): boolean {
  return atVault || (vaultSpec(p).remote && dist2D(p.pos, isl.center) <= isl.radius + 1);
}

/**
 * A vault move with the level's rules: deposits need room (storage counts item units; cash is unlimited);
 * withdrawals need you at the vault; deposits also work anywhere on your island from a remote level.
 */
export function vaultMove(p: PlayerState, isl: IslandLayout, atVault: boolean, a: VaultAction): Result {
  if (a.withdraw && !atVault) return { ok: false, reason: 'withdraw at your vault' };
  if (a.deposit && !canDepositAt(p, isl, atVault)) return { ok: false, reason: 'deposit at your vault' };
  if (!a.deposit && !a.withdraw) return { ok: false, reason: 'nothing to move' };
  if (a.deposit) {
    const room = vaultSpec(p).storage - itemUnits(p.vault) + (a.withdraw ? requestUnits(a.withdraw) : 0);
    if (requestUnits(a.deposit) > room) return { ok: false, reason: `vault full (Lv${vaultLevel(p)} holds ${vaultSpec(p).storage} items)` };
  }
  return vaultTransfer(p, { deposit: a.deposit, withdraw: a.withdraw });
}
