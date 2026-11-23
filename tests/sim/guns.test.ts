import { beforeAll, describe, expect, test } from 'vitest';
import { projectiles, tickExplosives, tickReload, tryFire, tryReload, type CombatCtx } from '../../src/sim/combat';
import { PIECES, ROCKET, WEAPONS } from '../../src/sim/constants';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import type { MatchEvent, PieceState, Vec3, WeaponKind } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
const spot = (d: number, side = 3): Vec3 => {
  const p = add(add(isl().center, scale(forward(yaw()), d)), scale(right(yaw()), side));
  return v3(p.x, isl().groundY, p.z);
};

async function setup(aAt = 4, bAt = 12) {
  const physics = await Physics.create(map);
  const a = newPlayer(1, 'a', false, 0, spot(aAt));
  const b = newPlayer(2, 'b', false, 0, spot(bAt));
  a.yaw = yaw();
  for (const p of [a, b]) physics.addPlayer(p.id, p.pos);
  const destroyed: number[] = [];
  const knocks: [number, Vec3][] = [];
  let id = 100;
  const ctx: CombatCtx = {
    physics,
    players: new Map([[1, a], [2, b]]),
    pieces: new Map(),
    explosives: [],
    nextId: () => id++,
    onPieceDestroyed: (pid) => { ctx.pieces.delete(pid); physics.removePiece(pid); destroyed.push(pid); },
    onKill: () => {},
    grounded: () => true,
    onKnockback: (pid, dv) => knocks.push([pid, dv]),
  };
  const give = (k: WeaponKind, mag = WEAPONS[k].mag, spare = 30) => { a.inv.weapons[k] = { mag, spare }; a.equipped = k; };
  const wall = (d: number, kind: PieceState['kind'] = 'steel') => {
    const pc: PieceState = { id: 9, kind, owner: 2, pos: spot(d), rotY: yaw(), hp: PIECES[kind].hp };
    ctx.pieces.set(9, pc);
    physics.addPiece(pc);
    return pc;
  };
  const run = (from: number, to: number) => {
    const evs: MatchEvent[] = [];
    for (let t = from; t <= to; t += 1 / 30) evs.push(...tickExplosives(ctx, t));
    return evs;
  };
  return { ctx, a, b, give, wall, run, destroyed, knocks };
}

describe('hitscan', () => {
  test('a headshot does double damage and says so', async () => {
    const { ctx, a, b, give } = await setup();
    give('pistol');
    a.ads = true;
    const hit = tryFire(ctx, a, 0).find((e) => e.type === 'hit')!;
    expect(hit.data.part).toBe('head');
    expect(b.hp).toBe(60);
  });
  test('damage falls off with range', async () => {
    const { ctx, a, b, give } = await setup(-15, 18); // 33 m apart
    give('pistol');
    a.ads = true;
    a.pitch = Math.atan2(-0.45, 33);
    tryFire(ctx, a, 0);
    expect(b.hp).toBeGreaterThan(80); // a 20-damage body shot lost some at 33 m
    expect(b.hp).toBeLessThan(90);
  });
  test('shots are deterministic: same state and tick → same impact', async () => {
    const s1 = await setup(), s2 = await setup();
    for (const s of [s1, s2]) { s.give('smg'); s.a.pitch = -0.3; }
    const to = (s: typeof s1) => tryFire(s.ctx, s.a, 1).find((e) => e.type === 'shot')!.data.to;
    expect(to(s1)).toEqual(to(s2));
  });
  test('aiming down sights groups shots far tighter than hip fire', async () => {
    const { ctx, a, give, wall } = await setup(0);
    wall(10);
    give('rifle', 25, 999);
    const group = (ads: boolean) => {
      const pts: Vec3[] = [];
      for (let i = 0; i < 20; i++) {
        a.ads = ads; a.bloom = 0; a.lastShotAt = -1e9; a.nextFireAt = 0; a.pitch = 0; a.yaw = yaw();
        a.inv.weapons.rifle!.mag = 25;
        pts.push(tryFire(ctx, a, i * 7.3).find((e) => e.type === 'shot')!.data.to as Vec3);
      }
      const c = pts.reduce((s, p) => add(s, scale(p, 1 / pts.length)), v3());
      return Math.max(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)));
    };
    const hip = group(false), ads = group(true);
    expect(ads).toBeLessThan(hip / 5);
    expect(hip).toBeGreaterThan(0.1);
  });
  test('recoil kicks the shooter\'s aim up by the amount the shot reports', async () => {
    const { ctx, a, give } = await setup();
    give('rifle');
    const pitch0 = a.pitch;
    const shot = tryFire(ctx, a, 0).find((e) => e.type === 'shot')!;
    const kick = shot.data.kick as { pitch: number; yaw: number };
    expect(kick.pitch).toBeGreaterThan(0);
    expect(a.pitch - pitch0).toBeCloseTo(kick.pitch, 4);
  });
  test('shotgun pellets spread and report their impacts', async () => {
    const { ctx, a, give } = await setup();
    give('shotgun');
    a.pitch = -0.4;
    const shot = tryFire(ctx, a, 0).find((e) => e.type === 'shot')!;
    expect(shot.data.tos).toHaveLength(WEAPONS.shotgun.pellets - 1);
  });
  test('empty with no spare: dry click, no shot', async () => {
    const { ctx, a, give } = await setup();
    give('pistol', 0, 0);
    const evs = tryFire(ctx, a, 0);
    expect(evs.map((e) => e.type)).toEqual(['dry']);
  });
});

