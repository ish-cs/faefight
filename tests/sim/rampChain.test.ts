import { beforeAll, describe, expect, test } from 'vitest';
import { BuildAim } from '../../src/client/buildAim';
import { validatePlacement } from '../../src/sim/building';
import { DT, PIECES, PLAYER } from '../../src/sim/constants';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import { unsupportedPieces } from '../../src/sim/support';
import type { PieceKind, PieceState, Vec3 } from '../../src/sim/types';
import { add, dist2D, forward, norm, right, rotateY, scale, sub, v3 } from '../../src/sim/vec';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
/** Climb direction: back toward the bunker, on a lane 3 m to the side (clear of the stations). */
const dir = () => forward(yaw() + Math.PI);
const lane = (d: number): Vec3 => {
  const p = add(add(isl().center, scale(dir(), d)), scale(right(yaw()), 3));
  return v3(p.x, isl().groundY, p.z);
};
const R = PIECES.ramp;

/** Walk with gravity toward `dir` until `until` says stop (or time runs out); returns the last pose. */
function walk(ph: Physics, id: number, d: Vec3, secs: number, until: (p: Vec3) => boolean) {
  let vy = 0;
  let last = { pos: v3(), grounded: false };
  for (let t = 0; t < secs; t += DT) {
    vy -= PLAYER.gravity * DT;
    last = ph.movePlayer(id, v3(d.x * 5 * DT, vy * DT, d.z * 5 * DT));
    if (last.grounded && vy < 0) vy = 0;
    if (until(last.pos)) break;
  }
  return last;
}

/** Resolve the build ghost like the client does, then place through the sim's validation. */
function aimAndPlace(ph: Physics, pieces: PieceState[], kind: PieceKind, player: Vec3, target: Vec3): PieceState {
  const eye = v3(player.x, player.y + 1.6, player.z);
  const out = new BuildAim().update({
    physics: ph, kind, ray: { eye, dir: norm(sub(target, eye)) }, player, yaw: yaw() + Math.PI, buildRot: 0, free: false,
    humanId: 1, pieces, islands: map, myIsland: 0,
  });
  if (!out.ok || !out.req) throw new Error(`ghost invalid: ${out.reason}`);
  const r = validatePlacement(ph, kind, out.req.pos, out.req.rotY, player);
  if (!r.ok) throw new Error(`sim rejected: ${r.reason}`);
  expect(r.pos.y).toBeCloseTo(out.ghost.y, 5); // the ghost shows exactly where it lands
  const p: PieceState = { id: pieces.length + 1, kind, owner: 0, pos: r.pos, rotY: out.req.rotY, hp: 200 };
  ph.addPiece(p);
  pieces.push(p);
  return p;
}

const along = (p: Vec3) => (p.x - lane(0).x) * dir().x + (p.z - lane(0).z) * dir().z;

describe('ramp staircases', () => {
  test('3 ramps chain by aiming forward from the top of each: even rise, flush edges, supported, walkable', async () => {
    const ph = await Physics.create(map);
    const pieces: PieceState[] = [];
    const g = isl().groundY;
    ph.addPlayer(1, lane(0));
    let player = lane(0);
    // first ramp: aim at the ground ahead
    aimAndPlace(ph, pieces, 'ramp', player, lane(2.5));
    for (let k = 1; k < 3; k++) {
      // walk up to just short of the top edge, then aim roughly forward past it
      const prev = pieces[k - 1];
      const topEdge = along(add(prev.pos, rotateY(v3(0, 0, R.d / 2), prev.rotY)));
      player = walk(ph, 1, dir(), 4, (p) => along(p) >= topEdge - 0.6).pos;
      expect(player.y).toBeGreaterThan(prev.pos.y + R.h - 0.5);
      const aimAt = add(add(player, scale(dir(), 2.6)), v3(0.4, 0.3, 0)); // rough aim, a bit off to the side
      aimAndPlace(ph, pieces, 'ramp', player, aimAt);
    }
    for (let k = 0; k < 3; k++) {
      expect(pieces[k].pos.y).toBeCloseTo(g + k * R.h, 3);
      expect(pieces[k].rotY).toBeCloseTo(pieces[0].rotY, 5);
    }
    for (let k = 1; k < 3; k++) {
      const topEdge = add(pieces[k - 1].pos, rotateY(v3(0, R.h, R.d / 2), pieces[k].rotY));
      const lowEdge = add(pieces[k].pos, rotateY(v3(0, 0, -R.d / 2), pieces[k].rotY));
      expect(dist2D(topEdge, lowEdge)).toBeLessThan(1e-3);
      expect(Math.abs(topEdge.y - lowEdge.y)).toBeLessThan(1e-3);
    }
    expect(unsupportedPieces(ph, new Map(pieces.map((p) => [p.id, p])))).toEqual([]);

    // walk from the bottom to the top without getting stuck at the joints
    ph.setPlayerPos(1, lane(-1));
    const top = pieces[2];
    const end = along(add(top.pos, rotateY(v3(0, 0, R.d / 2), top.rotY)));
    const r = walk(ph, 1, dir(), 5, (p) => along(p) >= end - 0.4);
    expect(along(r.pos)).toBeGreaterThanOrEqual(end - 0.4);
    expect(r.pos.y).toBeGreaterThan(g + 3 * R.h - 0.4);
  });

  test('removing the base ramp collapses the chain above it', async () => {
    const ph = await Physics.create(map);
    const g = isl().groundY;
    const rot = yaw(); // local +Z = dir()
    const pieces = [0, 1, 2].map((k): PieceState => ({
      id: k + 1, kind: 'ramp', owner: 0, rotY: rot, hp: 200, pos: v3(lane(2 + k * R.d).x, g + k * R.h, lane(2 + k * R.d).z),
    }));
    for (const p of pieces) ph.addPiece(p);
    const all = new Map(pieces.map((p) => [p.id, p]));
    expect(unsupportedPieces(ph, all)).toEqual([]);
    ph.removePiece(1);
    all.delete(1);
    expect(unsupportedPieces(ph, all).sort()).toEqual([2, 3]);
  });

  test('a ramp stacks on a wall top, climbing away from the player, and stays supported by it', async () => {
    const ph = await Physics.create(map);
    const wall: PieceState = { id: 1, kind: 'wood', owner: 0, pos: lane(2), rotY: yaw(), hp: 250 };
    ph.addPiece(wall);
    const pieces = [wall];
    const player = lane(0);
    const ramp = aimAndPlace(ph, pieces, 'ramp', player, add(lane(3.5), v3(0, PIECES.wood.h + 0.3, 0)));
    expect(ramp.pos.y).toBeCloseTo(isl().groundY + PIECES.wood.h, 3);
    expect(along(ramp.pos)).toBeGreaterThan(along(wall.pos)); // climbs away from the player
    const all = new Map(pieces.map((p) => [p.id, p]));
    expect(unsupportedPieces(ph, all)).toEqual([]);
    ph.removePiece(1);
    all.delete(1);
    expect(unsupportedPieces(ph, all)).toEqual([ramp.id]);
  });

  test('a ramp aimed at the ground next to a ramp top does not jump up onto it', async () => {
    const ph = await Physics.create(map);
    const base: PieceState = { id: 1, kind: 'ramp', owner: 0, pos: lane(2), rotY: yaw(), hp: 200 };
    ph.addPiece(base);
    const want = add(base.pos, rotateY(v3(0, 0, R.d), yaw()));
    const r = validatePlacement(ph, 'ramp', want, yaw(), lane(4.5));
    expect(r.ok && r.pos.y).toBeCloseTo(isl().groundY, 3);
  });
});
