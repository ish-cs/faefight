import { describe, expect, test } from 'vitest';
import { MAP, PIECES, PLAYER } from '../../src/sim/constants';
import { insideBunker } from '../../src/sim/bots/nav';
import { buildMap, bunkerSlitBoxes, bunkerWallBoxes, type Bunker } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { Physics } from '../../src/sim/physics';
import { isSealed } from '../../src/sim/seal';
import { NO_INPUT, type PieceState, type Vec3 } from '../../src/sim/types';
import { add, forward, rotateY, v3 } from '../../src/sim/vec';

const { slit, interior, wall } = MAP.bunker;
/** Bunker-local (x right, z back) → world, at height y above the floor. */
const at = (b: Bunker, x: number, z: number, y = 0): Vec3 => {
  const p = add(b.center, rotateY(v3(x, 0, z), b.facingYaw));
  return v3(p.x, b.center.y + y, p.z);
};
/** Lateral centre of the slit in a front-wall segment. */
const SLIT_X = MAP.bunker.doorWidth / 2 + (interior + 2 * wall - MAP.bunker.doorWidth) / 4;

describe('bunker firing slits', () => {
  test('every door wall has two slits and the back wall two, at chest-to-eye height', () => {
    const b = buildMap(2)[0].bunker;
    const s = bunkerSlitBoxes(b);
    expect(s).toHaveLength(8);
    for (const x of s) {
      expect(x.center.y - x.half.y).toBeCloseTo(b.center.y + slit.y0, 6);
      expect(x.center.y + x.half.y).toBeCloseTo(b.center.y + slit.y1, 6);
      expect(Math.max(x.half.x, x.half.z) * 2).toBeCloseTo(slit.width, 6);
    }
  });

  test('a bullet fired out of a slit hits a target outside; the solid wall next to it stops one', async () => {
    const m = await Match.create({ players: [{ name: 'in', isBot: false }, { name: 'out', isBot: false }] });
    const b = m.map[0].bunker;
    const fire = (x: number) => {
      m.debugTeleport(1, at(b, x, -1.2));
      m.debugTeleport(2, at(b, x, -6));
      m.debugGive(1, { weapons: { pistol: { mag: 12, spare: 0 } } });
      for (let i = 0; i < 20; i++) m.tick(new Map());
      const pitch = Math.atan2(1.0 - PLAYER.eyeHeight, 4.8);
      let hit = false;
      for (let i = 0; i < 15 && !hit; i++) {
        const s = m.tick(new Map([[1, { ...NO_INPUT, yaw: b.facingYaw, pitch, fire: true, slot: 'pistol' as const }]]));
        hit = s.events.some((e) => e.type === 'hit' && e.data.target === 2);
      }
      return hit;
    };
    expect(fire(SLIT_X)).toBe(true);
    expect(fire(0.95)).toBe(false); // between the door and the slit: concrete
  });

  test('players, grenades and rockets cannot pass a slit; bullets and sight can', async () => {
    const isl = buildMap(2)[0];
    const ph = await Physics.create([isl]);
    const b = isl.bunker;
    const from = at(b, SLIT_X, -1.5, (slit.y0 + slit.y1) / 2);
    const dir = forward(b.facingYaw);
    expect(ph.raycast(from, dir, 3, undefined, true)).toBeNull(); // straight out through the slit
    const blocked = ph.raycast(from, dir, 3); // explosives' rays stop at the slit plug
    expect(blocked?.hit.type).toBe('world');
    expect(blocked!.dist).toBeLessThan(1);
    // A player pressed against the slit, jumping, stays inside.
    const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] });
    const mb = m.map[0].bunker;
    m.debugTeleport(1, at(mb, SLIT_X, -1.5));
    let s = m.tick(new Map());
    for (let i = 0; i < 90; i++) s = m.tick(new Map([[1, { ...NO_INPUT, yaw: mb.facingYaw, moveZ: 1, jump: true }]]));
    expect(insideBunker(mb, s.players[0].pos)).toBe(true);
  });

  test('isSealed is unchanged by slits: same footprints, plugged doors still seal, open doors still do not', () => {
    const b = buildMap(2)[0].bunker;
    const foot = (boxes: { center: Vec3; half: Vec3 }[]) => {
      // Rasterize the body-height footprint on a 5 cm grid.
      const cells = new Set<string>();
      for (const x of boxes) {
        if (x.center.y - x.half.y >= b.center.y + 1.8) continue;
        for (let u = -x.half.x; u <= x.half.x + 1e-9; u += 0.05) for (let w = -x.half.z; w <= x.half.z + 1e-9; w += 0.05) {
          const p = add(x.center, rotateY(v3(u, 0, w), b.facingYaw));
          cells.add(`${Math.round(p.x * 20)},${Math.round(p.z * 20)}`);
        }
      }
      return cells;
    };
    const withSlits = foot(bunkerWallBoxes(b)), whole = foot(bunkerWallBoxes(b, false));
    expect([...withSlits].filter((c) => !whole.has(c))).toEqual([]);
    expect([...whole].filter((c) => !withSlits.has(c))).toEqual([]);
    expect(isSealed(b, [])).toBe(false);
    const plug = (d: Bunker['doorways'][number], id: number): PieceState => {
      const p = add(d.center, rotateY(v3(0, 0, -(wall / 2 + PIECES.steel.d / 2 + 0.05)), d.yaw));
      return { id, kind: 'steel', owner: 2, pos: v3(p.x, d.center.y, p.z), rotY: d.yaw, hp: 1200 };
    };
    expect(isSealed(b, b.doorways.map(plug))).toBe(true);
    expect(isSealed(b, b.doorways.slice(0, 2).map(plug))).toBe(false);
  });
});
