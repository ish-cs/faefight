import { describe, expect, it } from 'vitest';
import { flashStyle, monotonicFlash } from '../../src/client/screenFx';
import { smokeDepth } from '../../src/client/world/smokeFx';
import { defaultSettings, sanitizeSettings } from '../../src/client/settings/store';
import { SMOKE } from '../../src/sim/constants';
import type { SmokeCloud } from '../../src/sim/types';
import { flashAlpha, inSmoke, smokeCenter } from '../../src/sim/utility';

describe('flash overlay', () => {
  it('is white at full strength, a dim grey (≤ 0.85) with Reduced flash', () => {
    expect(flashStyle(1, false)).toEqual({ color: '#ffffff', opacity: 1 });
    expect(flashStyle(0.5, false).opacity).toBe(0.5);
    const r = flashStyle(1, true);
    expect(r.color).toBe('#777777');
    expect(r.opacity).toBeLessThanOrEqual(0.85);
    expect(flashStyle(0, true).opacity).toBe(0);
  });

  it('only fades while one blind lasts (never brightens again, never flickers); a new flash may brighten it', () => {
    let shown = 0, at: number | null = null;
    const seq = [1, 1, 0.8, 0.9, 0.6, 0.7, 0.3, 0];
    const out: number[] = [];
    for (const a of seq) { shown = monotonicFlash(a, 10, shown, at); at = 10; out.push(shown); }
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThanOrEqual(out[i - 1]);
    expect(monotonicFlash(1, 20, 0.2, 10)).toBe(1); // a new blind
    expect(monotonicFlash(0.5, null, 0.7, 10)).toBe(0); // no blind
  });

  it('follows the sim flashAlpha: white for the hold, then a monotonic fade to 0', () => {
    const blind = { at: 5, k: 1 };
    let prev = Infinity;
    for (let t = 5; t <= 10; t += 0.05) {
      const a = flashAlpha(blind, t);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
    expect(flashAlpha(blind, 10)).toBe(0);
  });

  it('Reduced flash setting: off by default, kept when set, junk falls back to off', () => {
    expect(defaultSettings().gameplay.reducedFlash).toBe(false);
    expect(sanitizeSettings({ gameplay: { reducedFlash: true } }).gameplay.reducedFlash).toBe(true);
    expect(sanitizeSettings({ gameplay: { reducedFlash: 'yes' } }).gameplay.reducedFlash).toBe(false);
  });
});

describe('smoke fog depth', () => {
  const cloud: SmokeCloud = { id: 1, owner: 2, pos: { x: 0, y: 0, z: 0 }, t0: 0 };
  const mid = smokeCenter(cloud);

  it('is 1 deep in a full cloud, 0 outside, and agrees with the sim inSmoke', () => {
    const t = 5;
    expect(smokeDepth([cloud], mid, t)).toBe(1);
    expect(smokeDepth([cloud], { x: SMOKE.radius + 1, y: mid.y, z: 0 }, t)).toBe(0);
    expect(smokeDepth(undefined, mid, t)).toBe(0);
    const edge = { x: SMOKE.radius * 0.8, y: mid.y, z: 0 };
    const k = smokeDepth([cloud], edge, t);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(1);
    expect(inSmoke([cloud], edge, t)).toBe(true);
  });

  it('thins out with the cloud and is gone when it ends', () => {
    expect(smokeDepth([cloud], mid, SMOKE.lifeSec - SMOKE.thinSec / 2)).toBeCloseTo(0.5, 5);
    expect(smokeDepth([cloud], mid, SMOKE.lifeSec)).toBe(0);
  });
});
