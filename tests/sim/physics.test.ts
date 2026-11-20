import { beforeAll, describe, expect, test } from 'vitest';
import { Physics } from '../../src/sim/physics';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { DT, PLAYER } from '../../src/sim/constants';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import type { PieceState, Vec3 } from '../../src/sim/types';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });

/** Simulate a player walking with gravity for `secs`. */
function walk(ph: Physics, id: number, dir: Vec3, speed: number, secs: number) {
  let vy = 0;
  let last = { pos: v3(), grounded: false };
  for (let t = 0; t < secs; t += DT) {
    vy -= PLAYER.gravity * DT;
    last = ph.movePlayer(id, v3(dir.x * speed * DT, vy * DT, dir.z * speed * DT));
    if (last.grounded && vy < 0) vy = 0;
  }
  return last;
}

const isl = () => map[0];
// Lane 3 m to the side of the island's center line, clear of the generator/vault/shop props.
const front = (d: number): Vec3 =>
  add(add(isl().center, scale(forward(isl().bunker.facingYaw), d)), scale(right(isl().bunker.facingYaw), 3));

describe('Physics', () => {
  test('player dropped on the island lands on the ground', async () => {
    const ph = await Physics.create(map);
    const p = front(10);
    ph.addPlayer(1, v3(p.x, 5, p.z));
    const r = walk(ph, 1, v3(), 0, 2);
    expect(r.grounded).toBe(true);
    expect(r.pos.y).toBeCloseTo(isl().groundY, 1);
  });

  test('walking off the edge falls below the water', async () => {
    const ph = await Physics.create(map);
    const p = front(18);
    ph.addPlayer(1, v3(p.x, isl().groundY, p.z));
    const r = walk(ph, 1, forward(isl().bunker.facingYaw), 5, 4);
    expect(r.pos.y).toBeLessThan(0);
  });

  test('bunker back wall blocks walking out the back', async () => {
    const ph = await Physics.create(map);
    const b = isl().bunker;
    ph.addPlayer(1, v3(b.center.x, b.center.y, b.center.z));
    const back = forward(b.facingYaw + Math.PI);
    const r = walk(ph, 1, back, 5, 2);
    const moved = (r.pos.x - b.center.x) * back.x + (r.pos.z - b.center.z) * back.z;
    expect(moved).toBeLessThan(2.1);
  });

  test('raycast hits a piece, then passes after removal', async () => {
    const ph = await Physics.create(map);
    const yaw = isl().bunker.facingYaw;
    const origin = add(front(4), v3(0, isl().groundY + 1, 0));
    const piecePos = add(front(9), v3(0, isl().groundY, 0));
    const piece: PieceState = { id: 7, kind: 'steel', owner: 1, pos: piecePos, rotY: yaw, hp: 1200 };
    ph.addPiece(piece);
    const hit = ph.raycast(origin, forward(yaw), 20);
    expect(hit?.hit).toEqual({ type: 'piece', id: 7 });
    expect(hit!.dist).toBeCloseTo(5 - 0.075, 1);
    ph.removePiece(7);
    const after = ph.raycast(origin, forward(yaw), 20);
    expect(after?.hit.type === 'piece').toBe(false);
  });

  test('raycast reports players and can ignore one', async () => {
    const ph = await Physics.create(map);
    const yaw = isl().bunker.facingYaw;
    const a = front(4), b = front(10);
    ph.addPlayer(1, v3(a.x, isl().groundY, a.z));
    ph.addPlayer(2, v3(b.x, isl().groundY, b.z));
    const hit = ph.raycast(v3(a.x, isl().groundY + 1.6, a.z), forward(yaw), 30, 1);
    expect(hit?.hit).toEqual({ type: 'player', id: 2 });
  });

  test('player can walk up a ramp', async () => {
    const ph = await Physics.create(map);
    const yaw = isl().bunker.facingYaw;
    const rampBase = add(front(8), v3(0, isl().groundY, 0));
    // Ramp rises along local +Z; local +Z of rotY=yaw points backward, so rotate by PI to rise toward travel.
    ph.addPiece({ id: 3, kind: 'ramp', owner: 1, pos: rampBase, rotY: yaw + Math.PI, hp: 200 });
    const start = front(4);
    ph.addPlayer(1, v3(start.x, isl().groundY, start.z));
    const r = walk(ph, 1, forward(yaw), 4, 1.3);
    expect(r.pos.y).toBeGreaterThan(isl().groundY + 0.8);
  });

  test('isGroundAt returns top y on land, null over water', async () => {
    const ph = await Physics.create(map);
    const c = isl().center;
    expect(ph.isGroundAt(c.x + 5, c.z)).toBeCloseTo(isl().groundY, 2);
    expect(ph.isGroundAt(0, 0)).toBeNull();
  });
});
