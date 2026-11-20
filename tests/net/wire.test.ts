import { describe, expect, test } from 'vitest';
import { WireDecoder, WireEncoder, wireHeader } from '../../src/net/wire';

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
/** The wire normalises -0 to 0 (harmless; saves bytes). */
function n0<T>(x: T): T {
  if (typeof x === 'number') return (Object.is(x, -0) ? 0 : x) as T;
  if (Array.isArray(x)) return x.map(n0) as T;
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, n0(v)])) as T;
  return x;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A snapshot-shaped tree that drifts a little each step (positions, hp, pieces come and go, events). */
function world(rand: () => number) {
  let tick = 0;
  let nextPiece = 100;
  const players = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: `p${i}`, pos: { x: r2(rand() * 100), y: 2, z: r2(rand() * 100) }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, hp: 100, alive: true, equipped: 'smg', inv: { cash: 10, weapons: { smg: { mag: 30, spare: 90 } } }, ads: i % 2 === 0 ? true : undefined,
  }));
  let pieces = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, kind: 'wood', owner: 1, pos: { x: i, y: 2, z: -i }, rotY: r3(i * 0.1), hp: 300 }));
  return () => {
    tick++;
    for (const p of players) {
      p.pos = { x: r2(p.pos.x + rand() - 0.5), y: p.pos.y, z: r2(p.pos.z + rand() - 0.5) };
      p.vel = { x: r2(rand() * 6 - 3), y: 0, z: r2(rand() * 6 - 3) };
      p.yaw = r3(rand() * 6.28 - 3.14);
      if (rand() < 0.05) p.hp = Math.max(0, p.hp - 20);
      if (rand() < 0.1) { if (p.ads) delete p.ads; else p.ads = true; }
    }
    pieces = pieces.filter(() => rand() > 0.02).map((pc) => (rand() < 0.05 ? { ...pc, hp: pc.hp - 10 } : pc));
    if (rand() < 0.3) pieces.push({ id: nextPiece++, kind: 'steel', owner: 2, pos: { x: 1.5, y: 2, z: 3.25 }, rotY: 0, hp: 1200 });
    const events = rand() < 0.5 ? [{ t: tick / 30, type: 'shot', data: { by: 1, from: { x: 1.23456789, y: 2, z: 3 }, to: { x: 4, y: 5, z: 6 } } }] : [];
    return structuredClone({ time: tick / 30, tick, players, pieces, events, waterY: r3(tick * 0.001), winner: null, own: { pos: { x: Math.PI * tick, y: 1e-7, z: 0 } } });
  };
}

