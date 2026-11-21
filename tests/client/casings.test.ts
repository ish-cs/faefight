import { describe, expect, test } from 'vitest';
import { CASING_LIFE, Casings } from '../../src/client/world/casings';

describe('shell casings', () => {
  test('a case bounces (clink per hard bounce), lies a few seconds, then is gone', () => {
    const c = new Casings();
    const clinks: { speed: number; hull: boolean }[] = [];
    c.onClink = (_x, _y, _z, speed, hull) => clinks.push({ speed, hull });
    c.spawn(0, 1.4, 0, 2, 2, 0, 0.028, 0.0055, 0xc9a03c, 0);
    for (let t = 0; t < 2; t += 1 / 60) c.update(1 / 60);
    expect(clinks.length).toBeGreaterThanOrEqual(1);
    expect(clinks.length).toBeLessThanOrEqual(3);
    expect(clinks[0].speed).toBeGreaterThan(1.2);
    expect(clinks[0].hull).toBe(false);
    for (let i = 1; i < clinks.length; i++) expect(clinks[i].speed).toBeLessThan(clinks[i - 1].speed); // each bounce quieter
    expect(c.live).toBe(1);
    expect(CASING_LIFE).toBeLessThanOrEqual(8);
    for (let t = 0; t < CASING_LIFE + 1.5; t += 1 / 60) c.update(1 / 60);
    expect(c.live).toBe(0);
  });
  test('the count is capped: the oldest are recycled', () => {
    const c = new Casings();
    c.limit = 10;
    for (let i = 0; i < 25; i++) c.spawn(0, 1, 0, 0, 0, 0, 0.06, 0.011, 0xa32a1e, 0);
    expect(c.live).toBeLessThanOrEqual(10);
  });
});
