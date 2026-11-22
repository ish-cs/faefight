import { describe, expect, test } from 'vitest';
import { DECAL_CAP, DecalRing } from '../../src/client/world/impacts';
import { harborGround, isPropOwner, OWNER_WORLD, ownCosmetic, ownDock, ownHazard, ownProp, propOfOwner, SURFACE_BURST, SURFACE_MARK, SurfaceMap } from '../../src/client/world/surfaces';
import { PIECES } from '../../src/sim/constants';
import { buildMapDef } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PieceState } from '../../src/sim/types';
import { add, rotateY, v3 } from '../../src/sim/vec';

describe('decal ring', () => {
  test('caps at the preset and recycles the oldest slot, never growing past the cap', () => {
    const r = new DecalRing(DECAL_CAP.high, DECAL_CAP.ultra);
    const slots: number[] = [];
    for (let i = 0; i < DECAL_CAP.high; i++) slots.push(r.add().slot);
    expect(new Set(slots).size).toBe(DECAL_CAP.high);
    expect(r.used).toBe(DECAL_CAP.high);
    const next = r.add();
    expect(next.evicted).toBe(true);
    expect(next.slot).toBe(slots[0]); // the oldest goes first
    expect(r.add().slot).toBe(slots[1]);
    for (let i = 0; i < 1000; i++) r.add();
    expect(r.used).toBe(DECAL_CAP.high);
    expect(r.live).toBe(DECAL_CAP.high);
  });

  test('the oldest marks fade toward eviction; the newest stay opaque', () => {
    const r = new DecalRing(100);
    const s = Array.from({ length: 100 }, () => r.add().slot);
    expect(r.alpha(s[99])).toBe(1);
    expect(r.alpha(s[0])).toBeLessThan(0.1);
    expect(r.alpha(s[12])).toBeGreaterThan(r.alpha(s[0]));
    // Half full: nothing fades.
    const h = new DecalRing(100);
    const hs = Array.from({ length: 50 }, () => h.add().slot);
    expect(hs.every((x) => h.alpha(x) === 1)).toBe(true);
  });

  test('marks owned by a piece go with it and their slots are reused first', () => {
    const r = new DecalRing(10);
    const a = r.add(7).slot, b = r.add(7).slot;
    r.add(-1);
    expect(r.removeOwner(7).sort()).toEqual([a, b].sort());
    expect(r.live).toBe(1);
    expect(r.alpha(a)).toBe(0);
    expect([a, b]).toContain(r.add().slot);
    expect(r.used).toBe(3);
  });

  test('lowering the quality preset drops the oldest marks down to the new cap', () => {
    const r = new DecalRing(DECAL_CAP.ultra);
    const s = Array.from({ length: DECAL_CAP.ultra }, () => r.add().slot);
    const dropped = r.setCap(DECAL_CAP.low);
    expect(dropped.length).toBe(DECAL_CAP.ultra - DECAL_CAP.low);
    expect(dropped).toContain(s[0]);
    expect(dropped).not.toContain(s[s.length - 1]);
    expect(r.live).toBe(DECAL_CAP.low);
    r.add();
    expect(r.live).toBe(DECAL_CAP.low);
  });
});

