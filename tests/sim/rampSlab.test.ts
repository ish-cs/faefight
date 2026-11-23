import { beforeAll, describe, expect, test } from 'vitest';
import { DT, PIECES, PLAYER, RAMP_SLAB, rampHull } from '../../src/sim/constants';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import { shields } from '../../src/sim/bots/build';
import type { PieceState, Vec3 } from '../../src/sim/types';
import { add, forward, right, rotateY, scale, v3 } from '../../src/sim/vec';

// Ramps are a thin sloped slab (RAMP_SLAB thick), open underneath: stand on top, walk and shoot under.
const R = PIECES.ramp;
let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
/** A clear spot on the island, away from the stations (same lane as rampChain.test). */
const spot = (): Vec3 => {
  const p = add(add(isl().center, scale(forward(yaw() + Math.PI), 4)), scale(right(yaw()), 3));
  return v3(p.x, isl().groundY, p.z);
};
/** Piece-local → world for a ramp. */
const local = (r: PieceState, x: number, y: number, z: number) => add(r.pos, rotateY(v3(x, y, z), r.rotY));
const slopeY = (z: number) => (R.h * (z + R.d / 2)) / R.d;

function walk(ph: Physics, id: number, d: Vec3, secs: number) {
  let vy = 0, last = { pos: v3(), grounded: false };
  for (let t = 0; t < secs; t += DT) {
    vy -= PLAYER.gravity * DT;
    last = ph.movePlayer(id, v3(d.x * 5 * DT, vy * DT, d.z * 5 * DT));
    if (last.grounded && vy < 0) vy = 0;
  }
  return last;
}

describe('ramp slab', () => {
  test('hull: top is the slope, RAMP_SLAB thick, inside the w×h×d box', () => {
    const h = rampHull();
    expect(h.length).toBe(8 * 3);
    for (let i = 0; i < h.length; i += 3) {
      const [x, y, z] = [h[i], h[i + 1], h[i + 2]];
      expect(Math.abs(x)).toBeCloseTo(R.w / 2, 6);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(R.h + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(R.d / 2 + 1e-6);
      // every point is on the slope or RAMP_SLAB under it (or on the base)
      const below = slopeY(z) - y;
      expect(below).toBeGreaterThanOrEqual(-1e-6);
      expect(below).toBeLessThanOrEqual(RAMP_SLAB + 1e-6);
    }
  });

  test('stand on top: a player dropped onto the middle lands on the slope', async () => {
    const ph = await Physics.create(map);
    const r: PieceState = { id: 1, kind: 'ramp', owner: 0, pos: spot(), rotY: yaw(), hp: R.hp };
    ph.addPiece(r);
    ph.addPlayer(1, local(r, 0, R.h + 1, 0));
    const p = walk(ph, 1, v3(), 1.5);
    expect(p.grounded).toBe(true);
    expect(p.pos.y).toBeGreaterThan(r.pos.y + slopeY(0) - 0.15);
    expect(p.pos.y).toBeLessThan(r.pos.y + slopeY(0) + 0.15);
  });

  test('walk under: a raised ramp lets a player through underneath (the old wedge was solid to its base)', async () => {
    const ph = await Physics.create(map);
    const base = spot();
    const r: PieceState = { id: 1, kind: 'ramp', owner: 0, pos: v3(base.x, base.y + 1.0, base.z), rotY: yaw(), hp: R.hp };
    ph.addPiece(r);
    // underside at local z=+1.0 is 1.0 + slope - slab ≈ 2.05 m: head room for a 1.8 m player
    const start = local(r, -2.5, 0, 1.0);
    ph.addPlayer(1, v3(start.x, base.y, start.z));
    const across = rotateY(v3(1, 0, 0), r.rotY);
    const end = walk(ph, 1, across, 1.2).pos;
    const moved = (end.x - start.x) * across.x + (end.z - start.z) * across.z;
    expect(moved).toBeGreaterThan(5);
    expect(end.y).toBeLessThan(base.y + 0.2); // walked under, not over
  });

  test('shoot under: a shot under the slope passes, a shot through the slab hits the ramp', async () => {
    const ph = await Physics.create(map);
    const r: PieceState = { id: 7, kind: 'ramp', owner: 0, pos: spot(), rotY: yaw(), hp: R.hp };
    ph.addPiece(r);
    const across = rotateY(v3(1, 0, 0), r.rotY);
    const z = 1.2, under = slopeY(z) - RAMP_SLAB; // ≈ 1.15
    const shot = (y: number) => ph.raycastStatic(local(r, -3, y, z), across, 6);
    const low = shot(under - 0.4);
    expect(low?.hit.type === 'piece' && low.hit.id === r.id).toBe(false);
    const mid = shot(under + RAMP_SLAB / 2);
    expect(mid?.hit.type).toBe('piece');
    expect(mid?.hit.type === 'piece' && mid.hit.id).toBe(r.id);
    // bots' cover test agrees
    const eye = local(r, -3, under - 0.4, z), chest = local(r, 3, under - 0.4, z);
    expect(shields(r, eye, chest)).toBe(false);
    expect(shields(r, local(r, -3, under + RAMP_SLAB / 2, z), local(r, 3, under + RAMP_SLAB / 2, z))).toBe(true);
  });
});
