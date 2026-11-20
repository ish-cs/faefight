import { describe, expect, test } from 'vitest';
import { Predictor, SNAP_DIST } from '../../src/client/predict';
import { MoveQueue } from '../../src/client/moveQueue';
import { Match } from '../../src/sim/match';
import type { MoveCmd } from '../../src/sim/movement';
import { NO_INPUT, type Snapshot, type Vec3 } from '../../src/sim/types';

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };
const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;

/** A scripted walk: forward, strafe, sprint, jumps, turning — and into the bunker wall. */
function script(seq: number, yaw0: number): MoveCmd {
  const t = seq % 90;
  return {
    seq,
    moveX: t > 40 && t < 60 ? 1 : 0,
    moveZ: t < 70 ? 1 : 0,
    yaw: yaw0 + Math.sin(seq / 25) * 1.2,
    jump: t === 20 || t === 50,
    sprint: t > 25 && t < 45,
  };
}

async function setup() {
  const m = await Match.create(humans);
  const s0 = m.tick(new Map());
  const pr = await Predictor.create(m.map, 1);
  pr.onSnapshot(s0);
  return { m, pr, yaw0: m.map[0].bunker.facingYaw };
}

describe('Predictor', () => {
  test('replaying unacked commands lands exactly where the sim ends up (with latency + jitter)', async () => {
    const { m, pr, yaw0 } = await setup();
    const q = new MoveQueue();
    const predictedAt = new Map<number, Vec3>();
    const inFlight: { at: number; cmds: MoveCmd[] }[] = [];
    const snaps: { at: number; s: Snapshot }[] = [];
    let seq = 0, maxErr = 0, compared = 0, lastAt = 0, lastSeq = 0, off = 0;
    for (let tick = 0; tick < 240; tick++) {
      // Client: one command per tick; sent with 3–5 ticks of latency (jittery).
      const c = script(++seq, yaw0);
      pr.step(c);
      predictedAt.set(c.seq, { ...pr.current!.pos });
      lastAt = Math.max(lastAt, tick + 3 + (tick % 4 === 1 ? 2 : 0)); // ordered link, jittery latency
      inFlight.push({ at: lastAt, cmds: [c] });
      // Host: drain arrived commands through the move queue, tick, send a snapshot back (4 ticks).
      for (const f of inFlight.filter((f) => f.at <= tick)) q.push(f.cmds);
      inFlight.splice(0, inFlight.length, ...inFlight.filter((f) => f.at > tick));
      const cmds = q.take({ moveX: 0, moveZ: 0, yaw: 0, sprint: false });
      for (const k of cmds) { expect(k.seq).toBeGreaterThan(lastSeq); lastSeq = k.seq; } // no synthetic steps
      const s = m.tick(new Map([[1, { ...NO_INPUT }]]), new Map([[1, cmds]]));
      snaps.push({ at: tick + 4, s });
      for (const r of snaps.filter((r) => r.at <= tick)) {
        pr.onSnapshot(r.s);
        const ack = me(r.s).mv!.ack;
        const p = predictedAt.get(ack);
        if (p) { const e = d3(p, me(r.s).pos); maxErr = Math.max(maxErr, e); if (e > 1e-3) off++; compared++; }
      }
      snaps.splice(0, snaps.length, ...snaps.filter((r) => r.at > tick));
    }
    expect(compared).toBeGreaterThan(200);
    // Rapier is f32 and its query tree depends on update history, so a rewind can differ from the
    // original run by float noise that contacts occasionally amplify to ~cm; never more.
    console.info(`[predict] ${compared} acks compared, ${off} off by >1 mm, max ${(maxErr * 100).toFixed(2)} cm`);
    expect(off / compared).toBeLessThan(0.15);
    expect(maxErr).toBeLessThan(0.1);
    expect(pr.stats.snaps).toBe(0);
    // Actually moved (and jumped) — not a vacuous pass.
    expect(d3(me(m.tick(new Map())).pos, m.map[0].spawn)).toBeGreaterThan(3);
  });

  test('small corrections are blended out over ~100 ms', async () => {
    const { m, pr } = await setup();
    const out = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    const idle: MoveCmd = { seq: 0, moveX: 0, moveZ: 0, yaw: 0, jump: false, sprint: false };
    pr.renderState(idle, 0, 1 / 60, out);
    const shown = { ...out.pos };
    // Server says we're 0.3 m off (e.g. bumped by another player).
    const s = m.tick(new Map());
    const pushed = structuredClone(s);
    me(pushed).pos.x += 0.3;
    pr.onSnapshot(pushed);
    pr.renderState(idle, 0, 1e-6, out);
    expect(d3(out.pos, shown)).toBeLessThan(0.01); // no visible pop
    for (let i = 0; i < 6; i++) pr.renderState(idle, 0, 1 / 60, out); // 100 ms
    expect(Math.abs(out.pos.x - me(pushed).pos.x)).toBeLessThan(0.3 * 0.1);
    expect(pr.stats.snaps).toBe(0);
  });

  test('big errors (teleport/respawn) snap immediately', async () => {
    const { m, pr } = await setup();
    const far = { ...m.map[0].center, y: m.map[0].groundY };
    m.debugTeleport(1, far);
    const s = m.tick(new Map());
    expect(d3(me(s).pos, pr.current!.pos)).toBeGreaterThan(SNAP_DIST);
    pr.onSnapshot(s);
    const out = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    pr.renderState({ seq: 0, moveX: 0, moveZ: 0, yaw: 0, jump: false, sprint: false }, 0, 1 / 60, out);
    expect(d3(out.pos, me(s).pos)).toBeLessThan(0.05);
    expect(pr.stats.snaps).toBe(1);
  });

  test('death turns prediction off; it resumes on respawn', async () => {
    const { m, pr } = await setup();
    m.debugKill(1);
    pr.onSnapshot(m.tick(new Map()));
    expect(pr.active).toBe(false);
    let s = m.tick(new Map());
    for (let i = 0; i < 200 && !me(s).alive; i++) s = m.tick(new Map());
    pr.onSnapshot(s);
    expect(pr.active).toBe(true);
    expect(d3(pr.current!.pos, me(s).pos)).toBeLessThan(1e-6);
  });

  test('a live (uncommitted) command moves the rendered position this frame', async () => {
    const { pr, yaw0 } = await setup();
    const out = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    const live: MoveCmd = { seq: 1, moveX: 0, moveZ: 1, yaw: yaw0, jump: false, sprint: false };
    pr.renderState(live, 0, 1 / 60, out);
    const a = { ...out.pos };
    pr.renderState(live, 0.5, 1 / 60, out);
    expect(d3(out.pos, a)).toBeGreaterThan(0.005);
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeGreaterThan(0.5);
  });
});
