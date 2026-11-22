import { describe, expect, test } from 'vitest';
import { cascadeToRefresh, nearCascadeDue, newCacheState, SHADOW_CACHE } from '../../src/client/world/shadowCache';

describe('staggered near cascades', () => {
  test('cascade 0 renders every frame, the other near cascades every second frame', () => {
    const r = (i: number) => [0, 1, 2, 3].map((f) => nearCascadeDue(i, f));
    expect(r(0)).toEqual([true, true, true, true]);
    expect(r(1)).toEqual([true, false, true, false]);
  });
});

describe('cached far shadow cascades', () => {
  test('first frames render every far cascade once, one per frame', () => {
    const s = newCacheState(4);
    const picks = [0, 1, 2].map(() => cascadeToRefresh(s, 2, false));
    expect(picks.slice(0, 2).sort()).toEqual([2, 3]);
    expect(picks[2]).toBe(-1);
  });

  test('a still camera refreshes each far cascade only every maxAge frames', () => {
    const s = newCacheState(3);
    cascadeToRefresh(s, 2, false); // initial render of cascade 2
    let renders = 0;
    for (let f = 0; f < SHADOW_CACHE.maxAge * 4; f++) if (cascadeToRefresh(s, 2, false) === 2) renders++;
    expect(renders).toBe(4);
  });

  test('camera movement makes far cascades due after minAge', () => {
    const s = newCacheState(3);
    cascadeToRefresh(s, 2, false);
    expect(cascadeToRefresh(s, 2, true)).toBe(-1); // dirty but only 1 frame old
    expect(cascadeToRefresh(s, 2, false)).toBe(2); // 2 frames old → re-render
    expect(cascadeToRefresh(s, 2, false)).toBe(-1); // clean again
  });

  test('never more than one far cascade per frame; the stalest goes first', () => {
    const s = newCacheState(5);
    for (let f = 0; f < 10; f++) cascadeToRefresh(s, 2, false);
    for (let f = 0; f < 50; f++) {
      const before = [...s.age];
      const p = cascadeToRefresh(s, 2, f % 3 === 0);
      if (p >= 0) {
        const stalest = Math.max(...before.slice(2).map((a) => a + 1));
        expect(before[p] + 1).toBe(stalest);
      }
    }
  });

  test('near cascades are never scheduled (they always render)', () => {
    const s = newCacheState(4);
    for (let f = 0; f < 100; f++) {
      const p = cascadeToRefresh(s, 2, f % 2 === 0);
      expect(p === -1 || p >= 2).toBe(true);
    }
  });
});
