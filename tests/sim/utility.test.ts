import { describe, expect, test } from 'vitest';
import { FLASH, PLAYER, SMOKE } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { Physics } from '../../src/sim/physics';
import { buy } from '../../src/sim/economy';
import { decodeReplay, encodeReplay } from '../../src/sim/replay/codec';
import { stateHash } from '../../src/sim/replay/hash';
import { Recorder } from '../../src/sim/replay/recorder';
import { ReplayRunner } from '../../src/sim/replay/runner';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder } from '../../src/net/wire';
import { sanitizeInput } from '../../src/net/sanitize';
import {
  distanceFactor, facingFactor, flashAlpha, inSmoke, smokeBlocks, smokeChord, smokeDensity, smokeRadius,
} from '../../src/sim/utility';
import { NO_INPUT, type PlayerInput, type PlayerState, type SmokeCloud, type Snapshot, type Vec3 } from '../../src/sim/types';
import { v3, yawOf } from '../../src/sim/vec';

const cloud = (t0 = 0, pos = v3(0, 0, 0)): SmokeCloud => ({ id: 1, owner: 1, pos, t0 });

describe('smoke volume (pure)', () => {
  test('blooms over bloomSec to full radius, thick until the last thinSec, gone at lifeSec', () => {
    const c = cloud();
    expect(smokeRadius(c, 0)).toBeCloseTo(SMOKE.radius * 0.3);
    expect(smokeRadius(c, SMOKE.bloomSec)).toBeCloseTo(SMOKE.radius);
    expect(smokeRadius(c, 10)).toBeCloseTo(SMOKE.radius);
    expect(smokeDensity(c, 5)).toBe(1);
    expect(smokeDensity(c, SMOKE.lifeSec - SMOKE.thinSec / 2)).toBeCloseTo(0.5);
    expect(smokeDensity(c, SMOKE.lifeSec)).toBe(0);
  });

  test('a sight line through the middle is blocked; one beside it, or over the top, is not', () => {
    const c = cloud();
    const t = 5;
    const a = v3(-20, 1.6, 0), b = v3(20, 1.6, 0);
    expect(smokeChord(c, a, b, t)).toBeGreaterThan(2 * SMOKE.radius - 1);
    expect(smokeBlocks([c], a, b, t)).toBe(true);
    expect(smokeBlocks([c], v3(-20, 1.6, SMOKE.radius + 0.5), v3(20, 1.6, SMOKE.radius + 0.5), t)).toBe(false);
    expect(smokeBlocks([c], v3(-20, SMOKE.height + 1, 0), v3(20, SMOKE.height + 1, 0), t)).toBe(false);
    // A line that ends before reaching the cloud is clear.
    expect(smokeBlocks([c], a, v3(-SMOKE.radius - 1, 1.6, 0), t)).toBe(false);
    // Standing inside, nothing outside is visible.
    expect(inSmoke([c], v3(1, 1.6, 1), t)).toBe(true);
    expect(smokeBlocks([c], v3(0, 1.6, 0), b, t)).toBe(true);
  });

  test('a thinning cloud stops blocking before it is gone; a grazing edge never blocks', () => {
    const c = cloud();
    const a = v3(-20, 1.6, 0), b = v3(20, 1.6, 0);
    expect(smokeBlocks([c], a, b, SMOKE.lifeSec - 0.1)).toBe(false);
    // Chord of ~2 m near the rim: below blockM.
    const z = Math.sqrt(SMOKE.radius ** 2 - 1);
    expect(smokeBlocks([c], v3(-20, 1, z), v3(20, 1, z), 5)).toBe(false);
  });
});

