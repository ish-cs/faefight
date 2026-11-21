import { PIECES } from '../constants';
import type { Difficulty } from '../types';
import type { Traits } from './personality';
import trained from './trained-params.json';

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
 * - fireRangeMult: Medium+ hold fire past this × the gun's falloff end (damage floor) unless that enemy is hitting me.
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
  fireRangeMult: number;
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

/**
 * The brain's weights (goal biases, rival choice, fight/survive thresholds, dodging, plan weights), flat. Each
 * entry: [min, max, hand-tuned default, optional trait coupling [trait, offset per unit of (trait − 0.5)]]; the
 * bot folds its personality in with `withTraits`. Steel kit cash lives in drive.steelRich.
 */
type Spec = readonly [min: number, max: number, def: number, trait?: readonly [keyof Traits, number]];

export const BRAIN_SPEC = {
  // ---- goal utility: additive bias per goal (on top of the situational scores in bot.ts)
  biasFight: [-0.4, 0.4, 0, ['aggression', 0.2]],
  biasDisengage: [-0.4, 0.4, 0, ['caution', 0.2]],
  biasGuard: [-0.4, 0.4, 0, ['caution', 0.2]],
  biasBank: [-0.4, 0.4, 0, ['caution', 0.1]],
  biasCollect: [-0.4, 0.4, 0, ['greed', 0.1]],
  biasShop: [-0.4, 0.4, 0],
  biasBridge: [-0.4, 0.4, 0, ['aggression', 0.15]],
  biasAttack: [-0.4, 0.4, 0, ['aggression', 0.2]],
  biasSeal: [-0.4, 0.4, 0, ['opportunism', 0.15]],
  biasCut: [-0.4, 0.4, 0, ['builder', 0.15]],
  biasLoot: [-0.4, 0.4, 0, ['greed', 0.15]],
  biasRaid: [-0.4, 0.4, 0, ['greed', 0.15]],
  biasHeal: [-0.4, 0.4, 0, ['caution', 0.15]],

  // ---- rival choice (mind.rivalScore)
  rsUnbridged: [0.01, 0.15, 0.06],
  rsDist: [0.05, 0.8, 0.42],
  rsRespawning: [0.2, 2, 0.9, ['opportunism', 0.4]],
  rsRecentDeath: [0, 1.5, 0.48],
  rsSealed: [0, 2, 0.9, ['opportunism', 0.3]],
  rsLowHp: [0, 1.5, 0.5, ['opportunism', 0.3]],
  rsGrudge: [0, 2, 0.7, ['vengeance', 0.6]],
  rsBusy: [0, 1.5, 0.25, ['opportunism', 0.4]],
  rsLeader: [0, 1, 0.28, ['aggression', 0.2]],
  rsIntruder: [0, 1.5, 0.8, ['caution', 0.4]],
  rsAway: [0, 1, 0.2, ['opportunism', 0.3]],
  rsCommit: [0, 0.8, 0.33, ['patience', 0.3]],

  // ---- fight / survive thresholds
  /** HP fraction under which a bot disengages (plus caution/aggression offsets). */
  lowHp: [0.1, 0.6, 0.3, ['caution', 0.2]],
  /** HP fraction under which a bot away from home goes back to heal. */
  healHp: [0.15, 0.7, 0.4, ['caution', 0.2]],
  /** HP at or below which a carried medkit is used. */
  medkitHp: [30, 75, 55],
  /** An enemy on another island farther than this is not worth dropping the current goal for (m). */
  engageRange: [10, 45, 25, ['aggression', 8]],
  /** Preferred duel range multiplier on each gun's natural range. */
  rangeMult: [0.6, 1.6, 1, ['range', 0.4]],
  /** HP under which any bot fights from cover when cover is near. */
  coverHp: [30, 100, 60, ['caution', 20]],
  /** Extra disengage utility per extra armed enemy in sight (don't fight two at once). */
  outnumbered: [0, 0.8, 0.3, ['caution', 0.2]],

  // ---- dodging (execution still scales with skill in tactics.ts)
  /** Seconds a hit or a near-miss tracer keeps a bot "under fire". */
  underFireSec: [0.5, 3, 1.2],
  jukeMinSec: [0.12, 0.6, 0.25],
  jukeMaxSec: [0.3, 1.2, 0.7],
  /** Weight of the lateral juke against the intended direction of travel. */
  jukeWeight: [0.2, 2, 1],
  /** Chance a juke direction change comes with a jump. */
  jumpChance: [0, 0.7, 0.25],
  /** HP fraction under which a bot under fire breaks line of sight to the nearest cover. */
  breakLosHp: [0.2, 0.9, 0.5, ['caution', 0.2]],
  /** Peek timing in cover: seconds hidden / seconds peeking (both randomized ±50%). */
  hideSec: [0.3, 2, 0.9],
  peekSec: [0.4, 2.5, 1.2],

  // ---- target selection among visible enemies
  tgtLowHp: [0, 2, 1],
  tgtShootingMe: [0, 2, 0.8],
  tgtPlanTarget: [0, 1.5, 0.5],
  tgtDist: [0, 0.1, 0.03],
  tgtKeep: [0, 1, 0.3],

  // ---- economy / tactics thresholds
  collectAt: [20, 150, 40, ['greed', -15]],
  raidAt: [30, 250, 60, ['greed', -30]],
  nadeRich: [200, 1200, 400],
  nadeMin: [5, 9, 6.5],
  nadeMax: [12, 30, 22],

  // ---- plan layer
  planSeal: [0, 2, 1, ['opportunism', 0.3]],
  planElim: [0, 2, 1.2, ['opportunism', 0.3]],
  planRaid: [0, 2, 0.6, ['greed', 0.4]],
  planRevenge: [0, 2, 0.6, ['vengeance', 0.6]],
  planCenter: [0, 2, 0.5, ['greed', 0.3]],
  planTurtle: [0, 2, 0.8, ['patience', 0.6]],
  planDefend: [0, 2, 1, ['caution', 0.4]],
  /** Seconds into the match a turtle plan stops making sense. */
  turtleUntil: [60, 420, 200, ['patience', 80]],
  /** Utility the current plan keeps over challengers (hysteresis). */
  planCommit: [0, 1, 0.3, ['patience', 0.3]],
  /** Minimum seconds a plan is kept unless an event invalidates it. */
  planMinSec: [3, 40, 12, ['patience', 8]],
  /** How strongly the current plan step pushes its goals. */
  stepPush: [0, 0.8, 0.3],

  // ---- brain goals (brain.ts): weights of the self-assessed goals
  planUpgrade: [0, 2, 0.9],
  planHeal: [0, 2, 1, ['caution', 0.3]],
  planBank: [0, 2, 0.5, ['caution', 0.3]],
  planRetreat: [0, 3, 1.5, ['caution', 0.4]],
  /** Estimated odds of winning a fight under which a bot runs instead (0.5 = even). */
  fleeOdds: [0.15, 0.6, 0.38, ['caution', 0.15]],
} as const satisfies Record<string, Spec>;

