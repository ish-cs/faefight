import { beforeAll, describe, expect, test } from 'vitest';
import { BuildAim, candidatesFor, rayDist, scoreCandidate, snapAngle, snapAxis, type AimInput, type Candidate, type Ray } from '../../src/client/buildAim';
import { snapPlacement, validatePlacement } from '../../src/sim/building';
import { PIECES } from '../../src/sim/constants';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import type { PieceKind, PieceState, Vec3 } from '../../src/sim/types';
import { add, dist2D, forward, norm, right, scale, sub, v3, yawOf } from '../../src/sim/vec';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const EYE = 1.6;
const rayTo = (player: Vec3, target: Vec3): Ray => {
  const eye = v3(player.x, player.y + EYE, player.z);
  return { eye, dir: norm(sub(target, eye)) };
};
const cand = (over: Partial<Candidate>): Candidate => ({
  tag: 'beside', pos: v3(0, 0, -3), rotY: 0, pts: [v3(0, 1, -3)], anchor: null, useful: 1, radius: 1.5, key: 'k', ...over,
});

describe('snapping math', () => {
  test('snapAxis rounds to the grid and holds the cell until clearly past the boundary', () => {
    expect(snapAxis(1.26, null)).toBe(1.5);
    expect(snapAxis(1.2, 1.5)).toBe(1.5); // 0.3 from the held cell: within half a cell + hysteresis
    expect(snapAxis(1.1, 1.5)).toBe(1); // 0.4 away: moves
    expect(snapAxis(1.74, 1.5)).toBe(1.5);
    expect(snapAxis(1.9, 1.5)).toBe(2);
  });
  test('snapAngle snaps to 15 degrees with hysteresis and wraps around', () => {
    const d = Math.PI / 180;
    expect(snapAngle(17 * d, null)).toBeCloseTo(15 * d);
    expect(snapAngle(24 * d, 15 * d)).toBeCloseTo(15 * d);
    expect(snapAngle(27 * d, 15 * d)).toBeCloseTo(30 * d);
    expect(snapAngle(-179 * d, 180 * d)).toBeCloseTo(180 * d); // across the ±π seam: same spot
  });
  test('rayDist measures perpendicular distance in front and eye distance behind', () => {
    const r: Ray = { eye: v3(0, 0, 0), dir: v3(0, 0, -1) };
    expect(rayDist(r, v3(1, 0, -5))).toBeCloseTo(1);
    expect(rayDist(r, v3(0, 2, 3))).toBeCloseTo(Math.hypot(2, 3));
  });
});

describe('scoreCandidate', () => {
  const player = v3(0, 0, 0);
  const ray: Ray = { eye: v3(0, 1.6, 0), dir: norm(v3(0, -0.3, -1)) };
  test('closer to the aim ray scores higher; outside the radius is not eligible', () => {
    const near = scoreCandidate(cand({ pts: [v3(0.2, 0.7, -3)] }), ray, player, 0, null);
    const far = scoreCandidate(cand({ pts: [v3(1.2, 0.7, -3)] }), ray, player, 0, null);
    expect(near).toBeGreaterThan(far);
    expect(scoreCandidate(cand({ pts: [v3(3, 0.7, -3)] }), ray, player, 0, null)).toBe(-Infinity);
  });
  test('spots behind the player are never offered', () => {
    expect(scoreCandidate(cand({ pos: v3(0, 0, 3), pts: [v3(0, 1.6, 0.5)] }), ray, player, 0, null)).toBe(-Infinity);
  });
  test('usefulness ranks a doorway plug over a plain in-line spot at the same distance', () => {
    const pts = [v3(0.5, 0.7, -3)];
    const door = scoreCandidate(cand({ tag: 'door', useful: 1.4, radius: 2.2, pts, key: 'd' }), ray, player, 0, null);
    const beside = scoreCandidate(cand({ useful: 0.65, radius: 1.1, pts, key: 'b' }), ray, player, 0, null);
    expect(door).toBeGreaterThan(beside);
  });
  test('hysteresis: the previous winner keeps a wider radius and a bonus; after raw aim, candidates need a tighter aim', () => {
    const c = cand({ pts: [v3(1.7, 0.7, -3)] }); // ~1.7 m off: outside 1.5
    expect(scoreCandidate(c, ray, player, 0, null)).toBe(-Infinity);
    expect(scoreCandidate(c, ray, player, 0, 'k')).toBeGreaterThan(0);
    const c2 = cand({ pts: [v3(1.4, 0.7, -3)] });
    expect(scoreCandidate(c2, ray, player, 0, null)).toBeGreaterThan(-Infinity);
    expect(scoreCandidate(c2, ray, player, 0, 'aim')).toBe(-Infinity);
  });
});

