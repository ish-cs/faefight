/**
 * Day/night cycle (pure; dayNight.ts applies it). The match starts in late-morning daylight and the light runs down
 * with match time: afternoon → golden hour → sunset → dusk → night, reached exactly at sudden death (the storm). The
 * phase is a pure function of match time and the match's sudden-death time (lobby setting), so every client, the
 * spectators and replays see the same sky at the same moment. Bots don't see light: nothing here touches the sim.
 */

export const DAY_CYCLE = {
  /** The key light (sun / moon, the shadow caster) moves in steps this long (s of match time), not every frame. */
  lightStepSec: 3,
  /** Phase where the key light swaps from the sun (gone below the horizon) to the moon, both near zero intensity. */
  moonAt: 0.885,
  /** Lowest the sun's light goes (deg): a light at the horizon would cast endless shadows; it is ~dark by then. */
  minLightElev: 4,
  /** The moon: fixed high in the opposite sky (deg). */
  moonElev: 40, moonAz: 238,
  /** Dock / street lamps fade in across this phase window (dusk). */
  lampsOn: [0.76, 0.84] as const,
  /** Night factor (moonlight, stars, brighter muzzle flashes and lightning) ramps over this window. */
  nightIn: [0.8, 0.94] as const,
  /** Blue hour: a deep blue afterglow over the (by then black) sky dome, in after sunset and gone into the night. */
  twilightIn: [0.78, 0.85] as const, twilightOut: [0.9, 0.98] as const,
};

/** One keyframe. Colours are 0xRRGGBB (sRGB), lerped per channel. */
type Key = {
  p: number;
  /** sun elevation / azimuth (deg): drives the sky dome; the light follows it until moonAt */
  elev: number; az: number;
  /** key light intensity + colour (sun until moonAt, then the moon) */
  light: number; lightC: number;
  skyGain: number; skySat: number;
  haze: number; hazeSun: number; density: number;
  env: number; exposure: number;
};

// p = 0 is today's look (sky.ts: sun 38° at azimuth 58°, intensity 6, haze, env 0.8, exposure 0.5).
const KEYS: Key[] = [
  { p: 0, elev: 38, az: 58, light: 6, lightC: 0xffe9cc, skyGain: 0.7, skySat: 1.12, haze: 0x9fc0dc, hazeSun: 0xf4dcb4, density: 0.0011, env: 0.8, exposure: 0.5 },
  { p: 0.45, elev: 27, az: 52, light: 6, lightC: 0xffe4c2, skyGain: 0.7, skySat: 1.12, haze: 0xa3bfd6, hazeSun: 0xf6d6a8, density: 0.0011, env: 0.78, exposure: 0.5 },
  { p: 0.68, elev: 10, az: 47, light: 4.8, lightC: 0xffb878, skyGain: 0.74, skySat: 1.25, haze: 0xc8b4a0, hazeSun: 0xffb070, density: 0.00125, env: 0.6, exposure: 0.52 },
  { p: 0.8, elev: 2.5, az: 43, light: 2.4, lightC: 0xff9454, skyGain: 0.85, skySat: 1.25, haze: 0xa88a80, hazeSun: 0xff9a5c, density: 0.0013, env: 0.4, exposure: 0.56 },
  { p: 0.86, elev: -4, az: 40, light: 0.5, lightC: 0xff7a4a, skyGain: 1, skySat: 1.15, haze: 0x5a5670, hazeSun: 0x8a6070, density: 0.0014, env: 0.22, exposure: 0.6 },
  { p: DAY_CYCLE.moonAt, elev: -8, az: 39, light: 0.04, lightC: 0x90a6d8, skyGain: 1, skySat: 1, haze: 0x343c56, hazeSun: 0x4a4660, density: 0.0015, env: 0.16, exposure: 0.62 },
  { p: 0.94, elev: -16, az: 36, light: 0.6, lightC: 0x9fb4e0, skyGain: 1, skySat: 0.9, haze: 0x1e2a3e, hazeSun: 0x2a3650, density: 0.0016, env: 0.12, exposure: 0.64 },
  { p: 1, elev: -24, az: 33, light: 0.75, lightC: 0xa4b8e4, skyGain: 1, skySat: 0.85, haze: 0x1a2436, hazeSun: 0x26324a, density: 0.0016, env: 0.11, exposure: 0.66 },
];

export type Rgb = [number, number, number];

