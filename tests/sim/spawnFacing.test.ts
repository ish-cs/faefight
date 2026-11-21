import { describe, expect, test } from 'vitest';
import { WEAPONS } from '../../src/sim/constants';
import { MAP_TEMPLATES } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import type { PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { dist2D, forward } from '../../src/sim/vec';

const TOL = 0.02; // rad
// Bots turn to whatever they think on their first tick, so the facing checks use human seats (same spawn code).
const setup = (n: number, map: (typeof MAP_TEMPLATES)[number], bots = false) => ({
  map, players: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, isBot: bots && i > 0, difficulty: 'easy' as const })),
});
/** Angle between where `yaw` looks and the direction from `from` to `to` (xz plane). */
const offBy = (yaw: number, from: Vec3, to: Vec3) => {
  const f = forward(yaw);
  const dx = to.x - from.x, dz = to.z - from.z;
  const l = Math.hypot(dx, dz);
  return Math.acos(Math.max(-1, Math.min(1, (f.x * dx + f.z * dz) / l)));
};
const expectFacesFront = (m: Match, p: Pick<PlayerState, 'yaw' | 'pitch' | 'pos' | 'island'>) => {
  const b = m.map[p.island].bunker;
  expect(offBy(p.yaw, p.pos, b.doorways[0].center)).toBeLessThan(TOL);
  expect(p.pitch).toBe(0);
};
const expectPistol = (p: Pick<PlayerState, 'hotbar' | 'selected' | 'equipped' | 'inv'>) => {
  expect(p.hotbar[p.selected]).toBe('pistol');
  expect(p.equipped).toBe('pistol');
  expect(p.inv.weapons.pistol).toEqual({ mag: WEAPONS.pistol.mag, spare: WEAPONS.pistol.mag });
  expect(WEAPONS.pistol.mag).toBe(12);
};

describe('front doorway', () => {
  test.each(MAP_TEMPLATES)('%s: doorways[0] faces out toward the island front', async (map) => {
    for (const n of [2, 4, 8]) {
      const m = await Match.create(setup(n, map));
      for (const isl of m.map) {
        const d = isl.bunker.doorways[0].center, c = isl.bunker.center;
        const toFront = { x: isl.center.x - c.x, z: isl.center.z - c.z };
        expect((d.x - c.x) * toFront.x + (d.z - c.z) * toFront.z).toBeGreaterThan(0);
      }
    }
  });
});

describe('spawn facing + loadout', () => {
  for (const map of MAP_TEMPLATES) for (const n of [2, 4, 8]) {
    test(`${map}, ${n} players: match start faces the front door with a selected pistol`, async () => {
      const m = await Match.create(setup(n, map));
      const snap = m.tick(new Map());
      expect(snap.players).toHaveLength(n);
      for (const p of snap.players) {
        expectFacesFront(m, p);
        expectPistol(p);
      }
      // Bots get the same loadout.
      const mb = await Match.create(setup(n, map, true));
      for (const p of mb.tick(new Map()).players) expectPistol(p);
    });

    test(`${map}, ${n} players: respawn (also from a shifted free spot) faces the front door`, async () => {
      const m = await Match.create(setup(n, map));
      m.tick(new Map());
      const isl = m.map[0];
      // Respawn 1: free spawn point.
      m.debugKill(1);
      let snap: Snapshot | undefined;
      for (let i = 0; i < 30 * 4 && !snap; i++) {
        const s = m.tick(new Map());
        if (s.events.some((e) => e.type === 'spawn' && e.data.player === 1)) snap = s;
      }
      if (!snap) throw new Error('no respawn');
      let me = snap.players.find((p) => p.id === 1)!;
      expect(me.alive).toBe(true);
      expect(dist2D(me.pos, isl.spawn)).toBeLessThan(0.05);
      expectFacesFront(m, me);
      expectPistol(me);
      const ev = snap.events.find((e) => e.type === 'spawn' && e.data.player === 1)!;
      expect(ev.data.yaw).toBeCloseTo(me.yaw, 9);

      // Respawn 2: a piece sits on the spawn point, so freeSpawnSpot shifts it.
      m.debugKill(1);
      m.debugPlacePiece('container', { ...isl.spawn }, isl.bunker.facingYaw);
      snap = undefined;
      for (let i = 0; i < 30 * 4 && !snap; i++) {
        const s = m.tick(new Map());
        if (s.events.some((e) => e.type === 'spawn' && e.data.player === 1)) snap = s;
      }
      if (!snap) throw new Error('no second respawn');
      me = snap.players.find((p) => p.id === 1)!;
      expect(dist2D(me.pos, isl.spawn)).toBeGreaterThan(0.2);
      expectFacesFront(m, me);
      expectPistol(me);
    });
  }
});
