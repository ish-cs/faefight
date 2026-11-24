import { AMMO_BOX, CHARGE, TRAP, GENERATOR_LEVELS, GENERATOR_MAX_LEVEL, GRAPPLE, GRENADE, LOCK_PRICE_MULT, MEDKIT, PIECES, PLAYER, POTIONS, SPARE_MAGS_ON_BUY, WEAPONS } from './constants';
import { addKind, canAdd, countOf, isHotbarItem, isPotionItem, removeIfEmpty, setGrapples, syncFromInventory } from './hotbar';
import { SHOP_LABEL, shopFor, soldAt, type ShopKind } from './potions';
import type { GunKind, HotbarItem, Inventory, LockItem, PieceKind, PlayerState, PotionKind, ShopAction, ShopItem, VaultAction, WeaponKind } from './types';

export type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

/** Cash a player can spend at a shop: carried plus banked (sim/vault.ts). */
export function funds(p: PlayerState): number {
  return p.inv.cash + p.vault.cash;
}

/** Pays `price` from carried cash first, then the vault. The caller checks `funds` first. */
export function pay(p: PlayerState, price: number): void {
  if (price > funds(p)) throw new Error(`pay: player ${p.id} short of $${price} (has $${funds(p)})`);
  const fromInv = Math.min(p.inv.cash, price);
  p.inv.cash -= fromInv;
  p.vault.cash -= price - fromInv;
}

export function emptyInventory(): Inventory {
  return { cash: 0, weapons: {}, pieces: {}, grenades: 0, charges: 0, medkits: 0, potions: {}, traps: 0 };
}

/** Rate and cap of a generator at `level` (1..GENERATOR_MAX_LEVEL; out-of-range clamps). */
export function generatorSpec(level: number): { rate: number; cap: number } {
  return GENERATOR_LEVELS[Math.max(0, Math.min(GENERATOR_MAX_LEVEL, Math.floor(level) || 1) - 1)];
}

export function tickGenerator(stored: number, dt: number, active: boolean, level = 1): number {
  if (!active) return stored;
  const { rate, cap } = generatorSpec(level);
  return Math.min(cap, stored + rate * dt);
}

export function collect(player: PlayerState, gen: { stored: number }): number {
  const amount = Math.floor(gen.stored);
  player.inv.cash += amount;
  gen.stored -= amount;
  return amount;
}

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const;
const isGun = (k: string): k is (typeof GUNS)[number] => (GUNS as readonly string[]).includes(k);
const isPiece = (k: string): k is PieceKind => k in PIECES;

/** The gun an ammo box would fill: the one in hand, else the first gun owned. */
export function ammoTarget(player: PlayerState): Exclude<WeaponKind, 'fists'> | undefined {
  return player.equipped !== 'fists' ? player.equipped : GUNS.find((g) => player.inv.weapons[g]);
}

/** Ammo box price for that gun (rockets cost more than a box of rounds). */
export function ammoPrice(gun: WeaponKind | undefined): number {
  return gun === 'rocket' ? AMMO_BOX.rocketPrice : AMMO_BOX.price;
}

/** Rounds one ammo box adds for that gun. */
export function ammoPerBox(gun: Exclude<WeaponKind, 'fists'>): number {
  return gun === 'rocket' ? AMMO_BOX.rockets : WEAPONS[gun].mag * AMMO_BOX.mags;
}

/** The gun a `lock:<gun>` shop item locks, or null for any other item. */
export function lockedGunOf(item: ShopItem): GunKind | null {
  if (!item.startsWith('lock:')) return null;
  const g = item.slice(5);
  return isGun(g) ? g : null;
}
/** Upgrades and locks are sold only at the buyer's own island's shop. */
export const isHomeOnly = (item: ShopItem): boolean => item === 'genUpgrade' || lockedGunOf(item) !== null;
export const lockItem = (g: GunKind): LockItem => `lock:${g}`;
export const lockPrice = (g: GunKind): number => WEAPONS[g].price * LOCK_PRICE_MULT;

/** Price of the next generator level from `level`, or null at max. */
export function genUpgradePrice(level: number): number | null {
  return level >= GENERATOR_MAX_LEVEL ? null : GENERATOR_LEVELS[Math.max(1, level)].price;
}

/** Shop price; an ammo box costs what the gun it would fill takes (pass the buyer). */
export function priceOf(item: ShopAction['buy'], player?: PlayerState): number {
  const locked = lockedGunOf(item);
  if (locked) return lockPrice(locked);
  if (isPotionItem(item)) return POTIONS[item].price;
  if (isGun(item)) return WEAPONS[item].price;
  if (isPiece(item)) return PIECES[item].price;
  if (item === 'ammo') return ammoPrice(player ? ammoTarget(player) : undefined);
  if (item === 'grenade') return GRENADE.price;
  if (item === 'medkit') return MEDKIT.price;
  if (item === 'grapple') return GRAPPLE.price;
  if (item === 'trap') return TRAP.price;
  return CHARGE.price;
}

/**
 * Buys at the player's own shop. `genLevels` (generator level by island) is needed for a generator
 * upgrade, which raises the buyer's own island.
 */
