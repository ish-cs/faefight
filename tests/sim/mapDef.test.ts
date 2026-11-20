import { describe, expect, test } from 'vitest';
import { CENTER, ECONOMY, MAP } from '../../src/sim/constants';
import {
  MAP_TEMPLATES, buildMap, buildMapDef, bunkerWallBoxes, resolveMapChoice,
  type Doorway, type IslandLayout, type MapDef, type MapTemplate,
} from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import type { Vec3 } from '../../src/sim/types';
import { add, dist2D, forward, right, rotateY, scale, sub, v3, yawOf } from '../../src/sim/vec';

/** The original buildMap (before MapDef), kept verbatim as the harbor golden reference. */
function legacyBuildMap(playerCount: number): IslandLayout[] {
  const r = MAP.islandRadius;
  const ring = (r + MAP.gap / 2) / Math.sin(Math.PI / playerCount);
  const g = MAP.groundY;
  const out: IslandLayout[] = [];
  for (let i = 0; i < playerCount; i++) {
    const a = Math.PI + (2 * Math.PI * i) / playerCount;
    const center = v3(Math.cos(a) * ring, 0, Math.sin(a) * ring);
    const inward = v3(-Math.cos(a), 0, -Math.sin(a));
    const facingYaw = yawOf(inward);
    const lat = right(facingYaw);
    const at = (fwd: number, side: number): Vec3 => {
      const p = add(add(center, scale(inward, fwd)), scale(lat, side));
      return v3(p.x, g, p.z);
    };
    const bunkerCenter = at(-(r - 7), 0);
    const off = MAP.bunker.interior / 2 + MAP.bunker.wall / 2;
    const doorways: Doorway[] = [0, Math.PI / 2, -Math.PI / 2].map((d) => {
      const yaw = facingYaw + d;
      const c = add(bunkerCenter, scale(forward(yaw), off));
      return { center: v3(c.x, g, c.z), yaw, width: MAP.bunker.doorWidth };
    });
    out.push({
      index: i, center, radius: r, groundY: g, bunker: { center: bunkerCenter, facingYaw, doorways },
      spawn: bunkerCenter, generator: at(6, -6), vault: at(8, 0), shop: at(6, 6),
    });
  }
  return out;
}

const NS = [2, 3, 4, 5, 6, 7, 8];
const each = (fn: (def: MapDef, t: MapTemplate, n: number) => void) => {
  for (const t of MAP_TEMPLATES) for (const n of NS) fn(buildMapDef(n, t), t, n);
};
/** World point → island-local frame (origin = island center, rotated so the island faces -Z). */
const local = (isl: IslandLayout, p: Vec3) => rotateY(sub(p, isl.center), -isl.bunker.facingYaw);
const close = (a: Vec3, b: Vec3) => {
  expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); expect(a.z).toBeCloseTo(b.z, 6);
};
/** 2D distance from p to an oriented box footprint. */
function boxDist(p: Vec3, b: { center: Vec3; half: Vec3; rotY: number }) {
  const l = rotateY(sub(p, b.center), -b.rotY);
  return Math.hypot(Math.max(0, Math.abs(l.x) - b.half.x), Math.max(0, Math.abs(l.z) - b.half.z));
}
const corners = (b: { center: Vec3; half: Vec3; rotY: number }) =>
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => add(b.center, rotateY(v3(sx * b.half.x, 0, sz * b.half.z), b.rotY)));

describe('MapDef: harbor golden', () => {
  test('harbor player islands reproduce the original map exactly for 2..8 players', () => {
    for (const n of NS) {
      expect(buildMapDef(n, 'harbor').islands).toEqual(legacyBuildMap(n));
      expect(buildMap(n)).toEqual(legacyBuildMap(n));
    }
  });
  test('harbor has no built-in cover on the player islands', () => {
    for (const n of NS) expect(buildMapDef(n, 'harbor').statics.filter((s) => s.island >= 0)).toEqual([]);
  });
});