describe('flash falloff (pure)', () => {
  test('facing it is full, side-on is partial, looking away is little', () => {
    expect(facingFactor(1)).toBe(1);
    expect(facingFactor(0.75)).toBe(1);
    expect(facingFactor(0)).toBeCloseTo(0.45);
    expect(facingFactor(-1)).toBeCloseTo(0.1);
    for (let c = -1; c < 1; c += 0.05) expect(facingFactor(c + 0.05)).toBeGreaterThanOrEqual(facingFactor(c));
  });
  test('distance: full close up, nothing past range, monotonic', () => {
    expect(distanceFactor(1)).toBe(1);
    expect(distanceFactor(FLASH.fullRange)).toBe(1);
    expect(distanceFactor(FLASH.range)).toBe(0);
    for (let d = 0; d < FLASH.range; d += 0.5) expect(distanceFactor(d + 0.5)).toBeLessThanOrEqual(distanceFactor(d));
  });
  test('durations: full white for holdSec, fading over fadeSec, monotonic (no strobe)', () => {
    const b = { at: 10, k: 1 };
    expect(flashAlpha(b, 10)).toBe(1);
    expect(flashAlpha(b, 10 + FLASH.holdSec)).toBe(1);
    expect(flashAlpha(b, 10 + FLASH.holdSec + FLASH.fadeSec / 2)).toBeCloseTo(0.5);
    expect(flashAlpha(b, 10 + FLASH.holdSec + FLASH.fadeSec)).toBe(0);
    let prev = 1;
    for (let t = 10; t < 15; t += 1 / 30) { const a = flashAlpha(b, t); expect(a).toBeLessThanOrEqual(prev); prev = a; }
    // A weak flash is shorter and dimmer.
    expect(flashAlpha({ at: 10, k: 0.2 }, 10)).toBeCloseTo(0.7);
    expect(flashAlpha({ at: 10, k: 0.2 }, 10 + 0.81 * 1)).toBe(0);
  });
});

