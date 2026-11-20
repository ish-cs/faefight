import type { PieceKind, PotionKind, WeaponKind } from './types';

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

export const PLAYER = {
  hp: 100,
  radius: 0.35,
  height: 1.8,
  eyeHeight: 1.6,
  walk: 5,
  sprint: 7.5,
  jumpVelocity: 4.6,
  gravity: 9.81,
};

export type PieceSpec = { w: number; h: number; d: number; hp: number; price: number; placeSec: number };

// w = width along local X, h = height, d = depth along local Z. Ramp rises along local +Z.
export const PIECES: Record<PieceKind, PieceSpec> = {
  sandbags: { w: 2, h: 1.0, d: 0.8, hp: 150, price: 10, placeSec: 0.5 },
  wood: { w: 2, h: 2.0, d: 0.2, hp: 250, price: 25, placeSec: 0.8 },
  metal: { w: 2, h: 2.5, d: 0.1, hp: 500, price: 60, placeSec: 1.2 },
  steel: { w: 2, h: 2.5, d: 0.15, hp: 1200, price: 150, placeSec: 2.0 },
  scaffold: { w: 2, h: 0.2, d: 4, hp: 200, price: 20, placeSec: 0.6 },
  ramp: { w: 2, h: 1.5, d: 3, hp: 200, price: 30, placeSec: 0.8 },
  container: { w: 6, h: 2.6, d: 2.4, hp: 2500, price: 300, placeSec: 3.0 },
};

export type WeaponSpec = {
  price: number; dmg: number; pellets: number; rps: number; mag: number; reloadSec: number; range: number;
};

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  fists: { price: 0, dmg: 10, pellets: 1, rps: 2, mag: Infinity, reloadSec: 0, range: 2 },
  pistol: { price: 50, dmg: 20, pellets: 1, rps: 3, mag: 12, reloadSec: 1.2, range: 60 },
  smg: { price: 150, dmg: 12, pellets: 1, rps: 10, mag: 30, reloadSec: 1.8, range: 40 },
  shotgun: { price: 200, dmg: 8, pellets: 10, rps: 1.2, mag: 6, reloadSec: 2.5, range: 20 },
  rifle: { price: 300, dmg: 30, pellets: 1, rps: 5, mag: 25, reloadSec: 2.2, range: 120 },
};
export const SPARE_MAGS_ON_BUY = 3;
export const AMMO_BOX = { price: 20, mags: 2 };
export const SHOTGUN_SPREAD_DEG = 4;

export const GRENADE = { price: 100, dmg: 100, radius: 4, fuseSec: 2.5, throwSpeed: 14 };
export const MEDKIT = { price: 75, heal: 50, useSec: 2 };
/** Shield sits on top of health (blue bar). */
export const SHIELD_MAX = 100;
export const POTIONS: Record<PotionKind, { price: number; useSec: number }> = {
  shieldSmall: { price: 50, useSec: 1 },
  shieldBig: { price: 100, useSec: 2 },
  healPotion: { price: 60, useSec: 1 },
  speedPotion: { price: 120, useSec: 1 },
};
/** Small shields only top you up to 50; big ones go to 100 (the usual shooter rule). */
export const SHIELD_POTIONS = { shieldSmall: { amount: 25, cap: 50 }, shieldBig: { amount: 50, cap: 100 } } as const;
export const HEAL_POTION = { amount: 40, overSec: 4 };
export const SPEED_POTION = { mult: 1.3, sec: 15 };
export const CHARGE = { price: 250, pieceDmg: 1500, radius: 2, playerRadius: 1, playerDmg: 100, fuseSec: 3 };

export type DamageSource = 'bullet' | 'fist' | 'explosive';
export const PIECE_DMG_MULT: Record<PieceKind, { bullet: number; fist: number }> = {
  sandbags: { bullet: 0.5, fist: 0.5 },
  wood: { bullet: 0.7, fist: 0.7 },
  metal: { bullet: 0.3, fist: 0 },
  steel: { bullet: 0.1, fist: 0 },
  scaffold: { bullet: 0.5, fist: 0.5 },
  ramp: { bullet: 0.5, fist: 0.5 },
  container: { bullet: 0.1, fist: 0 },
};

export const ECONOMY = {
  generatorRate: 5,
  generatorCap: 500,
  startCash: 50,
  interactRadius: 2.5,
  vaultSec: 1,
};

export const BUILD = { gridStep: 0.5, rotStepDeg: 15, reach: 5 };

export const LIFECYCLE = {
  respawnSec: 3,
  /** Respawning into a sealed bunker: break out within this long or you're eliminated. */
  breakoutSec: 10,
  invulnSec: 3,
  suddenDeathAt: 900,
  tideRate: 0.05,
  lootPickupRadius: 1.5,
  /** Dropped items land this far in front of you (just past pickup reach)... */
  dropAhead: 1.8,
  /** ...and you can't pick your own drop back up for this long. */
  dropPickupDelaySec: 1.5,
  regenDelaySec: 8,
  regenPerSec: 1,
  /** Landing faster than this (m/s, ≈3 m drop) hurts; damage per m/s above it. */
  safeFallSpeed: 8,
  fallDmgPerSpeed: 8,
};

export const SEAL = { cell: 0.25, half: 8, blockHeight: 1.3, exitRadius: 4 };

export const MAP = {
  islandRadius: 22,
  groundY: 2,
  waterY: 0,
  gap: 36,
  bunker: { interior: 4, wall: 0.3, height: 2.6, doorWidth: 1.6, doorHeight: 2.2 },
};
