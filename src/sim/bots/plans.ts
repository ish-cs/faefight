import { AMMO_BOX, CHARGE, GENERATOR_MAX_LEVEL, GRENADE, MAP, MEDKIT, PIECES, POTIONS, SEAL, WEAPONS } from '../constants';
import { buy, genUpgradePrice, lockItem, lockPrice } from '../economy';
import { HOTBAR_ITEMS, canAdd, countOf, takeOut } from '../hotbar';
import { uselessReason } from '../potions';
import type { Doorway } from '../map';
import type { Difficulty, HotbarItem, Inventory, PieceKind, PieceState, PlayerState, PotionKind, ShopItem, Vec3, WeaponKind } from '../types';
import { add, dist2D, forward, scale, v3 } from '../vec';

export const GUNS: Exclude<WeaponKind, 'fists'>[] = ['rifle', 'smg', 'pistol', 'shotgun'];
/** Pieces tall enough to plug a doorway alone, strongest first. */
export const TALL: PieceKind[] = ['steel', 'metal', 'wood'];
const HARD: PieceKind[] = ['metal', 'steel', 'container'];
const NON_BLOCKING: PieceKind[] = ['scaffold', 'ramp'];

const WALL_HALF = MAP.bunker.wall / 2;

export const hasAmmo = (inv: Inventory, g: WeaponKind) => {
  const a = inv.weapons[g];
  return g !== 'fists' && !!a && a.mag + a.spare > 0;
};
export const ownsGun = (inv: Inventory) => GUNS.some((g) => hasAmmo(inv, g));
export const isHard = (kind: PieceKind) => HARD.includes(kind);

/** Best gun to hold at this range ('fists' if none has ammo). */
export function bestGun(inv: Inventory, range: number): WeaponKind {
  if (range < 8 && hasAmmo(inv, 'shotgun')) return 'shotgun';
  return GUNS.find((g) => hasAmmo(inv, g)) ?? 'fists';
}

/** How many doorways the carried pieces can plug (two sandbags stack to one). */
export const sealKit = (inv: Inventory) =>
  TALL.reduce((n, k) => n + (inv.pieces[k] ?? 0), 0) + Math.floor((inv.pieces.sandbags ?? 0) / 2);

/** Where a piece spanning `door` sits: just outside the wall, rotated to the doorway. */
export function plugSpot(door: Doorway, kind: PieceKind, level: number): Vec3 {
  const p = add(door.center, scale(forward(door.yaw), WALL_HALF + PIECES[kind].d / 2 + 0.05));
  return v3(p.x, door.center.y + level, p.z);
}

const plugZone = (door: Doorway) => add(door.center, scale(forward(door.yaw), 0.4));

/** Pieces in front of a doorway that could stand in a player's way, highest first. */
export function doorPieces(pieces: PieceState[], door: Doorway): PieceState[] {
  const z = plugZone(door);
  return pieces
    .filter((p) => !NON_BLOCKING.includes(p.kind) && dist2D(p.pos, z) <= (p.kind === 'container' ? 1.8 : 1.0))
    .sort((a, b) => b.pos.y - a.pos.y);
}

export const doorBlocked = (pieces: PieceState[], door: Doorway) =>
  doorPieces(pieces, door).some((p) => p.pos.y - door.center.y + PIECES[p.kind].h >= SEAL.blockHeight);

/** Which carried piece to put in this doorway next, and at what height (a second sandbag goes on top of the first). */
export function plugFor(inv: Inventory, pieces: PieceState[], door: Doorway): { kind: PieceKind; level: number } | null {
  const tall = TALL.find((k) => (inv.pieces[k] ?? 0) > 0);
  if (tall) return { kind: tall, level: 0 };
  const bags = inv.pieces.sandbags ?? 0;
  const base = doorPieces(pieces, door).find((p) => p.kind === 'sandbags' && Math.abs(p.pos.y - door.center.y) < 0.2);
  if (base && bags >= 1) return { kind: 'sandbags', level: PIECES.sandbags.h };
  return bags >= 2 ? { kind: 'sandbags', level: 0 } : null;
}

/**
 * `tower`: sandbags wanted for climbing above the sudden-death tide. `grenades`/`medkits`: how many to carry.
 * `steel`: rich enough that the seal kit should be steel. `genLevel`: my generator's level (unknown = no upgrades).
 */
export type Needs = {
  scaffolds: number; kit: number; charge: boolean; tower?: number; grenades?: number; medkits?: number; steel?: boolean; genLevel?: number;
};

