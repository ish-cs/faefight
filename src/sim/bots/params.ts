import { PIECES } from '../constants';
import type { Difficulty } from '../types';
import type { Traits } from './personality';
import trained from './trained-params.json';

/**
 * Tunable bot strategy (drive to win, building, the elimination pipeline), in one record so self-play training can
 * search over it. A Bot takes a BotParams (default DEFAULT_BOT_PARAMS); `flattenParams` / `withParams` give the
 * trainer flat numeric keys like `drive.push.pro`, `buildSkill.hard.coverChance` or `buildTuning.coverScore`.
 * Execution skill (reaction, aim error, decision speed) is not here: it stays in aim.ts / bot.ts. How the view hand
 * moves (AimFeel), how long a bot commits to the enemy it aims at (`aim.*`) and gun handling against recoil
 * (compensation, burst discipline: `gunSkill.*`) are here so the trainer can tune them.
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
 * - Respawn window (5 s): a dead rival whose bunker is within sealRaceM m and that I can sprint to before they're
 *   back (+ windowSlackSec) gets pushed: seal it with a kit (windowPush added to seal), else hold their door
 *   (half of it added to attack). respawnCautionSec: right after my own respawn no pushes or offense (re-gear).
 * - siegeDist: camping a sealed bunker this far out from its weakest doorway; siegeAfterDeath: how long after the
 *   owner's death the camp holds without seeing them; siegeScore: attack score while camping.
 * - fireRangeMult: Medium+ hold fire past this × the gun's falloff end (damage floor) unless that enemy is hitting me.
 * - crossFire: hold fire at an enemy farther than this (m) who isn't on the island I stand on (across the water, or
 *   either of us on a bridge) unless that enemy is hitting me or is my last rival: no plinking in passing, the
 *   fights happen up close.
 * - sealBonus: added to the seal goal (seals win games); sealedHunt: added to attack/fight against a rival whose
 *   bunker is sealed (each death of theirs eliminates them); sealedFocus: among visible enemies, one with a sealed
 *   bunker counts as this many times closer when choosing whom to shoot.
 * Wooden piers (sim/docks.ts):
 * - dockShot: odds, per roll (every dockRollSec while it's on), of blowing out the pier section an enemy stands on
 *   (or the one under the piece they hide behind) with a rocket or grenade instead of shooting them;
 *   dockDefend: added when it's my own island's pier (an attacker crossing toward me);
 *   dockMinRange: never closer than this to the section (my own blast).
 *   Pushing over a pier with a broken section needs nothing extra: the bridge lane runs along the pier, so the gap
 *   is where the bridge's next scaffold goes.
 * - stallSec / stallDist / stallBanSec: goal watchdog (a goal with no progress for stallSec is dropped for
 *   stallBanSec; progress = something built/bought/shot, or getting stallDist m further from where the goal started
 *   than ever before, so pacing back and forth over the same ground doesn't count).
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
  windowSlackSec: number;
  windowPush: number;
  respawnCautionSec: number;
  siegeDist: number;
  siegeAfterDeath: number;
  siegeScore: number;
  stallSec: number;
  stallDist: number;
  stallBanSec: number;
  fireRangeMult: number;
  crossFire: Record<Difficulty, number>;
  sealBonus: number;
  sealedHunt: number;
  sealedFocus: number;
  dockShot: Record<Difficulty, number>;
  dockDefend: number;
  dockMinRange: number;
  dockRollSec: number;
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

/**
 * Teams play (teams matches only; free-for-all never reads these).
 * - focus: rival-choice bonus per teammate already going after that rival, and for whoever just hurt a teammate near
 *   me (focus one target: the team converges on one enemy island).
 * - groupPush: bridge/attack/seal bonus per teammate already on my target's island (half for one going after the same
 *   rival): the team pushes one island together.
 * - assistM / assistSec / assistScore: go help a teammate an enemy hurt within assistSec, if they're within assistM.
 * - regroupM / regroupScore: on offense, a pusher more than regroupM behind a teammate who goes after the same rival
 *   (and is nearer their island) catches up first (goal 'regroup'), so the team arrives together.
 * - defendMin: from this many players left on my team, one bot (the lowest id) stays home as the defender.
 * - defendBias: the defender's guard/fortify/cut/defend bonus, also taken off its bridge/attack/seal.
 * - follow: rival-choice bonus for the push lead's rival (the lead: the non-defender bot whose home is nearest an
 *   enemy island, lowest id on ties); the rest of the team goes for the same island instead of each its own neighbour.
 * - assistLowHp: extra assist score for a teammate in trouble, × their missing health (0..1).
 * - focusFire: in teams, an enemy who is hurting a teammate counts as this many times closer when picking whom to
 *   shoot (focus one target).
 * - waitM / waitSec: the push lead, about to step onto the rival island, waits up to waitSec at the bridge head for
 *   a pusher still more than waitM behind (so the team hits together; never in sight of an enemy).
 */
