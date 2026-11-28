/**
 * The trainer's view of the bot params (src/sim/bots/params.ts): a flat vector over the tunable keys, normalised to
 * [0,1] by PARAM_RANGES. Only the Hard and PRO tiers are searched: keys with an `easy` or `medium` segment stay at their
 * hand values, so the tier ladder below Hard is untouched. Everything not in the vector comes from DEFAULT_BOT_PARAMS.
 */
import * as params from '../../src/sim/bots/params';
import { DEFAULT_BOT_PARAMS, PARAM_RANGES, flattenParams, withParams, type BotParams } from '../../src/sim/bots/params';

/** Flat overrides over TRAIN_KEYS (`strength.rifleAt.pro` → value). */
export type FlatParams = Record<string, number>;

const LOWER_TIERS = new Set(['easy', 'medium']);
/** Searched keys, in PARAM_RANGES order (the order of the ES vector). */
export const TRAIN_KEYS: readonly string[] = Object.freeze(Object.keys(PARAM_RANGES).filter((k) => !k.split('.').some((s) => LOWER_TIERS.has(s))));

const handFlat = flattenParams(DEFAULT_BOT_PARAMS);
/** Hand-tuned values of the searched keys (generation 0, and the eval's opponent). */
export const HAND_PARAMS: Readonly<FlatParams> = Object.freeze(Object.fromEntries(TRAIN_KEYS.map((k) => {
  const v = handFlat[k];
  if (v === undefined) throw new Error(`train params: ${k} is in PARAM_RANGES but not in flattenParams(DEFAULT_BOT_PARAMS)`);
  return [k, v];
})));

/** Hand params with the `strength.*` knobs off, when params.ts provides them (the human-proxy seat); else the defaults. */
export const PROXY_BOT_PARAMS: Readonly<BotParams> = (params as unknown as { PRE_STRENGTH_PARAMS?: BotParams }).PRE_STRENGTH_PARAMS ?? DEFAULT_BOT_PARAMS;
export const PROXY_HAS_PRE_STRENGTH = PROXY_BOT_PARAMS !== DEFAULT_BOT_PARAMS;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Every searched key, clamped into its box; missing or non-finite entries take the hand value. Other keys are dropped. */
export function sanitize(p: Readonly<Record<string, unknown>>): FlatParams {
  const out: FlatParams = {};
  for (const k of TRAIN_KEYS) {
    const v = p[k], [lo, hi] = PARAM_RANGES[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : clamp(HAND_PARAMS[k], lo, hi);
  }
  return out;
}

/** Flat params → [0,1]^n over TRAIN_KEYS (clamped into the box first). */
export function encode(p: Readonly<FlatParams>): number[] {
  const s = sanitize(p);
  return TRAIN_KEYS.map((k) => { const [lo, hi] = PARAM_RANGES[k]; return hi > lo ? (s[k] - lo) / (hi - lo) : 0; });
}

/** [0,1]^n → flat params (out-of-box coordinates clamp). */
export function decode(x: readonly number[]): FlatParams {
  if (x.length !== TRAIN_KEYS.length) throw new Error(`train params: vector has ${x.length} entries, expected ${TRAIN_KEYS.length} (TRAIN_KEYS changed since this state was saved?)`);
  const out: FlatParams = {};
  TRAIN_KEYS.forEach((k, i) => {
    if (!Number.isFinite(x[i])) throw new Error(`train params: ${k} is ${x[i]} in the vector`);
    const [lo, hi] = PARAM_RANGES[k];
    out[k] = lo + clamp(x[i], 0, 1) * (hi - lo);
  });
  return out;
}

/** BotParams a Bot takes: the hand defaults with the (sanitized) searched keys applied. */
export const toBotParams = (p: Readonly<FlatParams>): BotParams => withParams(sanitize(p), DEFAULT_BOT_PARAMS);
