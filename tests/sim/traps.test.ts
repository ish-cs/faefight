import { describe, expect, test } from 'vitest';
import { PIECES, PLAYER, TRAP } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { Physics } from '../../src/sim/physics';
import { friendly, inTrapZone, trapAim, validateTrap } from '../../src/sim/traps';
import { NO_INPUT, type PlayerInput, type Snapshot, type TrapRequest, type Vec3 } from '../../src/sim/types';
import { forward, v3, yawOf } from '../../src/sim/vec';
import { SnapshotEncoder } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder } from '../../src/net/wire';
import { sanitizeInput } from '../../src/net/sanitize';

async function match(n = 2, seed = 1) {
  return Match.create({ players: Array.from({ length: n }, (_, i) => ({ name: `p${i + 1}`, isBot: false })), map: 'harbor', seed });
}
const physicsOf = (m: Match) => (m as unknown as { physics: Physics }).physics;
const ticks = (m: Match, sec: number, inputs = new Map<number, PlayerInput>()) => {
  const all: Snapshot[] = [];
  for (let i = 0; i < Math.round(sec * 30); i++) all.push(m.tick(inputs));
  return { last: all[all.length - 1], events: all.flatMap((s) => s.events), all };
};
/** Out of spawn protection, standing at `pos`. */
function stand(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = (m as unknown as { s: { players: Map<number, { invulnUntil: number; spawnProtected?: boolean }> } }).s.players.get(id)!;
  p.invulnUntil = 0;
  p.spawnProtected = false;
}
/** An open flat floor spot on island 0 where a trap validates (toward the island centre from the spawn). */
function openSpot(m: Match): Vec3 {
  const isl = m.def.islands[0];
  const ph = physicsOf(m);
  for (let r = 3; r < isl.radius - 3; r += 0.5) for (let a = 0; a < 6.28; a += 0.3) {
    const x = isl.center.x + Math.cos(a) * r, z = isl.center.z + Math.sin(a) * r;
    const y = ph.isGroundAt(x, z);
    if (y === null) continue;
    const at = v3(x, y, z);
    const ok = validateTrap(ph, { pos: at, rotY: 0, wall: false }, at, []);
    // Room around it to stand beside, too.
    if (ok.ok && validateTrap(ph, { pos: v3(x + 2.5, y, z), rotY: 0, wall: false }, at, []).ok) return ok.pos;
  }
  throw new Error('no open spot');
}
const placeReq = (pos: Vec3, rotY = 0, wall = false): TrapRequest => ({ pos, rotY, wall });
const act = (m: Match, id: number, input: Partial<PlayerInput>) => m.tick(new Map([[id, { ...NO_INPUT, ...input }]]));

