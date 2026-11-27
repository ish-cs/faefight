import { describe, expect, it } from 'vitest';
import { POWER, PowerState, SAVER_TRIM } from '../../src/client/power';
import { FULL_KNOBS } from '../../src/client/governor';

const BUDGET_120 = 1000 / 120;
/** feed `sec` seconds of frames of `ms` interval and `work` main-thread ms; returns how often saver changed */
const run = (p: PowerState, sec: number, ms: number, work: number, budget = BUDGET_120) => {
  let changes = 0;
  for (let t = 0; t < sec * 1000; t += ms) if (p.frame(ms, work, budget)) changes++;
  return changes;
};

/** feed frames until saver flips; returns the seconds it took (Infinity if it never did) */
const until = (p: PowerState, maxSec: number, ms: number, work: number, budget = BUDGET_120) => {
  const was = p.saver;
  for (let t = 0; t < maxSec * 1000; t += ms) { p.frame(ms, work, budget); if (p.saver !== was) return (t + ms) / 1000; }
  return Infinity;
};

describe('PowerState', () => {
  it('quality never saves, performance always does', () => {
    const p = new PowerState();
    p.mode = 'quality'; p.onBattery = true;
    run(p, 20, 40, 30);
    expect(p.saver).toBe(false);
    p.mode = 'performance'; p.onBattery = false;
    expect(p.saver).toBe(true);
  });

  it('auto saves on battery at once and stops when plugged in', () => {
    const p = new PowerState();
    expect(p.saver).toBe(false);
    p.onBattery = true;
    expect(p.saver).toBe(true);
    expect(p.reason).toBe('battery');
    p.onBattery = false;
    expect(p.saver).toBe(false);
  });

  it('auto enters on sustained slowness only (a short burst does not)', () => {
    const p = new PowerState();
    run(p, 10, BUDGET_120, 4);
    run(p, POWER.slowSec - 1.5, 20, 15);
    run(p, 3, BUDGET_120, 4);
    expect(p.saver).toBe(false);
    expect(run(p, POWER.slowSec + 2, 20, 15)).toBe(1);
    expect(p.saver).toBe(true);
    expect(p.reason).toBe('slow frames');
  });

  it('holds at least holdSec, then leaves after exitSec of main-thread headroom', () => {
    const p = new PowerState();
    run(p, POWER.slowSec + 2, 20, 15);
    expect(p.saver).toBe(true);
    // capped at 60 with plenty of headroom: held until holdSec (entered ~1.7 s before this phase)
    const t = until(p, 60, 1000 / 60, 2);
    expect(t).toBeGreaterThan(POWER.holdSec - 3);
    expect(t).toBeLessThan(POWER.holdSec);
    expect(p.saver).toBe(false);
  });

  it('does not leave while the main thread stays busy', () => {
    const p = new PowerState();
    run(p, POWER.slowSec + 2, 20, 15);
    run(p, POWER.holdSec + POWER.exitSec + 10, 1000 / 60, 9);
    expect(p.saver).toBe(true);
  });

  it('a quick re-entry doubles the hold (no flapping)', () => {
    const p = new PowerState();
    run(p, POWER.slowSec + 2, 20, 15);
    until(p, 60, 1000 / 60, 2);
    expect(p.saver).toBe(false);
    // uncapped, frames are still slow: back in, and this time held twice as long
    expect(until(p, 20, 20, 15)).toBeLessThan(POWER.slowSec + 2);
    expect(p.saver).toBe(true);
    const t = until(p, 120, 1000 / 60, 2);
    expect(t).toBeGreaterThan(2 * POWER.holdSec - 1);
    expect(t).toBeLessThan(2 * POWER.holdSec + 1);
  });

  it('caps: saver → 60 (or the lower user cap), menus → 30, plugged → user cap', () => {
    const p = new PowerState();
    expect(p.cap(0, false)).toBe(0);
    expect(p.cap(120, false)).toBe(120);
    expect(p.cap(0, true)).toBe(POWER.idleCapHz);
    p.onBattery = true;
    expect(p.cap(0, false)).toBe(60);
    expect(p.cap(120, false)).toBe(60);
    expect(p.cap(30, false)).toBe(30);
    expect(p.cap(0, true)).toBe(POWER.idleCapHz);
  });

  it('trims only while saving, never below the governor', () => {
    const p = new PowerState();
    expect(p.trim(FULL_KNOBS)).toBe(FULL_KNOBS);
    p.mode = 'performance';
    const t = p.trim(FULL_KNOBS);
    expect(t).toEqual({ ao: SAVER_TRIM.ao, shadowScale: 1, grass: SAVER_TRIM.grass, lodBias: SAVER_TRIM.lodBias, res: SAVER_TRIM.resMax });
    const deeper = p.trim({ ao: 2, shadowScale: 0.5, grass: 0.5, lodBias: 0.7, res: 0.6 });
    expect(deeper).toEqual({ ao: 2, shadowScale: 0.5, grass: 0.5, lodBias: 0.7, res: 0.6 });
  });
});
