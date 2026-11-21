import { describe, expect, test } from 'vitest';
import { applyStep, FrameGovernor, FULL_KNOBS, GOVERNOR, type GovernorKnobs, RES_MIN } from '../../src/client/governor';

const BUDGET = 1000 / 60;
/** Feed `sec` seconds of frames of `ms` each, with `work` ms of main-thread time per frame (default: all of it). */
function run(g: FrameGovernor, ms: number, sec: number, work = ms): GovernorKnobs {
  for (let t = 0; t < sec * 1000; t += ms) g.frame(ms, BUDGET, work);
  return g.knobs;
}
/** Feed frames until the knobs change (or `maxSec`); returns seconds taken (Infinity = none). */
function untilChange(g: FrameGovernor, ms: number, work = ms, maxSec = 60): number {
  for (let t = 0; t < maxSec * 1000; t += ms) if (g.frame(ms, BUDGET, work)) return (t + ms) / 1000;
  return Infinity;
}
const downSeq = (g: FrameGovernor, ms: number, work: number, n: number) => {
  const seq: GovernorKnobs[] = [];
  for (let i = 0; i < n; i++) { expect(untilChange(g, ms, work)).toBeLessThan(5); seq.push(g.knobs); }
  return seq;
};

describe('frame-time governor', () => {
  test('stays at full quality while frames meet the budget', () => {
    const g = new FrameGovernor();
    run(g, 16, 20);
    expect(g.level).toBe(0);
    expect(g.knobs).toEqual(FULL_KNOBS);
  });

  test('a single hitch changes nothing', () => {
    const g = new FrameGovernor();
    run(g, 16, 2);
    g.frame(200, BUDGET);
    run(g, 16, 2);
    expect(g.level).toBe(0);
  });

  test('GPU-bound (main thread mostly idle): render scale drops first, in small steps, AO only gets cheaper', () => {
    const g = new FrameGovernor();
    const seq = downSeq(g, 30, 5, 3);
    expect(g.gpuBound).toBe(true);
    expect(seq[0]).toEqual({ ...FULL_KNOBS, res: 0.95 });
    expect(seq[1]).toEqual({ ...FULL_KNOBS, res: 0.9 });
    expect(seq[2]).toEqual({ ...FULL_KNOBS, res: 0.9, ao: 1 }); // cheaper GTAO, never off
    for (const k of seq) { expect(k.shadowScale).toBe(1); expect(k.grass).toBe(1); expect(k.lodBias).toBe(1); }
  });

  test('CPU-bound (main thread fills the frame): draw-side knobs first, resolution last', () => {
    const g = new FrameGovernor();
    const seq = downSeq(g, 30, 30, 5);
    expect(g.gpuBound).toBe(false);
    expect(seq[0].lodBias).toBeLessThan(1);
    expect(seq[1].grass).toBeLessThan(1);
    expect(seq[2].shadowScale).toBe(0.5);
    expect(seq[3].ao).toBe(1);
    expect(seq[4].ao).toBe(2);
    for (const k of seq) expect(k.res).toBe(1);
  });

  test('render-scale steps follow each other faster than effect steps (smooth descent)', () => {
    const g = new FrameGovernor();
    untilChange(g, 30, 5); // res 0.95
    const t = untilChange(g, 30, 5); // res 0.9: res cooldown
    expect(t).toBeLessThan(GOVERNOR.cooldownSec);
  });

  test('sustained overload bottoms out, never below the minimum scale, AO never off', () => {
    const g = new FrameGovernor();
    run(g, 40, 120, 5);
    expect(g.knobs.res).toBeCloseTo(RES_MIN, 5);
    expect(g.knobs.ao).toBe(2);
    expect(untilChange(g, 40, 5, 10)).toBe(Infinity);
  });

  test('steps back up with headroom, last in first out, to full quality', () => {
    const g = new FrameGovernor();
    run(g, 40, 120, 5);
    const bottom = g.level;
    const before = g.knobs;
    expect(untilChange(g, 8, 4)).toBeLessThan(GOVERNOR.raiseAfterSec + 1);
    expect(g.level).toBe(bottom - 1);
    expect(g.knobs).not.toEqual(before);
    run(g, 8, 600, 4);
    expect(g.level).toBe(0);
    expect(g.knobs).toEqual(FULL_KNOBS);
  });

  test('a raise that overloads again is undone and the next raise waits longer', () => {
    const g = new FrameGovernor();
    untilChange(g, 30, 30);
    untilChange(g, 30, 30); // two CPU-side steps down
    expect(g.level).toBe(2);
    const firstWait = untilChange(g, 12, 12);
    expect(g.level).toBe(1);
    expect(untilChange(g, 30, 30)).toBeLessThan(GOVERNOR.failWindowSec);
    expect(g.level).toBe(2);
    const secondWait = untilChange(g, 12, 12);
    expect(g.level).toBe(1);
    expect(secondWait).toBeGreaterThan(firstWait * 1.6);
  });

  test('skipped steps (no AO on this preset) are passed over', () => {
    const g = new FrameGovernor((s) => s === 'ao');
    run(g, 40, 120, 5);
    expect(g.knobs.ao).toBe(0);
    expect(g.knobs.res).toBeCloseTo(RES_MIN, 5);
  });

  test('applyStep limits', () => {
    expect(applyStep({ ...FULL_KNOBS, res: RES_MIN }, 'res')).toBeNull();
    expect(applyStep({ ...FULL_KNOBS, ao: 2 }, 'ao')).toBeNull();
    expect(applyStep({ ...FULL_KNOBS, shadowScale: 0.5 }, 'shadow')).toBeNull();
    expect(applyStep(FULL_KNOBS, 'grass')).toEqual({ ...FULL_KNOBS, grass: 0.5 });
  });

  test('disabled = full knobs, reset = back to the top', () => {
    const g = new FrameGovernor();
    run(g, 40, 10);
    expect(g.level).toBeGreaterThan(0);
    g.enabled = false;
    expect(g.knobs).toEqual(FULL_KNOBS);
    g.enabled = true;
    g.reset();
    expect(g.level).toBe(0);
  });
});
