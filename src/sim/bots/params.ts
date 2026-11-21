import { PIECES } from '../constants';
import type { Difficulty } from '../types';

/**
 * Tunable bot strategy (drive to win, building, the elimination pipeline), in one record so self-play training can
 * search over it. A Bot takes a BotParams (default DEFAULT_BOT_PARAMS); `flattenParams` / `withParams` give the
 * trainer flat numeric keys like `drive.push.pro`, `buildSkill.hard.coverChance` or `buildTuning.coverScore`.
 * Execution skill (reaction, aim, decision speed) is not here: it stays in aim.ts / bot.ts.
 */

const D = <T>(easy: T, medium: T, hard: T, pro: T): Record<Difficulty, T> => ({ easy, medium, hard, pro });

/**
 * Drive to win (Medium/Hard/PRO; easy players stay calmer).
 * - offenseAt / offenseCash: from this time, or once this much money (carried + banked) is in hand with a gun,
 *   the bot is on an offensive plan: buy bridge + walls, cross, fight to the bunker, seal.
 * - push: added to bridge/attack/seal scores while on offense; shopForPush: shop score when the plan buys push gear.
 * - plinkRange: past this a fight across water isn't worth a goal (shots still go out in passing); on the same
 *   island the bot closes in instead (maxRange caps its preferred range, sprinting while the gap is > sprintGap).
 * - reengageSec: a retreat (disengage/heal) lasts at most this long unless I'm still being hit or very low.
 * - guardFreshSec: guarding home only for an intruder seen on my island this recently.
 * - collectCarried: once carrying what the push needs, the generator only matters past this much cash.
 * Elimination pipeline:
 * - steelRich: cash (carried + banked) from which Hard/PRO carry a steel seal kit (a respawn pistol can't break it).
 * - sealAway: seal bonus for a rival seen away from home, or not seen on their island for emptyHomeSec while I'm
 *   on it (their bunker is empty); sealAwayTarget: rival-choice
 *   bonus for such a rival while I carry a full kit and can walk to their island.
 * - sealRaceM: a rival who just died with their open bunker within this many metres is worth dropping all for.
 * - siegeDist: camping a sealed bunker this far out from its weakest doorway; siegeAfterDeath: how long after the
 *   owner's death the camp holds without seeing them; siegeScore: attack score while camping.
 * - stallSec / stallDist / stallBanSec: goal watchdog (a goal with no progress for stallSec is dropped for
 *   stallBanSec; moving stallDist counts as progress).
 */
export type DriveParams = {
  offenseAt: Record<Difficulty, number>;
  offenseCash: Record<Difficulty, number>;
  push: Record<Difficulty, number>;
  shopForPush: number;
  plinkRange: number;
  maxRange: Record<Difficulty, number>;
  sprintGap: number;
  reengageSec: number;
  reengageHp: number;
  guardFreshSec: number;
  collectCarried: number;
  steelRich: number;
  sealAway: number;
  sealAwayTarget: number;
  emptyHomeSec: number;
  sealRaceM: number;
  siegeDist: number;
  siegeAfterDeath: number;
  siegeScore: number;
  stallSec: number;
  stallDist: number;
  stallBanSec: number;
};

/**
 * How well a player of each skill builds. Same moves for everyone; better players see the need sooner, do it more
 * often, place cleaner and chain pieces with less dithering.
 * - coverChance: odds of throwing down a wall when shot at in the open (before personality).
 * - coverDelay: seconds from the first hit to starting the wall (noticing + choosing the piece).
 * - gap: extra pause between two pieces of a sequence (PRO chains them back to back).
 * - misplace: odds a piece goes somewhere silly (off to the side, skewed).
 * - fort: share of the home fortification plan this player bothers with (before personality).
 * - peekHide / peekOut: seconds behind cover and out shooting when peeking.
 */
export type BuildSkill = {
  coverChance: number; coverDelay: number; gap: number; misplace: number; fort: number;
  peekHide: number; peekOut: number; highGround: boolean; bridgeCover: boolean; altRoute: boolean;
};

/** Every building tunable outside the per-skill table. */
export type BuildTuning = {
  /** Never build anything within this of my own bunker without checking the way out stays open. */
  ownBunkerCheck: number;
  /** The way out of my bunker must stay ≥ 1.3 m wide: pieces grown by this per side on top of the player radius. */
  clearanceMargin: number;
  /** Keep doorways themselves (where a plug would sit) completely free. */
  doorKeepOut: number;
  /** Cash (carried + banked) kept back before buying fortification pieces: fortReserve × (1 − builder). */
  fortReserve: number;
  /** Builders at least this keen fortify before carrying a seal kit and even when a rival is in reach. */
  fortEarlyBuilder: number;
  /** Everyone else fortifies only with at least this many rivals left, carrying a kit, and no rival in walking reach. */
  fortMinRivals: number;
  /** Combat cover walls carried (× (0.4 + builder), rounded) by skill. */
  coverCarry: Record<Difficulty, number>;
  /** Rich enough (carried + banked) for metal instead of wood cover. */
  metalCoverAt: number;
  /** Carry a ramp for high ground in fights (skills with highGround) from this much cash. */
  rampAt: number;
  /** Bridge side walls: one per this many scaffolds of a bridge (× min(1, 0.3 + builder)). */
  scaffoldsPerBridgeWall: number;
  /** Bridge side walls go up once the deck is this far out over the water, and at least this far apart. */
  bridgeWallFrom: number; bridgeWallEvery: number;
  /** Shot at: build only when there's no cover spot within this, and stop covering after this long without contact. */
  coverNearSpot: number; coverForgetSec: number;
  /** Walls (or bags) one cover episode may use before giving up on it; a failed roll waits this long. */
  coverMaxPieces: number; coverRetrySec: number;
  /** Distance from me to the cover wall I throw down. */
  coverDist: [number, number, number];
  /** High ground: fight on the same island at this range, for this long, before throwing a ramp down. */
  highGroundRange: readonly [number, number]; highGroundAfter: number; perchSec: number;
  /** A fortification slot that won't place is left alone this long (repair waits for calm anyway). */
  slotBackoffSec: number;
  /** Ahead by this much health+shield on the shooter: fight instead of building/hiding. */
  pushLead: number;
  /** A bridge tip where no deck fits: retry this often; after this long go round (alt lane) or leave it this long. */
  bridgeRetrySec: number; bridgeStuckSec: number; bridgeHoldSec: number;
  /** Hotbar slots building never takes (guns, medkits, grenades, potions need room too). */
  freeSlots: number;
  /** Goal weights: covering under fire beats fighting in the open; fortifying is a calm-time job. */
  coverScore: number; fortifyScore: number;
};

