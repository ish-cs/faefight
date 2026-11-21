import { beforeAll, describe, expect, test } from 'vitest';
import { BuildAim } from '../../src/client/buildAim';
import { validatePlacement } from '../../src/sim/building';
import { DT, PIECES, PLAYER } from '../../src/sim/constants';
import { buildMap, CRANE, harborCraneBoxes, type Box, type IslandLayout } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import { unsupportedPieces } from '../../src/sim/support';
import type { PieceState, Vec3 } from '../../src/sim/types';
import { add, norm, rotateY, sub, v3, yawOf } from '../../src/sim/vec';

let map: IslandLayout[];
let boxes: Box[];
beforeAll(() => { map = buildMap(2); boxes = harborCraneBoxes(map); });
/** Island 0's crane: 4 legs, 2 low beams, 2 + 2 top girders. */
const crane = () => boxes.slice(0, 8);
const legs = () => crane().filter((b) => b.half.y > 2);
const lowBeams = () => crane().filter((b) => Math.abs(b.center.y - (map[0].groundY + 0.2 + CRANE.lowBeamY)) < 0.01);
/** World point at local (x, z) offset from a box centre (its own frame), at height y. */
const off = (b: Box, x: number, z: number, y: number): Vec3 => { const p = add(b.center, rotateY(v3(x, 0, z), b.rotY)); return v3(p.x, y, p.z); };

function fall(ph: Physics, id: number, secs: number) {
  let vy = 0;
  let last = { pos: v3(), grounded: false };
  for (let t = 0; t < secs; t += DT) {
    vy -= PLAYER.gravity * DT;
    last = ph.movePlayer(id, v3(0, vy * DT, 0));
    if (last.grounded && vy < 0) vy = 0;
  }
  return last;
}

describe('harbor crane', () => {
  test('has solid legs and beams in the sim; a player can stand on the low beam', async () => {
    expect(legs()).toHaveLength(4);
    expect(lowBeams()).toHaveLength(2);
    const ph = await Physics.create(map);
    const beam = lowBeams()[0];
    const top = beam.center.y + beam.half.y;
    ph.addPlayer(1, off(beam, 0, 2, top + 1));
    const r = fall(ph, 1, 2);
    expect(r.grounded).toBe(true);
    expect(r.pos.y).toBeCloseTo(top, 1);
  });

  test('a piece overlapping a leg is rejected; one flush against it is accepted and anchored', async () => {
    const ph = await Physics.create(map);
    const leg = legs()[0];
    const y = leg.center.y - leg.half.y + 4; // 4 m up the leg: nothing below (quay is scenery)
    const player = off(leg, 0, 3, y);
    const rot = yawOf(sub(off(leg, 0, 0, y), player)); // facing the leg
    expect(validatePlacement(ph, 'scaffold', off(leg, 0, 1, y), rot, player)).toEqual({ ok: false, reason: 'blocked' });
    const flush = off(leg, 0, leg.half.z + PIECES.scaffold.d / 2 + 0.02, y);
    const r = validatePlacement(ph, 'scaffold', flush, rot, player);
    expect(r).toEqual({ ok: true, pos: flush });
    if (!r.ok) return;
    const p: PieceState = { id: 1, kind: 'scaffold', owner: 0, pos: r.pos, rotY: rot, hp: 200 };
    ph.addPiece(p);
    // a second deck off its far end: supported only through the first
    const q: PieceState = { id: 2, kind: 'scaffold', owner: 0, pos: off(leg, 0, leg.half.z + 1.5 * PIECES.scaffold.d + 0.02, y), rotY: rot, hp: 200 };
    ph.addPiece(q);
    const all = new Map([[1, p], [2, q]]);
    expect(unsupportedPieces(ph, all)).toEqual([]);
    ph.removePiece(1);
    all.delete(1);
    expect(unsupportedPieces(ph, all)).toEqual([2]);
  });

  test('a wall built on the low beam rests on it and stays supported alone', async () => {
    const ph = await Physics.create(map);
    const beam = lowBeams()[0];
    const top = beam.center.y + beam.half.y;
    const player = off(beam, 0, 3, top);
    const r = validatePlacement(ph, 'wood', off(beam, 0, 0, top + 0.1), beam.rotY + Math.PI / 2, player);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pos.y).toBeCloseTo(top, 3);
    const p: PieceState = { id: 1, kind: 'wood', owner: 0, pos: r.pos, rotY: beam.rotY + Math.PI / 2, hp: 250 };
    ph.addPiece(p);
    expect(unsupportedPieces(ph, new Map([[1, p]]))).toEqual([]);
  });

  test('snap assist offers a spot flush against a leg', async () => {
    const ph = await Physics.create(map);
    const leg = legs()[0];
    const y = leg.center.y - leg.half.y + 4;
    const player = off(leg, 0, 3, y);
    const target = off(leg, 0, leg.half.z + 1, y);
    const eye = v3(player.x, player.y + 1.6, player.z);
    const out = new BuildAim().update({
      physics: ph, kind: 'scaffold', ray: { eye, dir: norm(sub(target, eye)) }, player, yaw: yawOf(sub(target, player)), buildRot: 0,
      free: false, humanId: 1, pieces: [], islands: map, myIsland: 0,
    });
    expect(out.ok).toBe(true);
    expect(out.tag).toBe('beside');
  });
});
