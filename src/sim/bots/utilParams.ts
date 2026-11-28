import type { Difficulty } from '../types';

/** Bot knobs for smoke grenades and flashbangs (bots/utilityPlan.ts); tuned by the ES trainer via params.ts. */
export type UtilParams = {
  /** How many of each to carry (0 = never buys). */
  carrySmoke: Record<Difficulty, number>;
  carryFlash: Record<Difficulty, number>;
  /** Cash (carried + vault) before buying them (they're extras, after the seal kit and guns). */
  buyAt: Record<Difficulty, number>;
  /** Chance per chance-window to smoke a retreat / heal with an enemy close or hurting me. */
  smokeRetreat: Record<Difficulty, number>;
  /** Chance to smoke a crossing (bridge, deck) or a seal attempt with an enemy around. */
  smokeCross: Record<Difficulty, number>;
  /** Chance to flash before a push (a fight at mid range, or a rival who just ducked out of sight). */
  flashPush: Record<Difficulty, number>;
  /** Chance not to push a fight into someone else's smoke (flank round its edge instead). */
  avoidSmoke: Record<Difficulty, number>;
  /** Chance, while blinded, to back away from where the enemy was (else hold still). */
  blindBack: Record<Difficulty, number>;
  /** Enemy within this (m) makes a retreat worth smoking. */
  retreatM: number;
  /** Flash a target this far away (m). */
  flashMin: number; flashMax: number;
  /** Seconds since a sighting that still counts as "just ducked out" / "around". */
  seenSec: number;
  /** Least time between two utility throws (s), and how long a roll holds before it's rolled again. */
  gapSec: number; rollSec: number;
};

const D = <T>(easy: T, medium: T, hard: T, pro: T): Record<Difficulty, T> => ({ easy, medium, hard, pro });

export const UTIL: UtilParams = {
  carrySmoke: D(0, 1, 1, 2), carryFlash: D(0, 1, 1, 1), buyAt: D(300, 180, 140, 120),
  smokeRetreat: D(0.35, 0.6, 0.85, 1), smokeCross: D(0.15, 0.4, 0.7, 0.9), flashPush: D(0, 0.4, 0.7, 0.9),
  avoidSmoke: D(0, 0.5, 1, 1), blindBack: D(0.5, 0.8, 1, 1),
  retreatM: 16, flashMin: 6, flashMax: 18, seenSec: 3, gapSec: 4, rollSec: 3,
};

/** Search boxes for the ES trainer (params.ts RANGE_RULES). */
export const UTIL_RANGES: [string, [number, number]][] = [
  ['util.carrySmoke.*', [0, 3]], ['util.carryFlash.*', [0, 3]], ['util.buyAt.*', [100, 1500]],
  ['util.smokeRetreat.*', [0, 1]], ['util.smokeCross.*', [0, 1]], ['util.flashPush.*', [0, 1]],
  ['util.avoidSmoke.*', [0, 1]], ['util.blindBack.*', [0, 1]],
  ['util.retreatM', [6, 30]], ['util.flashMin', [3, 10]], ['util.flashMax', [10, 25]], ['util.seenSec', [0.5, 8]],
  ['util.gapSec', [1, 15]], ['util.rollSec', [1, 8]],
];

