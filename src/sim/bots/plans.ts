import { AMMO_BOX, CHARGE, GENERATOR_MAX_LEVEL, GRAPPLE, GRENADE, MAP, MEDKIT, PIECES, TRAP, POTIONS, SEAL, WEAPONS } from '../constants';
import { ammoPrice, buy, genUpgradePrice, lockItem, lockPrice } from '../economy';
import { canAdd, countOf } from '../hotbar';
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

/** Best gun to hold at this range ('fists' if none has ammo); the shotgun inside `close` m. */
export function bestGun(inv: Inventory, range: number, close = 8): WeaponKind {
  if (range < close && hasAmmo(inv, 'shotgun')) return 'shotgun';
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
 * `grenades`/`medkits`: how many to carry.
 * `steel`: rich enough that the seal kit should be steel. `genLevel`: my generator's level (unknown = no upgrades).
 */
export type Needs = {
  /** A rival's base is wooden: worth a rocket launcher to set it on fire (medium+ bots, when rich). */
  rocket?: boolean;
  scaffolds: number; kit: number; charge: boolean; grenades?: number;
  /** Heals to carry (medkits + heal potions; HealParams stock). */
  medkits?: number; steel?: boolean; genLevel?: number;
  /** Metal plugs wanted in the kit (drive.hardKit): buy metal while fewer metal/steel than `kit`, at this many metal prices of cash (0 = no). */
  hardKit?: number;
  /** Carry a grappling hook: 'cross' (a crossing to make: bought before scaffolds), 'rich' (spare cash). */
  grapple?: 'cross' | 'rich';
  /** Spike traps to carry (on top of the ones standing). */
  traps?: number;
  /** Pieces wanted for building (fortifications, combat cover, bridge walls) on top of the seal kit. */
  build?: Partial<Record<PieceKind, number>>;
  /** Combat pieces bought right after the gun and its ammo (before bridging gear), when the cash is there. */
  combatKit?: Partial<Record<PieceKind, number>>;
  /** The rifle right after the gun's ammo, before bridging gear (strength.rifleAt, or out-ranged by a rifle). */
  rifle?: boolean;
  /** Keep a hotbar slot free for the rifle until I have one. */
  rifleSlot?: boolean;
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
  /** Buy building pieces before bridging gear (builders/turtles fortify home early). */
  buildFirst?: boolean;
};
export const PLAIN_STYLE: ShopStyle = { upgradeFirst: false, longGun: false, closeGun: false, metal: false, steel: false, coverWood: 0 };

/** Next thing worth buying right now (null = nothing, or saving up for the top priority). */
export function nextPurchase(p: PlayerState, needs: Needs, difficulty: Difficulty, style: ShopStyle = PLAIN_STYLE): ShopItem | null {
  const inv = p.inv, cash = inv.cash;
  if (!ownsGun(inv)) {
    // Guns with no ammo left still count as owned: restock instead of re-buying.
    if (GUNS.some((g) => inv.weapons[g])) return cash >= AMMO_BOX.price ? 'ammo' : null;
    return cash >= WEAPONS.pistol.price ? 'pistol' : null;
  }
  if (needs.charge && inv.charges === 0) return cash >= CHARGE.price ? 'charge' : null;
  const eq = p.equipped === 'fists' ? undefined : inv.weapons[p.equipped];
  if (eq && eq.mag + eq.spare < WEAPONS[p.equipped].mag && cash >= ammoPrice(p.equipped)) return 'ammo';
  const upgrade: ShopItem | null = inv.weapons.rifle ? null : style.longGun ? 'rifle' : inv.weapons.smg ? null : 'smg';
  if (style.upgradeFirst && upgrade) return cash >= WEAPONS[upgrade as 'smg' | 'rifle'].price ? upgrade : null;
  // Building pieces only when there's a hotbar slot for them (a full hotbar makes the shop refuse a new kind).
  // Short of heals with none slotted (and the cash for one): the last free slot is kept for a medkit.
  const healShort = cash >= MEDKIT.price && inv.medkits + (inv.potions.healPotion ?? 0) < (needs.medkits ?? 0) && !p.hotbar.includes('medkit') && !p.hotbar.includes('healPotion');
  // Hard/PRO keep a slot for the rifle until they have one (needs.rifleSlot): spoils arrive with a full hotbar otherwise.
  const rifleSlot = !!needs.rifleSlot && !inv.weapons.rifle;
  const free = p.hotbar.filter((x) => x === null).length;
  const room = (k: HotbarItem) => countOf(inv, k) > 0 ||
    (canAdd(p.hotbar, k) && free >= 1 + (healShort && k !== 'medkit' && k !== 'grapple' ? 1 : 0) + (rifleSlot && k !== 'rifle' ? 1 : 0));
  // Out-ranged (or rich enough): the rifle before anything but the gun's ammo; never saved up for.
  if (needs.rifle && !inv.weapons.rifle && room('rifle') && cash >= WEAPONS.rifle.price) return 'rifle';
  // A ramp in the pocket for fights (skilled players): cheap, never saved up for.
  for (const [k, n] of Object.entries(needs.combatKit ?? {}) as [PieceKind, number][])
    if ((inv.pieces[k] ?? 0) < n && room(k) && cash >= PIECES[k].price) return k;
  if (style.buildFirst) { const b = buildPurchase(inv, needs, room); if (b) return cash >= PIECES[b].price ? b : null; }
  // The first heal before bridging gear when the cash covers the decks too (it never holds up a crossing).
  const heals = inv.medkits + (inv.potions.healPotion ?? 0);
  const deckCost = Math.max(0, needs.scaffolds + (needs.build?.scaffold ?? 0) - (inv.pieces.scaffold ?? 0)) * PIECES.scaffold.price;
  if (heals === 0 && (needs.medkits ?? 0) > 0 && room('medkit') && cash >= MEDKIT.price + deckCost) return 'medkit';
  if (needs.grapple === 'cross' && !inv.grapples && room('grapple')) return cash >= GRAPPLE.price ? 'grapple' : null;
  if ((inv.pieces.scaffold ?? 0) < needs.scaffolds + (needs.build?.scaffold ?? 0) && room('scaffold')) return cash >= PIECES.scaffold.price ? 'scaffold' : null;
  // Otherwise right after the decks (before the seal kit): a strong player never heads out without one.
  if (heals === 0 && (needs.medkits ?? 0) > 0 && room('medkit') && cash >= MEDKIT.price) return 'medkit';
  if (sealKit(inv) - reservedBagPlugs(inv, needs) < needs.kit) {
    // (A kind the hotbar has no room for is skipped: the shop would refuse it.)
    if ((style.steel || needs.steel) && cash >= 2 * PIECES.steel.price && room('steel')) return 'steel';
    const skilled = difficulty === 'hard' || difficulty === 'pro';
    const wantMetal = skilled ? cash >= PIECES.metal.price
      : (difficulty === 'medium' || style.metal) && cash >= 2 * PIECES.metal.price;
    if (wantMetal && room('metal')) return 'metal';
    if (room('wood')) return cash >= PIECES.wood.price ? 'wood' : null;
  }
  // A kit of wood/sandbags gets shot out by the respawned owner: swap in metal plugs when the cash is there.
  const hardPlugs = (inv.pieces.metal ?? 0) + (inv.pieces.steel ?? 0);
  if (needs.hardKit && hardPlugs < needs.kit && cash >= needs.hardKit * PIECES.metal.price && room('metal')) return 'metal';
  // The rest of the heal stock right after the seal kit.
  if (heals < (needs.medkits ?? 0) && room('medkit') && cash >= MEDKIT.price) return 'medkit';
  { const b = buildPurchase(inv, needs, room); if (b) return cash >= PIECES[b].price ? b : null; }
  const genPrice = genUpgradePrice(needs.genLevel ?? GENERATOR_MAX_LEVEL);
  if (style.invest && genPrice !== null && cash >= genPrice + WEAPONS.smg.price) return 'genUpgrade';
  if (!inv.weapons.smg && !inv.weapons.rifle && !style.longGun && room('smg') && cash >= WEAPONS.smg.price) return 'smg';
  if (!inv.weapons.rifle && room('rifle') && cash >= WEAPONS.rifle.price) return 'rifle';
  if (needs.grapple && !inv.grapples && room('grapple')) return cash >= GRAPPLE.price ? 'grapple' : null;
  if (needs.rocket && !inv.weapons.rocket && canAdd(p.hotbar, 'rocket') && cash >= WEAPONS.rocket.price + 200) return 'rocket';
  // Extras only when there's a hotbar slot for them (a full hotbar makes the shop refuse: retrying every tick).
  if (inv.grenades < (needs.grenades ?? 0) && room('grenade')) return cash >= GRENADE.price ? 'grenade' : null;
  // Spike traps for my doorways: never saved up for (nice to have, not essential).
  if (inv.traps < (needs.traps ?? 0) && room('trap') && cash >= TRAP.price) return 'trap';
  if (style.closeGun && !inv.weapons.shotgun && room('shotgun') && cash >= WEAPONS.shotgun.price) return 'shotgun';
  const tall = TALL.reduce((n, k) => n + (inv.pieces[k] ?? 0), 0);
  if (tall < needs.kit + style.coverWood && room('wood') && cash >= PIECES.wood.price) return 'wood';
  // Rich: invest in the generator, then lock the favourite gun so a death doesn't leave me unarmed.
  if (genPrice !== null && cash >= 3 * genPrice) return 'genUpgrade';
  const fav = GUNS.find((g) => inv.weapons[g]);
  if (fav && !p.locked.includes(fav) && cash >= 2 * lockPrice(fav)) return lockItem(fav);
  return null;
}

/** Sandbags held for building that the seal-kit count must not lean on. */
function reservedBagPlugs(inv: Inventory, needs: Needs): number {
  const bags = inv.pieces.sandbags ?? 0;
  const reserved = Math.min(bags, (needs.build?.sandbags ?? 0));
  return Math.floor(bags / 2) - Math.floor((bags - reserved) / 2);
}

/** Next building piece to buy (batch: everything the build list still lacks), or null when it's all carried. */
function buildPurchase(inv: Inventory, needs: Needs, room: (k: PieceKind) => boolean): PieceKind | null {
  const b = needs.build;
  if (!b) return null;
  if ((inv.pieces.sandbags ?? 0) < (b.sandbags ?? 0) && room('sandbags')) return 'sandbags';
  if ((inv.pieces.ramp ?? 0) < (b.ramp ?? 0) && room('ramp')) return 'ramp';
  if ((inv.pieces.scaffold ?? 0) < needs.scaffolds + (b.scaffold ?? 0)) return 'scaffold';
  // Tall pieces: the seal kit comes out of them first.
  const spare = TALL.reduce((n, k) => n + (inv.pieces[k] ?? 0), 0) - needs.kit;
  if (spare < (b.metal ?? 0) + (b.wood ?? 0)) {
    const k = (inv.pieces.metal ?? 0) < (b.metal ?? 0) ? 'metal' : 'wood';
    if (room(k)) return k;
  }
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
      console.warn(`shoppingPlan: chose ${item} but buy failed: ${r.reason}`);
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
/** Hotbar slots a new potion kind must leave open. */
const POTION_FREE_SLOTS = 2;

/**
 * Bots value shields: at a potion seller they stock up on shield potions with spare cash, and out of
 * combat (no enemy in sight) they drink one whenever it would help, so they walk into the next fight
 * shielded. Returns the hotbar slot to drink from, or a potion to buy, or null.
 */
export function potionAction(p: PlayerState, now: number, enemyInSight: boolean, atSeller: boolean, healWant = 0): { drink: number } | { buy: PotionKind } | null {
  if (!p.alive) return null;
  if (atSeller) {
    // Heal potions toward the heal stock (they count with medkits), then shields. A new potion kind takes a slot only
    // while POTION_FREE_SLOTS more stay open (scaffolds, guns), and one shield kind at a time: potions must never clog
    // the hotbar (a full one can't take the decks to reach anyone). The first heal of all may take any free slot.
    const free = p.hotbar.filter((k) => k === null).length;
    const heals = p.inv.medkits + countOf(p.inv, 'healPotion');
    if (heals < healWant && p.inv.cash >= POTIONS.healPotion.price + POTION_RESERVE &&
      (countOf(p.inv, 'healPotion') > 0 || free > POTION_FREE_SLOTS || (heals === 0 && free > 0))) return { buy: 'healPotion' };
    for (const kind of ['shieldBig', 'shieldSmall'] as const) {
      if (countOf(p.inv, kind) >= SHIELD_STOCK || p.inv.cash < POTIONS[kind].price + POTION_RESERVE) continue;
      const other = kind === 'shieldBig' ? 'shieldSmall' : 'shieldBig';
      if (countOf(p.inv, kind) === 0 && (free <= POTION_FREE_SLOTS || countOf(p.inv, other) > 0)) continue;
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
