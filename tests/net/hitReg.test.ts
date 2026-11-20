import { describe, expect, test } from 'vitest';
import { InputAccumulator } from '../../src/client/inputAccum';
import { PlayerTrack, RenderClock } from '../../src/client/interp';
import { SimPipe } from '../../src/net/netSim';
import { SnapRate } from '../../src/net/snapRate';
import { SnapshotDecoder, SnapshotEncoder, type NetSnapshot } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder, wireHeader } from '../../src/net/wire';
import { DT, PLAYER } from '../../src/sim/constants';
import { LAG_COMP } from '../../src/sim/lagComp';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type PlayerInput, type Vec3 } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

/**
 * Hit registration end to end, in simulated time: host Match + snapshot pipeline (encoder → binary
 * delta wire → simulated network) → client (decode → adaptive render clock → Hermite tracks), which
 * aims exactly at the target's chest as drawn on its screen and fires; its input goes back over the
 * simulated network. Counts how many of those on-screen hits the host registers.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

function fakeClock() {
  let t = 0, seq = 0;
  const q: { at: number; seq: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { q.push({ at: t + ms, seq: seq++, fn }); q.sort((a, b) => a.at - b.at || a.seq - b.seq); },
    runUntil(until: number) { while (q.length && q[0].at <= until) { const e = q.shift()!; t = e.at; e.fn(); } t = until; },
  };
}

export async function hitReg(opts: { rttMs: number; jitterMs: number; loss: number; lagComp: boolean; shots: number; seed?: number }) {
  const rand = rng(opts.seed ?? 11);
  const clock = fakeClock();
  const net = { rttMs: opts.rttMs, jitterMs: opts.jitterMs, loss: opts.loss, random: rand, now: clock.now, setTimer: clock.setTimer };
  const m = await Match.create({ players: [{ name: 'shooter', isBot: false }, { name: 'target', isBot: false }], seed: 5 });
  const isl = m.map[0];
  // An open lane: nothing static between the shooter's eye and any point of the target's strafe line.
  const physics = (m as unknown as { physics: { raycastStatic(o: Vec3, d: Vec3, max: number): unknown } }).physics;
  const laneClear = (lz: number) => {
    for (let k = -4.5; k <= 4.5; k += 0.25) for (const h of [0.3, 1.2, 1.7]) {
      const o = v3(isl.center.x - 7, isl.groundY + PLAYER.eyeHeight, isl.center.z + lz);
      const t = v3(isl.center.x + 8, isl.groundY + h, isl.center.z + lz + k);
      const d = v3(t.x - o.x, t.y - o.y, t.z - o.z), L = Math.hypot(d.x, d.y, d.z);
      const hit = physics.raycastStatic(o, v3(d.x / L, d.y / L, d.z / L), L);
      if (hit) return false;
    }
    return true;
  };
  const laneZ = [14, -14, 16, -16, 12, -12, 2].find(laneClear);
  if (laneZ === undefined) throw new Error('hitReg: no open lane on island 0');
  const shooterFeet = v3(isl.center.x - 7, isl.groundY, isl.center.z + laneZ);
  m.debugTeleport(1, shooterFeet);
  m.debugGive(1, { weapons: { rifle: { mag: 25, spare: 900 } } });
  let snap = m.tick(new Map());
  const slot = snap.players[0].hotbar.indexOf('rifle');

  // Target strafes across the line of fire at ~5.5 m/s, reversing at random every 0.25–0.8 s (hard to track).
  let tz = 0, dir = 1, nextFlip = 0.5;
  const targetStep = (t: number) => {
    if (t >= nextFlip) { dir = -dir; nextFlip = t + 0.25 + rand() * 0.55; }
    tz = Math.max(-4, Math.min(4, tz + dir * 5.5 * DT));
    if (Math.abs(tz) >= 4) dir = -Math.sign(tz);
    return v3(isl.center.x + 8, isl.groundY, isl.center.z + laneZ + tz);
  };

  // Host: inputs arrive over the network into the accumulator; snapshots go out through the wire codec.
  const acc = new InputAccumulator();
  let ack = 0;
  const toHost = new SimPipe(net, (msg) => { const x = msg as { input: PlayerInput; ack: number }; acc.push(x.input); ack = x.ack; });
  const enc = new SnapshotEncoder(), wire = new WireEncoder(), rate = new SnapRate();
  // Client.
  const wdec = new WireDecoder(), sdec = new SnapshotDecoder();
  const rclock = new RenderClock();
  const track = new PlayerTrack();
  const toClient = new SimPipe(net, (msg) => {
    const n = wdec.decode<NetSnapshot>(msg as ArrayBuffer);
    if (!n) return;
    const s = sdec.decode(n);
    rclock.push(s.time, clock.now() / 1000);
    const p = s.players.find((q) => q.id === 2)!;
    track.push({ t: s.time, pos: p.pos, yaw: p.yaw, pitch: p.pitch });
  });

  let shotsFired = 0, tick = 0;
  const hostTick = () => {
    m.debugTeleport(2, targetStep(snap.time + DT));
    snap = m.tick(new Map([[1, acc.take()]]));
    if (ack) wire.ack(ack);
    enc.push(snap);
    if (rate.due(tick++)) {
      const b = wire.encode(snap.tick, enc.take(1, true));
      rate.sent(b.byteLength, wireHeader(b).baseSeq === 0);
      toClient.push(b);
    }
    clock.setTimer(hostTick, 1000 / 30);
  };
  clock.setTimer(hostTick, 1000 / 30);

  // Client frames at 60 Hz; input sent at 30 Hz; fires every 0.5 s at the target as it is drawn.
  const sendAcc = new InputAccumulator();
  let nextSend = 0, nextShot = 1500;
  const seen = { pos: v3(), vel: v3(), yaw: 0, pitch: 0 };
  const aim = { yaw: 0, pitch: 0 }; // held between shots, like a real mouse
  const frame = () => {
    const now = clock.now();
    const playT = rclock.advance(now / 1000);
    let input: PlayerInput = { ...NO_INPUT, select: slot, ads: true, ...aim };
    if (playT !== null && track.sample(playT, seen) && now >= nextShot && shotsFired < opts.shots) {
      const eyeY = shooterFeet.y + PLAYER.eyeHeight;
      const dx = seen.pos.x - shooterFeet.x, dy = seen.pos.y + 1.25 - eyeY, dz = seen.pos.z - shooterFeet.z;
      aim.yaw = Math.atan2(-dx, -dz);
      aim.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      // What's on screen is never newer than the newest snapshot (past it the track extrapolates/holds).
      input = { ...input, ...aim, fire: true, ...(opts.lagComp ? { viewT: Math.min(playT, track.newest!.t) } : {}) };
      shotsFired++;
      nextShot = now + 500;
    }
    sendAcc.push(input);
    if (now >= nextSend) { toHost.push({ input: sendAcc.take(), ack: wdec.ack }); nextSend += 1000 / 30; }
    clock.setTimer(frame, 1000 / 60);
  };
  clock.setTimer(frame, 1000 / 60);

  const hits: number[] = [];
  let shots = 0;
  const origTick = m.tick.bind(m);
  m.tick = (inputs, moves) => {
    const s = origTick(inputs, moves);
    for (const e of s.events) {
      if (e.type === 'shot' && e.data.by === 1) shots++;
      if (e.type === 'hit' && e.data.by === 1 && e.data.target === 2) hits.push(1);
    }
    return s;
  };
  // Keep the target alive: top it up so a long run measures registration, not deaths.
  let doneAt = Infinity;
  for (let ms = 0; ms < doneAt; ms += 100) {
    clock.runUntil(ms);
    m.debugSetHp(2, 100);
    if (shotsFired >= opts.shots && doneAt === Infinity) doneAt = ms + 1000;
    if (ms > 600_000) throw new Error(`hitReg: did not finish (fired ${shotsFired}, shots ${shots}, hits ${hits.length}, tick ${snap.tick}, ack ${ack}, decoded ${wdec.ack})`);
  }
  return { fired: shots, registered: hits.length, rate: hits.length / shots, rewound: m.lagStats.shots, avgRewindMs: (1000 * m.lagStats.rewindSec) / Math.max(1, m.lagStats.shots) };
}

describe('hit registration under latency (simulated network, full snapshot pipeline)', () => {
  test('120 ms RTT + 20 ms jitter: on-screen hits register with lag compensation, mostly miss without', async () => {
    const on = await hitReg({ rttMs: 120, jitterMs: 20, loss: 0, lagComp: true, shots: 40 });
    const off = await hitReg({ rttMs: 120, jitterMs: 20, loss: 0, lagComp: false, shots: 40 });
    if (env.BENCH) console.log(`[hitreg] 120ms rtt: lagComp ${(on.rate * 100).toFixed(0)}% (avg rewind ${on.avgRewindMs.toFixed(0)} ms), none ${(off.rate * 100).toFixed(0)}%`);
    expect(on.rate).toBeGreaterThanOrEqual(0.95);
    expect(off.rate).toBeLessThan(0.6);
    expect(on.rewound).toBeGreaterThanOrEqual(on.fired);
  });

  test('150 ms RTT with 2% loss (retransmits) still registers', async () => {
    const on = await hitReg({ rttMs: 150, jitterMs: 30, loss: 0.02, lagComp: true, shots: 40 });
    if (env.BENCH) console.log(`[hitreg] 150ms rtt 2% loss: lagComp ${(on.rate * 100).toFixed(0)}% (avg rewind ${on.avgRewindMs.toFixed(0)} ms)`);
    expect(on.rate).toBeGreaterThanOrEqual(0.9);
  });

  test.runIf(env.BENCH)('table', async () => {
    for (const max of [0.4, 0.6, 1.0]) {
      const keep = LAG_COMP.maxRewindSec, keepH = LAG_COMP.historySec;
      LAG_COMP.maxRewindSec = max; LAG_COMP.historySec = max + 0.2;
      const on = await hitReg({ rttMs: 150, jitterMs: 30, loss: 0.02, lagComp: true, shots: 60 });
      LAG_COMP.maxRewindSec = keep; LAG_COMP.historySec = keepH;
      console.log(`[hitreg] 150ms 2% loss, maxRewind ${max}: ${(on.rate * 100).toFixed(0)}%`);
    }
    for (const rtt of [0, 50, 100, 150, 200]) {
      const on = await hitReg({ rttMs: rtt, jitterMs: 20, loss: 0, lagComp: true, shots: 60 });
      const off = await hitReg({ rttMs: rtt, jitterMs: 20, loss: 0, lagComp: false, shots: 60 });
      console.log(`[hitreg] rtt ${rtt} ms: with rewind ${(on.rate * 100).toFixed(0)}% (avg ${on.avgRewindMs.toFixed(0)} ms), without ${(off.rate * 100).toFixed(0)}%`);
    }
  }, 300_000);
});
