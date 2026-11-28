import { describe, expect, test } from 'vitest';
import { GRAPPLE, PLAYER } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { newMoveState, stepMove, type MoveCmd, type MoveState } from '../../src/sim/movement';
import { navNodes, nodeAt } from '../../src/sim/bots/nav';
import { NO_INPUT, type PlayerInput, type PlayerState, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, dist, forward, scale, v3, yawOf } from '../../src/sim/vec';
import { decodeReplay } from '../../src/sim/replay/codec';
import { stateHash } from '../../src/sim/replay/hash';
import { Recorder } from '../../src/sim/replay/recorder';
import { ReplayRunner } from '../../src/sim/replay/runner';

// The rope pull (movement.ts stepPull): a direct pull with braking, an eased short hook and a light swing.
const DT = 1 / 30;
const free = (m: { pos: Vec3 }) => ({ movePlayer: (d: Vec3) => ({ pos: v3(m.pos.x + d.x, m.pos.y + d.y, m.pos.z + d.z), grounded: false }) });
const cmd = (x: Partial<MoveCmd> = {}): MoveCmd => ({ seq: 1, moveX: 0, moveZ: 0, yaw: 0, jump: false, sprint: false, ...x });
type Bob = { pos: Vec3; vel: Vec3; mv: MoveState };
const bob = (pos: Vec3, pull: NonNullable<MoveState['pull']>, vel = v3()): Bob => ({ pos, vel, mv: { ...newMoveState(), airTime: 1, pull } });

/** The rope pull before this change (NET 41), kept here as the yardstick: ease to 22 m/s at 7/s, no gravity, 2.4 s. */
function oldArrival(d: number, h: number): number {
  const ticksOut = Math.ceil(Math.hypot(d, h) / 90 / DT - 1e-9);
  const p = v3(), v = v3(), a = v3(d, h, 0);
  for (let i = 0; i < 200; i++) {
    const r = { x: a.x - p.x, y: a.y - p.y, z: a.z - p.z }, l = Math.hypot(r.x, r.y, r.z);
    if (l <= 1.6) return (ticksOut + i) * DT;
    const k = Math.min(1, 7 * DT);
    v.x += (r.x / l * 22 - v.x) * k; v.y += (r.y / l * 22 - v.y) * k; v.z += (r.z / l * 22 - v.z) * k;
    p.x += v.x * DT; p.y += v.y * DT; p.z += v.z * DT;
  }
  return Infinity;
}

function newArrival(d: number, h: number): number {
  const ticksOut = Math.ceil(Math.hypot(d, h) / GRAPPLE.tipSpeed / DT - 1e-9);
  const m = bob(v3(), { x: d, y: h, z: 0, left: GRAPPLE.pullSec });
  for (let i = 0; i < 200; i++) {
    if (!m.mv.pull) return (ticksOut + i - 1) * DT; // let go on the step before (the arrival step runs a normal move)
    stepMove(m, cmd(), DT, free(m));
  }
  return Infinity;
}