export type BrainKey = keyof typeof BRAIN_SPEC;
export type BrainParams = Record<BrainKey, number>;
export const BRAIN_KEYS = Object.keys(BRAIN_SPEC) as BrainKey[];
const clampBrain = (k: BrainKey, x: number) => Math.min(BRAIN_SPEC[k][1], Math.max(BRAIN_SPEC[k][0], x));

/** Hand-tuned brain weights. */
export const HAND_BRAIN: Readonly<BrainParams> = Object.freeze(
  Object.fromEntries(BRAIN_KEYS.map((k) => [k, BRAIN_SPEC[k][2]])) as BrainParams,
);

/** Personality as offsets on the brain weights: each coupled weight moves by offset × (trait − 0.5), then clamps. */
export function withTraits(base: Readonly<BrainParams>, t: Traits): BrainParams {
  const out = { ...base };
  for (const k of BRAIN_KEYS) {
    const spec: Spec = BRAIN_SPEC[k];
    if (spec[3]) out[k] = clampBrain(k, base[k] + spec[3][1] * (t[spec[3][0]] - 0.5));
  }
  return out;
}

export type BotParams = { drive: DriveParams; buildSkill: Record<Difficulty, BuildSkill>; buildTuning: BuildTuning; brain: BrainParams };

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
  fireRangeMult: 2,
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

