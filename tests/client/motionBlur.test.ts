import { describe, expect, test } from 'vitest';
import { BLUR_EXPOSURE, BLUR_HOLD, type BlurInput, blurParams, KILLCAM_BLUR } from '../../src/client/world/motionBlur';
import { defaultSettings, sanitizeSettings } from '../../src/client/settings/store';

const base: BlurInput = { ctx: 'play', play: 'off', spectate: 'auto', quality: 'ultra', competitive: false, reducedMotion: false, saver: false, killcamSlow: 0 };
const off = { exposure: 0, radial: 0, hold: 0 };

describe('motion blur', () => {
  test('defaults: off while playing, on while spectating (auto: Low on High, High on Ultra)', () => {
    const d = defaultSettings().video;
    expect(d.motionBlur).toBe('off');
    expect(d.motionBlurSpectate).toBe('auto');
    expect(blurParams({ ...base, play: d.motionBlur })).toEqual(off);
    expect(blurParams({ ...base, ctx: 'spectate' }).exposure).toBe(BLUR_EXPOSURE.high);
    expect(blurParams({ ...base, ctx: 'spectate', quality: 'high' }).exposure).toBe(BLUR_EXPOSURE.low);
  });

  test('levels map to a fixed exposure (frame-rate independent) with the context hold', () => {
    expect(blurParams({ ...base, play: 'low' })).toEqual({ exposure: BLUR_EXPOSURE.low, radial: 0, hold: BLUR_HOLD.play });
    expect(blurParams({ ...base, play: 'high' })).toEqual({ exposure: BLUR_EXPOSURE.high, radial: 0, hold: BLUR_HOLD.play });
    expect(blurParams({ ...base, ctx: 'spectate', spectate: 'off' })).toEqual(off);
    expect(blurParams({ ...base, ctx: 'spectate', spectate: 'low', quality: 'ultra' }).exposure).toBe(BLUR_EXPOSURE.low);
    expect(BLUR_EXPOSURE.low).toBeLessThan(BLUR_EXPOSURE.high);
  });

  test('killcam keeps its own slow-motion blur, whatever the live settings', () => {
    expect(blurParams({ ...base, ctx: 'killcam', play: 'high', spectate: 'high' })).toEqual(off);
    expect(blurParams({ ...base, ctx: 'killcam', killcamSlow: 1 })).toEqual({ exposure: KILLCAM_BLUR.exposure, radial: KILLCAM_BLUR.radial, hold: 0 });
    expect(blurParams({ ...base, ctx: 'killcam', killcamSlow: 0.5 }).exposure).toBeCloseTo(KILLCAM_BLUR.exposure / 2);
  });

  test('forced off: Low preset, Competitive mode, reduced motion, power saver', () => {
    const on = { ...base, play: 'high' as const };
    for (const p of [{ quality: 'low' as const }, { competitive: true }, { reducedMotion: true }, { saver: true }]) {
      expect(blurParams({ ...on, ...p })).toEqual(off);
      expect(blurParams({ ...on, ...p, ctx: 'spectate' })).toEqual(off);
      expect(blurParams({ ...on, ...p, ctx: 'killcam', killcamSlow: 1 })).toEqual(off);
    }
  });

  test('settings sanitize: unknown levels fall back to the defaults, valid ones stick', () => {
    const raw = { ...defaultSettings(), video: { ...defaultSettings().video, motionBlur: 'max', motionBlurSpectate: 'high' } };
    const s = sanitizeSettings(raw);
    expect(s.video.motionBlur).toBe('off');
    expect(s.video.motionBlurSpectate).toBe('high');
  });
});