export function buy(player: PlayerState, action: ShopAction, genLevels?: number[]): Result {
  const item = action.buy;
  if (item === 'genUpgrade') return upgradeGenerator(player, genLevels);
  const lockGun = lockedGunOf(item);
  if (lockGun) return lock(player, lockGun);
  const price = priceOf(item, player);
  if (funds(player) < price) return fail(`need $${price}, have $${funds(player)} (carried + vault)`);
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
    const gun = ammoTarget(player);
    const ammo = gun ? inv.weapons[gun] : undefined;
    if (!gun || !ammo) return fail('you need a gun to buy ammo');
    ammo.spare += ammoPerBox(gun);
  } else if (item === 'grenade') {
    inv.grenades += 1;
  } else if (item === 'medkit') {
    inv.medkits += 1;
  } else if (item === 'grapple') {
    setGrapples(inv, (inv.grapples ?? 0) + GRAPPLE.uses);
  } else if (item === 'trap') {
    inv.traps += 1;
  } else if (isPotionItem(item)) {
    inv.potions[item] = (inv.potions[item] ?? 0) + 1;
  } else {
    inv.charges += 1;
  }
  pay(player, price);
  if (slotKind) addKind(player.hotbar, slotKind);
  return { ok: true };
}

function upgradeGenerator(player: PlayerState, genLevels: number[] | undefined): Result {
  if (!genLevels) return fail('no generator to upgrade');
  const level = genLevels[player.island] ?? 1;
  const price = genUpgradePrice(level);
  if (price === null) return fail('generator already at max level');
  if (funds(player) < price) return fail(`need $${price}, have $${funds(player)} (carried + vault)`);
  pay(player, price);
  genLevels[player.island] = level + 1;
  return { ok: true };
}

function lock(player: PlayerState, gun: GunKind): Result {
  if (!player.inv.weapons[gun]) return fail(`buy a ${gun} before locking it`);
  if (player.locked.includes(gun)) return fail(`${gun} already locked`);
  const price = lockPrice(gun);
  if (funds(player) < price) return fail(`need $${price}, have $${funds(player)} (carried + vault)`);
  pay(player, price);
  player.locked.push(gun);
  return { ok: true };
}

/**
 * Respawn: hands back every locked gun not already held, with a full mag and one spare, into the first
 * free hotbar slots (call on an emptied hotbar so they come first). A gun with no free slot is skipped.
 */
export function grantLockedGuns(player: PlayerState): void {
  for (const g of GUNS) {
    if (!player.locked.includes(g) || player.inv.weapons[g]) continue;
    if (addKind(player.hotbar, g) < 0) {
      console.warn(`grantLockedGuns: hotbar full, player ${player.id} respawns without locked ${g}`);
      continue;
    }
    const mag = WEAPONS[g].mag;
    player.inv.weapons[g] = { mag, spare: mag };
  }
}

/**
 * Match start: everyone begins with a pistol + one spare mag (the respawn kit) selected in hand, so the
 * first click fires. Skipped if a pistol is already held or the hotbar is full.
 */
export function grantStartPistol(player: PlayerState): void {
  if (player.inv.weapons.pistol) return;
  const at = addKind(player.hotbar, 'pistol');
  if (at < 0) {
    console.warn(`grantStartPistol: hotbar full, player ${player.id} starts without a pistol`);
    return;
  }
  player.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: WEAPONS.pistol.mag };
  player.selected = at;
  player.equipped = 'pistol';
}

/**
 * Buying at a particular counter: the home shop (any island's NPC) or a potion seller each sell only
 * their own stock. `genLevels` is passed through for generator upgrades.
 */
export function buyAt(player: PlayerState, at: ShopKind, action: ShopAction, genLevels?: number[]): Result {
  const sells = shopFor(action.buy);
  if (!soldAt(action.buy, at)) return fail(`${SHOP_LABEL[action.buy] ?? action.buy} is only sold at ${sells === 'potion' ? 'the potion seller' : 'your home shop'}`);
  return buy(player, action, genLevels);
}

/** Checks `from` holds everything `req` asks for. Weapon entries in `req` are matched by key only. */
function holds(from: Inventory, req: Partial<Inventory>): string | null {
  const amounts = [req.cash, req.grenades, req.charges, req.medkits, req.traps, req.grapples, ...Object.values(req.pieces ?? {}), ...Object.values(req.potions ?? {})];
  if (amounts.some((n) => n !== undefined && (!Number.isFinite(n) || n < 0))) return 'amounts must be zero or more';
  if ((req.cash ?? 0) > from.cash) return `only $${from.cash} available`;
  if ((req.grenades ?? 0) > from.grenades) return 'not enough grenades';
  if ((req.charges ?? 0) > from.charges) return 'not enough charges';
  if ((req.medkits ?? 0) > from.medkits) return 'not enough medkits';
  if ((req.grapples ?? 0) > (from.grapples ?? 0)) return 'not enough grappling hooks';
  if ((req.traps ?? 0) > from.traps) return 'not enough traps';
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
  moved.traps = req.traps ?? 0;
  from.cash -= moved.cash;
  from.grenades -= moved.grenades;
  from.charges -= moved.charges;
  from.medkits -= moved.medkits;
  if (req.grapples) { setGrapples(moved, req.grapples); setGrapples(from, (from.grapples ?? 0) - req.grapples); }
  from.traps -= moved.traps;
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
  if (req.grapples) out.push('grapple');
  if (req.traps) out.push('trap');
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
  if (from.grapples) setGrapples(into, (into.grapples ?? 0) + from.grapples);
  into.traps += from.traps ?? 0;
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
