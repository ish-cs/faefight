import { describe, expect, test } from 'vitest';
import { GRAPPLE, PLAYER } from '../../src/sim/constants';
import { buy, buyAt, vaultTransfer } from '../../src/sim/economy';
import { takeOut } from '../../src/sim/hotbar';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type PlayerInput, type PlayerState, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, dist, dist2D, forward, scale, v3, yawOf } from '../../src/sim/vec';
import { sanitizeInput } from '../../src/net/sanitize';
import { newMoveState, stepMove } from '../../src/sim/movement';

describe('grappling hook item', () => {
  test(`costs $${GRAPPLE.price} for ${GRAPPLE.uses} uses in one hotbar slot`, () => {
    const p = newPlayer(1, 'p', false, 0, v3());
    p.inv.cash = GRAPPLE.price * 2;
    expect(buy(p, { buy: 'grapple' }).ok).toBe(true);
    expect(p.inv.grapples).toBe(GRAPPLE.uses);
    expect(p.hotbar[0]).toBe('grapple');
    expect(buy(p, { buy: 'grapple' }).ok).toBe(true);
    expect(p.inv.grapples).toBe(GRAPPLE.uses * 2);
    expect(p.hotbar.filter((k) => k === 'grapple')).toHaveLength(1);
    expect(buy(p, { buy: 'grapple' }).ok).toBe(false);
  });

  test('sold at the home shop and at the neutral potion seller (nobody is stuck out there)', () => {
    const p = newPlayer(1, 'p', false, 0, v3());
    p.inv.cash = GRAPPLE.price * 2;
    expect(buyAt(p, 'potion', { buy: 'grapple' }).ok).toBe(true);
    expect(buyAt(p, 'home', { buy: 'grapple' }).ok).toBe(true);
    expect(p.inv.grapples).toBe(GRAPPLE.uses * 2);
    expect(buyAt(p, 'potion', { buy: 'medkit' }).ok).toBe(false);
  });

  test('drops as one item with every use; vaults by count', () => {
    const p = newPlayer(1, 'p', false, 0, v3());
    p.inv.grapples = 3;
    p.hotbar[0] = 'grapple';
    expect(vaultTransfer(p, { deposit: { grapples: 2 } }).ok).toBe(true);
    expect(p.inv.grapples).toBe(1);
    expect(p.vault.grapples).toBe(2);
    expect(vaultTransfer(p, { deposit: { grapples: 5 } }).ok).toBe(false);
    const out = takeOut(p.inv, 'grapple', 'one')!;
    expect(out.grapples).toBe(1);
    expect(p.inv.grapples).toBeUndefined();
  });

  test('sanitize keeps grapple only when true, and accepts the shop item', () => {
    expect(sanitizeInput({ ...NO_INPUT, grapple: true })!.grapple).toBe(true);
    expect('grapple' in sanitizeInput({ ...NO_INPUT, grapple: 1 })!).toBe(false);
    expect(sanitizeInput({ ...NO_INPUT, shop: { buy: 'grapple' } })!.shop).toEqual({ buy: 'grapple' });
  });
});

describe('rope pull (movement.ts, shared with client prediction)', () => {
  const body = { movePlayer: (d: Vec3) => ({ pos: d, grounded: false }) };
  const cmd = { seq: 1, moveX: 0, moveZ: 0, yaw: 0, jump: false, sprint: false };
  test('reels toward the point, never mutates the pull object it was given, lets go on arrival', () => {
    const pull = { x: 0, y: 0, z: -20, left: GRAPPLE.pullSec };
    const m = { pos: v3(), vel: v3(), mv: { ...newMoveState(), pull } };
    let landed = 0;
    for (let i = 0; i < 90 && m.mv.pull; i++) {
      const at = m.pos;
      landed += stepMove(m, cmd, 1 / 30, { movePlayer: (d) => body.movePlayer(v3(at.x + d.x, at.y + d.y, at.z + d.z)) }).landingSpeed;
    }
    expect(pull.left).toBe(GRAPPLE.pullSec);
    expect(m.mv.pull).toBeUndefined();
    expect(m.pos.z).toBeLessThan(-17);
    expect(m.vel.y).toBeGreaterThan(0); // the little pop up onto the ledge
    expect(Math.abs(m.vel.z)).toBeLessThan(GRAPPLE.ropeMaxSpeed * 0.3);
    expect(landed).toBe(0);
  });

  test('a yank ignores the victim\'s own movement and jump', () => {
    const m = { pos: v3(), vel: v3(), mv: { ...newMoveState(), grounded: true, pull: { x: 10, y: 0.6, z: 0, left: GRAPPLE.yankSec, yank: true as const } } };
    const at = () => m.pos;
    stepMove(m, { ...cmd, moveZ: 1, jump: true, sprint: true }, 1 / 30, { movePlayer: (d) => body.movePlayer(v3(at().x + d.x, at().y + d.y, at().z + d.z)) });
    expect(m.mv.pull?.yank).toBe(true);
    expect(m.vel.x).toBeGreaterThan(GRAPPLE.yankSpeed * 0.9);
    expect(m.pos.z).toBeCloseTo(0, 6);
  });
});

