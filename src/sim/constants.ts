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

/** Spread cone half-angles in degrees. Bloom grows per shot and recovers at `recover` deg/s. */
export type SpreadSpec = {
  base: number; ads: number; perShot: number; max: number; recover: number;
  /** Added at full walk speed (scaled by speed), while sprinting, and while airborne. */
  move: number; sprint: number; air: number;
};
/** Recoil per shot in degrees: `up` climbs (growing by `upGrow` per shot of a burst, capped at 10 shots), `side` jitters around `sideBias`. */
export type RecoilSpec = { up: number; upGrow: number; side: number; sideBias: number };

export type WeaponSpec = {
  price: number; dmg: number; pellets: number; rps: number; mag: number;
  /** Tactical reload (rounds left); `reloadEmptySec` when empty (the bolt/slide has to be worked). Shotgun: per shell. */
  reloadSec: number; reloadEmptySec: number;
  /** A tactical reload keeps a round in the chamber: mag + 1. */
  chamber: boolean;
  range: number;
  /** Full damage to `start` m, linear down to `minMult` at `end` m and beyond. */
  falloff: { start: number; end: number; minMult: number };
  spread: SpreadSpec;
  recoil: RecoilSpec;
  /** Aim-down-sights: FOV zoom factor and move-speed multiplier. */
  adsZoom: number; adsMove: number;
};

const NO_SPREAD: SpreadSpec = { base: 0, ads: 0, perShot: 0, max: 0, recover: 1, move: 0, sprint: 0, air: 0 };
const NO_FALLOFF = { start: 1e9, end: 1e9 + 1, minMult: 1 };

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  fists: {
    price: 0, dmg: 10, pellets: 1, rps: 2, mag: Infinity, reloadSec: 0, reloadEmptySec: 0, chamber: false, range: 2,
    falloff: NO_FALLOFF, spread: NO_SPREAD, recoil: { up: 0, upGrow: 0, side: 0, sideBias: 0 }, adsZoom: 1, adsMove: 1,
  },
  pistol: {
    price: 50, dmg: 20, pellets: 1, rps: 4, mag: 12, reloadSec: 1.5, reloadEmptySec: 1.9, chamber: true, range: 60,
    falloff: { start: 15, end: 45, minMult: 0.6 },
    spread: { base: 0.8, ads: 0.3, perShot: 0.9, max: 4, recover: 9, move: 1.4, sprint: 3, air: 5 },
    recoil: { up: 1.3, upGrow: 0, side: 0.35, sideBias: 0 }, adsZoom: 1.3, adsMove: 0.75,
  },
  smg: {
    price: 150, dmg: 12, pellets: 1, rps: 11, mag: 30, reloadSec: 2.0, reloadEmptySec: 2.5, chamber: true, range: 45,
    falloff: { start: 10, end: 35, minMult: 0.5 },
    spread: { base: 1.5, ads: 0.7, perShot: 0.3, max: 4.5, recover: 10, move: 1.0, sprint: 2.5, air: 4 },
    recoil: { up: 0.42, upGrow: 0.04, side: 0.32, sideBias: -0.1 }, adsZoom: 1.35, adsMove: 0.8,
  },
  shotgun: {
    // Tube-fed: loads shell by shell (reloadTime), so no chamber bonus.
    price: 200, dmg: 9, pellets: 10, rps: 1.1, mag: 6, reloadSec: 0.45, reloadEmptySec: 0.45, chamber: false, range: 30,
    falloff: { start: 6, end: 22, minMult: 0.2 },
    spread: { base: 0.5, ads: 0.25, perShot: 1.0, max: 3, recover: 4, move: 0.8, sprint: 2, air: 3 },
    recoil: { up: 4.2, upGrow: 0, side: 1.0, sideBias: 0 }, adsZoom: 1.2, adsMove: 0.75,
  },
  rifle: {
    price: 300, dmg: 30, pellets: 1, rps: 6, mag: 25, reloadSec: 2.3, reloadEmptySec: 2.8, chamber: true, range: 150,
    falloff: { start: 60, end: 150, minMult: 0.85 },
    spread: { base: 2.2, ads: 0.12, perShot: 0.5, max: 5, recover: 7, move: 2.5, sprint: 5, air: 7 },
    recoil: { up: 0.75, upGrow: 0.05, side: 0.4, sideBias: 0.15 }, adsZoom: 2, adsMove: 0.6,
  },
  rocket: {
    // dmg = blast damage at the centre (see ROCKET); the projectile does the work.
    price: 500, dmg: 110, pellets: 1, rps: 1, mag: 1, reloadSec: 3, reloadEmptySec: 3, chamber: false, range: 150,
    falloff: NO_FALLOFF,
    spread: { base: 0.6, ads: 0.2, perShot: 0, max: 0, recover: 1, move: 1.5, sprint: 3, air: 4 },
    recoil: { up: 3.5, upGrow: 0, side: 0.6, sideBias: 0 }, adsZoom: 1.5, adsMove: 0.65,
  },
};
export const SPARE_MAGS_ON_BUY = 3;
/** Ammo box: `mags` magazines for the gun in hand; rockets come `rockets` per box at `rocketPrice`. */
export const AMMO_BOX = { price: 20, mags: 2, rocketPrice: 75, rockets: 1 };
/** Shotgun pellet ring (deg) around the shot direction, hip / aimed. */
export const SHOTGUN_SPREAD_DEG = 4.5;
export const SHOTGUN_ADS_SPREAD_DEG = 3.2;
/** Head sphere: centre above the feet and radius (m). Headshots do `mult` damage. */
export const HEAD = { y: 1.62, r: 0.18, mult: 2 };
/** A burst (recoil climb) resets once this long has passed after the gun could fire again. */
export const BURST_RESET_SEC = 0.2;

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
/**
 * Rocket: slow projectile, explodes on contact or after `fuseSec`. Player damage falls off with distance
 * to the body (full inside `fullRadius`; self-damage at `selfMult`, so a rocket jump costs about half your
 * health); pieces take heavy explosive damage measured to their surface (a direct hit breaks steel).
 * `knock`/`knockUp` = push (m/s) at the centre.
 */
export const ROCKET = {
  speed: 35, gravity: 2.5, fuseSec: 3, radius: 4.5, fullRadius: 0.5, playerDmg: 110, selfMult: 0.5,
  pieceDmg: 1300, knock: 9, knockUp: 3.5,
};

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

/** Generator upgrade levels (index 0 = level 1, the starting generator). Price = cost to reach that level. */
export const GENERATOR_LEVELS = [
  { price: 0, rate: ECONOMY.generatorRate, cap: ECONOMY.generatorCap },
  { price: 150, rate: 8, cap: 700 },
  { price: 400, rate: 12, cap: 1000 },
  { price: 900, rate: 18, cap: 1500 },
] as const;
export const GENERATOR_MAX_LEVEL = GENERATOR_LEVELS.length;
/** Locking a gun (respawn with it) costs this many times the gun. */
export const LOCK_PRICE_MULT = 4;

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
