import { describe, expect, test } from 'vitest';
import { Predictor } from '../../src/client/predict';
import { aimDir, eyePos } from '../../src/sim/combat';
import { GRAPPLE, PIECES, PLAYER } from '../../src/sim/constants';
import { grappleAim, physicsAimWorld } from '../../src/sim/grappleAim';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type PlayerInput, type PlayerState, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, forward, scale, v3, yawOf } from '../../src/sim/vec';

// The grapple's aim rule (grappleAim.ts): ledge tops, lock-on, just over the edge; the sim, bots and the marker share it.
const humans = { players: [{ name: 'you', isBot: false }, { name: 'them', isBot: false }], seed: 7 };
const me = (s: Snapshot, id = 1) => s.players.find((p) => p.id === id)!;
const internal = (m: Match, id = 1): PlayerState => (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(id)!;
function aimAt(p: { pos: Vec3 }, at: Vec3): { yaw: number; pitch: number } {
  const dx = at.x - p.pos.x, dy = at.y - (p.pos.y + PLAYER.eyeHeight), dz = at.z - p.pos.z;
  return { yaw: yawOf({ x: dx, z: dz }), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Me on my island facing out along f, the other player parked far away, hooks in hand. */
async function field() {
  const m = await Match.create(humans);
  const isl = m.map[0];
  const fy = forward(isl.bunker.facingYaw), f = v3(-fy.z, 0, fy.x);
  const start = add(add(isl.center, scale(fy, 4)), scale(f, -12));
  start.y = isl.center.y + 2.1;
  m.debugTeleport(1, start);
  m.debugTeleport(2, add(add(isl.center, scale(fy, -40)), v3(0, 2.1, 0)));
  m.debugGive(1, { grapples: 5 });
  let s = m.tick(new Map([[1, { ...NO_INPUT }]]));
  for (let i = 0; i < 12; i++) s = m.tick(new Map([[1, { ...NO_INPUT }]]));
  return { m, f, s, slot: me(s).hotbar.indexOf('grapple') };
}

describe('grapple aim rule', () => {
  test('a hook on a container face under its top bites the top edge, and the pull lands you on it', async () => {
    const { m, f, s: s0, slot } = await field();
    const p0 = me(s0);
    const at = add(p0.pos, scale(f, 12));
    m.debugPlacePiece('container', v3(at.x, p0.pos.y, at.z), yawOf(f) + Math.PI / 2);
    const faceX = add(p0.pos, scale(f, 12 - PIECES.container.d / 2));
    const top = m.debugGroundAt(at.x, at.z)!;
    expect(top).toBeGreaterThan(p0.pos.y + 2);
    // Aim at the face 0.9 m under the top.
    const aim = aimAt(p0, v3(faceX.x, top - 0.9, faceX.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    let s = m.tick(inp({ grapple: true }));
    expect(me(s).hook?.st).toBe(0);
    expect(me(s).hook!.y).toBeCloseTo(top, 2);
    let onTop = false;
    for (let i = 0; i < 75; i++) {
      s = m.tick(inp({ yaw: aim.yaw, pitch: 0 }));
      if (!me(s).mv?.pull && me(s).mv?.grounded && me(s).pos.y > top - 0.2) { onTop = true; break; }
    }
    expect(onTop).toBe(true);
    m.dispose();
  });

  test('just over a ledge top (crosshair on the sky above it), the hook still bites the top', async () => {
    const { m, f, s: s0, slot } = await field();
    const p0 = me(s0);
    const at = add(p0.pos, scale(f, 12));
    m.debugPlacePiece('container', v3(at.x, p0.pos.y, at.z), yawOf(f) + Math.PI / 2);
    const top = m.debugGroundAt(at.x, at.z)!;
    const near = add(p0.pos, scale(f, 12 - PIECES.container.d / 2));
    const aim = aimAt(p0, v3(near.x, top + 0.9, near.z)); // ~4° over the edge
    const s = m.tick(new Map([[1, { ...NO_INPUT, ...aim, select: slot, grapple: true }]]));
    expect(me(s).hook?.st).toBe(0);
    expect(me(s).hook!.y).toBeCloseTo(top, 2);
    m.dispose();
  });

  test('an enemy near the crosshair is locked on and yanked; one well off it is not', async () => {
    const { m, f, s: s0, slot } = await field();
    const p0 = me(s0);
    const them = add(p0.pos, scale(f, 12));
    m.debugTeleport(2, them);
    let s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    for (let i = 0; i < 4; i++) s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    internal(m, 2).spawnProtected = false; internal(m, 2).invulnUntil = 0;
    const chest = v3(them.x, them.y + PLAYER.height * 0.6, them.z);
    const side = v3(-f.z, 0, f.x);
    // 0.9 m beside the chest at 12 m (~4°): a plain ray would miss them.
    const near = aimAt(p0, add(chest, scale(side, 0.9)));
    const dir = aimDir(near.yaw, near.pitch);
    const raw = (m as unknown as { physics: { raycast: (o: Vec3, d: Vec3, l: number, i: number) => { hit: { type: string } } | null } }).physics.raycast(eyePos(me(s)), dir, 26, 1);
    expect(raw?.hit.type === 'player').toBe(false);
    s = m.tick(new Map([[1, { ...NO_INPUT, ...near, select: slot, grapple: true }]]));
    expect(me(s).hook?.tgt).toBe(2);
    for (let i = 0; i < 6 && me(s).hook?.st === 0; i++) s = m.tick(new Map([[1, { ...NO_INPUT, ...near, select: slot }]]));
    expect(me(s).hook?.st).toBe(2); // yanking
    m.dispose();

    const b = await field();
    const q0 = me(b.s);
    const them2 = add(q0.pos, scale(b.f, 12));
    b.m.debugTeleport(2, them2);
    let t = b.m.tick(new Map([[1, { ...NO_INPUT, select: b.slot }]]));
    internal(b.m, 2).spawnProtected = false; internal(b.m, 2).invulnUntil = 0;
    const far = aimAt(q0, add(v3(them2.x, them2.y + 1, them2.z), scale(v3(-b.f.z, 0, b.f.x), 3.5))); // ~16° off
    t = b.m.tick(new Map([[1, { ...NO_INPUT, ...far, select: b.slot, grapple: true }]]));
    expect(me(t).hook?.tgt).toBeUndefined();
    b.m.dispose();
  });

  test('the client marker (predictor world, same rule) shows the point the sim bites (to a millimetre)', async () => {
    const { m, f, s: s0, slot } = await field();
    const p0 = me(s0);
    const at = add(p0.pos, scale(f, 10));
    m.debugPlacePiece('container', v3(at.x, p0.pos.y, at.z), yawOf(f) + Math.PI / 2);
    let s = m.tick(new Map([[1, { ...NO_INPUT, select: slot }]]));
    const pr = await Predictor.create(m.def, 1);
    pr.onSnapshot(s);
    const world = physicsAimWorld(pr.world, m.hookRange, s.waterY);
    let checked = 0;
    for (const dy of [-1.5, -0.6, 0.4, 1.2, 3]) for (const dz of [-3, 0, 2.5]) {
      const aim = aimAt(p0, add(add(at, v3(0, dy + 1.2, 0)), scale(v3(-f.z, 0, f.x), dz)));
      const marker = grappleAim(world, me(s), eyePos(me(s)), aimDir(aim.yaw, aim.pitch), s.players, s.time);
      const fork = m.fork();
      const t = fork.tick(new Map([[1, { ...NO_INPUT, ...aim, select: slot, grapple: true }]]));
      const h = me(t).hook;
      if (!marker) expect(h === undefined || h.st === 3).toBe(true);
      else { expect(h?.st).toBe(0); expect(Math.hypot(h!.x - marker.point.x, h!.y - marker.point.y, h!.z - marker.point.z)).toBeLessThan(1e-3); checked++; }
      fork.dispose();
    }
    expect(checked).toBeGreaterThan(5);
    m.dispose();
  });

  test('reach rule: an aim point is never past the map reach from the eye', async () => {
    const { m, s } = await field();
    const p = internal(m);
    const ctx = (m as unknown as { grappleCtx: Parameters<typeof grappleAim>[0] }).grappleCtx;
    for (let yi = 0; yi < 24; yi++) for (const pitch of [-0.3, -0.1, 0, 0.1, 0.25, 0.5]) {
      const a = grappleAim(ctx, p, eyePos(p), aimDir(yi / 24 * Math.PI * 2, pitch), s.players, s.time);
      if (a) expect(a.dist).toBeLessThanOrEqual(m.hookRange + 1e-9);
      if (a) expect(Math.hypot(a.point.x - eyePos(p).x, a.point.y - eyePos(p).y, a.point.z - eyePos(p).z)).toBeLessThanOrEqual(m.hookRange + 1e-6);
    }
    expect(GRAPPLE.range).toBeGreaterThanOrEqual(m.hookRange);
    m.dispose();
  });
});