export type TeamParams = {
  focus: number; groupPush: number;
  assistM: number; assistSec: number; assistScore: number;
  regroupM: number; regroupScore: number;
  defendMin: number; defendBias: number;
  follow: number; assistLowHp: number; focusFire: number; waitM: number; waitSec: number;
};

/**
 * Grappling hook (sim/grapple.ts): when to buy one and when to use it.
 * - buyAt: cash (carried + banked) from which this skill carries a hook (Infinity = never).
 * - crossBuyAt: with a crossing to make (a bridge I'd otherwise build), a hook comes before scaffolds from this much cash.
 * - crossMax: hook over to an island I want but can't walk to once its near edge is this close to my eye.
 * - crossInset: aim this far in from that island's edge (so I land on it, not on the cliff face).
 * - escapeHp: hp + shield under this with an enemy in sight within escapeNear: hook away (at least escapeMin m).
 * - yankMin / yankMax: yank an enemy in this distance band when it pays: open water between us (they drop in), they
 *   hold high ground (yankHigh m above me), or my gun wants them closer (past yankFalloff × its falloff start).
 * - yankRate: yank tries per second while one would pay (seeded rng: not every chance).
 * - keepForTravel: uses held back for crossing while my target island is out of walking reach.
 */
export type HookParams = {
  buyAt: Record<Difficulty, number>;
  crossBuyAt: Record<Difficulty, number>;
  crossMax: number; crossInset: number;
  escapeHp: number; escapeNear: number; escapeMin: number;
  yankMin: number; yankMax: number; yankHigh: number; yankFalloff: number; yankRate: number;
  keepForTravel: number;
};

/**
 * Spike traps (sim/traps.ts).
 * - carry: traps to own (standing + carried) by skill, once `rich` cash (carried + banked) is in hand.
 * - setScore: goal score for setting one at home (doorways first, then the wall beside the front door) in calm times.
 * - avoidPad: keep this far (m) beyond an enemy trap's reach when walking.
 * - shootRange: an enemy trap this close in my way (or at where I'm going), with nobody in sight: shoot it first.
 */
export type TrapTuning = { carry: Record<Difficulty, number>; rich: number; setScore: number; avoidPad: number; shootRange: number };

/**
 * How a bot's view moves (aim.ts Aim.look): a damped spring on yaw/pitch, capped by the skill's turn speed.
 * - spring: natural frequency (rad/s): how fast a flick closes. Tracking lag behind a moving target ≈ 2·damping/spring s.
 * - damping: < 1 overshoots a flick slightly and settles (PRO ≈ 5%), 1 eases in with no overshoot.
 * - maxAccel: angular acceleration cap (rad/s²): no instant starts/stops.
 * - driftHz: how fast the aim error wanders (OU mean reversion, 1/s): low = slow hand drift, never tick-to-tick noise.
 * - holdSec: after losing sight of the enemy, keep looking at where they were this long before turning back to the walk.
 */
export type AimFeel = { spring: number; damping: number; maxAccel: number; driftHz: number; holdSec: number };

/**
 * Aim at one enemy at a time: feel per skill, plus target hysteresis.
 * - commitSec: stay on the enemy I'm aiming at at least this long while I can still see them.
 * - switchRatio: after that, switch only to an enemy closer than this × the current one's distance.
 */
export type AimParams = { feel: Record<Difficulty, AimFeel>; commitSec: number; switchRatio: number };

/**
 * Gun handling against recoil (the sim's recoil climbs the shooter's real aim, gunplay.recoilKick), per skill. Like a
 * strong human: pull the climb back down, tap/burst at range so recoil and bloom settle, spray up close.
 * - recoilComp: share of each kick pulled back down on the next tick (0 = rides the climb, 1 = perfect).
 * - burstShots: past sprayRange, an automatic gun (rifle / SMG) fires at most this many shots in a row, then
 * - burstPause: waits this long (s) before the next burst. Within sprayRange: full auto.
 */
export type GunSkill = { recoilComp: number; burstShots: number; burstPause: number; sprayRange: number };