describe('spike traps', () => {
  test('shop sells them; placing uses one and arms after armSec', async () => {
    const m = await match();
    const spot = openSpot(m);
    m.debugGive(1, { cash: TRAP.price });
    stand(m, 1, m.def.islands[0].shop);
    let s = act(m, 1, { shop: { buy: 'trap' } });
    expect(s.players[0].inv.traps).toBe(1);
    expect(s.players[0].hotbar).toContain('trap');
    stand(m, 1, v3(spot.x + 2, spot.y, spot.z));
    s = act(m, 1, { trap: placeReq(spot) });
    expect(s.players[0].inv.traps).toBe(0);
    expect(s.players[0].hotbar).not.toContain('trap');
    expect(s.traps).toHaveLength(1);
    expect(s.traps![0]).toMatchObject({ owner: 1, wall: false, hp: TRAP.hp });
    expect(s.events.some((e) => e.type === 'trap' && e.data.what === 'placed')).toBe(true);
    // An enemy standing on it before it arms is not hurt; once armed, it is.
    stand(m, 2, spot);
    const early = ticks(m, TRAP.armSec - 0.2);
    expect(early.events.filter((e) => e.type === 'hit')).toHaveLength(0);
    const later = ticks(m, 0.4);
    const hit = later.events.find((e) => e.type === 'hit' && e.data.target === 2)!;
    expect(hit.data).toMatchObject({ by: 1, weapon: 'trap', amount: TRAP.dmg });
    expect(later.events.some((e) => e.type === 'trap' && e.data.what === 'fired')).toBe(true);
  });

  test('owner never takes damage; re-arms after rearmSec (no instant loop)', async () => {
    const m = await match();
    const spot = openSpot(m);
    m.debugGive(1, { traps: 1 });
    stand(m, 1, v3(spot.x + 2, spot.y, spot.z));
    act(m, 1, { trap: placeReq(spot) });
    stand(m, 1, spot);
    const own = ticks(m, TRAP.armSec + 1);
    expect(own.events.filter((e) => e.type === 'hit')).toHaveLength(0);
    expect(friendly(1, { id: 1 })).toBe(true);
    expect(friendly(1, { id: 2 })).toBe(false);
    stand(m, 1, v3(spot.x + 3, spot.y, spot.z));
    stand(m, 2, spot);
    m.debugSetShield(2, 0);
    const run = ticks(m, TRAP.rearmSec + 0.2);
    const hits = run.events.filter((e) => e.type === 'hit' && e.data.target === 2);
    expect(hits).toHaveLength(2); // once now, once after re-arming
    expect(hits[1].t - hits[0].t).toBeCloseTo(TRAP.rearmSec, 1);
    expect(run.last.players[1].alive).toBe(false); // 2 × 60 > 100 hp
    const kill = run.events.find((e) => e.type === 'kill')!;
    expect(kill.data).toMatchObject({ victim: 2, killer: 1, via: 'trap' });
  });

  test('teams: a teammate walks over your trap untouched (it does not fire); an enemy does not', async () => {
    // 2v2v2v2 with 3 players = three teams of one, so pick: players 1 and 2 on team 0, player 3 on team 1.
    const m = await Match.create({
      players: [{ name: 'p1', isBot: false, team: 0 }, { name: 'p2', isBot: false, team: 0 }, { name: 'p3', isBot: false, team: 1 }],
      map: 'harbor', seed: 1, settings: { startCash: 50, suddenDeathSec: 900, genMult: 1, teamMode: 2 },
    });
    expect(friendly(1, { id: 2, team: 0 }, 0)).toBe(true);
    expect(friendly(1, { id: 3, team: 1 }, 0)).toBe(false);
    const spot = openSpot(m);
    m.debugGive(1, { traps: 1 });
    stand(m, 1, v3(spot.x + 2, spot.y, spot.z));
    act(m, 1, { trap: placeReq(spot) });
    stand(m, 1, v3(spot.x + 3, spot.y, spot.z));
    stand(m, 2, spot);
    const mate = ticks(m, TRAP.armSec + 1);
    expect(mate.events.filter((e) => e.type === 'hit' || (e.type === 'trap' && e.data.what === 'fired'))).toHaveLength(0);
    stand(m, 2, v3(spot.x - 3, spot.y, spot.z));
    stand(m, 3, spot);
    const foe = ticks(m, 0.5);
    expect(foe.events.some((e) => e.type === 'hit' && e.data.target === 3 && e.data.weapon === 'trap')).toBe(true);
  });

  test('limit per player, spacing, and only flat reachable floors', async () => {
    const m = await match();
    const ph = physicsOf(m);
    const spot = openSpot(m);
    expect(validateTrap(ph, placeReq(spot), v3(spot.x + 20, spot.y, spot.z), []).ok).toBe(false); // too far
    expect(validateTrap(ph, placeReq(v3(spot.x + 0.5, spot.y, spot.z)), spot, [{ pos: spot }])).toMatchObject({ ok: false, reason: 'too close to a trap' });
    m.debugGive(1, { traps: 5 });
    const placed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = openSpotNear(m, spot, i);
      stand(m, 1, at.standAt);
      const s = act(m, 1, { trap: placeReq(at.pos) });
      ticks(m, TRAP.placeSec + 0.05);
      placed.push(s.traps?.length ?? 0);
    }
    expect(Math.max(...placed)).toBe(TRAP.maxPerPlayer);
    expect(m.debugTraps()).toHaveLength(TRAP.maxPerPlayer);
  });

  test('wall traps sit on a wall face and only hit whoever is in front', async () => {
    const m = await match();
    const ph = physicsOf(m);
    const spot = openSpot(m);
    // A steel wall facing +X... built on the spot, turned so its face points along forward(yaw).
    const yaw = Math.PI / 2; // forward = -X
    const wall = m.debugPlacePiece('steel', spot, yaw, 0);
    const n = forward(yaw);
    const half = PIECES.steel.d / 2;
    const face = v3(spot.x + n.x * half, spot.y + 1.0, spot.z + n.z * half);
    const eye = v3(face.x + n.x * 2, face.y + 0.2, face.z + n.z * 2);
    const dir = v3(-n.x, -0.1, -n.z);
    const l = Math.hypot(dir.x, dir.y, dir.z);
    const req = trapAim(ph, eye, v3(dir.x / l, dir.y / l, dir.z / l), yawOf(v3(-n.x, 0, -n.z)), 5)!;
    expect(req.wall).toBe(true);
    const ok = validateTrap(ph, req, v3(eye.x, spot.y, eye.z), []);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.on).toBe(wall);
    // In front: inside; behind the wall: not.
    const t = { pos: ok.pos, rotY: ok.rotY, wall: true };
    expect(inTrapZone(t, v3(ok.pos.x + n.x * 0.4, spot.y, ok.pos.z + n.z * 0.4))).toBe(true);
    expect(inTrapZone(t, v3(ok.pos.x - n.x * 0.5, spot.y, ok.pos.z - n.z * 0.5))).toBe(false);
    expect(inTrapZone(t, v3(ok.pos.x + n.x * 2, spot.y, ok.pos.z + n.z * 2))).toBe(false);
    // Placed for real; the wall breaking takes the trap with it.
    m.debugGive(1, { traps: 1 });
    stand(m, 1, v3(eye.x, spot.y, eye.z));
    act(m, 1, { trap: req });
    expect(m.debugTraps()).toHaveLength(1);
    m.debugRemovePiece(wall);
    const s = act(m, 1, {});
    expect(m.debugTraps()).toHaveLength(0);
    expect(s.events.some((e) => e.type === 'trap' && e.data.what === 'broken')).toBe(true);
  });

  test('bullets and blasts break them', async () => {
    const m = await match();
    const spot = openSpot(m);
    m.debugGive(1, { traps: 2 });
    stand(m, 1, v3(spot.x + 2, spot.y, spot.z));
    act(m, 1, { trap: placeReq(spot) });
    // Shoot it from 4 m with a rifle.
    m.debugGive(2, { weapons: { rifle: { mag: 30, spare: 0 } } });
    const from = v3(spot.x - 4, spot.y, spot.z);
    stand(m, 2, from);
    const eyeY = from.y + PLAYER.eyeHeight;
    const aim = { yaw: yawOf(v3(1, 0, 0)), pitch: Math.atan2(spot.y + 0.04 - eyeY, 4), slot: 'rifle' as const };
    m.tick(new Map([[2, { ...NO_INPUT, ...aim }]]));
    let broke = false;
    for (let i = 0; i < 120 && !broke; i++) {
      const s = m.tick(new Map([[2, { ...NO_INPUT, ...aim, fire: true }]]));
      broke = s.events.some((e) => e.type === 'trap' && e.data.what === 'broken' && e.data.by === 2);
    }
    expect(broke).toBe(true);
    // A grenade at its middle breaks one too.
    const spot2 = openSpotNear(m, spot, 3);
    stand(m, 1, spot2.standAt);
    act(m, 1, { trap: placeReq(spot2.pos) });
    expect(m.debugTraps()).toHaveLength(1);
    m.debugExplode('grenade', v3(spot2.pos.x, spot2.pos.y + 0.3, spot2.pos.z), 2);
    ticks(m, 0.1);
    expect(m.debugTraps()).toHaveLength(0);
  });

  test('snapshots carry them over the wire; inputs survive sanitize; deterministic replay', async () => {
    const run = async () => {
      const m = await match();
      const spot = openSpot(m);
      m.debugGive(1, { traps: 1 });
      stand(m, 1, v3(spot.x + 2, spot.y, spot.z));
      act(m, 1, { trap: placeReq(spot) });
      stand(m, 2, v3(spot.x - 2, spot.y, spot.z));
      const out: Snapshot[] = [];
      for (let i = 0; i < 60; i++) out.push(m.tick(new Map([[2, { ...NO_INPUT, yaw: yawOf(v3(1, 0, 0)) }]])));
      stand(m, 2, spot);
      out.push(...ticks(m, 1).all);
      return out;
    };
    const a = await run(), b = await run();
    expect(JSON.stringify(a.map((s) => [s.traps, s.players.map((p) => p.hp)]))).toBe(JSON.stringify(b.map((s) => [s.traps, s.players.map((p) => p.hp)])));
    const enc = new SnapshotEncoder();
    enc.push(a[a.length - 1]);
    const net = enc.take(1);
    const we = new WireEncoder(), wd = new WireDecoder();
    const back = wd.decode(we.encode(1, net));
    expect(a[a.length - 1].traps).toHaveLength(1);
    expect((back as Snapshot | null)?.traps).toEqual(a[a.length - 1].traps);
    const s = sanitizeInput({ ...NO_INPUT, trap: { pos: { x: 1, y: 2, z: 3 }, rotY: 0.5, wall: true } });
    expect(s?.trap).toEqual({ pos: { x: 1, y: 2, z: 3 }, rotY: 0.5, wall: true });
    expect(sanitizeInput({ ...NO_INPUT, trap: { pos: 'x' } })?.trap).toBeUndefined();
  });
});

/** The i-th distinct valid spot near `base` (each ≥ minGap from the others), with somewhere to stand. */
function openSpotNear(m: Match, base: Vec3, i: number): { pos: Vec3; standAt: Vec3 } {
  const ph = physicsOf(m);
  const step = TRAP.minGap + 0.4;
  const offs = [[0, 0], [step, 0], [0, step], [step, step], [-step, 0], [0, -step], [-step, -step]];
  let found = 0;
  for (const [dx, dz] of offs) {
    const x = base.x + dx, z = base.z + dz;
    const y = ph.isGroundAt(x, z);
    if (y === null) continue;
    const r = validateTrap(ph, placeReq(v3(x, y, z)), v3(x, y, z), []);
    if (!r.ok) continue;
    if (found++ === i) return { pos: r.pos, standAt: v3(x + 0.9, y, z + 0.9) };
  }
  throw new Error(`no spot ${i} near base`);
}
