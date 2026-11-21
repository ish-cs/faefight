import { describe, expect, test } from 'vitest';
import { chunkCoord, chunkKey, distToBoxXZ, distToSphere, groupByChunk, LOD_HYSTERESIS, selectLod, updateSlice } from '../../src/client/world/lodMath';

describe('LOD selection', () => {
  const T = [30, 100]; // full < 30 m, simplified < 100 m, culled beyond

  test('fresh pick follows the thresholds exactly', () => {
    expect(selectLod(0, T, -1)).toBe(0);
    expect(selectLod(29.9, T, -1)).toBe(0);
    expect(selectLod(30.1, T, -1)).toBe(1);
    expect(selectLod(150, T, -1)).toBe(2);
  });

  test('hysteresis: no switch inside the band around a threshold', () => {
    const h = LOD_HYSTERESIS;
    // at level 0, crossing 30 m is not enough: needs 30·(1+h)
    expect(selectLod(31, T, 0)).toBe(0);
    expect(selectLod(30 * (1 + h) + 0.01, T, 0)).toBe(1);
    // at level 1, coming back needs 30·(1−h)
    expect(selectLod(29, T, 1)).toBe(1);
    expect(selectLod(30 * (1 - h) - 0.01, T, 1)).toBe(0);
  });

  test('no flicker when oscillating around a threshold', () => {
    let l = selectLod(29, T, -1);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) { l = selectLod(i % 2 ? 28.5 : 31.5, T, l); seen.add(l); }
    expect([...seen]).toEqual([0]);
  });

  test('jumps several levels at once when the camera teleports', () => {
    expect(selectLod(500, T, 0)).toBe(2);
    expect(selectLod(1, T, 2)).toBe(0);
  });

  test('scale stretches every threshold (preset / governor bias)', () => {
    expect(selectLod(40, T, -1, 1)).toBe(1);
    expect(selectLod(40, T, -1, 1.5)).toBe(0); // ultra-ish: 45 m
    expect(selectLod(25, T, -1, 0.6)).toBe(1); // low + bias: 18 m
  });

  test('no thresholds = always level 0', () => {
    expect(selectLod(1e6, [], -1)).toBe(0);
    expect(selectLod(1e6, [], 0)).toBe(0);
  });
});

describe('chunk math', () => {
  test('chunk coordinates floor toward −∞', () => {
    expect(chunkCoord(0, 16)).toBe(0);
    expect(chunkCoord(15.99, 16)).toBe(0);
    expect(chunkCoord(16, 16)).toBe(1);
    expect(chunkCoord(-0.01, 16)).toBe(-1);
    expect(chunkCoord(-16, 16)).toBe(-1);
    expect(chunkCoord(-16.01, 16)).toBe(-2);
  });

  test('chunk keys are unique per cell, including negatives', () => {
    const keys = new Set<number>();
    for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) keys.add(chunkKey(x, z));
    expect(keys.size).toBe(81 * 81);
  });

  test('groupByChunk buckets points by cell, keeping input order', () => {
    const pts = [{ x: 1, z: 1 }, { x: 20, z: 1 }, { x: 2, z: 15 }, { x: -1, z: 1 }, { x: 31, z: 2 }];
    const g = groupByChunk(pts, 16);
    expect(g.get(chunkKey(0, 0))).toEqual([0, 2]);
    expect(g.get(chunkKey(1, 0))).toEqual([1, 4]);
    expect(g.get(chunkKey(-1, 0))).toEqual([3]);
    expect(g.size).toBe(3);
  });

  test('XZ distance to a chunk box: 0 inside, edge and corner distances outside', () => {
    expect(distToBoxXZ(5, 5, 0, 0, 16, 16)).toBe(0);
    expect(distToBoxXZ(-3, 8, 0, 0, 16, 16)).toBe(3);
    expect(distToBoxXZ(20, 8, 0, 0, 16, 16)).toBe(4);
    expect(distToBoxXZ(19, 20, 0, 0, 16, 16)).toBe(5); // corner: 3-4-5
  });

  test('distance to a bounding sphere surface', () => {
    expect(distToSphere(0, 0, 0, 10, 0, 0, 4)).toBe(6);
    expect(distToSphere(9, 0, 0, 10, 0, 0, 4)).toBe(0);
  });

  test('round-robin update slices cover every item exactly once per cycle', () => {
    const n = 10, every = 3, hit = new Array(n).fill(0);
    for (let f = 0; f < every; f++) { const [a, b] = updateSlice(n, f, every); for (let i = a; i < b; i++) hit[i]++; }
    expect(hit).toEqual(new Array(n).fill(1));
    expect(updateSlice(5, 7, 1)).toEqual([0, 5]);
  });
});