describe('rope pull physics (movement.ts)', () => {
  test('no slower than the old pull: fire to arrival at 8 m, 15 m, 18 m (yard reach), 26 m (max reach), level and up a ledge', () => {
    const rows: string[] = [];
    for (const h of [0, 5]) for (const d of [8, 15, 18, GRAPPLE.range]) {
      const o = oldArrival(d, h), n = newArrival(d, h);
      rows.push(`${String(d).padStart(2)} m  up ${h} m   old ${o.toFixed(3)} s   new ${n.toFixed(3)} s   ${((n / o - 1) * 100).toFixed(0)}%`);
      expect(n, `${d} m, up ${h} m`).toBeLessThanOrEqual(o);
    }
    console.log(`[grapple arrival]\n${rows.join('\n')}`);
  });

  /** Steps of a pull from rest to `a` in free space: speed on the step before arrival, peak speed, steps taken. */
  function run(a: Vec3, c: Partial<MoveCmd> = {}, vel = v3()) {
    const m = bob(v3(), { x: a.x, y: a.y, z: a.z, left: GRAPPLE.pullSec }, vel);
    let peak = 0, last = 0, steps = 0, lowest = 0;
    for (; steps < 120 && m.mv.pull; steps++) {
      last = Math.hypot(m.vel.x, m.vel.y, m.vel.z);
      stepMove(m, cmd(c), DT, free(m));
      if (m.mv.pull) peak = Math.max(peak, Math.hypot(m.vel.x, m.vel.y, m.vel.z));
      lowest = Math.min(lowest, m.pos.y - a.y * Math.min(1, Math.hypot(m.pos.x, m.pos.z) / Math.max(1e-9, Math.hypot(a.x, a.z))));
    }
    return { m, peak, last, steps, lowest };
  }

  test('arrival braking: a long pull tops out at pullSpeed and comes in slow, never at full tilt', () => {
    for (const d of [8, 15, 26]) {
      const r = run(v3(d, 0, 0));
      expect(r.peak, `${d} m peak`).toBeLessThanOrEqual(GRAPPLE.pullSpeed + 0.5); // + the sag's sideways bit
      expect(r.last, `${d} m arrival speed`).toBeLessThan(GRAPPLE.arriveSpeed + 3);
      expect(r.m.mv.pull).toBeUndefined();
      // Let go: the arrival sheds the speed (no sailing past the point).
      expect(Math.hypot(r.m.vel.x, r.m.vel.z)).toBeLessThan(GRAPPLE.arriveStep + GRAPPLE.arriveKeep * (GRAPPLE.arriveSpeed + 3));
    }
  });

  test('a short hook eases in over several frames (no snap), slower at the top than a long one', () => {
    for (const [d, minSteps, maxPeak] of [[2.6, 4, 11], [3.5, 6, 14], [5, 9, 19]] as const) {
      const r = run(v3(d, 0, 0));
      expect(r.steps, `${d} m steps`).toBeGreaterThanOrEqual(minSteps);
      expect(r.peak, `${d} m peak`).toBeLessThanOrEqual(maxPeak);
    }
  });

  test('holding back on the stick no longer pins you on the rope: it still pulls you in', () => {
    const r = run(v3(12, 3, 0), { moveZ: -1 });
    expect(r.m.mv.pull).toBeUndefined();
    expect(r.steps).toBeLessThan(25);
  });

  test('blocked by a wall, the pull lets go within a fraction of a second instead of pinning you', () => {
    const m = bob(v3(), { x: 10, y: 4, z: 0, left: GRAPPLE.pullSec });
    const wall = { movePlayer: (_d: Vec3) => ({ pos: { ...m.pos }, grounded: true }) };
    let steps = 0;
    for (; steps < 120 && m.mv.pull; steps++) stepMove(m, cmd(), DT, wall);
    expect(steps * DT).toBeLessThan(0.45);
    // Sliding up a face (half the motion gets through) is progress, not a stall: the pull keeps going.
    const s = bob(v3(), { x: 10, y: 4, z: 0, left: GRAPPLE.pullSec });
    const slide = { movePlayer: (d: Vec3) => ({ pos: v3(s.pos.x + d.x * 0.5, s.pos.y + d.y * 0.5, s.pos.z + d.z * 0.5), grounded: false }) };
    for (let i = 0; i < 15; i++) stepMove(s, cmd(), DT, slide);
    expect(s.mv.pull).toBeDefined();
  });

  test('a mild swing: sideways speed carries a little and dies off; the path sags only a little under the line', () => {
    const r = run(v3(20, 0, 0), {}, v3(0, 0, 8));
    expect(r.m.mv.pull).toBeUndefined();
    const side = bob(v3(), { x: 20, y: 0, z: 0, left: GRAPPLE.pullSec }, v3(0, 0, 8));
    for (let i = 0; i < 9; i++) stepMove(side, cmd(), DT, free(side));
    expect(side.vel.z).toBeGreaterThan(8 * 0.15); // carried, not killed outright
    expect(side.vel.z).toBeLessThan(8 * 0.5); // but well damped within 0.3 s
    expect(r.lowest).toBeGreaterThan(-1); // sag under the straight line < 1 m on a 20 m pull
  });

  test('arriving under a ledge-top point hops you up and on so you land on it', () => {
    const m = bob(v3(0, 0, 0), { x: 1.2, y: 1, z: 0, left: GRAPPLE.pullSec }, v3(3, 3, 0));
    stepMove(m, cmd(), DT, free(m));
    expect(m.mv.pull).toBeUndefined();
    expect((m.vel.y + PLAYER.gravity * DT) ** 2 / (2 * PLAYER.gravity)).toBeGreaterThan(1.3); // clears 1 m + margin
    expect(m.vel.x).toBeGreaterThanOrEqual(GRAPPLE.arriveStep - 1e-9);
  });

  test('a jump lets go keeping the velocity (no stop), capped at GRAPPLE.flingMax', () => {
    const slow = bob(v3(), { x: 0, y: 10, z: 0, left: 4 }, v3(8, 0, 0));
    stepMove(slow, cmd({ jump: true }), DT, free(slow));
    expect(slow.mv.pull).toBeUndefined();
    expect(slow.vel.x).toBeCloseTo(8, 9);
    const fast = bob(v3(), { x: 0, y: 10, z: 0, left: 4 }, v3(25, 5, 0));
    stepMove(fast, cmd({ jump: true }), DT, free(fast));
    expect(fast.vel.x).toBeCloseTo(GRAPPLE.flingMax * 25 / Math.hypot(25, 5), 9);
    expect(fast.vel.y).toBeCloseTo(GRAPPLE.flingMax * 5 / Math.hypot(25, 5) - PLAYER.gravity * DT, 9);
  });
});