async function match(n = 2, seed = 1) {
  return Match.create({ players: Array.from({ length: n }, (_, i) => ({ name: `p${i + 1}`, isBot: false })), map: 'harbor', seed });
}
const physicsOf = (m: Match) => (m as unknown as { physics: Physics }).physics;
const playerOf = (m: Match, id: number) => (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(id)!;
const ticks = (m: Match, sec: number, inputs = new Map<number, PlayerInput>()) => {
  const all: Snapshot[] = [];
  for (let i = 0; i < Math.round(sec * 30); i++) all.push(m.tick(inputs));
  return { last: all[all.length - 1], events: all.flatMap((s) => s.events), all };
};
function stand(m: Match, id: number, pos: Vec3, faceTo?: Vec3) {
  m.debugTeleport(id, pos);
  const p = playerOf(m, id);
  p.invulnUntil = 0;
  p.spawnProtected = false;
  if (faceTo) { p.yaw = yawOf({ x: faceTo.x - pos.x, z: faceTo.z - pos.z }); p.pitch = 0; }
}
/** Two open floor spots `gap` m apart on island 0 with a clear line between (eye to eye). */
function openPair(m: Match, gap: number): [Vec3, Vec3] {
  const isl = m.def.islands[0];
  const ph = physicsOf(m);
  for (let r = 2; r < isl.radius - 2; r += 0.5) for (let a = 0; a < 6.28; a += 0.2) {
    const x = isl.center.x + Math.cos(a) * r, z = isl.center.z + Math.sin(a) * r;
    const y = ph.isGroundAt(x, z), y2 = ph.isGroundAt(x + gap, z);
    if (y === null || y2 === null || Math.abs(y - y2) > 0.05) continue;
    const e = v3(x, y + PLAYER.eyeHeight, z);
    if (ph.raycastStatic(e, v3(1, 0, 0), gap, true)) continue;
    // Some room around the midpoint too (no wall a flash would hide behind).
    if (ph.raycastStatic(v3(x + gap / 2, y + 0.3, z - 2), v3(0, 0, 1), 4, true)) continue;
    return [v3(x, y, z), v3(x + gap, y2, z)];
  }
  throw new Error('no open pair');
}
const act = (m: Match, id: number, input: Partial<PlayerInput>) => m.tick(new Map([[id, { ...NO_INPUT, yaw: playerOf(m, id).yaw, pitch: playerOf(m, id).pitch, ...input }]]));

describe('flashbang in a match', () => {
  test('the thrower is immune; someone facing it is whited out, looking away barely', async () => {
    const m = await match(3);
    const [a, b] = openPair(m, 8);
    const mid = v3((a.x + b.x) / 2, a.y + 0.05, a.z);
    stand(m, 1, a, mid);
    stand(m, 2, b, mid); // facing the flash
    stand(m, 3, v3(b.x, b.y, b.z + 1.5), v3(b.x + 10, b.y, b.z + 1.5)); // looking away
    m.debugExplode('flash', mid, 1);
    const s = m.tick(new Map());
    const ev = s.events.find((e) => e.type === 'flash')!;
    expect(ev).toBeTruthy();
    expect(s.events.some((e) => e.type === 'explosion')).toBe(false);
    const p1 = s.players.find((p) => p.id === 1)!, p2 = s.players.find((p) => p.id === 2)!, p3 = s.players.find((p) => p.id === 3)!;
    expect(p1.blind).toBeUndefined();
    expect(p2.blind!.k).toBeGreaterThan(0.85);
    expect(p3.blind!.k).toBeLessThan(0.3);
    expect(flashAlpha(p2.blind, s.time)).toBe(1);
    // Nobody hurt by it.
    expect(p2.hp).toBe(100);
    // Worn off after hold + fade.
    const later = ticks(m, FLASH.holdSec + FLASH.fadeSec + 0.2);
    expect(later.last.players.find((p) => p.id === 2)!.blind).toBeUndefined();
  });

  test('a wall between the flash and your eyes blocks it; out of range does nothing', async () => {
    const m = await match(2);
    const [a, b] = openPair(m, 8);
    stand(m, 2, b, a);
    const far = v3(b.x - FLASH.range - 1, b.y + 1.5, b.z);
    m.debugExplode('flash', far, 1);
    expect(m.tick(new Map()).players.find((p) => p.id === 2)!.blind).toBeUndefined();
    // A steel plate right in front of player 2's face.
    const ph = physicsOf(m);
    const id = 9999;
    ph.addPiece({ id, kind: 'steel', owner: 1, pos: v3(b.x - 1.2, b.y, b.z), rotY: Math.PI / 2, hp: 1000 });
    m.debugExplode('flash', v3(a.x, a.y + 0.05, a.z), 1);
    expect(m.tick(new Map()).players.find((p) => p.id === 2)!.blind).toBeUndefined();
  });

  test('blinded bots see nobody (bot view)', async () => {
    const m = await match(2);
    const [a, b] = openPair(m, 8);
    stand(m, 1, a, b);
    stand(m, 2, b, a);
    m.tick(new Map());
    const view = () => (m as any).botView(playerOf(m, 2));
    expect(view().enemies.map((e: PlayerState) => e.id)).toContain(1);
    m.debugExplode('flash', v3((a.x + b.x) / 2, a.y + 0.05, a.z), 1);
    m.tick(new Map());
    expect(view().enemies).toHaveLength(0);
    expect(view().blind).toBe(true);
  });
});

describe('smoke grenade in a match', () => {
  test('thrown from the hotbar (throwUtil), pops into a cloud that hides players from bots, then clears', async () => {
    const m = await match(2);
    const [a, b] = openPair(m, 14);
    stand(m, 1, a, b);
    stand(m, 2, b, a);
    m.debugGive(1, { smokes: 2 });
    expect(playerOf(m, 1).hotbar).toContain('smoke');
    const view = () => (m as any).botView(playerOf(m, 2));
    m.tick(new Map());
    expect(view().enemies.map((e: PlayerState) => e.id)).toContain(1);
    // Throw it at the ground halfway.
    playerOf(m, 1).pitch = -0.35;
    act(m, 1, { throwUtil: 'smoke' });
    expect(playerOf(m, 1).inv.smokes).toBe(1);
    const run = ticks(m, SMOKE.fuseSec + SMOKE.bloomSec + 0.2);
    const pop = run.events.find((e) => e.type === 'smoke')!;
    expect(pop.data.by).toBe(1);
    expect(run.last.smokes).toHaveLength(1);
    expect(run.events.some((e) => e.type === 'explosion')).toBe(false);
    expect(view().enemies).toHaveLength(0);
    expect(view().smokes).toHaveLength(1);
    // Gone (and visible again) after the cloud's life.
    const end = ticks(m, SMOKE.lifeSec);
    expect(end.last.smokes).toBeUndefined();
    expect(view().enemies.map((e: PlayerState) => e.id)).toContain(1);
  });

  test('shop: smoke/flash prices and stack limit', async () => {
    const m = await match(2);
    const p = playerOf(m, 1);
    p.inv.cash = 10_000;
    for (let i = 0; i < SMOKE.maxCarry; i++) expect(buy(p, { buy: 'smoke' }).ok).toBe(true);
    expect(buy(p, { buy: 'smoke' }).ok).toBe(false);
    expect(p.inv.smokes).toBe(SMOKE.maxCarry);
    expect(buy(p, { buy: 'flash' }).ok).toBe(true);
    expect(p.inv.cash).toBe(10_000 - SMOKE.maxCarry * SMOKE.price - FLASH.price);
    expect(p.hotbar).toContain('flash');
  });
});

describe('determinism / wire / replay', () => {
  const script = (t: number): PlayerInput | null =>
    t === 10 ? { ...NO_INPUT, pitch: -0.3, throwUtil: 'smoke' } : t === 40 ? { ...NO_INPUT, yaw: 3.1, pitch: -0.2, throwUtil: 'flash' } : null;

  test('sanitize keeps throwUtil and drops junk', () => {
    expect(sanitizeInput({ ...NO_INPUT, throwUtil: 'smoke' })!.throwUtil).toBe('smoke');
    expect(sanitizeInput({ ...NO_INPUT, throwUtil: 'nuke' })!.throwUtil).toBeUndefined();
  });

  test('two runs and a fork mid-smoke give identical snapshots; replay codec keeps throwUtil', async () => {
    const run = async (forkAt?: number) => {
      const m = await match(2, 7);
      m.debugGive(1, { smokes: 1, flashes: 1 });
      let live = m;
      const hashes: number[] = [];
      for (let t = 0; t < 150; t++) {
        if (t === forkAt) live = live.fork();
        const inp = script(t);
        hashes.push(stateHash(live.tick(inp ? new Map([[1, inp]]) : new Map())));
      }
      return hashes;
    };
    const a = await run(), b = await run(), c = await run(80);
    expect(b).toEqual(a);
    expect(c).toEqual(a);

    const setup = { players: [{ name: 'p1', isBot: false }, { name: 'p2', isBot: false }], map: 'harbor' as const, seed: 7 };
    const m = await Match.create(setup);
    const rec = new Recorder(m, { setup, kind: 'test', localId: 1, recordedAt: 0, id: 'u' });
    rec.tick(new Map());
    const give = { smokes: 1, flashes: 1 };
    m.debugGive(1, give); rec.op({ k: 'give', id: 1, inv: give });
    const hashes: number[] = [];
    for (let t = 1; t < 150; t++) { const inp = script(t); hashes.push(stateHash(rec.tick(inp ? new Map([[1, inp]]) : new Map()))); }
    const out = await rec.finish();
    m.dispose();
    const replay = await decodeReplay(out.bytes);
    expect(replay.ticks.some((tk) => JSON.stringify(tk).includes('"throwUtil":"smoke"'))).toBe(true);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    let snap: Snapshot | null = null;
    let sawSmoke = false, sawBlindOrFlash = false;
    while ((snap = runner.step())) {
      if (snap.smokes?.length) sawSmoke = true;
      if (snap.events.some((e) => e.type === 'flash')) sawBlindOrFlash = true;
    }
    expect(sawSmoke).toBe(true);
    expect(sawBlindOrFlash).toBe(true);
    expect(runner.divergedAt).toBeNull();
    runner.dispose();
    expect((await decodeReplay(await encodeReplay(replay))).ticks).toEqual(replay.ticks);
  });

  test('smokes and blind survive the snapshot codec + binary wire', async () => {
    const m = await match(2);
    const [a, b] = openPair(m, 8);
    stand(m, 2, b, a);
    m.debugExplode('smoke', v3(a.x, a.y, a.z + 3), 1);
    m.debugExplode('flash', v3((a.x + b.x) / 2, a.y + 0.05, a.z), 1);
    const s = m.tick(new Map());
    const enc = new SnapshotEncoder(), we = new WireEncoder(), wd = new WireDecoder(), dec = new SnapshotDecoder();
    enc.push(s);
    const out = dec.decode(wd.decode(we.encode(1, enc.take(2))) as never);
    expect(out.smokes).toHaveLength(1);
    expect(out.smokes![0].owner).toBe(1);
    expect(out.players.find((p) => p.id === 2)!.blind!.k).toBeCloseTo(s.players.find((p) => p.id === 2)!.blind!.k, 3);
  });
});
