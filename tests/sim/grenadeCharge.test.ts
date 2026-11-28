import { beforeAll, describe, expect, test } from 'vitest';
import { predictThrow, throwGrenade, throwSpeed, throwUtility, tickExplosives, type CombatCtx } from '../../src/sim/combat';
import { Physics } from '../../src/sim/physics';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import { FLASH, GRENADE, SMOKE, THROW } from '../../src/sim/constants';
import { NO_INPUT, type MatchEvent, type PieceState, type PlayerInput, type Snapshot, type Vec3 } from '../../src/sim/types';
import { Match } from '../../src/sim/match';
import { sanitizeInput } from '../../src/net/sanitize';
import { decodeReplay } from '../../src/sim/replay/codec';
import { stateHash } from '../../src/sim/replay/hash';
import { Recorder } from '../../src/sim/replay/recorder';
import { ReplayRunner } from '../../src/sim/replay/runner';

// Impact detonation + charged throws (combat.ts throwGrenade / tickExplosives / predictThrow).

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
  const b = newPlayer(2, 'b', false, 0, spot(30, 12));
  a.yaw = yaw();
  for (const p of [a, b]) physics.addPlayer(p.id, p.pos);
  let id = 100;
  const ctx: CombatCtx = {
    physics, players: new Map([[1, a], [2, b]]), pieces: new Map(), explosives: [], smokes: [], nextId: () => id++,
    onPieceDestroyed: (pid) => { ctx.pieces.delete(pid); physics.removePiece(pid); }, onKill: () => {},
  };
  return { ctx, a, b };
}

/** Ticks until the first explosion-like event; returns it with the tick time. */
function runUntilPop(ctx: CombatCtx, maxSec = 6): { e: MatchEvent; t: number } | null {
  for (let i = 1; i <= maxSec * 30; i++) {
    const t = i / 30;
    const ev = tickExplosives(ctx, t).find((x) => x.type === 'explosion' || x.type === 'smoke' || x.type === 'flash');
    if (ev) return { e: ev, t };
  }
  return null;
}

describe('charged throw curve', () => {
  test('speed rises from min to max with power and caps; no power = legacy speed', () => {
    expect(throwSpeed('grenade', 0)).toBe(THROW.minSpeed);
    expect(throwSpeed('grenade', 1)).toBe(THROW.maxSpeed);
    expect(throwSpeed('grenade', 5)).toBe(THROW.maxSpeed); // capped
    expect(throwSpeed('grenade', -1)).toBe(THROW.minSpeed);
    expect(throwSpeed('grenade', 0.5)).toBeCloseTo((THROW.minSpeed + THROW.maxSpeed) / 2, 6);
    expect(throwSpeed('grenade', undefined)).toBe(GRENADE.throwSpeed);
    expect(throwSpeed('smoke', undefined)).toBe(SMOKE.throwSpeed);
    expect(throwSpeed('flash', undefined)).toBe(FLASH.throwSpeed);
    expect(THROW.chargeSec).toBeGreaterThanOrEqual(1);
    expect(THROW.chargeSec).toBeLessThanOrEqual(1.2);
  });
  test('a full charge throws much further than a tap', async () => {
    const far: number[] = [];
    for (const power of [0, 1]) {
      const { ctx, a } = await setup();
      a.inv.grenades = 1;
      a.pitch = 0.5;
      throwGrenade(ctx, a, 0, power);
      const pop = runUntilPop(ctx)!;
      const p = pop.e.data.pos as Vec3;
      far.push(Math.hypot(p.x - a.pos.x, p.z - a.pos.z));
    }
    expect(far[1]).toBeGreaterThan(far[0] * 2.5);
  });
});

describe('impact detonation', () => {
  test('frag explodes the tick it hits the floor (well before the fuse fallback)', async () => {
    const { ctx, a } = await setup();
    a.inv.grenades = 1;
    a.pitch = -0.6;
    throwGrenade(ctx, a, 0, 0.3);
    const pop = runUntilPop(ctx)!;
    expect(pop.e.type).toBe('explosion');
    expect(pop.t).toBeLessThan(1);
    const p = pop.e.data.pos as Vec3;
    expect(Math.abs(p.y - isl().groundY)).toBeLessThan(0.2); // on the ground
  });
  test('frag explodes on hitting a wall', async () => {
    const { ctx, a } = await setup();
    const wall: PieceState = { id: 9, kind: 'steel', owner: 2, pos: spot(7), rotY: yaw(), hp: 1200 };
    ctx.pieces.set(9, wall);
    ctx.physics.addPiece(wall);
    a.inv.grenades = 1;
    a.pitch = 0.05;
    throwGrenade(ctx, a, 0, 1);
    const pop = runUntilPop(ctx)!;
    expect(pop.t).toBeLessThan(0.5);
    const p = pop.e.data.pos as Vec3;
    expect(Math.hypot(p.x - a.pos.x, p.z - a.pos.z)).toBeLessThan(3.3); // at the wall face, 3 m ahead
    expect(p.y).toBeGreaterThan(isl().groundY + 0.5); // in the air against the wall, not on the floor
  });
  test('fuse fallback: thrown straight up off the map edge it still goes off by fuseSec', async () => {
    const { ctx, a } = await setup();
    a.pos = v3(5000, 50, 5000); // nowhere near anything: no floor, no water hit before the fuse
    a.inv.grenades = 1;
    a.pitch = 1.3;
    throwGrenade(ctx, a, 0, 1);
    const pop = runUntilPop(ctx)!;
    expect(pop.t).toBeCloseTo(THROW.fuseSec, 1);
  });
  test('lands in the sea: goes off at the water surface', async () => {
    const { ctx, a } = await setup();
    a.pos = v3(5000, 3, 5000);
    a.inv.grenades = 1;
    a.pitch = 0.3;
    throwGrenade(ctx, a, 0, 0.5);
    const pop = runUntilPop(ctx)!;
    expect(pop.t).toBeLessThan(THROW.fuseSec - 0.5);
    expect((pop.e.data.pos as Vec3).y).toBeCloseTo(0, 1);
  });
  test('smoke deploys on landing; flash pops on impact', async () => {
    for (const kind of ['smoke', 'flash'] as const) {
      const { ctx, a } = await setup();
      if (kind === 'smoke') a.inv.smokes = 1; else a.inv.flashes = 1;
      a.pitch = -0.7;
      throwUtility(ctx, a, kind, 0, 0.2);
      const pop = runUntilPop(ctx)!;
      expect(pop.e.type).toBe(kind);
      expect(pop.t).toBeLessThan(0.7);
    }
  });
  test('all three share one fallback fuse when they never touch anything', async () => {
    for (const kind of ['grenade', 'smoke', 'flash'] as const) {
      const { ctx, a } = await setup();
      a.pos = v3(5000, 50, 5000);
      a.inv.grenades = 1; a.inv.smokes = 1; a.inv.flashes = 1;
      a.pitch = 1.3;
      if (kind === 'grenade') throwGrenade(ctx, a, 0, 1); else throwUtility(ctx, a, kind, 0, 1);
      const pop = runUntilPop(ctx)!;
      expect(pop.t).toBeCloseTo(THROW.fuseSec, 1);
    }
  });
});

