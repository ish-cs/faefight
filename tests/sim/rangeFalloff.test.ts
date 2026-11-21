import { describe, expect, test } from 'vitest';
import { predictedHit } from '../../src/client/shotPredict';
import { playerSpread, tryFire, type CombatCtx } from '../../src/sim/combat';
import { PIECE_DMG_MULT, PIECES, PLAYER, WEAPONS } from '../../src/sim/constants';

const PLAYER_R = PLAYER.radius;
import { shotDamage } from '../../src/sim/gunplay';
import type { Physics, RayHit } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import type { PieceState, PlayerState, Vec3, WeaponKind } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

/**
 * Range falloff through the real tryFire, with the ray stubbed to land at a chosen distance (so the
 * test is about the damage maths, not geometry). Also: spread stays a pure function of the seed.
 */
type Target = { kind: 'player'; part: 'head' | 'body' } | { kind: 'piece' };

function rig(target: Target, dist: number) {
  const a = newPlayer(1, 'a', false, 0, v3(0, 2, 0));
  const b = newPlayer(2, 'b', false, 1, v3(0, 2, -dist));
  b.shield = 0;
  b.hp = 1e6; // never dies: we read raw damage
  const piece: PieceState = { id: 50, kind: 'wood', owner: 2, pos: v3(0, 2, -dist), rotY: 0, hp: 1e6 } as PieceState;
  const dirs: Vec3[] = [];
  const ctx: CombatCtx = {
    physics: { raycast: () => null } as unknown as Physics,
    players: new Map([[1, a], [2, b]]),
    pieces: new Map([[50, piece]]),
    explosives: [],
    nextId: () => 99,
    onPieceDestroyed: () => {},
    onKill: () => {},
    grounded: () => true,
    castShot: (_o, dir, _max): RayHit => {
      dirs.push(dir);
      const point = v3(0, 3, -dist);
      return target.kind === 'player'
        ? { dist, point, hit: { type: 'player', id: 2 }, part: target.part }
        : { dist, point, hit: { type: 'piece', id: 50 } };
    },
  };
  return { ctx, a, b, piece, dirs };
}

const arm = (p: PlayerState, w: WeaponKind) => { p.inv.weapons[w] = { mag: 30, spare: 0 }; p.equipped = w; };

describe('range falloff in the sim', () => {
  const guns = ['pistol', 'shotgun', 'rifle', 'smg'] as const;
  test('client prediction equals the sim, per pellet, at every distance, head and body', () => {
    for (const w of guns)
      for (const d of [3, 8, 15, 20, 25, 30, 40, 50, 60, 90])
        for (const part of ['head', 'body'] as const) {
          const { ctx, a } = rig({ kind: 'player', part }, d);
          arm(a, w);
          const hits = tryFire(ctx, a, 0).filter((e) => e.type === 'hit');
          expect(hits.length).toBe(WEAPONS[w].pellets);
          const want = predictedHit(w, d, part === 'head');
          for (const h of hits) {
            expect(h.data.amount).toBe(want.amount);
            expect(h.data.falloff).toBe(want.falloff);
          }
        }
  });
  test('sample distances: pistol 20/20/10, rifle 30/30/20.4 (10/25/50 m, body)', () => {
    const one = (w: WeaponKind, d: number) => {
      const { ctx, a } = rig({ kind: 'player', part: 'body' }, d);
      arm(a, w);
      return tryFire(ctx, a, 0).find((e) => e.type === 'hit')!.data.amount as number;
    };
    expect([10, 25, 50].map((d) => one('pistol', d))).toEqual([20, 16, 10]);
    expect(one('rifle', 10)).toBe(30);
    expect(one('rifle', 25)).toBe(30);
    expect(one('rifle', 50)).toBeCloseTo(30 * (1 - 0.45 * (25 / 35)), 9);
    expect(one('rifle', 120)).toBeCloseTo(30 * 0.55, 9);
  });
  test('full-damage hits carry no falloff tag; reduced ones do', () => {
    const tag = (d: number) => {
      const { ctx, a } = rig({ kind: 'player', part: 'body' }, d);
      arm(a, 'pistol');
      return tryFire(ctx, a, 0).find((e) => e.type === 'hit')!.data.falloff;
    };
    expect(tag(10)).toBeUndefined();
    expect(tag(40)).toBe(0.5);
  });
  test('piece damage gets the same falloff (long-range wall chipping is weaker)', () => {
    for (const d of [5, 30, 70]) {
      const { ctx, a, piece } = rig({ kind: 'piece' }, d);
      arm(a, 'rifle');
      tryFire(ctx, a, 0);
      expect(1e6 - piece.hp).toBeCloseTo(shotDamage('rifle', d).amount * PIECE_DMG_MULT.wood.bullet, 6);
    }
    expect(PIECES.wood.hp).toBe(200); // the recent HP cut stays
  });
  test('rocket has no hitscan falloff path (projectile, unchanged)', () => {
    const { ctx, a, b } = rig({ kind: 'player', part: 'body' }, 80);
    arm(a, 'rocket');
    const evs = tryFire(ctx, a, 0);
    expect(evs.some((e) => e.type === 'hit')).toBe(false);
    expect(b.hp).toBe(1e6);
    expect(ctx.explosives.length).toBe(1);
  });
});

describe('spread determinism', () => {
  /** A burst of sustained fire with motion: every shot direction, so replays/lag-comp can compare. */
  const burst = (moving: boolean, airborne: boolean) => {
    const { ctx, a, dirs } = rig({ kind: 'player', part: 'body' }, 40);
    ctx.grounded = () => !airborne;
    arm(a, 'rifle');
    a.ads = true;
    if (moving) a.vel = v3(5, 0, 0);
    for (let t = 0; t < 20; t++) tryFire(ctx, a, t / 30);
    return { dirs, yaw: a.yaw };
  };
  test('same seed, same state → identical shot directions', () => {
    for (const [m, j] of [[false, false], [true, false], [false, true]] as const) {
      expect(burst(m, j).dirs).toEqual(burst(m, j).dirs);
    }
  });
  test('sustained fire, moving and jumping each widen the cone; aimed still taps stay tight at mid range', () => {
    const cone = (moving: boolean, airborne: boolean, shots: number, gap: number) => {
      const { ctx, a } = rig({ kind: 'player', part: 'body' }, 40);
      ctx.grounded = () => !airborne;
      arm(a, 'rifle');
      a.ads = true;
      if (moving) a.vel = v3(5, 0, 0);
      let t = 0;
      for (let i = 0; i < shots; i++, t += gap) tryFire(ctx, a, t);
      return playerSpread(ctx, a, t);
    };
    const tap = cone(false, false, 6, 0.5);
    const spray = cone(false, false, 12, 1 / 6);
    expect(tap).toBeCloseTo(WEAPONS.rifle.spread.ads, 6); // tap-firing fully recovers
    // 0.12° at 40 m = 8 cm off: a tapped aimed rifle shot lands on a body at mid range.
    expect(Math.tan((tap * Math.PI) / 180) * 40).toBeLessThan(PLAYER_R);
    expect(spray).toBeGreaterThan(tap * 3);
    expect(cone(true, false, 1, 1)).toBeGreaterThan(tap);
    expect(cone(false, true, 1, 1)).toBeGreaterThan(cone(true, false, 1, 1));
  });
});