/** The hand-tuned tables (what the bots did before training). */
export const HAND_BOT_PARAMS: Readonly<BotParams> = Object.freeze({ drive: DRIVE, buildSkill: BUILD_SKILL, buildTuning: BUILD_TUNING, brain: HAND_BRAIN });

/** Every numeric leaf as `path.to.key` → value (booleans and Infinity are left out: not tunable). */
export function flattenParams(p: Readonly<BotParams> = DEFAULT_BOT_PARAMS): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'number') { if (Number.isFinite(o)) out[path] = o; return; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(p, '');
  return out;
}

/** A copy of `base` with flat overrides applied; an unknown or non-numeric key is an error (typos fail loudly). */
export function withParams(over: Record<string, number>, base: Readonly<BotParams> = DEFAULT_BOT_PARAMS): BotParams {
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

/**
 * Search box for the trainer, per flat key (`flattenParams`). The first matching pattern wins; `*` stands for one
 * path segment. Keys with no entry (safety geometry: ownBunkerCheck, clearanceMargin, doorKeepOut) aren't tuned.
 */
const RANGE_RULES: [string, [number, number]][] = [
  ['drive.offenseAt.*', [60, 600]], ['drive.offenseCash.*', [50, 400]], ['drive.push.*', [0, 0.8]],
  ['drive.maxRange.*', [8, 35]], ['drive.shopForPush', [0.4, 1.1]], ['drive.plinkRange', [15, 50]],
  ['drive.sprintGap', [3, 15]], ['drive.reengageSec', [5, 40]], ['drive.reengageHp', [0.1, 0.6]],
  ['drive.guardFreshSec', [1, 10]], ['drive.collectCarried', [50, 500]], ['drive.steelRich', [450, 1500]],
  ['drive.sealAway', [0, 0.8]], ['drive.sealAwayTarget', [0, 1.5]], ['drive.emptyHomeSec', [3, 20]],
  ['drive.sealRaceM', [10, 60]], ['drive.siegeDist', [4, 12]], ['drive.siegeAfterDeath', [5, 30]],
  ['drive.siegeScore', [0.3, 1.2]], ['drive.stallSec', [5, 25]], ['drive.stallDist', [1, 5]], ['drive.stallBanSec', [5, 60]], ['drive.fireRangeMult', [0.5, 2]],
  ['buildSkill.*.coverChance', [0, 1]], ['buildSkill.*.coverDelay', [0.1, 2]], ['buildSkill.*.gap', [0, 2]],
  ['buildSkill.*.misplace', [0, 0.5]], ['buildSkill.*.fort', [0, 1]], ['buildSkill.*.peekHide', [0.3, 3]],
  ['buildSkill.*.peekOut', [0.3, 3]],
  ['buildTuning.fortReserve', [0, 600]], ['buildTuning.fortEarlyBuilder', [0.3, 1]], ['buildTuning.fortMinRivals', [1, 6]],
  ['buildTuning.coverCarry.*', [0, 4]], ['buildTuning.metalCoverAt', [100, 1500]], ['buildTuning.rampAt', [100, 1000]],
  ['buildTuning.scaffoldsPerBridgeWall', [2, 10]], ['buildTuning.bridgeWallFrom', [3, 20]], ['buildTuning.bridgeWallEvery', [4, 15]],
  ['buildTuning.coverNearSpot', [1, 6]], ['buildTuning.coverForgetSec', [2, 15]], ['buildTuning.coverMaxPieces', [1, 6]],
  ['buildTuning.coverRetrySec', [1, 15]], ['buildTuning.coverDist.*', [0.9, 2.5]], ['buildTuning.highGroundRange.0', [4, 15]],
  ['buildTuning.highGroundRange.1', [20, 50]], ['buildTuning.highGroundAfter', [0.5, 6]], ['buildTuning.perchSec', [4, 25]],
  ['buildTuning.slotBackoffSec', [10, 90]], ['buildTuning.pushLead', [0, 80]], ['buildTuning.bridgeRetrySec', [0.2, 2]],
  ['buildTuning.bridgeStuckSec', [1, 10]], ['buildTuning.bridgeHoldSec', [5, 60]], ['buildTuning.freeSlots', [1, 4]],
  ['buildTuning.coverScore', [0.5, 1.5]], ['buildTuning.fortifyScore', [0.1, 1]],
];
const ruleMatch = (pattern: string, key: string) => {
  const a = pattern.split('.'), b = key.split('.');
  return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]);
};

