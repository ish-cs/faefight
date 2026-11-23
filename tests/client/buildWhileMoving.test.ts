import { describe, expect, test } from 'vitest';
import { BuildPredictor, REJECT_MS } from '../../src/client/buildPredict';
import { MoveQueue } from '../../src/client/moveQueue';
import { Predictor } from '../../src/client/predict';
import { validatePlacement } from '../../src/sim/building';
import { DT, PIECES, PLAYER } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { MoveCmd } from '../../src/sim/movement';
import { NO_INPUT, type BuildRequest, type PieceKind, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

// Placing while running, then walking straight onto the piece: the client shows the piece (and its predicted player
// collides with it) at once, so the host must place it at the very spot, from the very position, the client
// validated. Before BuildRequest.seq the host validated after whatever batch of moves it got that tick, a few steps
// ahead or behind: a ramp/deck refused as 'blocked' (we had run into its footprint) or 'too far', which the client
// still showed for a second and let us stand on, then we fell through it (the user's "it looks placed but I fall").

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };
const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;
const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

type Plan = (tick: number, at: Vec3, yaw: number) => BuildRequest | null;

/**
 * Client (Predictor + BuildPredictor, the main.ts flow) and host (Match + MoveQueue) over a jittery link: commands
 * leave every tick and arrive 2-6 ticks later in bursts; snapshots come back 3 ticks later.
 * `plan` may ask to place at the predicted position; `move` gives the movement for each tick.
 */
async function run(opts: {
  kind: PieceKind; n: number; ticks: number; give?: number;
  stand: (m: Match) => Vec3; move: (tick: number) => Partial<MoveCmd>; plan: Plan; yaw: (m: Match) => number;
  hostOnly?: (m: Match) => void;
  /** The old protocol (no BuildRequest.seq): the host places after whatever moves it got that tick. */
  noSeq?: boolean;
  /** Commands leave in bursts of 3 (a slow input rate, or a stalled link catching up): the host moves 3 steps at once. */
  bursty?: boolean;
}) {
  const m = await Match.create(humans);
  m.debugTeleport(1, opts.stand(m));
  if (opts.give !== 0) m.debugGive(1, { pieces: { [opts.kind]: opts.give ?? opts.n } });
  const s0 = m.tick(new Map());
  opts.hostOnly?.(m);
  const pr = await Predictor.create(m.def, 1);
  pr.onSnapshot(s0);
  const builds = new BuildPredictor();
  const q = new MoveQueue();
  const yaw = opts.yaw(m);
  const sent: { at: number; c: MoveCmd; build: BuildRequest | null }[] = [];
  const back: { at: number; s: Snapshot }[] = [];
  let latest = s0, seq = 0, last = 0, s = s0;
  const out = { placed: 0, placedAtMs: [] as number[], refused: 0, refusedAtMs: [] as number[], maxErr: 0, predicted: [] as Vec3[], maxHostY: -Infinity, maxPredY: -Infinity };
  const predictedAt = new Map<number, Vec3>();
  for (let tick = 1; tick <= opts.ticks; tick++) {
    const nowMs = tick * DT * 1000;
    let build: BuildRequest | null = null;
    const cur = pr.current?.pos;
    if (cur && out.placed < opts.n && builds.canPlace(nowMs)) {
      const want = opts.plan(tick, cur, yaw);
      if (want) {
        const v = validatePlacement(pr.world, want.kind, want.pos, want.rotY, cur);
        if (v.ok) {
          build = opts.noSeq ? want : { ...want, seq };
          const afterId = latest.pieces.reduce((a, p) => Math.max(a, p.id), 0);
          pr.addLocalPiece(builds.place(want.kind, v.pos, want.rotY, 1, nowMs, afterId, opts.noSeq ? undefined : seq));
          out.predicted.push(v.pos);
          out.placedAtMs.push(nowMs);
          out.placed++;
        }
      }
    }
    const c: MoveCmd = { seq: ++seq, moveX: 0, moveZ: 0, yaw, jump: false, sprint: false, ...opts.move(tick) };
    pr.step(c);
    predictedAt.set(c.seq, { ...pr.current!.pos });
    last = opts.bursty ? Math.ceil((tick + 3) / 3) * 3 : Math.max(last, tick + 3 + (tick % 4 === 1 ? 2 : 0)); // ordered, jittery link (as predict.test.ts)
    sent.push({ at: last, c, build });
    // Host
    const arrived = sent.filter((x) => x.at <= tick);
    sent.splice(0, sent.length, ...sent.filter((x) => x.at > tick));
    q.push(arrived.map((x) => x.c));
    const b = arrived.map((x) => x.build).filter((x) => x).pop() ?? null;
    s = m.tick(new Map([[1, { ...NO_INPUT, yaw, build: b }]]), new Map([[1, q.take({ moveX: 0, moveZ: 0, yaw, sprint: false })]]));
    back.push({ at: tick + 3, s });
    for (const x of back.filter((x) => x.at <= tick)) {
      const mine = me(x.s);
      const refused = builds.refusedBy(x.s.pieces, mine.mv!.ack, mine.busyUntil > x.s.time, nowMs);
      for (const p of refused) { pr.removeLocalPiece(p.id); out.refused++; out.refusedAtMs.push(nowMs); }
      pr.onSnapshot(x.s);
      latest = x.s;
      const r = builds.reconcile(x.s.pieces, nowMs);
      for (const p of [...r.confirmed, ...r.rejected]) pr.removeLocalPiece(p.id);
      out.refused += r.rejected.length;
      const p = predictedAt.get(mine.mv!.ack);
      if (p) out.maxErr = Math.max(out.maxErr, d3(p, mine.pos));
    }
    back.splice(0, back.length, ...back.filter((x) => x.at > tick));
    out.maxHostY = Math.max(out.maxHostY, me(s).pos.y);
    if (pr.current) out.maxPredY = Math.max(out.maxPredY, pr.current.pos.y);
  }
  if (process.env.BWM_DEBUG) console.log(JSON.stringify({ ...out, host: s.pieces.filter((p) => p.owner === 1).map((p) => p.pos), g: m.map[0].groundY, hostEnd: me(s).pos, predEnd: pr.current?.pos }));
  return { m, s, pr, builds, out, host: s.pieces.filter((p) => p.owner === 1 && p.kind === opts.kind) };
}