describe('preview = sim', () => {
  test('predictThrow lands exactly where the real grenade explodes', async () => {
    for (const [pitch, power] of [[0.4, 0.8], [-0.3, 0.1], [0.9, 1]] as const) {
      const { ctx, a } = await setup();
      a.inv.grenades = 1;
      a.pitch = pitch;
      const pts = new Float32Array(3 * 200);
      const pred = predictThrow(ctx.physics, a, 'grenade', power, pts);
      throwGrenade(ctx, a, 0, power);
      const pop = runUntilPop(ctx)!;
      const p = pop.e.data.pos as Vec3;
      expect(pred.hit).toBe(true);
      expect(Math.abs(pred.end.x - p.x)).toBeLessThan(1e-4);
      expect(Math.abs(pred.end.y - p.y)).toBeLessThan(1e-4);
      expect(Math.abs(pred.end.z - p.z)).toBeLessThan(1e-4);
      expect(pred.count).toBeGreaterThan(2);
    }
  });
});

describe('determinism / replay (match level)', () => {
  const script = (t: number): PlayerInput | null =>
    t === 10 ? { ...NO_INPUT, pitch: 0.3, throwGrenade: true, throwPower: 0.85 } :
    t === 40 ? { ...NO_INPUT, yaw: 3.1, pitch: -0.2, throwUtil: 'flash', throwPower: 0.25 } :
    t === 70 ? { ...NO_INPUT, yaw: 1.5, pitch: 0.2, throwUtil: 'smoke', throwPower: 1 } : null;

  test('sanitize clamps throwPower and drops junk', () => {
    expect(sanitizeInput({ ...NO_INPUT, throwPower: 0.4 })!.throwPower).toBe(0.4);
    expect(sanitizeInput({ ...NO_INPUT, throwPower: 7 })!.throwPower).toBe(1);
    expect(sanitizeInput({ ...NO_INPUT, throwPower: 'x' })!.throwPower).toBeUndefined();
    expect(sanitizeInput({ ...NO_INPUT, throwPower: NaN })!.throwPower).toBeUndefined();
  });

  test('two runs + a fork agree; a recorded replay keeps throwPower and re-runs without diverging', async () => {
    const setup = { players: [{ name: 'p1', isBot: false }, { name: 'p2', isBot: false }], map: 'harbor' as const, seed: 7 };
    const give = { grenades: 1, smokes: 1, flashes: 1 };
    const run = async (forkAt?: number) => {
      const m = await Match.create(setup);
      m.debugGive(1, give);
      let live = m;
      const hashes: number[] = [];
      let booms = 0;
      for (let t = 0; t < 160; t++) {
        if (t === forkAt) live = live.fork();
        const inp = script(t);
        const s = live.tick(inp ? new Map([[1, inp]]) : new Map());
        booms += s.events.filter((e) => e.type === 'explosion' || e.type === 'flash' || e.type === 'smoke').length;
        hashes.push(stateHash(s));
      }
      return { hashes, booms };
    };
    const a = await run(), b = await run(), c = await run(25);
    expect(a.booms).toBe(3);
    expect(b.hashes).toEqual(a.hashes);
    expect(c.hashes).toEqual(a.hashes);

    const m = await Match.create(setup);
    const rec = new Recorder(m, { setup, kind: 'test', localId: 1, recordedAt: 0, id: 'g' });
    rec.tick(new Map());
    m.debugGive(1, give); rec.op({ k: 'give', id: 1, inv: give });
    for (let t = 1; t < 160; t++) { const inp = script(t); rec.tick(inp ? new Map([[1, inp]]) : new Map()); }
    const out = await rec.finish();
    m.dispose();
    const replay = await decodeReplay(out.bytes);
    expect(replay.ticks.some((tk) => JSON.stringify(tk).includes('"throwPower":0.85'))).toBe(true);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    let booms = 0;
    let snap: Snapshot | null;
    while ((snap = runner.step())) booms += snap.events.filter((e) => e.type === 'explosion' || e.type === 'flash' || e.type === 'smoke').length;
    expect(booms).toBe(3);
    expect(runner.divergedAt).toBeNull();
    runner.dispose();
  });
});
