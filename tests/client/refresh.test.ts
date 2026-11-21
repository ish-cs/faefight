import { describe, expect, it } from 'vitest';
import { RefreshProbe, frameBudgetMs, snapHz } from '../../src/client/refresh';

describe('display refresh estimate', () => {
  it('snaps a measured rate to the nearest common refresh', () => {
    expect(snapHz(59.7)).toBe(60);
    expect(snapHz(119.2)).toBe(120);
    expect(snapHz(143)).toBe(144);
    expect(snapHz(88)).toBe(90);
    expect(snapHz(30)).toBe(60); // never below 60: a slow start is not a slow display
  });

  it('measures from the median rAF interval, ignoring hitches', () => {
    const p = new RefreshProbe();
    for (let i = 0; i < 40; i++) p.frame(i % 9 === 0 ? 40 : 8.33);
    expect(p.hz).toBe(120);
  });

  it('defaults to 60 Hz until enough frames are seen', () => {
    const p = new RefreshProbe();
    for (let i = 0; i < 5; i++) p.frame(6.94);
    expect(p.hz).toBe(60);
  });

  it('only raises its estimate (a GPU-bound stretch must not read as a slow display)', () => {
    const p = new RefreshProbe();
    for (let i = 0; i < 40; i++) p.frame(8.33);
    for (let i = 0; i < 200; i++) p.frame(16.7);
    expect(p.hz).toBe(120);
  });

  it('frame budget: the cap when set, else the display refresh; never above the display', () => {
    expect(frameBudgetMs(0, 120)).toBeCloseTo(8.33, 2);
    expect(frameBudgetMs(60, 120)).toBeCloseTo(16.67, 2);
    expect(frameBudgetMs(120, 60)).toBeCloseTo(16.67, 2);
  });
});