/** Personal shopping taste (from personality): order and materials, never what is allowed. */
export type ShopStyle = {
  /** Buy the gun upgrade before bridging gear. */
  upgradeFirst: boolean;
  /** Go straight for the rifle (skip the SMG). */
  longGun: boolean;
  /** Add a shotgun for close quarters. */
  closeGun: boolean;
  /** Prefer metal plugs even when it means fewer spare dollars. */
  metal: boolean;
  /** Prefer steel plugs when rich. */
  steel: boolean;
  /** Extra wood walls carried for throwing down cover. */
  coverWood: number;
  /** Upgrade the generator as soon as the essentials are covered (economists, turtles). */
  invest?: boolean;
};
export const PLAIN_STYLE: ShopStyle = { upgradeFirst: false, longGun: false, closeGun: false, metal: false, steel: false, coverWood: 0 };

/** The hotbar item a purchase lands in (null for ammo, generator upgrades, locks). */
const slotItem = (item: ShopItem): HotbarItem | null => ((HOTBAR_ITEMS as readonly string[]).includes(item) ? (item as HotbarItem) : null);

/** Is there room on the hotbar for this purchase (a free slot, or a stack it joins)? */
export function fits(p: PlayerState, item: ShopItem): boolean {
  const k = slotItem(item);
  return !k || canAdd(p.hotbar, k);
}

/**
 * The hotbar slot I can best afford to give up to make room for `want` (dropped like a human clears a slot):
 * a pistol once I have a better gun, a shotgun, ramps/containers, speed/heal potions, grenades, medkits.
 * -1 when everything held matters more.
 */
export function junkSlot(p: PlayerState, want: ShopItem): number {
  const inv = p.inv;
  const better = !!(inv.weapons.smg || inv.weapons.rifle);
  const order: HotbarItem[] = [
    ...(better ? ['pistol' as const] : []), ...(better || inv.weapons.pistol ? ['shotgun' as const] : []),
    'ramp', 'container', 'speedPotion', 'healPotion', 'grenade', 'medkit',
  ];
  for (const k of order) {
    if (k === want) continue;
    const slot = p.hotbar.indexOf(k);
    if (slot >= 0) return slot;
  }
  return -1;
}

/**
 * Next thing worth buying right now (null = nothing, or saving up for the top priority). Optional stock
 * (medkits, grenades, a shotgun, spare cover) is only bought when there's room on the hotbar for it.
 */
export function nextPurchase(p: PlayerState, needs: Needs, difficulty: Difficulty, style: ShopStyle = PLAIN_STYLE): ShopItem | null {
  const n = { ...needs };
  if (!fits(p, 'medkit')) n.medkits = 0;
  if (!fits(p, 'grenade')) n.grenades = 0;
  const st = { ...style };
  if (!fits(p, 'shotgun')) st.closeGun = false;
  if (!fits(p, 'wood')) st.coverWood = 0;
  return choosePurchase(p, n, difficulty, st);
}

function choosePurchase(p: PlayerState, needs: Needs, difficulty: Difficulty, style: ShopStyle): ShopItem | null {
  const inv = p.inv, cash = inv.cash;
  if (!ownsGun(inv)) {
    // Guns with no ammo left still count as owned: restock instead of re-buying.
    if (GUNS.some((g) => inv.weapons[g])) return cash >= AMMO_BOX.price ? 'ammo' : null;
    return cash >= WEAPONS.pistol.price ? 'pistol' : null;
  }
  if (needs.charge && inv.charges === 0) return cash >= CHARGE.price ? 'charge' : null;
  if ((inv.pieces.sandbags ?? 0) < (needs.tower ?? 0)) return cash >= PIECES.sandbags.price ? 'sandbags' : null;
  const eq = p.equipped === 'fists' ? undefined : inv.weapons[p.equipped];
  if (eq && eq.mag + eq.spare < WEAPONS[p.equipped].mag && cash >= 20) return 'ammo';
  const upgrade: ShopItem | null = inv.weapons.rifle ? null : style.longGun ? 'rifle' : inv.weapons.smg ? null : 'smg';
  if (style.upgradeFirst && upgrade) return cash >= WEAPONS[upgrade as 'smg' | 'rifle'].price ? upgrade : null;
  if ((inv.pieces.scaffold ?? 0) < needs.scaffolds) return cash >= PIECES.scaffold.price ? 'scaffold' : null;
  if (sealKit(inv) < needs.kit) {
    if ((style.steel || needs.steel) && cash >= 2 * PIECES.steel.price) return 'steel';
    const skilled = difficulty === 'hard' || difficulty === 'pro';
    const wantMetal = skilled ? cash >= PIECES.metal.price
      : (difficulty === 'medium' || style.metal) && cash >= 2 * PIECES.metal.price;
    if (wantMetal) return 'metal';
    return cash >= PIECES.wood.price ? 'wood' : null;
  }
  const genPrice = genUpgradePrice(needs.genLevel ?? GENERATOR_MAX_LEVEL);
  if (style.invest && genPrice !== null && cash >= genPrice + WEAPONS.smg.price) return 'genUpgrade';
  if (!inv.weapons.smg && !inv.weapons.rifle && !style.longGun && cash >= WEAPONS.smg.price) return 'smg';
  if (!inv.weapons.rifle && cash >= WEAPONS.rifle.price) return 'rifle';
  if (inv.grenades < (needs.grenades ?? 0)) return cash >= GRENADE.price ? 'grenade' : null;
  if (inv.medkits < (needs.medkits ?? 0)) return cash >= MEDKIT.price ? 'medkit' : null;
  if (style.closeGun && !inv.weapons.shotgun && cash >= WEAPONS.shotgun.price) return 'shotgun';
  const tall = TALL.reduce((n, k) => n + (inv.pieces[k] ?? 0), 0);
  if (tall < needs.kit + style.coverWood && cash >= PIECES.wood.price) return 'wood';
  // Rich: invest in the generator, then lock the favourite gun so a death doesn't leave me unarmed.
  if (genPrice !== null && cash >= 3 * genPrice) return 'genUpgrade';
  const fav = GUNS.find((g) => inv.weapons[g]);
  if (fav && !p.locked.includes(fav) && cash >= 2 * lockPrice(fav)) return lockItem(fav);
  return null;
}

