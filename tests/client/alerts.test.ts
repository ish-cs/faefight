import { describe, expect, test } from 'vitest';
import { ALARM_COOLDOWN_MS, BunkerWatch, GEN_COOLDOWN_MS, GenWatch, RateLimiter, blockedByOthers, genAlertText } from '../../src/client/qol/alerts';
import { DT, ECONOMY } from '../../src/sim/constants';
import { tickGenerator } from '../../src/sim/economy';
import type { Snapshot } from '../../src/sim/types';

describe('RateLimiter', () => {
  test('allows once per gap, per key', () => {
    const r = new RateLimiter(1000);
    expect(r.allow('a', 0)).toBe(true);
    expect(r.allow('a', 999)).toBe(false);
    expect(r.allow('b', 999)).toBe(true);
    expect(r.allow('a', 1000)).toBe(true);
  });
});

describe('BunkerWatch', () => {
  test('first look never alarms; rises by others alarm and escalate at once', () => {
    const w = new BunkerWatch();
    expect(w.update(1, true, 0)).toBeNull(); // joined with a door already blocked
    expect(w.update(0, true, 100)).toBeNull();
    expect(w.update(1, true, 200)).toEqual({ kind: 'alarm', count: 1 });
    expect(w.update(2, true, 210)).toEqual({ kind: 'alarm', count: 2 }); // escalation is never held back
  });
  test('flicker at the same level stays quiet until the cooldown passes', () => {
    const w = new BunkerWatch();
    w.update(0, true, 0);
    expect(w.update(1, true, 1000)).toEqual({ kind: 'alarm', count: 1 });
    let alarms = 0;
    for (let t = 1100; t + 100 < 1000 + ALARM_COOLDOWN_MS; t += 200) {
      if (w.update(0, true, t)) alarms++;
      if (w.update(1, true, t + 100)) alarms++;
    }
    expect(alarms).toBe(0);
    w.update(0, true, 1000 + ALARM_COOLDOWN_MS);
    expect(w.update(1, true, 1000 + ALARM_COOLDOWN_MS + 1)).toEqual({ kind: 'alarm', count: 1 });
  });
  test('your own building never alarms; sealing is left to the seal announcement', () => {
    const w = new BunkerWatch();
    w.update(0, false, 0);
    expect(w.update(1, false, 10)).toBeNull();
    expect(w.update(2, false, 20)).toBeNull();
    expect(w.update(3, true, 30)).toBeNull();
  });
  test('sealed → open says "reopened" once, rate-limited', () => {
    const w = new BunkerWatch();
    w.update(3, true, 0);
    expect(w.update(2, true, 100)).toEqual({ kind: 'reopened' });
    w.update(3, true, 200);
    expect(w.update(2, true, 300)).toBeNull(); // flickering seal: no second toast yet
    w.update(3, true, 6000);
    expect(w.update(1, true, 6100)).toEqual({ kind: 'reopened' });
  });
  test('placements by me only vs by others', () => {
    const s = (by: number[]) => ({ events: by.map((b) => ({ t: 0, type: 'placed', data: { by: b } })) }) as unknown as Snapshot;
    expect(blockedByOthers(s([1]), 1)).toBe(false);
    expect(blockedByOthers(s([1, 2]), 1)).toBe(true);
    expect(blockedByOthers(s([]), 1)).toBe(true); // unattributed
  });
});

describe('GenWatch', () => {
  /** Ticks a level-1 generator from empty at the sim rate; returns the times alerts fired. */
  function run(pct: number, sec: number) {
    const w = new GenWatch();
    let stored = 0;
    const fired: { t: number; kind: string; stored: number }[] = [];
    for (let i = 0; i * DT <= sec; i++) {
      const t = i * DT;
      const a = w.update(stored, 1, pct, t * 1000);
      if (a) fired.push({ t, kind: a.kind, stored: a.stored });
      stored = tickGenerator(stored, DT, true, 1);
    }
    return fired;
  }
  const fullAt = ECONOMY.generatorCap / ECONOMY.generatorRate; // 100 s at level 1

  test('"full" fires once, on the tick the generator reaches its cap', () => {
    const f = run(100, fullAt + 30);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('full');
    expect(f[0].stored).toBe(ECONOMY.generatorCap);
    expect(f[0].t).toBeGreaterThanOrEqual(fullAt);
    expect(f[0].t).toBeLessThanOrEqual(fullAt + 2 * DT);
  });
  test('a lower threshold fires at that amount, then once more when full', () => {
    const f = run(75, fullAt + 10);
    expect(f.map((x) => x.kind)).toEqual(['high', 'full']);
    expect(f[0].t).toBeCloseTo(0.75 * fullAt, 0);
    expect(genAlertText({ kind: 'high', stored: 375, cap: 500 })).toBe('Generator 75%: $375 waiting');
  });
  test('off never fires; collecting re-arms but the toast is still rate-limited', () => {
    expect(run(0, fullAt + 10)).toHaveLength(0);
    const w = new GenWatch();
    w.update(499, 1, 100, 0);
    expect(w.update(500, 1, 100, 1)?.kind).toBe('full');
    expect(w.update(500, 1, 100, 2)).toBeNull(); // still full: nothing new
    w.update(0, 1, 100, 3); // collected
    expect(w.update(500, 1, 100, 4)).toBeNull(); // refilled within the cooldown (debug cash): quiet
    w.update(0, 1, 100, 5);
    expect(w.update(500, 1, 100, 5 + GEN_COOLDOWN_MS)?.kind).toBe('full');
  });
});