describe('surface → mark mapping', () => {
  test('every surface has the right decal and burst', () => {
    expect(SURFACE_MARK).toMatchObject({ concrete: 'chip', quay: 'chip', container: 'paint', metal: 'dent', wood: 'splinter', bark: 'bark', sand: 'divot', gravel: 'divot', water: null });
    expect(SURFACE_BURST).toMatchObject({ concrete: 'dust', container: 'sparks', metal: 'sparks', wood: 'splinters', bark: 'splinters', sand: 'sand', water: 'splash' });
  });

  const def = buildMapDef(2, 'harbor');
  const surf = new SurfaceMap(def);
  const isl = def.islands[0];
  const local = (x: number, z: number, y = isl.groundY) => { const w = add(isl.center, rotateY(v3(x, 0, z), isl.bunker.facingYaw)); return v3(w.x, y, w.z); };
  const view = { pieces: [] as PieceState[], players: [], waterY: 0 };
  const shoot = (to: { x: number; y: number; z: number }, from = v3(to.x + 5, to.y + 1.6, to.z + 5), range = 150) => surf.classify(from, to, range, view);

  test('ground under a shot: grass bed, sand bed, gravel path, plain slab', () => {
    expect(harborGround(-12.8, 9.6)).toBe('grass');
    expect(harborGround(0, 5.2)).toBe('sand');
    expect(harborGround(0, 0)).toBe('gravel'); // on the middle gravel path
    expect(harborGround(-8, -10)).toBe('concrete');
    const h = shoot(local(-8, -10))!;
    expect(h.surface).toBe('concrete');
    expect(h.normal).toEqual(v3(0, 1, 0));
    expect(shoot(local(-12.8, 9.6))!.surface).toBe('grass');
  });

  test('cover containers, bunker walls, quay wall, water', () => {
    const yard = buildMapDef(2, 'yard');
    const ysurf = new SurfaceMap(yard);
    const box = yard.statics.find((s) => s.look === 'container')!;
    const face = add(box.center, rotateY(v3(box.half.x, 0, 0), box.rotY));
    const h = ysurf.classify(add(face, rotateY(v3(5, 0.5, 0), box.rotY)), face, 150, view)!;
    expect(h.surface).toBe('container');
    const n = rotateY(v3(1, 0, 0), box.rotY);
    expect(h.normal.x).toBeCloseTo(n.x, 5);
    expect(h.normal.z).toBeCloseTo(n.z, 5);
    const back = add(isl.bunker.center, rotateY(v3(0, 1, 2.3), isl.bunker.facingYaw));
    expect(shoot(back)!.surface).toBe('concrete');
    const rim = add(isl.center, rotateY(v3(0, 0, -isl.radius - 0.1), isl.bunker.facingYaw));
    expect(shoot(v3(rim.x, isl.groundY - 1, rim.z))!.surface).toBe('quay');
    const sea = add(isl.center, rotateY(v3(0, 0, -isl.radius - 6), isl.bunker.facingYaw));
    expect(shoot(v3(sea.x, 0.1, sea.z))!.surface).toBe('water');
    expect(SURFACE_MARK[shoot(v3(sea.x, 0.1, sea.z))!.surface]).toBeNull();
    expect(ysurf.groundAt(yard.islands[0].center.x + 3, yard.islands[0].center.z)!.surface).toBe('asphalt');
    const barrier = def.statics.find((s) => s.look === 'barrier')!;
    expect(shoot(add(barrier.center, v3(0, barrier.half.y, 0)))!.surface).toBe('concrete');
  });

  test('misses, players and built pieces are not world marks', () => {
    const from = local(0, 0, isl.groundY + 1.6);
    expect(surf.classify(from, add(from, v3(0, 0, -60)), 60, view)).toBeNull(); // full range: hit nothing
    const pl = newPlayer(2, 'b', false, 0, local(-8, -10));
    expect(surf.classify(from, add(pl.pos, v3(0, 1, 0)), 150, { ...view, players: [pl] })).toBeNull();
    const wall: PieceState = { id: 3, kind: 'wood', owner: 1, pos: local(-8, -10), rotY: 0, hp: 200 };
    expect(surf.classify(from, add(wall.pos, v3(0, 1, 0.1)), 150, { ...view, pieces: [wall] })).toBeNull();
  });

  test('bullets passing a palm mark its trunk with bark', () => {
    const palm = def.cosmetics.find((c) => c.kind === 'palm')!;
    const hits = surf.propHits(v3(palm.pos.x - 10, palm.pos.y + 1.5, palm.pos.z), v3(palm.pos.x + 10, palm.pos.y + 1.5, palm.pos.z), new Set());
    const h = hits.find((x) => x.surface === 'bark')!;
    expect(h).toBeDefined();
    expect(h.point.x).toBeCloseTo(palm.pos.x - 0.2, 3);
    expect(h.normal.x).toBeCloseTo(-1, 3);
    expect(surf.propHits(v3(palm.pos.x - 10, palm.pos.y + 1.5, palm.pos.z), v3(palm.pos.x + 10, palm.pos.y + 1.5, palm.pos.z), new Set([palm.id])).some((x) => x.surface === 'bark' && Math.abs(x.point.z - palm.pos.z) < 0.01 && Math.abs(x.point.x - palm.pos.x + 0.2) < 0.01)).toBe(false);
  });
});

