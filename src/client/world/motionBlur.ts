import type { Quality } from './sky';

/**
 * Motion blur (Settings → Video): which blur a frame gets. Pure, so it's unit-tested; post.ts's `cameraBlur` draws it.
 *
 * - Killcam: its own slow-motion blur (strength = the slow-mo amount), as before.
 * - Playing: Settings "Motion blur (playing)", default Off (competitive clarity).
 * - Spectating (free-fly, follow cam, cinematic director): "Motion blur (spectating)", default Auto = Low on High,
 *   High on Ultra.
 * Never on Low or in Competitive mode (the blur pass isn't compiled there), under prefers-reduced-motion, or while the
 * power saver trims effects.
 */
export const BLUR_LEVELS = ['off', 'low', 'high'] as const;
export type BlurLevel = (typeof BLUR_LEVELS)[number];
export const SPECTATE_BLUR_LEVELS = ['auto', ...BLUR_LEVELS] as const;
export type SpectateBlurLevel = (typeof SPECTATE_BLUR_LEVELS)[number];
export type BlurContext = 'play' | 'spectate' | 'killcam';

/**
 * Exposure per level (s): a fixed time, so the streak is the same at any frame rate. High = a film camera's 180°
 * shutter at 50 fps; Low = 2.5× shorter (a quick turn just softens).
 */
export const BLUR_EXPOSURE: Record<BlurLevel, number> = { off: 0, low: 1 / 250, high: 1 / 100 };
/** Share of the blur taken back at the crosshair and within a few metres of the camera (see motionBlurNode). */
export const BLUR_HOLD: Record<Exclude<BlurContext, 'killcam'>, number> = { play: 0.85, spectate: 0.6 };
/** Killcam: exposure (s) and radial smear at full slow motion (unchanged from the killcam's own blur). */
export const KILLCAM_BLUR = { exposure: 1 / 24, radial: 0.045 };

export type BlurInput = {
  ctx: BlurContext;
  play: BlurLevel;
  spectate: SpectateBlurLevel;
  quality: Quality;
  competitive: boolean;
  reducedMotion: boolean;
  /** power saver active (power.ts, once it exists on main) */
  saver: boolean;
  /** killcam slow-motion amount, 0–1 */
  killcamSlow: number;
};
export type BlurParams = { exposure: number; radial: number; hold: number };

const OFF: BlurParams = { exposure: 0, radial: 0, hold: 0 };

/** Whether the preset compiles the blur pass at all (sky.ts: high / ultra, not competitive). */
export const blurAvailable = (quality: Quality, competitive: boolean) => quality !== 'low' && !competitive;

export function blurParams(i: BlurInput): BlurParams {
  if (!blurAvailable(i.quality, i.competitive) || i.reducedMotion || i.saver) return OFF;
  if (i.ctx === 'killcam') return i.killcamSlow > 0 ? { exposure: i.killcamSlow * KILLCAM_BLUR.exposure, radial: i.killcamSlow * KILLCAM_BLUR.radial, hold: 0 } : OFF;
  const level: BlurLevel = i.ctx === 'play' ? i.play
    : i.spectate === 'auto' ? (i.quality === 'ultra' ? 'high' : 'low') : i.spectate;
  return level === 'off' ? OFF : { exposure: BLUR_EXPOSURE[level], radial: 0, hold: BLUR_HOLD[i.ctx] };
}