describe('MapDef: fairness per template (2..8 players)', () => {
  test('neighbouring islands are equally far apart', () => each((def) => {
    const m = def.islands;
    const gaps = m.map((a, i) => dist2D(a.center, m[(i + 1) % m.length].center) - a.radius - m[(i + 1) % m.length].radius);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
    expect(gaps[0]).toBeGreaterThan(20);
  }));

  test('container yard keeps its 26 m gaps from 3 players up (2 players: the center island sits between)', () => {
    for (const n of [4, 5, 6, 7, 8]) {
      const m = buildMapDef(n, 'yard').islands;
      expect(dist2D(m[0].center, m[1].center) - 2 * m[0].radius).toBeCloseTo(26, 6);
    }
  });

  test('every island is equally far from the center island, which overlaps nothing', () => each((def) => {
    const c = def.center;
    const gaps = def.islands.map((i) => dist2D(i.center, c.center) - i.radius - c.radius);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
    expect(gaps[0]).toBeGreaterThanOrEqual(8 - 1e-6);
    expect(c.radius).toBeGreaterThanOrEqual(10);
  }));

  test('islands are rotation-identical: POIs, cover and cosmetics match in island-local frame', () => each((def) => {
    const ref = def.islands[0];
    const poi = (isl: IslandLayout) => [isl.spawn, isl.generator, isl.vault, isl.shop, isl.bunker.center, ...isl.bunker.doorways.map((d) => d.center)].map((p) => local(isl, p));
    const stat = (isl: IslandLayout) => def.statics.filter((s) => s.island === isl.index).map((s) => ({ c: local(isl, s.center), half: s.half, rot: s.rotY - isl.bunker.facingYaw }));
    const per = def.cosmetics.length ? def.cosmetics.filter((c) => dist2D(c.pos, ref.center) <= ref.radius).length : 0;
    const cos = (isl: IslandLayout) => def.cosmetics.filter((c) => dist2D(c.pos, isl.center) <= isl.radius).map((c) => ({ kind: c.kind, p: local(isl, c.pos) }));
    for (const isl of def.islands) {
      expect(isl.radius).toBe(ref.radius);
      poi(isl).forEach((p, k) => close(p, poi(ref)[k]));
      const s = stat(isl), s0 = stat(ref);
      expect(s.length).toBe(s0.length);
      s.forEach((x, k) => { close(x.c, s0[k].c); expect(x.half).toEqual(s0[k].half); expect(Math.cos(x.rot - s0[k].rot)).toBeCloseTo(1, 6); });
      const c = cos(isl), c0 = cos(ref);
      expect(c.length).toBe(per);
      c.forEach((x, k) => { expect(x.kind).toBe(c0[k].kind); close(x.p, c0[k].p); });
    }
  }));

  test('no map cover within 9 m of any bunker (seal results never depend on map statics)', () => each((def) => {
    for (const s of def.statics) for (const isl of def.islands) expect(boxDist(isl.bunker.center, s)).toBeGreaterThanOrEqual(9);
  }));

  test('cover sits fully on its island, clear of stations and spawn', () => each((def) => {
    for (const s of def.statics) {
      const isl = s.island >= 0 ? def.islands[s.island] : def.center;
      for (const p of corners(s)) expect(dist2D(p, isl.center)).toBeLessThan(isl.radius - 0.5);
      const stations = s.island >= 0
        ? [def.islands[s.island].generator, def.islands[s.island].vault, def.islands[s.island].shop, def.islands[s.island].spawn]
        : [def.center.goldGen, def.center.supplyGen, def.center.potionShop, def.center.shieldWell];
      for (const p of stations) expect(boxDist(p, s)).toBeGreaterThanOrEqual(1.5);
    }
  }));

  test('center stations are on the center island, spread apart', () => each((def) => {
    const c = def.center;
    const pts = [c.goldGen, c.supplyGen, c.potionShop, c.shieldWell];
    for (const p of pts) expect(dist2D(p, c.center)).toBeLessThan(c.radius - 2);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(dist2D(pts[i], pts[j])).toBeGreaterThanOrEqual(3);
  }));

  test('every station and spawn stands on solid ground; cover is solid', async () => {
    for (const t of MAP_TEMPLATES) for (const n of [2, 5, 8]) {
      const def = buildMapDef(n, t);
      const ph = await Physics.create(def);
      for (const isl of def.islands) for (const p of [isl.generator, isl.vault, isl.shop, isl.spawn]) expect(ph.isGroundAt(p.x, p.z)).not.toBeNull();
      for (const p of [def.center.goldGen, def.center.supplyGen, def.center.potionShop]) expect(ph.isGroundAt(p.x, p.z)).not.toBeNull();
      expect(ph.isGroundAt(def.center.shieldWell.x, def.center.shieldWell.z)).toBeCloseTo(def.center.groundY, 5);
      for (const s of def.statics) {
        const top = ph.isGroundAt(s.center.x, s.center.z);
        expect(top).toBeCloseTo(s.center.y + s.half.y, 4);
      }
    }
  });
});

describe('map choice', () => {
  test('a fixed choice is played as picked', () => {
    expect(resolveMapChoice('yard', 'yard')).toBe('yard');
    expect(resolveMapChoice('harbor', null)).toBe('harbor');
  });
  test('Random never picks the same map twice in a row', () => {
    let last: MapTemplate | null = null;
    const seen = new Set<MapTemplate>();
    let x = 0.123;
    const rng = () => (x = (x * 9301 + 49297) % 233280 / 233280);
    for (let i = 0; i < 200; i++) {
      const m = resolveMapChoice('random', last, rng);
      expect(m).not.toBe(last);
      seen.add(m);
      last = m;
    }
    expect(seen.size).toBe(MAP_TEMPLATES.length);
    // Even an rng that always returns the same value can't repeat.
    expect(resolveMapChoice('random', 'harbor', () => 0)).toBe('yard');
    expect(resolveMapChoice('random', 'yard', () => 0.999)).toBe('harbor');
  });
});

describe('center island constants', () => {
  test('gold generator runs at twice the home rate with a 1000 cap', () => {
    expect(CENTER.goldRate).toBe(2 * ECONOMY.generatorRate);
    expect(CENTER.goldCap).toBe(1000);
  });
  test('bunker walls unchanged', () => {
    // 3 door walls × (2 slit segments × 4 boxes + lintel) + back wall (2 × 4) + roof
    expect(bunkerWallBoxes(buildMap(2)[0].bunker).length).toBe(3 * 9 + 8 + 1);
  });
});
