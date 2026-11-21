import { beforeAll, describe, expect, test } from 'vitest';
import { damagePiece, snapPlacement, validatePlacement } from '../../src/sim/building';
import { Physics } from '../../src/sim/physics';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import type { PieceState, Vec3 } from '../../src/sim/types';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
const spot = (d: number, side = 3): Vec3 => {
  const p = add(add(isl().center, scale(forward(yaw()), d)), scale(right(yaw()), side));
  return v3(p.x, isl().groundY, p.z);
};

describe('snapPlacement', () => {
  test('rounds to 0.5 m and 15 degrees', () => {
    const r = snapPlacement(v3(1.26, 2, -0.74), (17 * Math.PI) / 180, false);
    expect(r.pos).toEqual(v3(1.5, 2, -0.5));
    expect(r.rotY).toBeCloseTo((15 * Math.PI) / 180);
  });
  test('free placement keeps raw values', () => {
    const r = snapPlacement(v3(1.26, 2, -0.74), 0.3, true);
    expect(r.pos).toEqual(v3(1.26, 2, -0.74));
    expect(r.rotY).toBe(0.3);
  });
});

describe('validatePlacement', () => {
  test('rejects beyond 5 m reach', async () => {
    const ph = await Physics.create(map);
    const r = validatePlacement(ph, 'sandbags', spot(12), yaw(), spot(4));
    expect(r.ok).toBe(false);
  });
  test('accepts on ground within reach', async () => {
    const ph = await Physics.create(map);
    const r = validatePlacement(ph, 'sandbags', spot(7), yaw(), spot(4));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pos.y).toBeCloseTo(isl().groundY, 2);
  });
  test('rejects overlap with an existing piece', async () => {
    const ph = await Physics.create(map);
    ph.addPiece({ id: 1, kind: 'steel', owner: 0, pos: spot(7), rotY: yaw(), hp: 1200 });
    expect(validatePlacement(ph, 'wood', spot(7), yaw(), spot(4)).ok).toBe(false);
  });
  test('second sandbags stacks on top of the first', async () => {
    const ph = await Physics.create(map);
    ph.addPiece({ id: 1, kind: 'sandbags', owner: 0, pos: spot(7), rotY: yaw(), hp: 150 });
    const r = validatePlacement(ph, 'sandbags', add(spot(7), v3(0, 1.2, 0)), yaw(), spot(4));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pos.y).toBeCloseTo(isl().groundY + 1.0, 2);
  });
  test('scaffold may hang over water from the shore, but not float', async () => {
    const ph = await Physics.create(map);
    const f = forward(yaw());
    // Island front edge is 22 m from center; scaffold centered at 23 m spans 21..25 m.
    const edge = v3(isl().center.x + f.x * 23, isl().groundY, isl().center.z + f.z * 23);
    const stand = v3(isl().center.x + f.x * 20, isl().groundY, isl().center.z + f.z * 20);
    expect(validatePlacement(ph, 'scaffold', edge, yaw(), stand).ok).toBe(true);
    const floating = v3(isl().center.x + f.x * 26, isl().groundY, isl().center.z + f.z * 26);
    const standEdge = v3(isl().center.x + f.x * 21.5, isl().groundY, isl().center.z + f.z * 21.5);
    expect(validatePlacement(ph, 'scaffold', floating, yaw(), standEdge).ok).toBe(false);
  });
  test('chained scaffold stays level with the deck it attaches to', async () => {
    const ph = await Physics.create(map);
    const f = forward(yaw());
    const at = (d: number) => v3(isl().center.x + f.x * d, isl().groundY, isl().center.z + f.z * d);
    const first = validatePlacement(ph, 'scaffold', at(23), yaw(), at(20));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    ph.addPiece({ id: 1, kind: 'scaffold', owner: 0, pos: first.pos, rotY: yaw(), hp: 200 });
    // Standing on the first deck, attach the next 4 m segment to its far end.
    const second = validatePlacement(ph, 'scaffold', add(at(27), v3(0, 0.2, 0)), yaw(), add(at(24), v3(0, 0.2, 0)));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.pos.y).toBeCloseTo(first.pos.y, 2);
  });

  test('non-scaffold pieces cannot be placed over water', async () => {
    const ph = await Physics.create(map);
    const f = forward(yaw());
    const water = v3(isl().center.x + f.x * 25, isl().groundY, isl().center.z + f.z * 25);
    const stand = v3(isl().center.x + f.x * 21, isl().groundY, isl().center.z + f.z * 21);
    expect(validatePlacement(ph, 'sandbags', water, yaw(), stand).ok).toBe(false);
  });
});

describe('damagePiece', () => {
  const piece = (kind: PieceState['kind'], hp: number): PieceState => ({ id: 1, kind, owner: 0, pos: v3(), rotY: 0, hp });
  test('steel takes a tenth of bullet damage', () => {
    const p = piece('steel', 1200);
    damagePiece(p, 30, 'bullet');
    expect(p.hp).toBeCloseTo(1197);
  });
  test('fists do nothing to steel', () => {
    const p = piece('steel', 1200);
    expect(damagePiece(p, 10, 'fist')).toBe(false);
    expect(p.hp).toBe(1200);
  });
  test('explosives do full damage and report destruction', () => {
    const p = piece('steel', 1200);
    expect(damagePiece(p, 1500, 'explosive')).toBe(true);
  });
});

describe('forgiving placement', () => {
  // In front of the island (fwd 2): clear of the shop/generator/vault no-build zones at fwd 6..8.
  const wall = (id: number, pos: Vec3, rotY: number): PieceState => ({ id, kind: 'wood', owner: 0, pos, rotY, hp: 250 });
  test('a wall just touching / slightly overlapping its neighbour is accepted', async () => {
    const ph = await Physics.create(map);
    ph.addPiece(wall(1, spot(2, 2), yaw()));
    // 2 m wide walls side by side, overlapping by 0.1 m.
    const r = validatePlacement(ph, 'wood', spot(2, 2 + 1.9), yaw(), spot(-1, 3));
    expect(r.ok).toBe(true);
  });
  test('a rotated wall whose corner clips a neighbour is accepted', async () => {
    const ph = await Physics.create(map);
    ph.addPiece(wall(1, spot(2, 2), yaw()));
    const r = validatePlacement(ph, 'wood', spot(2.3, 4), yaw() + Math.PI / 6, spot(-1, 3));
    expect(r.ok).toBe(true);
  });
  test('a bigger overlap is nudged clear (by at most half a metre)', async () => {
    const ph = await Physics.create(map);
    ph.addPiece(wall(1, spot(2, 2), yaw()));
    const want = spot(2, 2 + 1.6); // overlaps 0.4 m
    const r = validatePlacement(ph, 'wood', want, yaw(), spot(-1, 3));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.hypot(r.pos.x - want.x, r.pos.z - want.z)).toBeLessThanOrEqual(0.51);
  });
  test('placing right on top of an existing wall is still rejected', async () => {
    const ph = await Physics.create(map);
    ph.addPiece(wall(1, spot(2, 2), yaw()));
    expect(validatePlacement(ph, 'wood', spot(2, 2), yaw(), spot(-1, 3)).ok).toBe(false);
  });
  test('never places a piece inside a player', async () => {
    const ph = await Physics.create(map);
    ph.addPlayer(2, spot(2, 3));
    expect(validatePlacement(ph, 'wood', spot(2, 3), yaw(), spot(-1, 3)).ok).toBe(false);
  });
});
