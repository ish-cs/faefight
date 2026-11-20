import trained from './trained-params.json';
import type { Traits } from './personality';

/**
 * Every tunable weight and threshold of bot strategy and tactics, in one flat record so self-play training
 * (scripts/train-bots.ts) can search over it. Difficulty is NOT here: reaction, aim and decision speed stay in
 * aim.ts / bot.ts (execution skill). Personalities are offsets on these values (see `withTraits`).
 *
 * Each entry: [min, max, hand-tuned default, optional trait coupling [trait, offset per unit of (trait - 0.5)]].
 */
type Spec = readonly [min: number, max: number, def: number, trait?: readonly [keyof Traits, number]];

export const PARAM_SPEC = {
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
  rsSealed: [0, 1.5, 0.65, ['opportunism', 0.3]],
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
  steelRich: [400, 1500, 800],
  nadeMin: [5, 9, 6.5],
  nadeMax: [12, 30, 22],

  // ---- plan layer (strategy.ts)
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
} as const satisfies Record<string, Spec>;

export type ParamKey = keyof typeof PARAM_SPEC;
export type BotParams = Record<ParamKey, number>;
export const PARAM_KEYS = Object.keys(PARAM_SPEC) as ParamKey[];

const clamp = (k: ParamKey, x: number) => Math.min(PARAM_SPEC[k][1], Math.max(PARAM_SPEC[k][0], x));

/** Hand-tuned values (what the bots did before training). */
export const HAND_PARAMS: Readonly<BotParams> = Object.freeze(
  Object.fromEntries(PARAM_KEYS.map((k) => [k, PARAM_SPEC[k][2]])) as BotParams,
);

/** Fill in missing keys from the hand defaults and clamp every value into its range. */
export function sanitize(p: Partial<Record<string, number>>): BotParams {
  const out = { ...HAND_PARAMS };
  for (const k of PARAM_KEYS) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp(k, v);
  }
  return out;
}

/** The trained champion (scripts/train-bots.ts writes trained-params.json); the default for every bot. */
export const DEFAULT_PARAMS: Readonly<BotParams> = Object.freeze(sanitize((trained as { params?: Record<string, number> }).params ?? {}));

/** Personality as offsets on the params: each coupled param moves by offset × (trait − 0.5), then clamps. */
export function withTraits(base: BotParams, t: Traits): BotParams {
  const out = { ...base };
  for (const k of PARAM_KEYS) {
    const spec: Spec = PARAM_SPEC[k];
    if (spec[3]) out[k] = clamp(k, base[k] + spec[3][1] * (t[spec[3][0]] - 0.5));
  }
  return out;
}

/** Params ↔ [0,1]^n (for the optimizer). */
export const encode = (p: BotParams): number[] => PARAM_KEYS.map((k) => (p[k] - PARAM_SPEC[k][0]) / (PARAM_SPEC[k][1] - PARAM_SPEC[k][0]));
export const decode = (x: number[]): BotParams => {
  if (x.length !== PARAM_KEYS.length) throw new Error(`decode: got ${x.length} values for ${PARAM_KEYS.length} params`);
  return sanitize(Object.fromEntries(PARAM_KEYS.map((k, i) => [k, PARAM_SPEC[k][0] + Math.min(1, Math.max(0, x[i])) * (PARAM_SPEC[k][1] - PARAM_SPEC[k][0])])));
};