const humans = { players: [{ name: 'you', isBot: false }, { name: 'them', isBot: false }], seed: 7 };
const me = (s: Snapshot, id = 1) => s.players.find((p) => p.id === id)!;
function aimAt(p: { pos: Vec3 }, at: Vec3): { yaw: number; pitch: number } {
  const dx = at.x - p.pos.x, dy = at.y - (p.pos.y + PLAYER.eyeHeight), dz = at.z - p.pos.z;
  return { yaw: yawOf({ x: dx, z: dz }), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

async function onGround() {
  const m = await Match.create(humans);
  const isl = m.map[0];
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

describe('rope pull in a match', () => {
  test('the rope snaps when the piece it bit is destroyed (event + you fly on)', async () => {
    const { m, f, s: s0, slot } = await onGround();
    const p0 = me(s0);
    const wallAt = add(p0.pos, scale(f, 20));
    const id = m.debugPlacePiece('steel', v3(wallAt.x, p0.pos.y + 1.5, wallAt.z), yawOf(f));
    const aim = aimAt(p0, v3(wallAt.x, p0.pos.y + 2.5, wallAt.z));
    const inp = (x: Partial<PlayerInput> = {}) => new Map([[1, { ...NO_INPUT, ...aim, select: slot, ...x }]]);
    let s = m.tick(inp({ grapple: true }));
    for (let i = 0; i < 10 && me(s).hook?.st !== 1; i++) s = m.tick(inp());
    expect(me(s).hook?.st).toBe(1);
    for (let i = 0; i < 6; i++) s = m.tick(inp());
    const speed = Math.hypot(me(s).vel.x, me(s).vel.z);
    expect(speed).toBeGreaterThan(8);
    m.debugRemovePiece(id);
    s = m.tick(inp());
    expect(s.events.some((e) => e.type === 'grapple' && e.data.phase === 'snap')).toBe(true);
    expect(me(s).hook).toBeUndefined();
    expect(me(s).mv?.pull).toBeUndefined();
    expect(Math.hypot(me(s).vel.x, me(s).vel.z)).toBeGreaterThan(Math.min(speed, GRAPPLE.flingMax) * 0.7);
  });

  test('replay round trip: a recorded hook, swing and release re-sims bit for bit', async () => {
    const setup = { players: [{ name: 'You', isBot: false }, { name: 'B', isBot: false }], seed: 7 };
    const m = await Match.create(setup);
    const rec = new Recorder(m, { setup, kind: 'test', localId: 1, recordedAt: 0, id: 'test' });
    const hashes: number[] = [];
    let s = rec.tick(new Map());
    hashes.push(stateHash(s));
    const isl = m.map[0];
    const fy = forward(isl.bunker.facingYaw), f = v3(-fy.z, 0, fy.x);
    const start = add(add(isl.center, scale(fy, 4)), scale(f, -12));
    start.y = isl.center.y + 2.1;
    m.debugTeleport(1, start); rec.op({ k: 'teleport', id: 1, pos: start });
    m.debugGive(1, { grapples: 3 }); rec.op({ k: 'give', id: 1, inv: { grapples: 3 } });
    const wallAt = add(start, scale(f, 18));
    const piece = { kind: 'steel' as const, pos: v3(wallAt.x, start.y + 4, wallAt.z), rotY: yawOf(f) };
    m.debugPlacePiece(piece.kind, piece.pos, piece.rotY); rec.op({ k: 'piece', ...piece });
    let seq = 0, phases = 0;
    for (let t = 2; t <= 150; t++) {
      const p = me(s);
      const aim = aimAt({ pos: start }, v3(wallAt.x, start.y + 5.5, wallAt.z));
      const slot = p.hotbar.indexOf('grapple');
      const input: PlayerInput = { ...NO_INPUT, ...aim, yaw: aim.yaw + t * 1e-3, select: slot >= 0 ? slot : null, grapple: t === 20 || t === 90,
        moveZ: t > 30 && t < 45 ? -1 : 0, moveX: t > 32 && t < 40 ? 0.7071067811865476 : 0, jump: t === 60 };
      const cmds: MoveCmd[] = [{ seq: ++seq, moveX: input.moveX, moveZ: input.moveZ, yaw: input.yaw, jump: input.jump, sprint: false }];
      s = rec.tick(new Map([[1, input]]), new Map([[1, cmds]]));
      hashes.push(stateHash(s));
      phases += s.events.filter((e) => e.type === 'grapple').length;
    }
    const out = await rec.finish();
    m.dispose();
    expect(phases).toBeGreaterThan(1);
    const replay = await decodeReplay(out.bytes);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    for (let i = 0; i < hashes.length; i++) {
      const r = runner.step()!;
      if (stateHash(r) !== hashes[i]) throw new Error(`diverged at tick ${r.tick}`);
    }
    expect(runner.divergedAt).toBeNull();
    runner.dispose();
  }, 60_000);
});

// The reach rule (map.ts grappleRange: a few decks short of the narrowest gap) must survive the swing: from a player
// island's shore, no hook in any direction, reeled or held, released at any moment, lands you on another player island.
describe('reach rule survives the swing', () => {
  test('container yard (18 m reach, 26 m gaps): no hook + swing + fling from the shore reaches a rival island', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], map: 'yard', seed: 1 });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const players = m.def.islands.length;
    const home = nodes[0];
    // Shore spots toward each other player island: standing 1.5 m in from the edge, and a sprint + jump off it.
    type Start = { spot: Vec3; out: number; run: boolean; deck?: Vec3 };
    const starts: Start[] = [];
    for (let j = 1; j < players; j++) {
      const o = nodes[j], dx = o.center.x - home.center.x, dz = o.center.z - home.center.z, l = Math.hypot(dx, dz);
      const out = yawOf({ x: dx, z: dz });
      starts.push({ spot: v3(home.center.x + dx / l * (home.radius - 1.5), home.groundY + 0.05, home.center.z + dz / l * (home.radius - 1.5)), out, run: false });
      starts.push({ spot: v3(home.center.x + dx / l * (home.radius - 4), home.groundY + 0.05, home.center.z + dz / l * (home.radius - 4)), out, run: true });
      // One deck of bridge out (4 m): still well short of hook reach to the rival.
      const deck = v3(home.center.x + dx / l * (home.radius + 1.5), home.groundY, home.center.z + dz / l * (home.radius + 1.5));
      starts.push({ spot: v3(home.center.x + dx / l * (home.radius + 3), home.groundY + 0.3, home.center.z + dz / l * (home.radius + 3)), out, run: false, deck });
      starts.push({ spot: v3(home.center.x + dx / l * (home.radius - 4), home.groundY + 0.05, home.center.z + dz / l * (home.radius - 4)), out, run: true, deck });
    }
    m.debugTeleport(2, v3(m.def.center.center.x, m.def.center.groundY + 0.1, m.def.center.center.z));
    m.debugGive(1, { grapples: 99 });
    const internal = (x: Match): PlayerState => (x as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(1)!;
    let latched = 0, flights = 0, crossed = 0, best = 0;
    const onRival = (p: { pos: Vec3 }) => {
      const k = nodeAt(nodes, p.pos);
      return k > 0 && k < players && p.pos.y > nodes[k].groundY - 1;
    };
    for (const st of starts) {
      const base = m.fork();
      if (st.deck) base.debugPlacePiece('scaffold', st.deck, st.out, 1);
      base.debugTeleport(1, st.spot);
      let s = base.tick(new Map([[1, { ...NO_INPUT, yaw: st.out }]]));
      for (let i = 0; i < 5; i++) s = base.tick(new Map([[1, { ...NO_INPUT, yaw: st.out }]]));
      const slot = me(s).hotbar.indexOf('grapple');
      if (st.run) {
        // Sprint at the water and jump off the edge (the hook goes out on the way down).
        const r = () => Math.hypot(me(s).pos.x - home.center.x, me(s).pos.z - home.center.z);
        const tip = st.deck ? home.radius + 3.2 : home.radius;
        for (let i = 0; i < 50 && r() < tip + 0.5; i++) {
          const edge = r() > tip - 1;
          s = base.tick(new Map([[1, { ...NO_INPUT, yaw: st.out, moveZ: 1, sprint: true, jump: edge, select: slot }]]));
        }
      }
      const l0 = latched;
      for (let yi = 0; yi < 16; yi++) for (const pitch of [-0.15, 0.1, 0.35, 0.6, 0.9]) {
        const yaw = (yi / 16) * Math.PI * 2;
        const a = base.fork();
        const aim = { yaw, pitch, select: slot };
        let t = a.tick(new Map([[1, { ...NO_INPUT, ...aim, grapple: true }]]));
        for (let i = 0; i < 6 && me(t).hook?.st === 0; i++) t = a.tick(new Map([[1, { ...NO_INPUT, ...aim }]]));
        if (me(t).hook?.st !== 1) { a.dispose(); continue; }
        latched++;
        for (const hold of [false, true]) {
          const r = a.fork();
          const move = (jump: boolean): PlayerInput => ({ ...NO_INPUT, ...aim, moveZ: hold ? -1 : 0, jump });
          for (let k = 0; k <= 75; k++) {
            if (!internal(r).mv?.pull) break;
            if (k % 3 === 0) {
              // Let go here (jump) and fly it out.
              const fl = r.fork();
              let u = fl.tick(new Map([[1, move(true)]]));
              flights++;
              for (let i = 0; i < 150 && me(u).alive && !(me(u).mv?.grounded && i > 2); i++) {
                u = fl.tick(new Map([[1, { ...NO_INPUT, ...aim, yaw: st.out, moveZ: 1, sprint: true }]])); // and steer on outward
                const out = Math.hypot(me(u).pos.x - home.center.x, me(u).pos.z - home.center.z) - home.radius;
                best = Math.max(best, out);
                if (onRival(me(u))) { crossed++; break; }
              }
              fl.dispose();
            }
            const u = r.tick(new Map([[1, move(false)]]));
            if (onRival(me(u))) crossed++;
          }
          r.dispose();
        }
        a.dispose();
      }
      expect(latched - l0, `hooks that bit from ${st.run ? 'a running jump' : 'standing'}${st.deck ? ' on a deck' : ''}`).toBeGreaterThan(0);
      base.dispose();
    }
    console.log(`[grapple reach] latched ${latched} hooks, ${flights} releases, furthest past the shore ${best.toFixed(1)} m (reach ${m.hookRange} m), crossed ${crossed}`);
    expect(latched).toBeGreaterThan(5);
    expect(crossed).toBe(0);
    m.dispose();
  }, 600_000);
});
