import { beforeAll, describe, expect, test } from 'vitest';
import { boxesOverlap, validatePlacement } from '../../src/sim/building';
import { BuildAim } from '../../src/client/buildAim';
import { MAP, PIECES } from '../../src/sim/constants';
import { Physics } from '../../src/sim/physics';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { add, forward, norm, rotateY, sub, v3 } from '../../src/sim/vec';
import type { PieceKind, Vec3 } from '../../src/sim/types';

let map: IslandLayout[];
let ph: Physics;
beforeAll(async () => { map = buildMap(2); ph = await Physics.create(map); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
/** Offset in the island/prop frame (+Z toward the island's own centre, as the client props use). */
const local = (base: Vec3, x: number, z: number, y = 0): Vec3 => add(base, add(rotateY(v3(x, 0, z), yaw()), v3(0, y, 0)));
/** A standing spot `d` m from `p`, toward the bunker side (open ground). */
const stand = (p: Vec3) => local(p, 0, -3.5);
const place = (kind: PieceKind, pos: Vec3, from: Vec3, rotY = yaw()) => validatePlacement(ph, kind, pos, rotY, from);

describe('no-build zones', () => {
  test('rejects pieces on / through the shop NPC and under its awning', () => {
    const shop = isl().shop;
    const at = stand(shop);
    expect(place('wood', shop, at)).toEqual({ ok: false, reason: 'too close to shop' });
    // the screenshot bug: a ramp poking through the awning in front of the keeper
    expect(place('ramp', local(shop, 0, 1.2), at)).toEqual({ ok: false, reason: 'too close to shop' });
    expect(place('sandbags', local(shop, 1.5, 0.5), at)).toEqual({ ok: false, reason: 'too close to shop' });
  });

  test('accepts pieces just outside the shop clearance', () => {
    const shop = isl().shop;
    expect(place('wood', local(shop, 0, -2), stand(shop)).ok).toBe(true);
    expect(place('sandbags', local(shop, 3.5, 0.5), local(shop, 3.5, -3)).ok).toBe(true);
  });

  test('rejects on the generator, accepts nearby', () => {
    const g = isl().generator;
    expect(place('sandbags', g, stand(g))).toEqual({ ok: false, reason: 'too close to generator' });
    expect(place('wood', local(g, 0, -1.1), stand(g))).toEqual({ ok: false, reason: 'too close to generator' });
    expect(place('wood', local(g, 0, -2), stand(g)).ok).toBe(true);
  });

  test('rejects a piece intersecting the vault body, accepts one beside it', () => {
    const v = isl().vault;
    expect(place('wood', v, stand(v))).toEqual({ ok: false, reason: 'too close to vault' });
    expect(place('sandbags', local(v, 1.2, 0), stand(v))).toEqual({ ok: false, reason: 'too close to vault' });
    expect(place('wood', local(v, 0, -2), stand(v)).ok).toBe(true);
  });

  test('accepts a piece directly above the vault (resting on it)', () => {
    const v = isl().vault;
    const r = place('sandbags', add(v, v3(0, 2.1, 0)), stand(v));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pos.y).toBeCloseTo(v.y + 2.0, 2);
  });

  test('rejects on the potion seller, accepts nearby; zone follows the seller', async () => {
    const p2 = await Physics.create(map);
    const seller = local(v3(isl().center.x, isl().groundY, isl().center.z), 6, -2);
    p2.setPotionShops([seller]);
    const from = local(seller, 0, -3.5);
    expect(validatePlacement(p2, 'wood', local(seller, 0, 0.6), yaw(), from)).toEqual({ ok: false, reason: 'too close to potion seller' });
    expect(validatePlacement(p2, 'wood', local(seller, 3, 0), yaw(), from).ok).toBe(true);
    p2.setPotionShops([]);
    expect(validatePlacement(p2, 'wood', local(seller, 0, 0.6), yaw(), from).ok).toBe(true);
  });

  test('bunker doorway seals still place (all three doorways)', () => {
    const enemy = map[1];
    for (const door of enemy.bunker.doorways) {
      const f = forward(door.yaw);
      const off = MAP.bunker.wall / 2 + PIECES.wood.d / 2 + 0.03;
      const pos = v3(door.center.x + f.x * off, enemy.groundY + 0.05, door.center.z + f.z * off);
      const from = v3(door.center.x + f.x * 2.5, enemy.groundY, door.center.z + f.z * 2.5);
      expect(validatePlacement(ph, 'wood', pos, door.yaw, from).ok).toBe(true);
    }
  });

  test('snap assist never resolves to a spot inside a zone', () => {
    const shop = isl().shop;
    const player = stand(shop);
    const eye = add(player, v3(0, 1.6, 0));
    for (const kind of ['wood', 'ramp', 'sandbags', 'scaffold'] as PieceKind[]) {
      for (const tx of [-1, 0, 1]) {
        const dir = norm(sub(local(shop, tx, 0.7, 1), eye));
        const out = new BuildAim().update({
          physics: ph, kind, ray: { eye, dir }, player, yaw: yaw() + Math.PI, buildRot: 0, free: false,
          humanId: -1, pieces: [], islands: map, myIsland: 0,
        });
        if (!out.ok) continue;
        const s = PIECES[kind];
        const c = v3(out.ghost.x, out.ghost.y + s.h / 2 + 0.01, out.ghost.z);
        const h = v3(s.w / 2 - 0.02, s.h / 2 - 0.02, s.d / 2 - 0.02);
        expect(ph.noBuildZones().some((z) => boxesOverlap(c, h, out.rotY, z))).toBe(false);
      }
    }
  });
});
