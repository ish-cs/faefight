import { describe, expect, test } from 'vitest';
import { DAY_CYCLE, dayLook, dayPhase, lightAngles, lightStepPhase } from '../../src/client/world/dayCycle';

describe('day/night cycle', () => {
  test('phase runs from 0 at match start to 1 at sudden death and holds', () => {
    expect(dayPhase(0, 900)).toBe(0);
    expect(dayPhase(450, 900)).toBe(0.5);
    expect(dayPhase(900, 900)).toBe(1);
    expect(dayPhase(1300, 900)).toBe(1);
    expect(dayPhase(-5, 900)).toBe(0);
  });

  test('follows the lobby sudden-death setting', () => {
    expect(dayPhase(480, 480)).toBe(1);
    expect(dayPhase(480, 1500)).toBeCloseTo(0.32);
  });

  test('no sudden death (practice) or bad input stays day', () => {
    expect(dayPhase(5000, null)).toBe(0);
    expect(dayPhase(100, 0)).toBe(0);
    expect(dayPhase(NaN, 900)).toBe(0);
  });

  test('phase 0 is the existing daytime look', () => {
    expect(dayLook(0).twilight).toBe(0);
    expect(dayLook(1).twilight).toBe(0);
    expect(dayLook(0.87).twilight).toBeGreaterThan(0.9);
    const l = dayLook(0);
    expect(l.sunElev).toBe(38);
    expect(l.sunAz).toBe(58);
    expect(l.light).toBe(6);
    expect(l.env).toBe(0.8);
    expect(l.exposure).toBe(0.5);
    expect(l.skyGain).toBe(0.7);
    expect(l.density).toBe(0.0011);
    expect(l.lamps).toBe(0);
    expect(l.night).toBe(0);
  });

  test('it gets darker as the match goes on: sun lower, less ambient, lamps on by night', () => {
    let prevElev = Infinity, prevEnv = Infinity;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const l = dayLook(p);
      expect(l.sunElev).toBeLessThanOrEqual(prevElev);
      expect(l.env).toBeLessThanOrEqual(prevEnv + 1e-9);
      prevElev = l.sunElev; prevEnv = l.env;
    }
    const night = dayLook(1);
    expect(night.sunElev).toBeLessThan(0);
    expect(night.night).toBe(1);
    expect(night.lamps).toBe(1);
    expect(night.light).toBeLessThan(1); // moonlight
    expect(dayLook(0.5).lamps).toBe(0);
  });

  test('the key light swaps sun → moon only when it is nearly dark (no visible shadow jump)', () => {
    const before = dayLook(DAY_CYCLE.moonAt - 1e-6), at = dayLook(DAY_CYCLE.moonAt);
    expect(before.light).toBeLessThan(0.1);
    expect(at.light).toBeLessThan(0.1);
    expect(lightAngles(DAY_CYCLE.moonAt - 0.01).moon).toBe(false);
    expect(lightAngles(DAY_CYCLE.moonAt).moon).toBe(true);
    expect(lightAngles(1)).toEqual({ elev: DAY_CYCLE.moonElev, az: DAY_CYCLE.moonAz, moon: true });
  });

  test('the sun light never goes below the minimum elevation', () => {
    for (let p = 0; p < DAY_CYCLE.moonAt; p += 0.01) expect(lightAngles(p).elev).toBeGreaterThanOrEqual(DAY_CYCLE.minLightElev);
  });

  test('the light moves in steps of lightStepSec', () => {
    const s = DAY_CYCLE.lightStepSec;
    expect(lightStepPhase(0, 900)).toBe(0);
    expect(lightStepPhase(s - 0.01, 900)).toBe(0);
    expect(lightStepPhase(s, 900)).toBeCloseTo(s / 900);
    expect(lightStepPhase(s * 2 + 1, 900)).toBeCloseTo((2 * s) / 900);
    expect(lightStepPhase(5000, null)).toBe(0);
  });

  test('competitive keeps the night brighter, the day unchanged', () => {
    expect(dayLook(0, true)).toEqual(dayLook(0, false));
    const n = dayLook(1, false), c = dayLook(1, true);
    expect(c.env).toBeGreaterThan(n.env);
    expect(c.exposure).toBeGreaterThan(n.exposure);
    expect(c.light).toBeGreaterThan(n.light);
  });
});
