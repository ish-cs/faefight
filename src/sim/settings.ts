import { ECONOMY, LIFECYCLE } from './constants';

/**
 * Host-chosen match rules ("Game settings" in the lobby). Part of MatchSetup, so a recorded setup
 * replays the same match. Every field defaults to today's constants.
 */
export type GameSettings = {
  /** Cash each player spawns with. */
  startCash: number;
  /** Match time (s) when sudden death begins (whatever sudden death does: tide, storm…). */
  suddenDeathSec: number;
  /** Multiplier on every generator's speed (home cash, center gold, center supply). */
  genMult: number;
};

export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  startCash: ECONOMY.startCash,
  suddenDeathSec: LIFECYCLE.suddenDeathAt,
  genMult: 1,
});

/** Slider ranges. Defaults sit on a step (tested). */
export const SETTING_RANGES: Readonly<Record<keyof GameSettings, { min: number; max: number; step: number }>> = Object.freeze({
  startCash: { min: 0, max: 1000, step: 10 },
  suddenDeathSec: { min: 8 * 60, max: 25 * 60, step: 60 },
  genMult: { min: 0.5, max: 2, step: 0.25 },
});

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof GameSettings)[];

/** One value: non-number / NaN → default; clamped to the range and snapped to the step. */
export function clampSetting(key: keyof GameSettings, x: unknown): number {
  const { min, max, step } = SETTING_RANGES[key];
  if (typeof x !== 'number' || !Number.isFinite(x)) return DEFAULT_SETTINGS[key];
  const v = Math.min(max, Math.max(min, x));
  const snapped = min + Math.round((v - min) / step) * step;
  // Avoid 0.30000000000000004-style float noise from the step arithmetic.
  return Math.min(max, Math.round(snapped * 1000) / 1000);
}

/** Settings from anything (untrusted peer, localStorage, old recording): missing fields take defaults, the rest clamp. */
export function clampSettings(x: unknown): GameSettings {
  const o = typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  return {
    startCash: clampSetting('startCash', o.startCash),
    suddenDeathSec: clampSetting('suddenDeathSec', o.suddenDeathSec),
    genMult: clampSetting('genMult', o.genMult),
  };
}

export const sameSettings = (a: GameSettings, b: GameSettings) => SETTING_KEYS.every((k) => a[k] === b[k]);

/** Palette size (ISLAND_COLORS on the client). */
export const COLOR_COUNT = 8;
export const isColor = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < COLOR_COUNT;

/**
 * Palette index per player. A valid pick nobody earlier took is kept; everyone else gets the lowest
 * free colour in order. Nobody picking = 0, 1, 2… (today's island colours).
 */
export function resolveColors(picks: (number | null | undefined)[]): number[] {
  const out: (number | null)[] = picks.map(() => null);
  const used = new Set<number>();
  picks.forEach((c, i) => { if (isColor(c) && !used.has(c)) { out[i] = c; used.add(c); } });
  let next = 0;
  return out.map((c) => {
    if (c !== null) return c;
    while (used.has(next)) next++;
    used.add(next);
    return next % COLOR_COUNT;
  });
}