describe('reload', () => {
  test('a tactical reload keeps one in the chamber', async () => {
    const { a, give } = await setup();
    give('rifle', 10, 50);
    tryReload(a, 0);
    expect(a.reloadSec).toBe(WEAPONS.rifle.reloadSec);
    tickReload(a, a.reloadUntil);
    expect(a.inv.weapons.rifle).toEqual({ mag: 26, spare: 34 });
  });
  test('shotgun loads shell by shell and firing stops the reload between shells', async () => {
    const { ctx, a, give } = await setup();
    give('shotgun', 1, 20);
    tryReload(a, 0);
    tickReload(a, 1.0);
    const mid = a.inv.weapons.shotgun!.mag;
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(6);
    a.pitch = -0.4;
    expect(tryFire(ctx, a, 1.0).some((e) => e.type === 'shot')).toBe(true);
    expect(a.reloadUntil).toBe(0);
    expect(a.inv.weapons.shotgun!.mag).toBe(mid - 1);
  });
});

describe('rocket', () => {
  test('flies at ~35 m/s and is in the projectile list', async () => {
    const { ctx, a, give, run } = await setup();
    give('rocket', 1, 3);
    a.pitch = 0.3; // up into open sky
    tryFire(ctx, a, 0);
    const p0 = projectiles(ctx.explosives)[0];
    expect(p0.kind).toBe('rocket');
    run(1 / 30, 0.5);
    const p1 = projectiles(ctx.explosives)[0];
    const moved = Math.hypot(p1.pos.x - p0.pos.x, p1.pos.y - p0.pos.y, p1.pos.z - p0.pos.z);
    expect(moved).toBeGreaterThan(ROCKET.speed * 0.4);
    expect(moved).toBeLessThan(ROCKET.speed * 0.55);
  });
  test('explodes after its fuse in the air', async () => {
    const { ctx, a, give, run } = await setup();
    give('rocket', 1, 3);
    a.pitch = 0.6;
    tryFire(ctx, a, 0);
    const evs = run(1 / 30, ROCKET.fuseSec + 0.1);
    expect(evs.filter((e) => e.type === 'explosion')).toHaveLength(1);
    expect(ctx.explosives).toHaveLength(0);
  });
  test('explodes on a wall and breaks steel close up', async () => {
    const { ctx, a, give, wall, run, destroyed } = await setup(0, 30);
    wall(8);
    give('rocket', 1, 3);
    a.pitch = -0.05;
    tryFire(ctx, a, 0);
    const evs = run(1 / 30, 1);
    const boom = evs.find((e) => e.type === 'explosion')!;
    expect(boom.data.kind).toBe('rocket');
    expect(boom.t).toBeLessThan(0.3);
    expect(destroyed).toEqual([9]);
  });
  test('a container survives one rocket', async () => {
    const { ctx, a, give, wall, run, destroyed } = await setup(0, 30);
    const c = wall(9, 'container');
    give('rocket', 1, 3);
    a.pitch = -0.05;
    tryFire(ctx, a, 0);
    run(1 / 30, 1);
    expect(destroyed).toEqual([]);
    expect(c.hp).toBeLessThan(PIECES.container.hp * 0.6);
  });
  test('a direct hit kills; damage falls off across the radius', async () => {
    const near = await setup(4, 12);
    near.give('rocket', 1, 3);
    near.a.pitch = -0.05;
    tryFire(near.ctx, near.a, 0);
    near.run(1 / 30, 1);
    expect(near.b.hp).toBe(0);

    // Rocket into the ground 2.5 m short of b: hurt, not killed, and pushed away.
    const off = await setup(4, 12);
    off.give('rocket', 1, 3);
    off.a.pitch = Math.atan2(-1.6, 5.5);
    tryFire(off.ctx, off.a, 0);
    off.run(1 / 30, 1);
    expect(off.b.hp).toBeGreaterThan(0); // ~92 damage since rockets went x1.5 (2026-11-22)
    expect(off.b.hp).toBeLessThan(30);
    const push = off.knocks.find(([id]) => id === 2)![1];
    const f = forward(yaw());
    expect(push.x * f.x + push.z * f.z).toBeGreaterThan(0); // away from the blast
  });
  test('self-damage applies but a rocket jump is survivable, and it throws you up', async () => {
    const { ctx, a, give, run, knocks } = await setup(4, 20);
    give('rocket', 1, 3);
    a.pitch = -Math.PI / 2 + 0.05; // at your own feet
    tryFire(ctx, a, 0);
    run(1 / 30, 0.2);
    expect(a.hp).toBeLessThan(100);
    expect(100 - a.hp).toBeLessThanOrEqual(ROCKET.selfDmgMax); // capped (25), however close the blast
    expect(ROCKET.selfDmgMax).toBeLessThanOrEqual(30);
    const up = knocks.find(([id]) => id === 1)![1];
    expect(up.y).toBeGreaterThan(5);
  });
  test('a wall between you and the blast soaks most of it', async () => {
    const { ctx, a, b, give, wall, run } = await setup(4, 10.5);
    const pc = wall(8, 'container'); // survives the hit, stays between (front face at 6.8 m, b 3.7 m behind it)
    give('rocket', 1, 3);
    a.pitch = -0.05;
    tryFire(ctx, a, 0);
    run(1 / 30, 1);
    expect(pc.hp).toBeGreaterThan(0);
    expect(b.hp).toBeGreaterThan(80); // unshielded at this range would be ~68
    expect(b.hp).toBeLessThan(100);
  });
});
