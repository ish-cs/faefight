import { beforeAll, describe, expect, test } from 'vitest';
import { applyPlayerDamage, placeCharge, throwGrenade, tickExplosives, tickReload, tryFire, tryReload, type CombatCtx } from '../../src/sim/combat';
import { Physics } from '../../src/sim/physics';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import { GRENADE } from '../../src/sim/constants';
import type { PieceState, PlayerState, Vec3 } from '../../src/sim/types';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
const spot = (d: number, side = 3): Vec3 => {
  const p = add(add(isl().center, scale(forward(yaw()), d)), scale(right(yaw()), side));
  return v3(p.x, isl().groundY, p.z);
};

async function setup() {
  const physics = await Physics.create(map);
  const a = newPlayer(1, 'a', false, 0, spot(4));
  const b = newPlayer(2, 'b', false, 0, spot(12));
  a.yaw = yaw();
  for (const p of [a, b]) physics.addPlayer(p.id, p.pos);
  const kills: [number, number | null][] = [];
  const destroyed: number[] = [];
  let id = 100;
  const ctx: CombatCtx = {
    physics,
    players: new Map([[1, a], [2, b]]),
    pieces: new Map(),
    explosives: [],
    nextId: () => id++,
    onPieceDestroyed: (pid) => { ctx.pieces.delete(pid); physics.removePiece(pid); destroyed.push(pid); },
    onKill: (v, k) => kills.push([v, k]),
  };
  return { ctx, a, b, kills, destroyed };
}

const givePistol = (p: PlayerState) => { p.inv.weapons.pistol = { mag: 12, spare: 36 }; p.equipped = 'pistol'; };

describe('combat', () => {
  test('pistol hit deals 20', async () => {
    const { ctx, a, b } = await setup();
    givePistol(a);
    tryFire(ctx, a, 0);
    expect(b.hp).toBe(80);
  });
  test('fire rate limits shots in the same tick', async () => {
    const { ctx, a, b } = await setup();
    givePistol(a);
    tryFire(ctx, a, 0);
    tryFire(ctx, a, 0);
    expect(b.hp).toBe(80);
    expect(a.inv.weapons.pistol!.mag).toBe(11);
  });
  test('mag empties after 12 and auto-reload refills 1.2 s after the last shot', async () => {
    const { ctx, a } = await setup();
    givePistol(a);
    let last = 0;
    for (let i = 0; i < 12; i++) { last = i * 0.4; tryFire(ctx, a, last); }
    const w = a.inv.weapons.pistol!;
    expect(w.mag).toBe(0);
    // Empty mag auto-reloads from the last shot; a manual reload request mid-reload is ignored.
    tryReload(a, last + 0.5);
    tickReload(a, last + 1.0);
    expect(w.mag).toBe(0);
    tickReload(a, last + 1.21);
    expect(w).toEqual({ mag: 12, spare: 24 });
  });
  test('invulnerable target takes no damage', async () => {
    const { ctx, a, b } = await setup();
    givePistol(a);
    b.invulnUntil = 5;
    tryFire(ctx, a, 1);
    expect(b.hp).toBe(100);
  });
  test('lethal damage reports a kill', async () => {
    const { ctx, b, kills } = await setup();
    applyPlayerDamage(ctx, b, 150, 1, 0);
    expect(kills).toEqual([[2, 1]]);
  });
  test('bullet into steel does a tenth of damage', async () => {
    const { ctx, a } = await setup();
    givePistol(a);
    const steel: PieceState = { id: 9, kind: 'steel', owner: 2, pos: spot(8), rotY: yaw(), hp: 1200 };
    ctx.pieces.set(9, steel);
    ctx.physics.addPiece(steel);
    tryFire(ctx, a, 0);
    expect(steel.hp).toBeCloseTo(1198);
  });
  test('hitting a piece reports where, by whom, effective damage and remaining hp', async () => {
    const { ctx, a } = await setup();
    givePistol(a);
    const steel: PieceState = { id: 9, kind: 'steel', owner: 2, pos: spot(8), rotY: yaw(), hp: 1200 };
    ctx.pieces.set(9, steel);
    ctx.physics.addPiece(steel);
    const evs = tryFire(ctx, a, 0);
    const e = evs.find((x) => x.type === 'pieceHit')!;
    expect(e).toBeDefined();
    expect(e.data).toMatchObject({ piece: 9, kind: 'steel', by: 1, maxHp: 1200 });
    expect(e.data.amount as number).toBeCloseTo(2);
    expect(e.data.hp as number).toBeCloseTo(1198);
    expect((e.data.pos as Vec3).y).toBeGreaterThan(spot(8).y);
  });
  test('destroying a piece reports its kind and position for debris', async () => {
    const { ctx, a } = await setup();
    a.inv.charges = 1;
    const wood: PieceState = { id: 9, kind: 'wood', owner: 2, pos: spot(5.5), rotY: yaw(), hp: 250 };
    ctx.pieces.set(9, wood);
    ctx.physics.addPiece(wood);
    placeCharge(ctx, a, 0);
    const evs = [];
    for (let t = 0; t <= 3.1; t += 1 / 30) evs.push(...tickExplosives(ctx, t));
    const d = evs.find((x) => x.type === 'destroyed')!;
    expect(d.data).toMatchObject({ piece: 9, kind: 'wood' });
    expect(d.data.pos).toBeDefined();
  });
  test('firing a gun you do not own does nothing', async () => {
    const { ctx, a, b } = await setup();
    a.equipped = 'rifle';
    tryFire(ctx, a, 0);
    expect(b.hp).toBe(100);
  });
  test('grenade does 100 at the center and nothing beyond 4 m', async () => {
    const { ctx, a, b } = await setup();
    a.inv.grenades = 1;
    a.pitch = -Math.PI / 2; // throw straight down at own feet
    throwGrenade(ctx, a, 0);
    expect(a.inv.grenades).toBe(0);
    for (let t = 0; t <= GRENADE.fuseSec + 0.1; t += 1 / 30) tickExplosives(ctx, t);
    expect(a.hp).toBeLessThan(100 - 50);
    expect(b.hp).toBe(100); // 8 m away
  });
  test('grenade stops at a wall instead of flying through it', async () => {
    const { ctx, a } = await setup();
    const wall: PieceState = { id: 9, kind: 'steel', owner: 2, pos: spot(6), rotY: yaw(), hp: 1200 };
    ctx.pieces.set(9, wall);
    ctx.physics.addPiece(wall);
    a.inv.grenades = 1;
    a.pitch = 0.1;
    throwGrenade(ctx, a, 0);
    const events = [];
    for (let t = 0; t <= GRENADE.fuseSec + 0.1; t += 1 / 30) events.push(...tickExplosives(ctx, t));
    const boom = events.find((e) => e.type === 'explosion')!;
    const p = boom.data.pos as Vec3;
    expect(Math.hypot(p.x - a.pos.x, p.z - a.pos.z)).toBeLessThan(2.3);
  });
  test('breach charge destroys steel', async () => {
    const { ctx, a, destroyed } = await setup();
    const steel: PieceState = { id: 9, kind: 'steel', owner: 2, pos: spot(5.5), rotY: yaw(), hp: 1200 };
    ctx.pieces.set(9, steel);
    ctx.physics.addPiece(steel);
    a.inv.charges = 1;
    placeCharge(ctx, a, 0);
    for (let t = 0; t <= 3.1; t += 1 / 30) tickExplosives(ctx, t);
    expect(destroyed).toEqual([9]);
  });
});
