import { AMMO_BOX, CHARGE, ECONOMY, GRENADE, PIECES, SPARE_MAGS_ON_BUY, WEAPONS } from './constants';
import type { Inventory, PieceKind, PlayerState, ShopAction, VaultAction, WeaponKind } from './types';

export type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

export function emptyInventory(): Inventory {
  return { cash: 0, weapons: {}, pieces: {}, grenades: 0, charges: 0 };
}

export function tickGenerator(stored: number, dt: number, active: boolean): number {
  if (!active) return stored;
  return Math.min(ECONOMY.generatorCap, stored + ECONOMY.generatorRate * dt);
}

export function collect(player: PlayerState, gen: { stored: number }): number {
  const amount = Math.floor(gen.stored);
  player.inv.cash += amount;
  gen.stored -= amount;
  return amount;
}

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle'] as const;
const isGun = (k: string): k is (typeof GUNS)[number] => (GUNS as readonly string[]).includes(k);
const isPiece = (k: string): k is PieceKind => k in PIECES;

function priceOf(item: ShopAction['buy']): number {
  if (isGun(item)) return WEAPONS[item].price;
  if (isPiece(item)) return PIECES[item].price;
  if (item === 'ammo') return AMMO_BOX.price;
  if (item === 'grenade') return GRENADE.price;
  return CHARGE.price;
}

export function buy(player: PlayerState, action: ShopAction): Result {
  const item = action.buy;
  const price = priceOf(item);
  if (player.inv.cash < price) return fail(`need $${price}, carrying $${player.inv.cash}`);
  const inv = player.inv;
  if (isGun(item)) {
    if (inv.weapons[item]) return fail(`already own ${item}`);
    const mag = WEAPONS[item].mag;
    inv.weapons[item] = { mag, spare: mag * SPARE_MAGS_ON_BUY };
  } else if (isPiece(item)) {
    inv.pieces[item] = (inv.pieces[item] ?? 0) + 1;
  } else if (item === 'ammo') {
    const gun = player.equipped;
    const ammo = inv.weapons[gun];
    if (gun === 'fists' || !ammo) return fail('equip a gun to buy ammo');
    ammo.spare += WEAPONS[gun].mag * AMMO_BOX.mags;
  } else if (item === 'grenade') {
    inv.grenades += 1;
  } else {
    inv.charges += 1;
  }
  inv.cash -= price;
  return { ok: true };
}

/** Checks `from` holds everything `req` asks for. Weapon entries in `req` are matched by key only. */
function holds(from: Inventory, req: Partial<Inventory>): string | null {
  if ((req.cash ?? 0) > from.cash) return `only $${from.cash} available`;
  if ((req.grenades ?? 0) > from.grenades) return 'not enough grenades';
  if ((req.charges ?? 0) > from.charges) return 'not enough charges';
  for (const [k, n] of Object.entries(req.pieces ?? {})) if ((n ?? 0) > (from.pieces[k as PieceKind] ?? 0)) return `not enough ${k}`;
  for (const k of Object.keys(req.weapons ?? {})) if (!from.weapons[k as WeaponKind]) return `no ${k} to move`;
  return null;
}

function move(from: Inventory, to: Inventory, req: Partial<Inventory>) {
  const moved = emptyInventory();
  moved.cash = req.cash ?? 0;
  moved.grenades = req.grenades ?? 0;
  moved.charges = req.charges ?? 0;
  from.cash -= moved.cash;
  from.grenades -= moved.grenades;
  from.charges -= moved.charges;
  for (const [k, n] of Object.entries(req.pieces ?? {})) {
    const kind = k as PieceKind;
    from.pieces[kind] = (from.pieces[kind] ?? 0) - (n ?? 0);
    if (from.pieces[kind] === 0) delete from.pieces[kind];
    moved.pieces[kind] = n ?? 0;
  }
  for (const k of Object.keys(req.weapons ?? {})) {
    const kind = k as WeaponKind;
    moved.weapons[kind] = from.weapons[kind];
    delete from.weapons[kind];
  }
  mergeInventory(to, moved);
}

export function vaultTransfer(player: PlayerState, action: VaultAction): Result {
  const dep = action.deposit, wd = action.withdraw;
  const depErr = dep ? holds(player.inv, dep) : null;
  if (depErr) return fail(depErr);
  const wdErr = wd ? holds(player.vault, wd) : null;
  if (wdErr) return fail(wdErr);
  if (dep) move(player.inv, player.vault, dep);
  if (wd) move(player.vault, player.inv, wd);
  if (!player.inv.weapons[player.equipped] && player.equipped !== 'fists') player.equipped = 'fists';
  return { ok: true };
}

export function mergeInventory(into: Inventory, from: Inventory): void {
  into.cash += from.cash;
  into.grenades += from.grenades;
  into.charges += from.charges;
  for (const [k, n] of Object.entries(from.pieces)) {
    const kind = k as PieceKind;
    into.pieces[kind] = (into.pieces[kind] ?? 0) + (n ?? 0);
  }
  for (const [k, ammo] of Object.entries(from.weapons)) {
    if (!ammo) continue;
    const kind = k as WeaponKind;
    const have = into.weapons[kind];
    if (have) have.spare += ammo.mag + ammo.spare;
    else into.weapons[kind] = { mag: ammo.mag, spare: ammo.spare };
  }
}