const lane = (m: Match, yawOff: number, d: number, side = 0) => {
  const isl = m.map[0], yaw = isl.bunker.facingYaw + yawOff;
  const p = add(add(isl.center, scale(forward(yaw), d)), scale(right(yaw), side));
  return v3(p.x, isl.groundY, p.z);
};

/** A piece `ahead` m in front of the predicted feet, along the run; ramps turned so their high end is ahead. */
const ahead = (kind: PieceKind, ahead: number, yOff = 0): Plan => (tick, at, yaw) => {
  if (tick < 8) return null;
  const c = add(at, scale(forward(yaw), ahead));
  return { kind, pos: v3(c.x, at.y + yOff, c.z), rotY: kind === 'ramp' ? yaw + Math.PI : yaw, free: true };
};
const sideways = (m: Match) => m.map[0].bunker.facingYaw + Math.PI / 2; // over open ground toward the shore
const start = (d: number) => (m: Match) => lane(m, Math.PI / 2, d);

describe('placing while moving: the host places exactly what the client showed', () => {
  // A ramp's low end just in front of us (0.25 m clear of the body) while sprinting at it, over a link that delivers
  // commands 3 at a time: valid where the client stands, but the host (old protocol) checks it 2 steps further on,
  // inside its footprint.
  const rampRun = { kind: 'ramp' as const, n: 1, ticks: 75, stand: start(2), yaw: sideways, bursty: true,
    move: (t: number) => ({ moveZ: t < 40 ? 1 : 0, sprint: true }), plan: ahead('ramp', PIECES.ramp.d / 2 + PLAYER.radius + 0.25) };

  test('a ramp placed while sprinting, then straight up it: same spot on host and client, no refusal, we climb it', async () => {
    const r = await run(rampRun);
    expect(r.out.placed).toBe(1);
    expect(r.out.refused).toBe(0);
    expect(r.host).toHaveLength(1);
    expect(d3(r.host[0].pos, r.out.predicted[0])).toBeLessThan(1e-9);
    const g = r.m.map[0].groundY;
    expect(r.out.maxHostY - g).toBeGreaterThan(1.0); // ran up it on the host...
    expect(r.out.maxPredY - g).toBeGreaterThan(1.0); // ...and in prediction
    expect(r.out.maxErr).toBeLessThan(0.1);
    expect(r.pr.stats.snaps).toBe(0); // no rubber-band
  });

  test('the old protocol (no seq) gets that same ramp wrong: the host, already in its footprint, moves or refuses it', async () => {
    const r = await run({ ...rampRun, noSeq: true });
    expect(r.out.placed).toBe(1);
    // Refused (client shows it, then it's gone), or nudged clear of the host's body: not where the client showed it.
    const where = r.host.length ? d3(r.host[0].pos, r.out.predicted[0]) : Infinity;
    expect(where).toBeGreaterThan(0.1);
  });

  for (const kind of ['scaffold', 'sandbags', 'wood'] as PieceKind[]) {
    test(`${kind}: a row placed while walking, each where the client showed it, none refused`, async () => {
      const r = await run({ kind, n: 3, ticks: 150, stand: start(-6), yaw: sideways, move: (t) => ({ moveZ: t < 120 ? 1 : 0 }),
        plan: (tick, at, yaw) => {
          const p = ahead(kind, 3.4)(tick, at, yaw);
          return p && { ...p, pos: add(p.pos, scale(right(yaw), 2.5)) }; // beside the path: walls don't block the run
        } });
      expect(r.out.placed).toBe(3);
      expect(r.out.refused).toBe(0);
      expect(r.host).toHaveLength(3);
      r.out.predicted.forEach((p) => expect(r.host.some((h) => d3(h.pos, p) < 1e-9)).toBe(true));
      expect(r.out.maxErr).toBeLessThan(0.1);
    });
  }

  const deckRun = { kind: 'scaffold' as const, n: 1, ticks: 90, stand: start(2), yaw: sideways,
    move: (t: number) => ({ moveZ: t < 30 ? 1 : 0 }), plan: ahead('scaffold', PIECES.scaffold.d / 2 + PLAYER.radius + 0.4) };

  test('a scaffold placed just ahead while walking, then onto it: host and prediction both stand on it', async () => {
    const r = await run(deckRun);
    expect(r.out.refused).toBe(0);
    expect(d3(r.host[0].pos, r.out.predicted[0])).toBeLessThan(1e-9);
    const top = r.host[0].pos.y + PIECES.scaffold.h;
    expect(Math.abs(me(r.s).pos.y - top)).toBeLessThan(0.05);
    expect(Math.abs(r.pr.current!.pos.y - top)).toBeLessThan(0.05);
    expect(r.out.maxErr).toBeLessThan(0.1);
  });

  test('host refusal: the piece is dropped within a round trip, and from then on we are not standing on it', async () => {
    // The host has none to place (the client thinks it does): refused. We walk onto where it showed.
    const r = await run({ ...deckRun, give: 0 });
    expect(r.out.placed).toBe(1);
    expect(r.host).toHaveLength(0);
    expect(r.out.refused).toBe(1);
    expect(r.out.refusedAtMs[0] - r.out.placedAtMs[0]).toBeLessThan(400); // one round trip, well before REJECT_MS
    expect(REJECT_MS).toBeGreaterThan(400);
    expect(r.builds.pieces).toHaveLength(0);
    const g = r.m.map[0].groundY;
    expect(me(r.s).pos.y - g).toBeLessThan(0.05); // host: on the ground
    expect(Math.abs(r.pr.current!.pos.y - me(r.s).pos.y)).toBeLessThan(0.01); // prediction agrees
    expect(r.pr.stats.snaps).toBe(0); // a small correction, not a snap
  });
});
