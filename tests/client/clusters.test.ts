import { describe, expect, it } from 'vitest';
import { buildMapDef } from '../../src/sim/map';
import {
  centerPlacements, centerZones, footprint, ISLAND_MAX_H, islandPlacements, islandZones, type Placement, PROP_SPEC, quayClusters,
  quayFrame, quayObstacles, toLocal, topOf, zonesClear,
} from '../../src/client/world/clusters';
import { ISLAND_DECOR } from '../../src/client/world/decor';

const maps = [buildMapDef(8, 'harbor'), buildMapDef(4, 'harbor'), buildMapDef(2, 'harbor'), buildMapDef(8, 'yard'), buildMapDef(3, 'yard')];

/** Every item either stands on the ground (y = 0) or exactly on the top of the item it names, inside its footprint. */
function expectGrounded(ps: Placement[]) {
  for (const p of ps) {
    if (p.type === 'decal') { expect(p.y).toBeLessThan(0.01); continue; }
    if (p.on === undefined) { expect(Math.abs(p.y)).toBeLessThan(1e-6); continue; }
    const base = ps[p.on];
    expect(base, `${p.type} on missing item`).toBeDefined();
    expect(PROP_SPEC[base.type].stack, `${p.type} on non-stackable ${base.type}`).toBe(true);
    expect(Math.abs(p.y - topOf(base))).toBeLessThan(1e-6);
    expect(p.tier, 'a lower preset must never keep an item whose support it dropped').toBeGreaterThanOrEqual(base.tier);
    const f = footprint(base);
    expect(Math.abs(p.x - base.x)).toBeLessThanOrEqual(f.hx + 1e-6);
    expect(Math.abs(p.z - base.z)).toBeLessThanOrEqual(f.hz + 1e-6);
  }
}

describe('dock clusters: backdrop quays', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const def = maps[0], f = quayFrame(def, def.islands[0]);
    expect(quayClusters(f, 11)).toEqual(quayClusters(f, 11));
    expect(quayClusters(f, 11)).not.toEqual(quayClusters(f, 12));
  });

  it('places dense clusters (≥ 150 items per quay) with nothing floating', () => {
    for (const def of maps) for (const isl of def.islands) {
      const ps = quayClusters(quayFrame(def, isl), 100 + isl.index);
      expect(ps.length).toBeGreaterThan(def.template === 'harbor' ? 150 : 60);
      expectGrounded(ps);
    }
  });

  it('keeps ground items off existing quay furniture, vehicle bays and the edge strip', () => {
    for (const def of maps) for (const isl of def.islands) {
      const f = quayFrame(def, isl);
      const obs = quayObstacles(f);
      for (const p of quayClusters(f, 7 + isl.index)) {
        if (p.type === 'decal' || p.type === 'manhole' || p.type === 'rail') continue;
        const fp = footprint(p);
        expect(Math.abs(p.x)).toBeLessThan(f.hw);
        expect(p.z).toBeLessThan(f.z0 + 80);
        // edge gear lives on the strip; everything else stays behind it
        const edgeGear = ['ropeLoop', 'bitt', 'cleat', 'ladder', 'lifeRing', 'tyreFender', 'fence', 'gate'].includes(p.type);
        if (!edgeGear) {
          expect(p.z - fp.hz).toBeGreaterThan(f.z0 + 1.9);
          for (const o of obs) {
            const hit = Math.abs(p.x - o.x) < fp.hx + o.hx && Math.abs(p.z - o.z) < fp.hz + o.hz;
            expect(hit, `${p.type} at ${p.x.toFixed(1)},${p.z.toFixed(1)} overlaps obstacle ${JSON.stringify(o)}`).toBe(false);
          }
        }
      }
    }
  });

  it('includes every purposeful cluster kind on a harbor quay', () => {
    const def = maps[0];
    const types = new Set(def.islands.flatMap((isl) => quayClusters(quayFrame(def, isl), 3 + isl.index).map((p) => p.type)));
    for (const t of ['workbench', 'genset', 'portacabin', 'vending', 'dumpster', 'gravelHeap', 'sandPile', 'timber', 'rebar', 'forklift', 'ibc', 'reel', 'lobsterPot', 'netPile', 'bicycle', 'fence', 'gate', 'ladder', 'bitt', 'rail', 'stone'] as const) {
      expect(types.has(t), t).toBe(true);
    }
  });
});

describe('dock clusters: playable islands', () => {
  it('is deterministic', () => {
    const def = maps[0];
    expect(islandPlacements(def, def.islands[2])).toEqual(islandPlacements(def, def.islands[2]));
  });

  it('only low clutter (≤ 0.35 m) inside the disc, nothing floating', () => {
    for (const def of maps) {
      for (const isl of def.islands) {
        const ps = islandPlacements(def, isl);
        expect(ps.length).toBeGreaterThan(10);
        expectGrounded(ps.filter((p) => !p.edge));
        for (const p of ps) {
          if (p.edge) { expect(['ladderLow', 'tyreFender']).toContain(p.type); continue; }
          expect(topOf(p)).toBeLessThanOrEqual(ISLAND_MAX_H + 1e-6);
          expect(Math.hypot(p.x, p.z)).toBeLessThan(isl.radius - 0.1);
        }
      }
      for (const p of centerPlacements(def)) if (!p.edge) {
        expect(topOf(p)).toBeLessThanOrEqual(ISLAND_MAX_H + 1e-6);
        expect(Math.hypot(p.x, p.z)).toBeLessThan(def.center.radius - 0.1);
      }
    }
  });

  it('keeps bunker doorways, NPC/generator/vault zones, cover, cosmetics and paths clear', () => {
    for (const def of maps) for (const isl of def.islands) {
      const z = islandZones(def, isl);
      for (const p of islandPlacements(def, isl)) {
        if (p.edge || p.type === 'decal' || p.type === 'cleat') continue;
        const fp = footprint(p);
        expect(zonesClear(z, p.x, p.z, Math.max(fp.hx, fp.hz) - 1e-6), `${p.type} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`).toBe(true);
      }
      // the zones really cover the sim's doorways and stations
      for (const d of isl.bunker.doorways) { const l = toLocal(d.center, isl.center, isl.bunker.facingYaw); expect(zonesClear(z, l.x, l.z, 0)).toBe(false); }
      for (const k of ['generator', 'vault', 'shop'] as const) { const l = toLocal(isl[k], isl.center, isl.bunker.facingYaw); expect(zonesClear(z, l.x, l.z, 0)).toBe(false); }
      if (def.template === 'harbor') for (const path of ISLAND_DECOR.gravelPaths) for (const [x, zz] of path.pts) expect(zonesClear(z, x, zz, 0)).toBe(false);
    }
    for (const def of maps) {
      const z = centerZones(def);
      for (const p of centerPlacements(def)) {
        if (p.edge || p.type === 'decal') continue;
        const fp = footprint(p);
        expect(zonesClear(z, p.x, p.z, Math.max(fp.hx, fp.hz) - 1e-6)).toBe(true);
      }
    }
  });

  it('decals lie flat in the open, away from doorways', () => {
    const def = maps[0];
    for (const isl of def.islands) {
      const z = islandZones(def, isl);
      for (const p of islandPlacements(def, isl)) if (p.type === 'decal') {
        expect(p.y).toBeLessThan(0.01);
        expect(zonesClear(z, p.x, p.z, 0)).toBe(true);
      }
    }
  });
});
