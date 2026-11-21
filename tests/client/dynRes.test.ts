import { describe, expect, test } from 'vitest';
import { DynamicResolution, DYNRES } from '../../src/client/dynRes';

/** Feed `sec` seconds of frames at `ms` each; returns the scale after. */
function run(d: DynamicResolution, ms: number, sec: number, budgetMs = 1000 / 60): number {
  for (let t = 0; t < sec * 1000; t += ms) d.frame(ms, budgetMs);
  return d.scale;
}

describe('dynamic resolution', () => {
  test('holds full scale while frames meet the budget', () => {
    const d = new DynamicResolution();
    expect(run(d, 16.7, 10)).toBe(1);
  });

  test('a single hitch does not drop the scale', () => {
    const d = new DynamicResolution();
    run(d, 16.7, 2);
    d.frame(120, 1000 / 60);
    expect(run(d, 16.7, 2)).toBe(1);
  });

  test('sustained slow frames step the scale down, never below the minimum', () => {
    const d = new DynamicResolution();
    expect(run(d, 33.3, 1.5)).toBeLessThan(1);
    expect(run(d, 33.3, 60)).toBe(DYNRES.minScale);
  });

  test('steps are spaced by the cooldown (one step per cooldown at most)', () => {
    const d = new DynamicResolution();
    const changes: number[] = [];
    let t = 0, last = d.scale;
    for (; t < 5000; t += 33.3) { d.frame(33.3, 1000 / 60); if (d.scale !== last) { changes.push(t); last = d.scale; } }
    for (let i = 1; i < changes.length; i++) expect(changes[i] - changes[i - 1]).toBeGreaterThanOrEqual(DYNRES.cooldownSec * 1000 - 40);
  });

  test('restores in small steps once frames are back under budget for a while', () => {
    const d = new DynamicResolution();
    run(d, 33.3, 10);
    const low = d.scale;
    expect(run(d, 16.7, 1)).toBe(low); // not immediately
    const after = run(d, 16.7, DYNRES.raiseAfterSec + 0.5);
    expect(after).toBeGreaterThan(low);
    expect(after - low).toBeLessThanOrEqual(DYNRES.upStep + 1e-9);
    expect(run(d, 16.7, 120)).toBe(1);
  });

  test('hysteresis: a raise that immediately overloads backs off for longer each time (no oscillation)', () => {
    const d = new DynamicResolution();
    // GPU-bound so that scale 0.8 is fine but 0.85+ is too slow: frame cost ∝ pixel count.
    const costAt = (s: number) => (s > 0.8 + 1e-9 ? 26 : 16.7);
    let changes = 0, last = d.scale;
    for (let t = 0; t < 120_000; ) {
      const ms = costAt(d.scale);
      d.frame(ms, 1000 / 60);
      t += ms;
      if (d.scale !== last) { changes++; last = d.scale; }
    }
    // Without backoff this would flip every few seconds (~40+ changes in 2 min).
    expect(changes).toBeLessThan(14);
    expect(d.scale).toBeLessThanOrEqual(0.85 + 1e-9);
  });

  test('disabled: scale is 1 and frames are ignored', () => {
    const d = new DynamicResolution();
    run(d, 40, 5);
    d.enabled = false;
    expect(d.scale).toBe(1);
    expect(run(d, 40, 5)).toBe(1);
  });

  test('long gaps (tab hidden, breakpoints) are ignored', () => {
    const d = new DynamicResolution();
    for (let i = 0; i < 20; i++) d.frame(1500, 1000 / 60);
    expect(d.scale).toBe(1);
  });
});