describe('candidatesFor', () => {
  const piece = (id: number, kind: PieceKind, pos: Vec3, rotY: number): PieceState => ({ id, kind, owner: 1, pos, rotY, hp: 100 });
  test('a scaffold offers both bridge ends; the end over water is the useful one', () => {
    const isl = map[0];
    const lat = right(isl.bunker.facingYaw);
    const rotY = yawOf(lat);
    const deck = add(isl.center, scale(lat, 23.65));
    const player = { ...add(isl.center, scale(lat, 24.5)), y: isl.groundY + 0.2 };
    const cs = candidatesFor('scaffold', player, rotY, [piece(1, 'scaffold', v3(deck.x, isl.groundY, deck.z), rotY)], map, 0)
      .filter((c) => c.tag === 'bridge');
    const out = cs.find((c) => dist2D(c.pos, isl.center) > 25)!;
    expect(out.useful).toBeGreaterThan(cs.find((c) => c !== out)?.useful ?? 0);
    expect(dist2D(out.pos, add(deck, scale(lat, 4)))).toBeCloseTo(0, 5);
  });
  test('two in-line walls one wall-width apart offer the gap between them', () => {
    const isl = map[0];
    const y = isl.bunker.facingYaw;
    const a = add(isl.center, scale(right(y), -2)), b = add(isl.center, scale(right(y), 2));
    const player = add(isl.center, scale(forward(y), -3));
    const cs = candidatesFor('wood', v3(player.x, isl.groundY, player.z), y,
      [piece(1, 'wood', v3(a.x, isl.groundY, a.z), y), piece(2, 'wood', v3(b.x, isl.groundY, b.z), y)], map, 0);
    const gaps = cs.filter((c) => c.tag === 'gap');
    expect(gaps).toHaveLength(1);
    expect(dist2D(gaps[0].pos, isl.center)).toBeCloseTo(0, 5);
  });
  test('walls near an enemy bunker offer doorway plugs (not at your own bunker)', () => {
    const enemy = map[1];
    const door = enemy.bunker.doorways[0];
    const player = { ...add(door.center, scale(forward(door.yaw), 3)), y: enemy.groundY };
    expect(candidatesFor('wood', player, door.yaw + Math.PI, [], map, 0).some((c) => c.tag === 'door')).toBe(true);
    expect(candidatesFor('wood', player, door.yaw + Math.PI, [], map, 1).some((c) => c.tag === 'door')).toBe(false);
  });
  test('a ramp onto sandbags faces the player (low end toward them)', () => {
    const isl = map[0];
    const y = isl.bunker.facingYaw;
    const bags = v3(isl.center.x, isl.groundY, isl.center.z);
    const player = { ...add(bags, scale(forward(y), -4.5)), y: isl.groundY };
    const r = candidatesFor('ramp', player, y, [piece(1, 'sandbags', bags, y)], map, 0).filter((c) => c.tag === 'ramp');
    expect(r).toHaveLength(1);
    // Rises along local +Z = toward the sandbags.
    const up = v3(Math.sin(r[0].rotY), 0, Math.cos(r[0].rotY));
    const toBags = norm(sub(bags, r[0].pos));
    expect(up.x * toBags.x + up.z * toBags.z).toBeGreaterThan(0.99);
  });
});