export type BotParams = { drive: DriveParams; buildSkill: Record<Difficulty, BuildSkill>; buildTuning: BuildTuning; hook: HookParams; trap: TrapTuning; aim: AimParams; gunSkill: Record<Difficulty, GunSkill>; team: TeamParams; brain: BrainParams };

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
  sealRaceM: 60,
  windowSlackSec: 2,
  windowPush: 0.6,
  respawnCautionSec: 8,
  siegeDist: 6.5,
  siegeAfterDeath: 16,
  siegeScore: 0.75,
  stallSec: 10,
  stallDist: 2.5,
  stallBanSec: 20,
  fireRangeMult: 2,
  // PRO only (measured: ~80% of 8-PRO FFA hits were drive-by shots across water at ~40 m while bridging/sealing).
  crossFire: D(Infinity, Infinity, Infinity, 25),
  sealBonus: 0.35,
  sealedHunt: 0.6,
  sealedFocus: 1.6,
  dockShot: D(0.15, 0.45, 0.65, 0.85),
  dockDefend: 0.3,
  dockMinRange: 6,
  dockRollSec: 1,
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

export const TEAM: TeamParams = {
  focus: 0.45, groupPush: 0.3,
  assistM: 75, assistSec: 6, assistScore: 0.9,
  regroupM: 12, regroupScore: 1.1,
  defendMin: 3, defendBias: 0.45,
  follow: 0.9, assistLowHp: 0.4, focusFire: 1.4, waitM: 25, waitSec: 8,
};

export const HOOK: HookParams = {
  buyAt: D(1200, 450, 350, 300),
  crossBuyAt: D(Infinity, 160, 600, 110),
  crossMax: 39, crossInset: 2.5,
  escapeHp: 45, escapeNear: 20, escapeMin: 12,
  yankMin: 8, yankMax: 30, yankHigh: 2.5, yankFalloff: 1.2, yankRate: 0.6,
  keepForTravel: 1,
};

export const TRAP_TUNING: TrapTuning = { carry: D(0, 1, 2, 3), rich: 350, setScore: 0.45, avoidPad: 0.35, shootRange: 9 };

export const AIM_PARAMS: AimParams = {
  feel: {
    easy: { spring: 8, damping: 0.95, maxAccel: 70, driftHz: 2, holdSec: 0.5 },
    medium: { spring: 12, damping: 0.85, maxAccel: 120, driftHz: 2.5, holdSec: 0.6 },
    hard: { spring: 22, damping: 0.75, maxAccel: 220, driftHz: 3, holdSec: 0.7 },
    pro: { spring: 32, damping: 0.7, maxAccel: 320, driftHz: 3, holdSec: 0.8 },
  },
  commitSec: 0.6,
  switchRatio: 0.6,
};

/** Easy sprays at any range (sprayRange Infinity: not tunable); better players compensate harder and burst at range. */
export const GUN_SKILL: Record<Difficulty, GunSkill> = {
  easy: { recoilComp: 0.25, burstShots: 30, burstPause: 0.3, sprayRange: Infinity },
  medium: { recoilComp: 0.6, burstShots: 6, burstPause: 0.35, sprayRange: 12 },
  hard: { recoilComp: 0.85, burstShots: 5, burstPause: 0.3, sprayRange: 14 },
  pro: { recoilComp: 0.95, burstShots: 4, burstPause: 0.22, sprayRange: 15 },
};

