import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { Physics } from '../../src/sim/physics';
import { buildMap } from '../../src/sim/map';
import { unsupportedPieces } from '../../src/sim/support';
import { PIECES } from '../../src/sim/constants';
import { NO_INPUT, type PieceKind, type PieceState, type Vec3 } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import type { IslandLayout } from '../../src/sim/map';

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };

/** Place a piece through the real build path as player 1 standing at `stand`, aiming at `at`. */
function place(m: Match, isl: IslandLayout, kind: PieceKind, stand: Vec3, at: Vec3, rotY: number): number {
  m.debugTeleport(1, v3(stand.x, isl.groundY, stand.z));
  m.debugGive(1, { pieces: { [kind]: 1 } });
  m.tick(new Map());
  const snap = m.tick(new Map([[1, { ...NO_INPUT, yaw: rotY, build: { kind, pos: at, rotY, free: true } }]]));
  const ev = snap.events.find((e) => e.type === 'placed');
  if (!ev) throw new Error(`could not place ${kind} at ${JSON.stringify(at)}`);
  for (let i = 0; i < 100; i++) m.tick(new Map()); // wait out the build busy time
  return ev.data.piece as number;
}

const ids = (m: Match) => m.tick(new Map()).pieces.map((p) => p.id);

/** Break `victim`, tick, and return which of `keep` collapsed. */
function collapsedAfterBreaking(m: Match, victim: number, keep: number[]): number[] {
  m.debugDamagePiece(victim, 10_000);
  const left = ids(m);
  expect(left).not.toContain(victim);
  return keep.filter((id) => !left.includes(id));
}

describe('ground support at exactly ground height', () => {
  test.each([0, 1e-9, -1e-9, 1e-4, -1e-4, 0.05, -0.05, 0.1, -0.1, -0.2, -0.5])(
    'a lone piece with its base at groundY + %s is supported', async (dy) => {
      const map = buildMap(2);
      const ph = await Physics.create(map);
      const isl = map[0];
      const f = forward(isl.bunker.facingYaw), r = right(isl.bunker.facingYaw);
      const pieces = new Map<number, PieceState>();
      (['steel', 'wood', 'metal', 'sandbags', 'ramp', 'container'] as PieceKind[]).forEach((kind, i) => {
        const c = add(add(isl.center, scale(f, -4 + i * 2.5)), scale(r, 4));
        const p: PieceState = { id: i + 1, kind, owner: 0, pos: v3(c.x, isl.groundY + dy, c.z), rotY: isl.bunker.facingYaw, hp: PIECES[kind].hp };
        pieces.set(p.id, p);
        ph.addPiece(p);
      });
      expect(unsupportedPieces(ph, pieces)).toEqual([]);
    });

  test.each([0.13, 0.3, 1])('a piece hovering %f m above the ground still collapses', async (dy) => {
    const map = buildMap(2);
    const ph = await Physics.create(map);
    const isl = map[0];
    const p: PieceState = { id: 1, kind: 'steel', owner: 0, pos: v3(isl.center.x, isl.groundY + dy, isl.center.z), rotY: 0, hp: 1 };
    ph.addPiece(p);
    expect(unsupportedPieces(ph, new Map([[1, p]]))).toEqual([1]);
  });

  test('flat ground: breaking an unrelated piece drops none of the walls placed by a player', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    const at = (d: number, side: number) => { const p = add(add(isl.center, scale(f, d)), scale(r, side)); return v3(p.x, isl.groundY, p.z); };
    const walls = [-3, -0.5, 2].map((side) => place(m, isl, 'steel', at(1, side), at(3, side), yaw));
    const others = (['wood', 'metal', 'sandbags', 'ramp'] as PieceKind[]).map((k, i) => place(m, isl, k, at(-6, -6 + i * 3), at(-3, -6 + i * 3), yaw));
    const victim = place(m, isl, 'sandbags', at(-2, 8), at(0, 8), yaw);
    // Real placement rests on the ray hit: ground height up to float32 noise (seen: +4.8e-7), never exact.
    for (const p of m.tick(new Map()).pieces.filter((q) => walls.includes(q.id))) expect(p.pos.y).toBeCloseTo(isl.groundY, 5);
    expect(collapsedAfterBreaking(m, victim, [...walls, ...others])).toEqual([]);
  });

  test('bunker doorways: steel plugs placed by a player survive an unrelated break', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const plugs = isl.bunker.doorways.map((d) => {
      const out = forward(d.yaw);
      const at = add(d.center, scale(out, 0.15 + PIECES.steel.d / 2 + 0.05));
      const stand = add(d.center, scale(out, 3));
      return place(m, isl, 'steel', stand, v3(at.x, isl.groundY, at.z), d.yaw);
    });
    const yaw = isl.bunker.facingYaw;
    const c = add(isl.center, scale(right(yaw), 6));
    const victim = place(m, isl, 'sandbags', add(c, scale(forward(yaw), -2)), v3(c.x, isl.groundY, c.z), yaw);
    expect(collapsedAfterBreaking(m, victim, plugs)).toEqual([]);
  });

  test('island rim: a wall hanging half over the water stays up after an unrelated break', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    // Along the lateral axis to the rim, wall facing outward so its width runs along the rim.
    const rim = (d: number) => { const p = add(isl.center, scale(r, d)); return v3(p.x, isl.groundY, p.z); };
    const wall = place(m, isl, 'steel', rim(isl.radius - 3), rim(isl.radius - 0.05), yaw + Math.PI / 2);
    const side = place(m, isl, 'wood', rim(isl.radius - 3), add(rim(isl.radius - 0.6), scale(f, 2.5)), yaw);
    const victim = place(m, isl, 'sandbags', add(isl.center, scale(f, 3)), add(rim(0), scale(f, 6)), yaw);
    expect(collapsedAfterBreaking(m, victim, [wall, side])).toEqual([]);
  });

  test('walls touching each other at ground level survive their neighbour breaking', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw, f = forward(yaw), r = right(yaw);
    const at = (d: number, side: number) => { const p = add(add(isl.center, scale(f, d)), scale(r, side)); return v3(p.x, isl.groundY, p.z); };
    const row = [0, 2, 4, 6].map((side) => place(m, isl, 'steel', at(1, side - 2), at(3, side - 2), yaw));
    expect(collapsedAfterBreaking(m, row[1], [row[0], row[2], row[3]])).toEqual([]);
  });
});