/** Everything the renderer sets for one moment of the cycle (colours as sRGB 0..1 triples). */
export type DayLook = {
  /** sun elevation / azimuth for the sky dome, haze glow and lens flare (deg; below 0 = set) */
  sunElev: number; sunAz: number;
  light: number; lightC: Rgb;
  skyGain: number; skySat: number;
  haze: Rgb; hazeSun: Rgb; density: number;
  env: number; exposure: number;
  /** 0 → 1: lamps off → on */
  lamps: number;
  /** 0 → 1: day → night (moon, stars, brighter flashes) */
  night: number;
  /** 0 → 1 → 0: blue-hour sky glow around dusk */
  twilight: number;
};

const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const hexRgb = (h: number, out: Rgb): Rgb => { out[0] = ((h >> 16) & 255) / 255; out[1] = ((h >> 8) & 255) / 255; out[2] = (h & 255) / 255; return out; };
const tmpA: Rgb = [0, 0, 0], tmpB: Rgb = [0, 0, 0];
function lerpHex(a: number, b: number, t: number, out: Rgb): Rgb {
  hexRgb(a, tmpA); hexRgb(b, tmpB);
  for (let i = 0; i < 3; i++) out[i] = tmpA[i] + (tmpB[i] - tmpA[i]) * t;
  return out;
}

/** Cycle position: 0 at match start → 1 at sudden death (held after). No sudden-death time (practice) = day. */
export function dayPhase(time: number, suddenDeathAt: number | null): number {
  if (suddenDeathAt === null || !(suddenDeathAt > 0) || !Number.isFinite(time)) return 0;
  return clamp01(time / suddenDeathAt);
}

/** The phase the key light / shadows use: the phase at the start of the current light step. */
export function lightStepPhase(time: number, suddenDeathAt: number | null): number {
  if (suddenDeathAt === null || !(suddenDeathAt > 0)) return 0;
  return dayPhase(Math.floor(Math.max(0, time) / DAY_CYCLE.lightStepSec) * DAY_CYCLE.lightStepSec, suddenDeathAt);
}

export function newDayLook(): DayLook {
  return { sunElev: 0, sunAz: 0, light: 0, lightC: [0, 0, 0], skyGain: 0, skySat: 0, haze: [0, 0, 0], hazeSun: [0, 0, 0], density: 0, env: 0, exposure: 0, lamps: 0, night: 0, twilight: 0 };
}

/**
 * The look at `phase`. `competitive` (Settings → Video) keeps the night brighter: more moonlight and ambient, a
 * little more exposure, so players stay readable; the day is unchanged.
 */
export function dayLook(phase: number, competitive = false, out: DayLook = newDayLook()): DayLook {
  const p = clamp01(phase);
  let i = 0;
  while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp01((p - a.p) / (b.p - a.p));
  out.sunElev = lerp(a.elev, b.elev, t);
  out.sunAz = lerp(a.az, b.az, t);
  out.light = lerp(a.light, b.light, t);
  lerpHex(a.lightC, b.lightC, t, out.lightC);
  out.skyGain = lerp(a.skyGain, b.skyGain, t);
  out.skySat = lerp(a.skySat, b.skySat, t);
  lerpHex(a.haze, b.haze, t, out.haze);
  lerpHex(a.hazeSun, b.hazeSun, t, out.hazeSun);
  out.density = lerp(a.density, b.density, t);
  out.env = lerp(a.env, b.env, t);
  out.exposure = lerp(a.exposure, b.exposure, t);
  out.lamps = smooth(DAY_CYCLE.lampsOn[0], DAY_CYCLE.lampsOn[1], p);
  out.night = smooth(DAY_CYCLE.nightIn[0], DAY_CYCLE.nightIn[1], p);
  out.twilight = smooth(DAY_CYCLE.twilightIn[0], DAY_CYCLE.twilightIn[1], p) * (1 - smooth(DAY_CYCLE.twilightOut[0], DAY_CYCLE.twilightOut[1], p));
  if (competitive) {
    const n = out.night;
    out.env += (0.34 - out.env) * 0.6 * n;
    out.exposure += 0.08 * n;
    if (p >= DAY_CYCLE.moonAt) out.light *= 1 + 0.9 * n;
  }
  return out;
}

/** Key light direction (elevation / azimuth, deg) at `phase`: the sun, clamped above the horizon, then the moon. */
export function lightAngles(phase: number): { elev: number; az: number; moon: boolean } {
  const p = clamp01(phase);
  if (p >= DAY_CYCLE.moonAt) return { elev: DAY_CYCLE.moonElev, az: DAY_CYCLE.moonAz, moon: true };
  const l = dayLook(p, false, scratch);
  return { elev: Math.max(DAY_CYCLE.minLightElev, l.sunElev), az: l.sunAz, moon: false };
}
const scratch = newDayLook();