describe('marks belong to what they sit on', () => {
  test('dropping a surface removes only its marks (indexed, no scan); other owners and the world stay', () => {
    const r = new DecalRing(50);
    const wall = [r.add(7).slot, r.add(7).slot];
    const dock = r.add(ownDock(3)).slot, crate = r.add(ownCosmetic(9)).slot, world = r.add(OWNER_WORLD).slot, other = r.add(8).slot;
    expect([...r.owners()].sort()).toEqual([7, 8, ownDock(3), ownCosmetic(9)].sort());
    expect(r.removeOwner(7).sort()).toEqual(wall.sort());
    expect(r.slotsOf(7)).toBeUndefined();
    for (const s of wall) expect(r.alpha(s)).toBe(0);
    for (const s of [dock, crate, world, other]) expect(r.alpha(s)).toBe(1);
    expect(r.removeOwner(ownDock(3))).toEqual([dock]);
    expect(r.removeOwner(ownDock(3))).toEqual([]); // twice: nothing left
    expect(r.live).toBe(3);
    expect(r.clear().sort()).toEqual([crate, world, other].sort());
    expect(r.live).toBe(0);
    expect([...r.owners()]).toEqual([]);
  });

  test('an evicted slot leaves its old owner\'s index', () => {
    const r = new DecalRing(2);
    const a = r.add(5).slot;
    r.add(6);
    const c = r.add(OWNER_WORLD); // full: evicts the oldest (owner 5's mark)
    expect(c.evicted).toBe(true);
    expect(c.slot).toBe(a);
    expect(r.slotsOf(5)).toBeUndefined();
    expect(r.removeOwner(5)).toEqual([]);
    expect(r.live).toBe(2);
  });

  test('owner namespaces never collide and stay int32', () => {
    const ids = [0, 1, 999, 3_000_000];
    const all = ids.flatMap((i) => [i, ownDock(i), ownCosmetic(i), ownHazard(i), ownProp(i)]);
    expect(new Set(all).size).toBe(all.length);
    for (const i of ids) {
      expect(isPropOwner(ownProp(i))).toBe(true);
      expect(propOfOwner(ownProp(i))).toBe(i);
      expect(isPropOwner(ownHazard(i))).toBe(false);
    }
    for (const o of all) expect(o >= -(2 ** 31) && o < 2 ** 31).toBe(true);
  });

  const def = buildMapDef(2, 'harbor');
  const surf = new SurfaceMap(def);
  const view = { pieces: [] as PieceState[], players: [], waterY: 0 };

  test('the shot that destroyed a wall leaves no world mark where the wall was', () => {
    const isl = def.islands[0];
    const at = add(isl.center, rotateY(v3(-8, 0, -10), isl.bunker.facingYaw));
    const wall: PieceState = { id: 11, kind: 'wood', owner: 1, pos: v3(at.x, isl.groundY, at.z), rotY: 0, hp: 0 };
    const from = v3(at.x, isl.groundY + 1.6, at.z + 6), to = v3(at.x, isl.groundY + 1.2, at.z + PIECES.wood.d / 2);
    // The snapshot no longer lists the wall: without `gone` the shot fell through to a floating backdrop mark.
    expect(surf.classify(from, to, 150, view)).not.toBeNull();
    expect(surf.classify(from, to, 150, { ...view, gone: [wall] })).toBeNull();
  });

  test('pier planks are owned by their section; a broken section takes no marks', () => {
    const d = def.docks![0];
    const top = v3(d.center.x, d.center.y + d.half.y, d.center.z);
    const h = surf.classify(v3(top.x + 3, top.y + 1.6, top.z + 3), top, 150, view)!;
    expect(h.surface).toBe('wood');
    expect(h.owner).toBe(ownDock(d.id));
    const broken = new SurfaceMap(def);
    broken.brokenDocks = new Set([d.id]);
    expect(broken.boxAt(top)?.box.owner).not.toBe(ownDock(d.id));
  });

  test('cosmetic props own their marks; dynamic solids (props, hazards) win over the backdrop', () => {
    const palm = def.cosmetics.find((c) => c.kind === 'palm')!;
    const hits = surf.propHits(v3(palm.pos.x - 10, palm.pos.y + 1.5, palm.pos.z), v3(palm.pos.x + 10, palm.pos.y + 1.5, palm.pos.z), new Set());
    expect(hits.find((x) => x.surface === 'bark')!.owner).toBe(ownCosmetic(palm.id));
    const isl = def.islands[0];
    const p = v3(isl.center.x, isl.groundY + 0.9, isl.center.z);
    const solid = (q: { x: number; y: number; z: number }) => (q === p ? { surface: 'metal' as const, point: q, normal: v3(1, 0, 0), owner: ownHazard(4) } : null);
    expect(surf.classify(v3(p.x + 4, p.y + 1, p.z), p, 150, { ...view, solid })!.owner).toBe(ownHazard(4));
  });
});
