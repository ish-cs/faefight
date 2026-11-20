import { describe, expect, test } from 'vitest';
import { buildMap, bunkerWallBoxes } from '../../src/sim/map';
import { MAP } from '../../src/sim/constants';
import { dist2D, forward } from '../../src/sim/vec';

describe('buildMap', () => {
  test('1v1 islands sit opposite at x = ±40', () => {
    const m = buildMap(2);
    expect(m).toHaveLength(2);
    const xs = m.map((i) => Math.round(i.center.x)).sort((a, b) => a - b);
    expect(xs).toEqual([-40, 40]);
    for (const i of m) expect(Math.abs(i.center.z)).toBeLessThan(1e-6);
  });

  test('adjacent island edges are 36 m apart for 2..8 players', () => {
    for (let n = 2; n <= 8; n++) {
      const m = buildMap(n);
      for (let i = 0; i < n; i++) {
        const a = m[i], b = m[(i + 1) % n];
        expect(dist2D(a.center, b.center) - 2 * MAP.islandRadius).toBeCloseTo(MAP.gap, 2);
      }
    }
  });

  test('each island has 3 doorways, none facing the back edge', () => {
    for (const isl of buildMap(4)) {
      expect(isl.bunker.doorways).toHaveLength(3);
      const out = { x: isl.center.x, z: isl.center.z };
      const len = Math.hypot(out.x, out.z);
      for (const d of isl.bunker.doorways) {
        const f = forward(d.yaw);
        expect((f.x * out.x + f.z * out.z) / len).toBeLessThan(0.5);
      }
    }
  });

  test('points of interest are on the island and spread apart', () => {
    for (const isl of buildMap(3)) {
      const pts = [isl.spawn, isl.generator, isl.vault, isl.shop];
      for (const p of pts) expect(dist2D(p, isl.center)).toBeLessThan(MAP.islandRadius - 2);
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) expect(dist2D(pts[i], pts[j])).toBeGreaterThanOrEqual(3);
    }
  });

  test('bunker walls leave the spawn clear', () => {
    const isl = buildMap(2)[0];
    const boxes = bunkerWallBoxes(isl.bunker);
    expect(boxes.length).toBeGreaterThan(4);
    const low = boxes.filter((b) => b.center.y - b.half.y < isl.groundY + 1.8);
    for (const b of low) expect(dist2D(b.center, isl.spawn)).toBeGreaterThan(1.5);
  });
});