/** [min, max] per tunable flat key; every default lies inside its box (tests/sim/botParams.test.ts checks). */
export const PARAM_RANGES: Readonly<Record<string, [number, number]>> = Object.freeze(Object.fromEntries(
  Object.keys(flattenParams(HAND_BOT_PARAMS)).flatMap((k): [string, [number, number]][] => {
    const brain: Spec | undefined = k.startsWith('brain.') ? BRAIN_SPEC[k.slice(6) as BrainKey] : undefined;
    if (brain) return [[k, [brain[0], brain[1]]]];
    const r = RANGE_RULES.find(([p]) => ruleMatch(p, k));
    return r ? [[k, r[1]]] : [];
  }),
));

// ---------------------------------------------------------------- trainer view

/** What the trainer searches over: every key with a range (brain.*, drive.*, buildSkill.*, buildTuning.*), in a fixed order. */
export const PARAM_KEYS: readonly string[] = Object.freeze(Object.keys(PARAM_RANGES));
/** A full set of tunable values by flat key (JSON-safe, unlike BotParams with easy's Infinity entries). */
export type FlatParams = Record<string, number>;

/**
 * Every tunable key, from `base` overridden by the known finite keys of `p`, clamped into its range. Keys without a
 * range (safety geometry) or unknown ones are ignored; a bare brain key (`biasFight`, the run-1/2 format) means
 * `brain.biasFight`.
 */
export function sanitize(p: Readonly<Record<string, unknown>>, base: Readonly<FlatParams> = HAND_PARAMS): FlatParams {
  const out: FlatParams = {};
  for (const k of PARAM_KEYS) out[k] = base[k];
  for (const [raw, v] of Object.entries(p)) {
    const k = raw in PARAM_RANGES ? raw : `brain.${raw}`;
    const r = PARAM_RANGES[k];
    if (r && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(r[1], Math.max(r[0], v));
  }
  return out;
}

/** Flat tunables on top of the hand-tuned tables (keys outside PARAM_KEYS are an error). */
export function toBotParams(flat: Readonly<FlatParams>): BotParams {
  for (const k of Object.keys(flat)) if (!(k in PARAM_RANGES)) throw new Error(`toBotParams: ${k} is not a tunable param`);
  return withParams(flat, HAND_BOT_PARAMS);
}

/** Flat params ↔ [0,1]^n (for the optimizer). */
export const encode = (p: Readonly<FlatParams>): number[] => PARAM_KEYS.map((k) => {
  const [lo, hi] = PARAM_RANGES[k];
  return (p[k] - lo) / (hi - lo);
});
export const decode = (x: readonly number[]): FlatParams => {
  if (x.length !== PARAM_KEYS.length) throw new Error(`decode: got ${x.length} values for ${PARAM_KEYS.length} params`);
  return Object.fromEntries(PARAM_KEYS.map((k, i) => {
    const [lo, hi] = PARAM_RANGES[k];
    return [k, lo + Math.min(1, Math.max(0, x[i])) * (hi - lo)];
  }));
};

/** Hand-tuned tunables, flat. */
export const HAND_PARAMS: Readonly<FlatParams> = Object.freeze(Object.fromEntries(
  PARAM_KEYS.map((k) => [k, flattenParams(HAND_BOT_PARAMS)[k]]),
));

/**
 * The shipped champion: trained-params.json holds flat overrides (written only after a champion passes the ship
 * checks in tests/sim/shipChecks.test.ts). A key that isn't tunable there is an error, not silently dropped.
 */
const TRAINED: Readonly<Record<string, number>> = (trained as { params?: Record<string, number> }).params ?? {};
for (const k of Object.keys(TRAINED)) if (!(k in PARAM_RANGES)) throw new Error(`trained-params.json: ${k} is not a tunable param`);
export const DEFAULT_PARAMS: Readonly<FlatParams> = Object.freeze(sanitize(TRAINED));
export const DEFAULT_BOT_PARAMS: Readonly<BotParams> = Object.keys(TRAINED).length
  ? Object.freeze(toBotParams(DEFAULT_PARAMS)) : HAND_BOT_PARAMS;