/** The hand-tuned tables (what the bots did before training). */
export const HAND_BOT_PARAMS: Readonly<BotParams> = Object.freeze({ drive: DRIVE, buildSkill: BUILD_SKILL, buildTuning: BUILD_TUNING, hook: HOOK, trap: TRAP_TUNING, aim: AIM_PARAMS, gunSkill: GUN_SKILL, team: TEAM, brain: HAND_BRAIN });

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
  ['drive.sealRaceM', [10, 120]], ['drive.windowSlackSec', [0, 6]], ['drive.windowPush', [0, 1.5]],
  ['drive.respawnCautionSec', [0, 30]], ['drive.siegeDist', [4, 12]], ['drive.siegeAfterDeath', [5, 30]],
  ['drive.siegeScore', [0.3, 1.2]], ['drive.stallSec', [5, 25]], ['drive.stallDist', [1, 5]], ['drive.stallBanSec', [5, 60]], ['drive.fireRangeMult', [0.5, 2]], ['drive.crossFire.*', [15, 60]],
  ['drive.sealBonus', [0, 1.2]], ['drive.sealedHunt', [0, 1.5]], ['drive.sealedFocus', [1, 3]],
  ['drive.dockShot.*', [0, 1]], ['drive.dockDefend', [0, 0.8]], ['drive.dockMinRange', [4.5, 12]], ['drive.dockRollSec', [0.3, 4]],
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
  ['hook.buyAt.*', [150, 1500]], ['hook.crossBuyAt.*', [90, 600]], ['hook.crossMax', [20, 40]], ['hook.crossInset', [1, 6]],
  ['hook.escapeHp', [0, 120]], ['hook.escapeNear', [8, 35]], ['hook.escapeMin', [6, 30]],
  ['hook.yankMin', [3, 15]], ['hook.yankMax', [15, 40]], ['hook.yankHigh', [1, 6]], ['hook.yankFalloff', [0.5, 3]],
  ['hook.yankRate', [0, 3]], ['hook.keepForTravel', [0, 2]],
  ['trap.carry.*', [0, 3]], ['trap.rich', [100, 1200]], ['trap.setScore', [0.1, 1]], ['trap.avoidPad', [0, 1.5]], ['trap.shootRange', [3, 20]],
  ['aim.feel.*.spring', [6, 45]], ['aim.feel.*.damping', [0.55, 1.2]], ['aim.feel.*.maxAccel', [40, 600]],
  ['aim.feel.*.driftHz', [0.5, 8]], ['aim.feel.*.holdSec', [0, 2]], ['aim.commitSec', [0, 2]], ['aim.switchRatio', [0.3, 1]],
  ['gunSkill.*.recoilComp', [0, 1]], ['gunSkill.*.burstShots', [2, 30]], ['gunSkill.*.burstPause', [0.1, 0.8]], ['gunSkill.*.sprayRange', [5, 40]],
  ['team.focus', [0, 1.5]], ['team.groupPush', [0, 1]], ['team.assistM', [15, 90]], ['team.assistSec', [1, 10]],
  ['team.assistScore', [0.3, 1.5]], ['team.regroupM', [6, 30]], ['team.regroupScore', [0.3, 1.6]], ['team.defendMin', [2, 5]], ['team.defendBias', [0, 1]],
  ['team.follow', [0, 2]], ['team.assistLowHp', [0, 1]], ['team.focusFire', [1, 3]], ['team.waitM', [8, 60]], ['team.waitSec', [0, 20]],
];
const ruleMatch = (pattern: string, key: string) => {
  const a = pattern.split('.'), b = key.split('.');
  return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]);
};

/** [min, max] per tunable flat key; every default lies inside its box (tests/sim/botParams.test.ts checks). */
/** Keys searched only within ±fraction of their hand-tuned default (clipped to their RANGE_RULES box). */
const SEARCH_NEAR_DEFAULT: [string, number][] = [['aim.feel.*.spring', 0.25], ['aim.feel.*.damping', 0.25], ['aim.feel.*.maxAccel', 0.25], ['gunSkill.*.recoilComp', 0.15]];
/** Trainer search limits tighter than RANGE_RULES (product decisions): PRO must not buy back long-range plinking. */
const SEARCH_LIMIT: [string, [number, number]][] = [['drive.crossFire.pro', [15, 30]]];

export const PARAM_RANGES: Readonly<Record<string, [number, number]>> = Object.freeze(Object.fromEntries(
  Object.keys(flattenParams(HAND_BOT_PARAMS)).flatMap((k): [string, [number, number]][] => {
    const brain: Spec | undefined = k.startsWith('brain.') ? BRAIN_SPEC[k.slice(6) as BrainKey] : undefined;
    if (brain) return [[k, [brain[0], brain[1]]]];
    const r = RANGE_RULES.find(([p]) => ruleMatch(p, k));
    if (!r) return [];
    const lim = SEARCH_LIMIT.find(([p]) => ruleMatch(p, k))?.[1];
    if (lim) return [[k, [Math.max(r[1][0], lim[0]), Math.min(r[1][1], lim[1])]]];
    // Feel keys (how a view spring moves) are searched only near their hand values: winning shouldn't buy extremes.
    const f = SEARCH_NEAR_DEFAULT.find(([p]) => ruleMatch(p, k))?.[1];
    if (f === undefined) return [[k, r[1]]];
    const def = flattenParams(HAND_BOT_PARAMS)[k];
    return [[k, [Math.max(r[1][0], def * (1 - f)), Math.min(r[1][1], def * (1 + f))]]];
  }),
));

// ---------------------------------------------------------------- trainer view

/**
 * What the trainer searches over, in a fixed order: every key with a range, except team.* (training games are FFAs
 * and duels, which never read TEAM: those keys would only random-walk; they keep their hand values until team games
 * are part of the fitness).
 */
export const PARAM_KEYS: readonly string[] = Object.freeze(Object.keys(PARAM_RANGES).filter((k) => !k.startsWith('team.')));
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
