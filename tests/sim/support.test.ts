import { beforeAll, describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type PieceKind } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import type { IslandLayout } from '../../src/sim/map';

let m: Match;
let isl: IslandLayout;
const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };

/** Place a piece as player 1 standing at `stand`, aiming at `at`. Returns the new piece id. */
function place(kind: PieceKind, stand: { x: number; z: number }, at: { x: number; y: number; z: number }, rotY: number, standY = 0): number {
  m.debugTeleport(1, v3(stand.x, isl.groundY + standY, stand.z));
  m.debugGive(1, { pieces: { [kind]: 1 } });
  m.tick(new Map());
  const snap = m.tick(new Map([[1, { ...NO_INPUT, yaw: rotY, build: { kind, pos: at, rotY, free: true } }]]));
  const ev = snap.events.find((e) => e.type === 'placed');
  if (!ev) throw new Error(`could not place ${kind}`);
  for (let i = 0; i < 100; i++) m.tick(new Map()); // wait out the build busy time
  return ev.data.piece as number;
}

const pieceIds = () => m.tick(new Map()).pieces.map((p) => p.id);

beforeAll(() => {});

describe('structural support', () => {
  test('breaking the scaffold attached to the shore drops the rest of the bridge', async () => {
    m = await Match.create(humans);
    isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    const lane = (d: number) => add(add(isl.center, scale(f, d)), scale(r, 3));
    const a = place('scaffold', lane(20), v3(lane(23).x, isl.groundY, lane(23).z), yaw);
    const b = place('scaffold', lane(23), v3(lane(27).x, isl.groundY + 0.2, lane(27).z), yaw, 0.2);
    const c = place('scaffold', lane(27), v3(lane(31).x, isl.groundY + 0.2, lane(31).z), yaw, 0.2);
    expect(pieceIds()).toEqual(expect.arrayContaining([a, b, c]));
    m.debugDamagePiece(a, 10_000);
    const snap = m.tick(new Map());
    expect(snap.pieces.map((p) => p.id)).toEqual([]);
  });

  test('a wall stacked on sandbags falls when the sandbags break; a neighbour on the ground stays', async () => {
    m = await Match.create(humans);
    isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    const at = (d: number, side: number) => add(add(isl.center, scale(f, d)), scale(r, side));
    const base = place('sandbags', at(4, 3), v3(at(7, 3).x, isl.groundY, at(7, 3).z), yaw);
    const top = place('sandbags', at(4, 3), v3(at(7, 3).x, isl.groundY + 1.2, at(7, 3).z), yaw);
    const side = place('wood', at(1, 6), v3(at(3, 6).x, isl.groundY, at(3, 6).z), yaw); // clear of the shop stall at (6, 6)
    m.debugDamagePiece(base, 10_000);
    const ids = m.tick(new Map()).pieces.map((p) => p.id);
    expect(ids).not.toContain(top);
    expect(ids).toContain(side);
  });

  test('collapse events say the piece collapsed, with its position', async () => {
    m = await Match.create(humans);
    isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    const at = (d: number) => add(add(isl.center, scale(f, d)), scale(r, 3));
    const base = place('sandbags', at(4), v3(at(7).x, isl.groundY, at(7).z), yaw);
    const top = place('sandbags', at(4), v3(at(7).x, isl.groundY + 1.2, at(7).z), yaw);
    m.debugDamagePiece(base, 10_000);
    const snap = m.tick(new Map());
    const e = snap.events.find((x) => x.type === 'destroyed' && x.data.piece === top);
    expect(e?.data).toMatchObject({ collapse: true, kind: 'sandbags' });
    expect(e?.data.pos).toBeDefined();
  });
});
