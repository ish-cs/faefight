import { AMMO_BOX, CHARGE, ECONOMY, GRENADE, MEDKIT, PIECES, PLAYER, POTIONS, SPARE_MAGS_ON_BUY, WEAPONS } from './constants';
import { addKind, canAdd, countOf, isHotbarItem, isPotionItem, removeIfEmpty, syncFromInventory } from './hotbar';
import { SHOP_LABEL, shopFor, type ShopKind } from './potions';
import type { HotbarItem, Inventory, PieceKind, PlayerState, PotionKind, ShopAction, VaultAction, WeaponKind } from './types';

export type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

export function emptyInventory(): Inventory {
  return { cash: 0, weapons: {}, pieces: {}, grenades: 0, charges: 0, medkits: 0, potions: {} };
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

export function priceOf(item: ShopAction['buy']): number {
  if (isPotionItem(item)) return POTIONS[item].price;
  if (isGun(item)) return WEAPONS[item].price;
  if (isPiece(item)) return PIECES[item].price;
  if (item === 'ammo') return AMMO_BOX.price;
  if (item === 'grenade') return GRENADE.price;
  if (item === 'medkit') return MEDKIT.price;
  return CHARGE.price;
}

export function buy(player: PlayerState, action: ShopAction): Result {
  const item = action.buy;
  const price = priceOf(item);
  if (player.inv.cash < price) return fail(`need $${price}, carrying $${player.inv.cash}`);
  const inv = player.inv;
  // A new kind needs a free hotbar slot; more of a kind you hold (or ammo) doesn't.
  const slotKind = isHotbarItem(item) ? item : null;
  if (slotKind && countOf(inv, slotKind) === 0 && !canAdd(player.hotbar, slotKind)) return fail('Hotbar full');
  if (isGun(item)) {
    if (inv.weapons[item]) return fail(`already own ${item}`);
    const mag = WEAPONS[item].mag;
    inv.weapons[item] = { mag, spare: mag * SPARE_MAGS_ON_BUY };
  } else if (isPiece(item)) {
    inv.pieces[item] = (inv.pieces[item] ?? 0) + 1;
  } else if (item === 'ammo') {
    // Ammo for the gun in hand; with fists out, for the first gun you own.
    const gun = player.equipped !== 'fists' ? player.equipped : GUNS.find((g) => inv.weapons[g]);
    const ammo = gun ? inv.weapons[gun] : undefined;
    if (!gun || !ammo) return fail('you need a gun to buy ammo');
    ammo.spare += WEAPONS[gun].mag * AMMO_BOX.mags;
  } else if (item === 'grenade') {
    inv.grenades += 1;
  } else if (item === 'medkit') {
    inv.medkits += 1;
  } else if (isPotionItem(item)) {
    inv.potions[item] = (inv.potions[item] ?? 0) + 1;
  } else {
    inv.charges += 1;
  }
  inv.cash -= price;
  if (slotKind) addKind(player.hotbar, slotKind);
  return { ok: true };
}

/** Buying at a particular counter: the home shop or a potion seller each sell only their own stock. */
export function buyAt(player: PlayerState, at: ShopKind, action: ShopAction): Result {
  const sells = shopFor(action.buy);
  if (sells !== at) return fail(`${SHOP_LABEL[action.buy] ?? action.buy} is only sold at ${sells === 'potion' ? 'the potion seller' : 'your home shop'}`);
  return buy(player, action);
}

/** Checks `from` holds everything `req` asks for. Weapon entries in `req` are matched by key only. */
function holds(from: Inventory, req: Partial<Inventory>): string | null {
  const amounts = [req.cash, req.grenades, req.charges, req.medkits, ...Object.values(req.pieces ?? {}), ...Object.values(req.potions ?? {})];
  if (amounts.some((n) => n !== undefined && (!Number.isFinite(n) || n < 0))) return 'amounts must be zero or more';
  if ((req.cash ?? 0) > from.cash) return `only $${from.cash} available`;
  if ((req.grenades ?? 0) > from.grenades) return 'not enough grenades';
  if ((req.charges ?? 0) > from.charges) return 'not enough charges';
  if ((req.medkits ?? 0) > from.medkits) return 'not enough medkits';
  for (const [k, n] of Object.entries(req.pieces ?? {})) if ((n ?? 0) > (from.pieces[k as PieceKind] ?? 0)) return `not enough ${k}`;
  for (const [k, n] of Object.entries(req.potions ?? {})) if ((n ?? 0) > (from.potions[k as PotionKind] ?? 0)) return `not enough ${k}`;
  for (const k of Object.keys(req.weapons ?? {})) if (!from.weapons[k as WeaponKind]) return `no ${k} to move`;
  return null;
}

function move(from: Inventory, to: Inventory, req: Partial<Inventory>) {
  const moved = emptyInventory();
  moved.cash = req.cash ?? 0;
  moved.grenades = req.grenades ?? 0;
  moved.charges = req.charges ?? 0;
  moved.medkits = req.medkits ?? 0;
  from.cash -= moved.cash;
  from.grenades -= moved.grenades;
  from.charges -= moved.charges;
  from.medkits -= moved.medkits;
  for (const [k, n] of Object.entries(req.pieces ?? {})) {
    const kind = k as PieceKind;
    from.pieces[kind] = (from.pieces[kind] ?? 0) - (n ?? 0);
    if (from.pieces[kind] === 0) delete from.pieces[kind];
    moved.pieces[kind] = n ?? 0;
  }
  for (const [k, n] of Object.entries(req.potions ?? {})) {
    const kind = k as PotionKind;
    from.potions[kind] = (from.potions[kind] ?? 0) - (n ?? 0);
    if (from.potions[kind] === 0) delete from.potions[kind];
    moved.potions[kind] = n ?? 0;
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
  if (wd && !withdrawFits(player, dep, wd)) return fail('Hotbar full');
  if (dep) move(player.inv, player.vault, dep);
  removeIfEmpty(player.hotbar, player.inv);
  if (wd) move(player.vault, player.inv, wd);
  syncFromInventory(player.hotbar, player.inv);
  if (!player.inv.weapons[player.equipped] && player.equipped !== 'fists') player.equipped = 'fists';
  return { ok: true };
}

/** Kinds a vault request names with a nonzero amount. */
function kindsIn(req: Partial<Inventory>): HotbarItem[] {
  const out: HotbarItem[] = [];
  for (const k of Object.keys(req.weapons ?? {})) if (isHotbarItem(k)) out.push(k);
  for (const [k, n] of Object.entries(req.pieces ?? {})) if (n && isHotbarItem(k)) out.push(k);
  if (req.grenades) out.push('grenade');
  if (req.charges) out.push('charge');
  if (req.medkits) out.push('medkit');
  for (const [k, n] of Object.entries(req.potions ?? {})) if (n && isHotbarItem(k)) out.push(k);
  return out;
}

/** Whether every new kind a withdrawal brings in gets a hotbar slot (after the deposit frees any). */
function withdrawFits(player: PlayerState, dep: Partial<Inventory> | undefined, wd: Partial<Inventory>): boolean {
  const inv = structuredClone(player.inv);
  const bar = [...player.hotbar];
  if (dep) move(inv, emptyInventory(), dep);
  removeIfEmpty(bar, inv);
  const fresh = kindsIn(wd).filter((k) => countOf(inv, k) === 0 && !bar.includes(k));
  return fresh.length <= bar.filter((k) => k === null).length;
}

export function mergeInventory(into: Inventory, from: Inventory): void {
  into.cash += from.cash;
  into.grenades += from.grenades;
  into.charges += from.charges;
  into.medkits += from.medkits;
  for (const [k, n] of Object.entries(from.potions ?? {})) {
    const kind = k as PotionKind;
    into.potions[kind] = (into.potions[kind] ?? 0) + (n ?? 0);
  }
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

/** Starts using a medkit from the selected slot: consumes it now, heals when the use time is up. */
export function startMedkit(player: PlayerState, now: number): Result {
  if (!player.alive) return fail('dead');
  if (player.hotbar[player.selected] !== 'medkit') return fail('select a medkit first');
  if (player.inv.medkits <= 0) return fail('no medkits');
  if (now < player.busyUntil) return fail('busy');
  if (player.hp >= PLAYER.hp) return fail('already at full health');
  player.inv.medkits -= 1;
  removeIfEmpty(player.hotbar, player.inv);
  player.healAt = now + MEDKIT.useSec;
  player.busyUntil = player.healAt;
  return { ok: true };
}

/** Applies a finished medkit heal (capped at full health). */
export function tickHealing(player: PlayerState, now: number): void {
  if (player.healAt === null || now < player.healAt) return;
  player.healAt = null;
  if (player.alive) player.hp = Math.min(PLAYER.hp, player.hp + MEDKIT.heal);
}
