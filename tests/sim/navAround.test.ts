import { describe, expect, test } from 'vitest';
import { insideBunker, WalkGrid, withinIsland, type NavNode } from '../../src/sim/bots/nav';
import { MAP } from '../../src/sim/constants';
import type { Bunker } from '../../src/sim/map';
import { dist2D, rotateY, v3 } from '../../src/sim/vec';
import type { Vec3 } from '../../src/sim/types';

const HALF = MAP.bunker.interior / 2 + MAP.bunker.wall;

/** Walk from `from` toward `to` round the bunker, 0.1 m a step, as the bot does; the path and the step directions. */
function walk(b: Bunker, from: Vec3, to: Vec3, steps = 600) {
  let p = from;
  const dirs: Vec3[] = [];
  for (let i = 0; i < steps && dist2D(p, to) > 0.15; i++) {
    if (insideBunker(b, p)) throw new Error(`walked into the bunker at step ${i}: ${JSON.stringify(from)} -> ${JSON.stringify(to)} now ${JSON.stringify(p)}`);
    const wp = withinIsland({ bunker: b }, p, to);
    const d = dist2D(wp, p);
    if (d < 1e-6) break;
    const u = v3((wp.x - p.x) / d, 0, (wp.z - p.z) / d);
    dirs.push(u);
    p = v3(p.x + u.x * Math.min(0.1, d), 0, p.z + u.z * Math.min(0.1, d));
  }
  return { end: p, dirs };
}

describe('withinIsland: round the bunker', () => {
  // The botAim seed-1 case (seal walk, hard bot at (−3, −115.9)) in bunker-local terms, plus every pair of spots on
  // a ring round the bunker: the walk gets there and never doubles back (no pacing between two corners).
  test.each([0, 0.7, 2.1])('no doubling back, arrives (bunker yaw %s)', (yaw) => {
    const b: Bunker = { center: v3(5, 0, -7), facingYaw: yaw, doorways: [] };
    const ring = (a: number, r: number) => {
      // on a square r out from the bunker's centre (a circle would cut into the corners)
      const k = r / Math.max(Math.abs(Math.sin(a)), Math.abs(Math.cos(a)));
      const l = v3(Math.sin(a) * k, 0, Math.cos(a) * k);
      const w = rotateY(l, yaw);
      return v3(b.center.x + w.x, 0, b.center.z + w.z);
    };
    let worst = 1;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
      if (i === j) continue;
      for (const [r1, r2] of [[HALF + 0.3, HALF + 3], [HALF + 2.5, HALF + 0.4], [HALF + 4, HALF + 4]]) {
        const from = ring((i / 16) * 2 * Math.PI + 0.1, r1), to = ring((j / 16) * 2 * Math.PI, r2);
        const { end, dirs } = walk(b, from, to);
        expect(dist2D(end, to), `${i}->${j} r ${r1}/${r2}`).toBeLessThan(0.2);
        for (let k = 1; k < dirs.length; k++) worst = Math.min(worst, dirs[k].x * dirs[k - 1].x + dirs[k].z * dirs[k - 1].z);
      }
    }
    expect(worst).toBeGreaterThan(-0.5);
  });
});

describe('WalkGrid: props', () => {
  const node: NavNode = { index: 0, center: v3(0, 0, 0), radius: 20, groundY: 0, bunker: null };
  test('a prop in the way is walked round; a straight line past it is still clear', () => {
    const g = new WalkGrid(node, []);
    g.props = [{ pos: v3(0, 0.6, 0), r: 0.8 }];
    expect(g.clear(v3(-5, 0, 0), v3(5, 0, 0))).toBe(false);
    expect(g.clear(v3(-5, 0, 3), v3(5, 0, 3))).toBe(true);
    const pts = g.path(v3(-5, 0, 0), v3(5, 0, 0))!;
    expect(pts.at(-1)).toEqual(v3(5, 0, 0));
    expect(pts.length).toBeGreaterThan(1);
    for (const q of pts.slice(0, -1)) expect(dist2D(q, v3(0, 0, 0))).toBeGreaterThan(0.8);
    // the prop is only in this search: without it the walk is straight again
    g.props = [];
    expect(g.path(v3(-5, 0, 0), v3(5, 0, 0))).toEqual([v3(5, 0, 0)]);
  });
});