describe('BuildAim (local validation)', () => {
  const input = (ph: Physics, kind: PieceKind, player: Vec3, target: Vec3, yaw: number, pieces: PieceState[] = [], myIsland = 0): AimInput => ({
    physics: ph, kind, ray: rayTo(player, target), player, yaw, buildRot: 0, free: false, humanId: 99, pieces, islands: map, myIsland,
  });
  /** What the sim would do with the request a click sends. */
  const simPlace = (ph: Physics, kind: PieceKind, req: { pos: Vec3; rotY: number; free: boolean }, player: Vec3) => {
    const s = snapPlacement(req.pos, req.rotY, req.free);
    return validatePlacement(ph, kind, s.pos, s.rotY, player);
  };

  test('ground aim: grid-snapped, valid, and the ghost does not hop cells on small aim changes', async () => {
    const ph = await Physics.create(map);
    const isl = map[0];
    const y = isl.bunker.facingYaw;
    const player = v3(isl.center.x, isl.groundY, isl.center.z);
    const aim = new BuildAim();
    const ground = (d: number, side: number) => { const p = add(add(player, scale(forward(y), d)), scale(right(y), side)); return v3(p.x, isl.groundY, p.z); };
    const first = aim.update(input(ph, 'sandbags', player, ground(3.2, 0.24), y));
    expect(first.ok).toBe(true);
    expect(first.tag).toBe('aim');
    for (let i = 0; i < 20; i++) {
      const o = aim.update(input(ph, 'sandbags', player, ground(3.2, 0.24 + Math.sin(i) * 0.08), y));
      expect([o.ghost.x, o.ghost.z]).toEqual([first.ghost.x, first.ghost.z]);
      expect(o.ghost.y).toBeCloseTo(first.ghost.y, 4);
    }
    const r = simPlace(ph, 'sandbags', first.req!, player);
    expect(r.ok && r.pos).toEqual(first.ghost);
  });

  test('looking off the shore (not exactly at it) snaps a first bridge segment, then continues the bridge', async () => {
    const ph = await Physics.create(map);
    const isl = map[0];
    const lat = right(isl.bunker.facingYaw);
    const yaw = yawOf(lat);
    const player = { ...add(isl.center, scale(lat, 19.5)), y: isl.groundY };
    const aim = new BuildAim();
    // Aim at the water ~1 m to the side of straight ahead, past the edge.
    const off = add(add(isl.center, scale(lat, 24)), scale(forward(isl.bunker.facingYaw), 1));
    const a = aim.update(input(ph, 'scaffold', player, v3(off.x, 0, off.z), yaw));
    expect(a.tag).toBe('shore');
    expect(a.ok).toBe(true);
    const r1 = simPlace(ph, 'scaffold', a.req!, player);
    expect(r1.ok && r1.pos).toEqual(a.ghost);
    const p1: PieceState = { id: 1, kind: 'scaffold', owner: 0, pos: a.ghost, rotY: a.rotY, hp: 200 };
    ph.addPiece(p1);

    // Walk out onto the deck; aim at the water ahead, a little off the bridge line.
    let player2 = { ...add(a.ghost, scale(forward(a.rotY), 1)), y: a.ghost.y + PIECES.scaffold.h };
    const pieces = [p1];
    for (let n = 2; n <= 4; n++) {
      const last = pieces[pieces.length - 1];
      const target = add(add(last.pos, scale(forward(last.rotY), 5)), scale(right(last.rotY), 0.9));
      const b = new BuildAim().update(input(ph, 'scaffold', player2, v3(target.x, 0, target.z), yaw, pieces));
      expect(b.tag, `segment ${n}`).toBe('bridge');
      expect(b.ok).toBe(true);
      expect(b.ghost.y).toBeCloseTo(last.pos.y, 5); // level bridge
      expect(dist2D(b.ghost, add(last.pos, scale(forward(last.rotY), 4)))).toBeLessThan(1e-6);
      const r = simPlace(ph, 'scaffold', b.req!, player2);
      expect(r.ok && r.pos).toEqual(b.ghost);
      const p: PieceState = { id: n, kind: 'scaffold', owner: 0, pos: b.ghost, rotY: b.rotY, hp: 200 };
      ph.addPiece(p);
      pieces.push(p);
      player2 = { ...add(p.pos, scale(forward(p.rotY), 1)), y: p.pos.y + PIECES.scaffold.h };
    }
  });

  test('aiming near (not into) an enemy doorway plugs it with the wall', async () => {
    const ph = await Physics.create(map);
    const enemy = map[1];
    const door = enemy.bunker.doorways[0];
    const player = { ...add(door.center, scale(forward(door.yaw), 3.2)), y: enemy.groundY };
    const target = add(add(door.center, scale(right(door.yaw), 1.0)), v3(0, 0.6, 0));
    const o = new BuildAim().update(input(ph, 'wood', player, target, door.yaw + Math.PI, [], 0));
    expect(o.tag).toBe('door');
    expect(o.ok).toBe(true);
    expect(dist2D(o.ghost, door.center)).toBeLessThan(0.5);
    const r = simPlace(ph, 'wood', o.req!, player);
    expect(r.ok && r.pos).toEqual(o.ghost);
  });

  test('pointing at the top of a piece stacks on it, even right after an in-line snap was showing', async () => {
    const ph = await Physics.create(map);
    const isl = map[0];
    const y = isl.bunker.facingYaw;
    const bags: PieceState = { id: 7, kind: 'sandbags', owner: 0, pos: v3(isl.center.x, isl.groundY, isl.center.z), rotY: y + 0.26, hp: 150 };
    ph.addPiece(bags);
    const player = { ...add(bags.pos, scale(forward(y), -3.5)), y: isl.groundY };
    const aim = new BuildAim();
    const besideSpot = add(bags.pos, scale(right(bags.rotY), 2));
    expect(aim.update(input(ph, 'sandbags', player, v3(besideSpot.x, isl.groundY + 0.3, besideSpot.z), y, [bags])).tag).toBe('beside');
    const o = aim.update(input(ph, 'sandbags', player, v3(bags.pos.x + 0.3, isl.groundY + 1.0, bags.pos.z), y, [bags]));
    expect(o.tag).toBe('stack');
    expect(o.ok).toBe(true);
    expect(o.ghost.y).toBeCloseTo(isl.groundY + 1, 3);
  });

  test('free placement (Alt) skips the assist and the grid', async () => {
    const ph = await Physics.create(map);
    const enemy = map[1];
    const door = enemy.bunker.doorways[0];
    const player = { ...add(door.center, scale(forward(door.yaw), 3.2)), y: enemy.groundY };
    const target = add(door.center, scale(right(door.yaw), 1.0));
    const o = new BuildAim().update({ ...input(ph, 'wood', player, v3(target.x, enemy.groundY, target.z), door.yaw + Math.PI), free: true });
    expect(o.tag).toBe('aim');
  });
});