describe('wire codec (binary delta snapshots)', () => {
  test('full snapshot round-trips exactly', () => {
    const next = world(rng(1));
    const s = next();
    const buf = new WireEncoder().encode(s.tick, s);
    expect(new WireDecoder().decode(buf)).toEqual(n0(s));
    expect(wireHeader(buf)).toEqual({ seq: 1, baseSeq: 0 });
  });

  test('deltas against acked snapshots round-trip exactly, with acks lagging (RTT) and much smaller', () => {
    const next = world(rng(2));
    const enc = new WireEncoder(), dec = new WireDecoder();
    const inFlight: number[] = [];
    let fullBytes = 0, deltaBytes = 0;
    for (let i = 0; i < 200; i++) {
      const s = next();
      const buf = enc.encode(s.tick, s);
      const got = dec.decode(buf);
      expect(got).toEqual(n0(s));
      inFlight.push(dec.ack);
      if (inFlight.length > 3) enc.ack(inFlight.shift()!); // acks arrive 3 messages late
      if (i > 10) { deltaBytes += buf.byteLength; fullBytes += new WireEncoder().encode(s.tick, s).byteLength; }
    }
    expect(enc.stats.delta).toBeGreaterThan(190);
    expect(deltaBytes).toBeLessThan(fullBytes * 0.5);
  });

  test('packet loss: state converges; deltas without their base are dropped, never mis-applied', () => {
    const rand = rng(3);
    const next = world(rng(4));
    const enc = new WireEncoder(), dec = new WireDecoder();
    let delivered = 0, dropped = 0, ackLost = 0;
    let last: unknown = null;
    for (let i = 0; i < 400; i++) {
      const s = next();
      const buf = enc.encode(s.tick, s);
      if (rand() < 0.25) { dropped++; continue; } // lost on the way to the client
      const got = dec.decode(buf);
      if (got) { expect(got).toEqual(n0(s)); delivered++; last = got; }
      if (rand() < 0.25) { ackLost++; continue; } // ack lost on the way back
      enc.ack(dec.ack);
    }
    expect(dropped).toBeGreaterThan(50);
    expect(ackLost).toBeGreaterThan(50);
    expect(delivered).toBeGreaterThan(200);
    expect(last).not.toBeNull();
  });

  test('a client that lost its history gets a full snapshot again after the host history rolls over', () => {
    const next = world(rng(5));
    const enc = new WireEncoder();
    let s = next();
    enc.encode(s.tick, s);
    enc.ack(1);
    for (let i = 0; i < 70; i++) { s = next(); enc.encode(s.tick, s); } // no acks for > history
    s = next();
    const buf = enc.encode(s.tick, s);
    expect(wireHeader(buf).baseSeq).toBe(0);
    expect(new WireDecoder().decode(buf)).toEqual(n0(s));
  });

  test('a delta whose base the client never got is dropped', () => {
    const next = world(rng(6));
    const enc = new WireEncoder(), dec = new WireDecoder();
    const a = next(); enc.encode(a.tick, a); enc.ack(a.tick); // host thinks the client has tick 1 (forged/mistaken ack)
    const b = next();
    const warn = console.warn; console.warn = () => {};
    expect(dec.decode(enc.encode(b.tick, b))).toBeNull();
    console.warn = warn;
  });

  test('quantization: cm/mm values are exact, other floats keep full precision; ints and specials survive', () => {
    const vals = [0, -0, 1, -1, 63, 64, 1e9, -(2 ** 40), 2 ** 40, 1.23, -45.67, 0.001, -3.141, Math.PI, 1e-7, Infinity, -Infinity, NaN, 299.99, -1e9 + 0.5];
    const enc = new WireEncoder(), dec = new WireDecoder();
    const tree = { vals, nested: [{ a: 'x' }, { a: 'é😀' }], b: true, n: null, u: undefined };
    const out = dec.decode<typeof tree>(enc.encode(1, tree))!;
    out.vals.forEach((v, i) => expect(Object.is(v, vals[i]) || (v === 0 && vals[i] === 0)).toBe(true));
    expect(out.nested).toEqual(tree.nested);
    expect('u' in out).toBe(true);
    // Deltas between grid values land exactly on the grid.
    enc.ack(1);
    const tree2 = { ...tree, vals: vals.map((v) => (Number.isFinite(v) ? r2(v + 0.37) : v)) };
    const out2 = dec.decode<typeof tree>(enc.encode(2, tree2))!;
    out2.vals.forEach((v, i) => expect(Object.is(v, tree2.vals[i]) || (v === 0 && tree2.vals[i] === 0)).toBe(true));
  });

  test('stale or duplicate messages are ignored', () => {
    const next = world(rng(7));
    const enc = new WireEncoder(), dec = new WireDecoder();
    const a = next(), b = next();
    const ba = enc.encode(a.tick, a), bb = enc.encode(b.tick, b);
    expect(dec.decode(bb)).toEqual(n0(b));
    expect(dec.decode(ba)).toBeNull();
    expect(dec.decode(bb)).toBeNull();
  });

  test('decoded snapshots are independent copies (mutating one cannot corrupt later deltas)', () => {
    const next = world(rng(8));
    const enc = new WireEncoder(), dec = new WireDecoder();
    const a = next();
    const got = dec.decode<ReturnType<typeof next>>(enc.encode(a.tick, a))!;
    enc.ack(dec.ack);
    got.players[0].pos.x = 12345;
    const b = next();
    expect(dec.decode(enc.encode(b.tick, b))).toEqual(n0(b));
  });

  test('unsupported values fail loudly', () => {
    expect(() => new WireEncoder().encode(1, { m: new Map() })).toThrow(/cannot encode/);
  });
});