export type BotParams = { drive: DriveParams; buildSkill: Record<Difficulty, BuildSkill>; buildTuning: BuildTuning };

export const DRIVE: DriveParams = {
  offenseAt: D(Infinity, 330, 300, 180),
  offenseCash: D(Infinity, 3 * PIECES.wood.price, 3 * PIECES.metal.price, 3 * PIECES.wood.price),
  push: D(0, 0.25, 0.25, 0.35),
  shopForPush: 0.75,
  plinkRange: 30,
  maxRange: D(Infinity, 20, 20, 24),
  sprintGap: 8,
  reengageSec: 20,
  reengageHp: 0.3,
  guardFreshSec: 4,
  collectCarried: 200,
  steelRich: 550,
  sealAway: 0.25,
  sealAwayTarget: 0.6,
  emptyHomeSec: 8,
  sealRaceM: 30,
  siegeDist: 6.5,
  siegeAfterDeath: 16,
  siegeScore: 0.75,
  stallSec: 10,
  stallDist: 2.5,
  stallBanSec: 20,
};

export const BUILD_SKILL: Record<Difficulty, BuildSkill> = {
  easy: { coverChance: 0.25, coverDelay: 1.4, gap: 1.6, misplace: 0.35, fort: 0.3, peekHide: 2.0, peekOut: 1.6, highGround: false, bridgeCover: false, altRoute: false },
  medium: { coverChance: 0.55, coverDelay: 0.8, gap: 0.8, misplace: 0.12, fort: 0.55, peekHide: 1.4, peekOut: 1.3, highGround: false, bridgeCover: true, altRoute: false },
  hard: { coverChance: 0.7, coverDelay: 0.5, gap: 0.3, misplace: 0.03, fort: 0.85, peekHide: 1.0, peekOut: 1.2, highGround: false, bridgeCover: true, altRoute: true },
  pro: { coverChance: 0.95, coverDelay: 0.22, gap: 0.05, misplace: 0, fort: 1, peekHide: 0.6, peekOut: 0.9, highGround: true, bridgeCover: true, altRoute: true },
};

export const BUILD_TUNING: BuildTuning = {
  ownBunkerCheck: 8,
  clearanceMargin: 0.3,
  doorKeepOut: 2.6,
  fortReserve: 200,
  fortEarlyBuilder: 0.7,
  fortMinRivals: 2,
  coverCarry: D(1, 1, 2, 2),
  metalCoverAt: 500,
  rampAt: 300,
  scaffoldsPerBridgeWall: 4,
  bridgeWallFrom: 8, bridgeWallEvery: 7.5,
  coverNearSpot: 3, coverForgetSec: 6,
  coverMaxPieces: 3, coverRetrySec: 5,
  coverDist: [1.3, 1.6, 1.05],
  highGroundRange: [8, 35] as const, highGroundAfter: 2.5, perchSec: 12,
  slotBackoffSec: 30,
  pushLead: 30,
  bridgeRetrySec: 0.5, bridgeStuckSec: 4, bridgeHoldSec: 20,
  freeSlots: 2,
  coverScore: 1.05, fortifyScore: 0.5,
};

export const DEFAULT_BOT_PARAMS: Readonly<BotParams> = Object.freeze({ drive: DRIVE, buildSkill: BUILD_SKILL, buildTuning: BUILD_TUNING });

/** Every numeric leaf as `path.to.key` → value (booleans and Infinity are left out: not tunable). */
export function flattenParams(p: BotParams = DEFAULT_BOT_PARAMS): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'number') { if (Number.isFinite(o)) out[path] = o; return; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(p, '');
  return out;
}

/** A copy of `base` with flat overrides applied; an unknown or non-numeric key is an error (typos fail loudly). */
export function withParams(over: Record<string, number>, base: BotParams = DEFAULT_BOT_PARAMS): BotParams {
  const out = structuredClone(base) as BotParams;
  for (const [path, v] of Object.entries(over)) {
    if (!Number.isFinite(v)) throw new Error(`withParams: ${path} = ${v} is not a finite number`);
    const keys = path.split('.');
    let o = out as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      if (!o[k] || typeof o[k] !== 'object') throw new Error(`withParams: unknown param ${path}`);
      o = o[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (typeof o[last] !== 'number') throw new Error(`withParams: unknown or non-numeric param ${path}`);
    o[last] = v;
  }
  return out;
}
