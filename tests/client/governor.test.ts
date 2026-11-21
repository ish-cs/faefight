import { describe, expect, test } from 'vitest';
import { FrameGovernor, GOVERNOR, GOVERNOR_LADDER, type GovernorKnobs } from '../../src/client/governor';

const BUDGET = 1000 / 60;
function run(g: FrameGovernor, ms: number, sec: number): GovernorKnobs {
  for (let t = 0; t < sec * 1000; t += ms) g.frame(ms, BUDGET);
  return g.knobs;
}
/** Feed frames of `ms` until the knobs change (or `maxSec` passes); returns seconds taken (Infinity = none). */
function untilChange(g: FrameGovernor, ms: number, maxSec = 60): number {
  for (let t = 0; t < maxSec * 1000; t += ms) if (g.frame(ms, BUDGET)) return (t + ms) / 1000;
  return Infinity;
}

describe('frame-time governor', () => {
  test('stays at full quality while frames meet the budget', () => {
    const g = new FrameGovernor();
    run(g, 16, 20);
    expect(g.level).toBe(0);
    expect(g.knobs).toEqual(GOVERNOR_LADDER[0]);
  });

  test('a single hitch changes nothing', () => {
    const g = new FrameGovernor();
    run(g, 16, 2);
    g.frame(200, BUDGET);
    run(g, 16, 2);
    expect(g.level).toBe(0);
  });

  test('steps down effects first: AO, then shadows, then grass, then LOD, resolution last', () => {
    const g = new FrameGovernor();
    const seq: GovernorKnobs[] = [];
    for (let i = 0; i < 6; i++) { expect(untilChange(g, 30)).toBeLessThan(5); seq.push(g.knobs); }
    expect(seq[0].ao).toBe(false);
    expect(seq[0].shadowScale).toBe(1);
    expect(seq[1].shadowScale).toBe(0.5);
    expect(seq[2].grass).toBeLessThan(1);
    expect(seq[3].lodBias).toBeLessThan(1);
    // resolution untouched until every effect rung is used
    for (const k of seq.slice(0, 4)) expect(k.res).toBe(1);
    expect(seq[4].res).toBeLessThan(1);
  });

  test('sustained overload bottoms out at the last rung, never past it', () => {
    const g = new FrameGovernor();
    run(g, 40, 120);
    expect(g.level).toBe(GOVERNOR_LADDER.length - 1);
  });

  test('steps back up with headroom, resolution first (last in, first out)', () => {
    const g = new FrameGovernor();
    run(g, 40, 120);
    const bottom = g.level;
    expect(untilChange(g, 8)).toBeLessThan(GOVERNOR.raiseAfterSec + 1);
    expect(g.level).toBe(bottom - 1);
    expect(g.knobs.ao).toBe(false); // effects come back after resolution
    run(g, 8, 300);
    expect(g.level).toBe(0);
    expect(g.knobs.ao).toBe(true);
  });

  test('a raise that overloads again is undone and the next raise waits longer', () => {
    const g = new FrameGovernor();
    untilChange(g, 30);
    untilChange(g, 30); // two rungs down
    const held = g.level;
    expect(held).toBe(2);
    const firstWait = untilChange(g, 12); // headroom → raise
    expect(g.level).toBe(held - 1);
    expect(untilChange(g, 30)).toBeLessThan(GOVERNOR.failWindowSec); // overload right after → undo
    expect(g.level).toBe(held);
    const secondWait = untilChange(g, 12);
    expect(g.level).toBe(held - 1);
    expect(secondWait).toBeGreaterThan(firstWait * 1.6); // backoff doubled the wait
  });

  test('rungs that change nothing on this preset are passed in one step (AO already off on low)', () => {
    const noAo = (a: GovernorKnobs, b: GovernorKnobs) => a.ao !== b.ao && a.shadowScale === b.shadowScale && a.grass === b.grass && a.lodBias === b.lodBias && a.res === b.res;
    const g = new FrameGovernor(GOVERNOR_LADDER, noAo);
    untilChange(g, 30);
    expect(g.level).toBe(2); // skipped the AO-only rung
    expect(g.knobs.shadowScale).toBe(0.5);
    run(g, 8, 300);
    expect(g.level).toBe(0);
  });

  test('disabled = full knobs, reset = back to the top', () => {
    const g = new FrameGovernor();
    run(g, 40, 10);
    expect(g.level).toBeGreaterThan(0);
    g.enabled = false;
    expect(g.knobs).toEqual(GOVERNOR_LADDER[0]);
    g.enabled = true;
    g.reset();
    expect(g.level).toBe(0);
  });
});