const humans = { players: [{ name: 'you', isBot: false }, { name: 'them', isBot: false }], seed: 7 };
const me = (s: Snapshot, id = 1) => s.players.find((p) => p.id === id)!;
const internal = (m: Match, id: number): PlayerState => (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(id)!;

/** Yaw/pitch from `p`'s eye to a point. */
function aimAt(p: { pos: Vec3 }, at: Vec3): { yaw: number; pitch: number } {
  const ex = p.pos.x, ey = p.pos.y + PLAYER.eyeHeight, ez = p.pos.z;
  const dx = at.x - ex, dy = at.y - ey, dz = at.z - ez;
  return { yaw: yawOf({ x: dx, z: dz }), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Player 1 on open ground in front of their bunker, holding a hook; returns the match and a point ahead. */
async function setup() {
  const m = await Match.create(humans);
  const isl = m.map[0];
  // Open flat ground: across the island in front of the bunker (ground top at y = 2 here).
  const fy = forward(isl.bunker.facingYaw), f = v3(-fy.z, 0, fy.x);
  const start = add(add(isl.center, scale(fy, 4)), scale(f, -12));
  start.y = isl.center.y + 2.1;
  m.debugTeleport(1, start);
  m.debugTeleport(2, add(add(isl.center, scale(fy, -40)), v3(0, 2.1, 0)));
  m.debugGive(1, { grapples: 3 });
  let s = m.tick(new Map([[1, { ...NO_INPUT }]]));
  for (let i = 0; i < 10; i++) s = m.tick(new Map([[1, { ...NO_INPUT }]]));
  return { m, f, s, slot: me(s).hotbar.indexOf('grapple') };
}

describe('grappling hook in a match', () => {
  test('hooking a wall reels you to it, spends one use, then cools down', async () => {
    const { m, f, s: s0, slot } = await setup();
    const p0 = me(s0);
    const wallAt = add(p0.pos, scale(f, 16));
    m.debugPlacePiece('steel', v3(wallAt.x, p0.pos.y + 1.5, wallAt.z), yawOf(f));
    const aim = aimAt(p0, v3(wallAt.x, p0.pos.y + 3, wallAt.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    let s = m.tick(inp({ grapple: true }));
    expect(me(s).hook?.st).toBe(0);
    expect(s.events.some((e) => e.type === 'grapple' && e.data.phase === 'fire')).toBe(true);
    let latched = false, closest = Infinity;
    for (let i = 0; i < 90; i++) {
      s = m.tick(inp());
      if (me(s).hook?.st === 1) latched = true;
      closest = Math.min(closest, dist2D(me(s).pos, wallAt));
    }
    expect(latched).toBe(true);
    expect(closest).toBeLessThan(2);
    expect(me(s).hook).toBeUndefined();
    expect(me(s).inv.grapples).toBe(2);
    expect(me(s).hp).toBe(PLAYER.hp); // no fall damage off the rope
    // Cooldown is over by now; a second hook works.
    expect(me(s).hookReadyAt! <= s.time).toBe(true);
  });

  test('jump lets go early, keeping momentum', async () => {
    const { m, f, s: s0, slot } = await setup();
    const p0 = me(s0);
    const wallAt = add(p0.pos, scale(f, 25));
    m.debugPlacePiece('steel', v3(wallAt.x, p0.pos.y + 1.5, wallAt.z), yawOf(f));
    const aim = aimAt(p0, v3(wallAt.x, p0.pos.y + 2.5, wallAt.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    let s = m.tick(inp({ grapple: true }));
    for (let i = 0; i < 30 && me(s).hook?.st !== 1; i++) s = m.tick(inp());
    expect(me(s).hook?.st).toBe(1);
    for (let i = 0; i < 8; i++) s = m.tick(inp());
    const speed = Math.hypot(me(s).vel.x, me(s).vel.z);
    expect(speed).toBeGreaterThan(10);
    s = m.tick(inp({ jump: true }));
    s = m.tick(inp());
    expect(me(s).hook).toBeUndefined();
    expect(me(s).mv?.pull).toBeUndefined();
    expect(Math.hypot(me(s).vel.x, me(s).vel.z)).toBeGreaterThan(Math.min(speed, GRAPPLE.flingMax) * 0.9); // kept (capped at the fling limit)
  });

  test('a miss into the sky or water spends nothing', async () => {
    const { m, s: s0, slot } = await setup();
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, yaw: me(s0).yaw, pitch: 1.3, select: slot, ...x }]]);
    let s = m.tick(inp({ grapple: true }));
    expect(me(s).hook?.st).toBe(3);
    for (let i = 0; i < 30; i++) s = m.tick(inp());
    expect(me(s).hook).toBeUndefined();
    expect(me(s).inv.grapples).toBe(3);
  });

  test('hooking a player yanks them over to you', async () => {
    const { m, f, s: s0, slot } = await setup();
    const p0 = me(s0);
    m.debugTeleport(2, add(p0.pos, scale(f, 14)));
    let s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    for (let i = 0; i < 5; i++) s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    const them = me(s, 2);
    const aim = aimAt(me(s), v3(them.pos.x, them.pos.y + 1.1, them.pos.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    const before = dist(me(s).pos, them.pos);
    s = m.tick(inp({ grapple: true }));
    expect(me(s).hook?.tgt).toBe(2);
    let yanked = false;
    for (let i = 0; i < 40; i++) {
      s = m.tick(inp());
      if (s.events.some((e) => e.type === 'grapple' && e.data.phase === 'yank')) yanked = true;
    }
    expect(yanked).toBe(true);
    const after = dist(me(s).pos, me(s, 2).pos);
    expect(after).toBeLessThan(before - 6);
    expect(after).toBeGreaterThan(1.2);
    expect(me(s, 2).alive).toBe(true);
    expect(me(s).inv.grapples).toBe(2);
    expect(me(s).hook).toBeUndefined();
  });

  test('no yank through a wall that went up while the hook flew; nothing spent', async () => {
    const { m, f, s: s0, slot } = await setup();
    const p0 = me(s0);
    m.debugTeleport(2, add(p0.pos, scale(f, 22)));
    let s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    for (let i = 0; i < 5; i++) s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    const them = me(s, 2);
    const aim = aimAt(me(s), v3(them.pos.x, them.pos.y + 1.1, them.pos.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    s = m.tick(inp({ grapple: true }));
    expect(me(s).hook?.tgt).toBe(2);
    const mid = add(me(s).pos, scale(f, 11));
    m.debugPlacePiece('steel', v3(mid.x, me(s).pos.y, mid.z), yawOf(f));
    const at = me(s, 2).pos;
    for (let i = 0; i < 30; i++) s = m.tick(inp());
    expect(dist(me(s, 2).pos, at)).toBeLessThan(0.5);
    expect(me(s).inv.grapples).toBe(3);
  });

  test('a spawn-protected player can not be yanked', async () => {
    const { m, f, s: s0, slot } = await setup();
    const p0 = me(s0);
    m.debugTeleport(2, add(p0.pos, scale(f, 14)));
    let s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    internal(m, 2).invulnUntil = 1e9;
    const them = me(s, 2);
    const aim = aimAt(me(s), v3(them.pos.x, them.pos.y + 1.1, them.pos.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    s = m.tick(inp({ grapple: true }));
    for (let i = 0; i < 30; i++) s = m.tick(inp());
    expect(dist(me(s, 2).pos, them.pos)).toBeLessThan(0.5);
    expect(me(s).inv.grapples).toBe(3);
  });

  test('replays: same inputs, same result (fork)', async () => {
    const { m, f, s: s0, slot } = await setup();
    const p0 = me(s0);
    const wallAt = add(p0.pos, scale(f, 16));
    m.debugPlacePiece('steel', v3(wallAt.x, p0.pos.y + 1.5, wallAt.z), yawOf(f));
    const aim = aimAt(p0, v3(wallAt.x, p0.pos.y + 3, wallAt.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    m.tick(inp({ grapple: true }));
    const copy = m.fork();
    let a: Snapshot | null = null, b: Snapshot | null = null;
    for (let i = 0; i < 20; i++) { a = m.tick(inp()); b = copy.tick(inp()); }
    expect(me(b!).pos).toEqual(me(a!).pos);
    expect(me(b!).hook).toEqual(me(a!).hook);
  });
});

describe('yank kill credit', () => {
  test('drowning within a few seconds of a yank is the yanker\'s kill, via grapple', async () => {
    const m = await Match.create(humans);
    m.tick(new Map());
    internal(m, 2).yankedBy = { by: 1, at: (m as unknown as { s: { time: number } }).s.time };
    m.debugTeleport(2, v3(500, -3, 500));
    const s = m.tick(new Map());
    const kill = s.events.find((e) => e.type === 'kill');
    expect(kill?.data).toMatchObject({ victim: 2, killer: 1, inWater: true, via: 'grapple' });
    expect(me(s).kills).toBe(1);
  });
});