const ESSENTIAL: ShopItem[] = ['pistol', 'charge', 'ammo', 'scaffold', 'metal', 'wood'];

/** Purchases affordable now in order, what they cost, and whether they cover every essential need. */
export function shoppingPlan(
  p: PlayerState, needs: Needs, difficulty: Difficulty, style: ShopStyle = PLAIN_STYLE,
): { items: ShopItem[]; covered: boolean; spent: number } {
  const sim = structuredClone(p);
  const items: ShopItem[] = [];
  const n = { ...needs };
  const levels: number[] = [];
  for (let i = 0; i < 30; i++) {
    levels[p.island] = n.genLevel ?? GENERATOR_MAX_LEVEL;
    const item = nextPurchase(sim, n, difficulty, style);
    if (!item) break;
    const r = buy(sim, { buy: item }, levels);
    n.genLevel = levels[p.island];
    if (!r.ok) {
      // Essentials with a full hotbar: plan on dropping junk first (the bot does that at the shop), else stop.
      const j = fits(sim, item) ? -1 : junkSlot(sim, item);
      if (j >= 0) {
        takeOut(sim.inv, sim.hotbar[j]!, 'stack');
        sim.hotbar[j] = null;
        i--;
        continue;
      }
      if (fits(sim, item)) console.warn(`shoppingPlan: chose ${item} but buy failed: ${r.reason}`);
      break;
    }
    items.push(item);
  }
  const spent = p.inv.cash - sim.inv.cash;
  sim.inv.cash = Infinity;
  const left = nextPurchase(sim, n, difficulty, style);
  return { items, covered: left === null || !ESSENTIAL.includes(left), spent };
}

/** Cash a bot keeps back from potion shopping (for guns, ammo and seal kit). */
export const POTION_RESERVE = 150;
const SHIELD_STOCK = 2;

/**
 * Bots value shields: at a potion seller they stock up on shield potions with spare cash, and out of
 * combat (no enemy in sight) they drink one whenever it would help, so they walk into the next fight
 * shielded. Returns the hotbar slot to drink from, or a potion to buy, or null.
 */
export function potionAction(p: PlayerState, now: number, enemyInSight: boolean, atSeller: boolean): { drink: number } | { buy: PotionKind } | null {
  if (!p.alive) return null;
  if (atSeller) {
    for (const kind of ['shieldBig', 'shieldSmall'] as const) {
      if (countOf(p.inv, kind) >= SHIELD_STOCK || p.inv.cash < POTIONS[kind].price + POTION_RESERVE) continue;
      if (countOf(p.inv, kind) === 0 && !canAdd(p.hotbar, kind)) continue;
      return { buy: kind };
    }
  }
  if (enemyInSight || p.drinking || now < p.busyUntil) return null;
  const order: PotionKind[] = ['shieldBig', 'shieldSmall', ...(p.hp <= 60 ? ['healPotion' as const] : [])];
  for (const kind of order) {
    const slot = p.hotbar.indexOf(kind);
    if (slot >= 0 && countOf(p.inv, kind) > 0 && !uselessReason(p, kind, now)) return { drink: slot };
  }
  return null;
}
