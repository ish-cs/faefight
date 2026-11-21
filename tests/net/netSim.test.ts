import { describe, expect, test } from 'vitest';
import { conditionsFrom, SimPipe, type NetConditions } from '../../src/net/netSim';

/** Fake clock + timer queue. */
export function fakeClock() {
  let t = 0, seq = 0;
  const q: { at: number; seq: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { q.push({ at: t + ms, seq: seq++, fn }); q.sort((a, b) => a.at - b.at || a.seq - b.seq); },
    /** Run every timer due up to `until` (ms). */
    runUntil(until: number) {
      while (q.length && q[0].at <= until) { const e = q.shift()!; t = e.at; e.fn(); }
      t = until;
    },
  };
}
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

function pipe(c: Partial<NetConditions>) {
  const clock = fakeClock();
  const got: { msg: number; at: number }[] = [];
  const p = new SimPipe({ rttMs: 0, jitterMs: 0, loss: 0, random: rng(1), now: clock.now, setTimer: clock.setTimer, ...c }, (m) => got.push({ msg: m as number, at: clock.now() }));
  return { p, got, clock };
}

describe('network conditions simulator', () => {
  test('one-way delay is half the RTT', () => {
    const { p, got, clock } = pipe({ rttMs: 120 });
    p.push(1);
    clock.runUntil(59);
    expect(got).toEqual([]);
    clock.runUntil(1000);
    expect(got).toEqual([{ msg: 1, at: 60 }]);
  });

  test('jitter stays within bounds and a reliable link never reorders', () => {
    const { p, got, clock } = pipe({ rttMs: 100, jitterMs: 40 });
    for (let i = 0; i < 200; i++) { p.push(i); clock.runUntil(clock.now() + 10); }
    clock.runUntil(1e6);
    expect(got.map((g) => g.msg)).toEqual([...Array(200).keys()]);
    for (const g of got) expect(g.at - g.msg * 10).toBeGreaterThanOrEqual(50);
    // in-order delivery can only add head-of-line wait, never exceed the max lateness of an earlier message
    expect(Math.max(...got.map((g) => g.at - g.msg * 10))).toBeLessThanOrEqual(90 + 1e-9);
  });

  test('reliable loss = retransmission ~1 RTT later with head-of-line blocking (nothing lost)', () => {
    const { p, got, clock } = pipe({ rttMs: 100, loss: 0.2 });
    for (let i = 0; i < 300; i++) { p.push(i); clock.runUntil(clock.now() + 10); }
    clock.runUntil(1e6);
    expect(got.map((g) => g.msg)).toEqual([...Array(300).keys()]);
    expect(p.stats.lost).toBeGreaterThan(30);
    const late = got.filter((g) => g.at - g.msg * 10 >= 150).length;
    expect(late).toBeGreaterThan(30);
  });

  test('unordered mode drops lost messages', () => {
    const { p, got, clock } = pipe({ rttMs: 50, jitterMs: 30, loss: 0.25, ordered: false });
    for (let i = 0; i < 400; i++) { p.push(i); clock.runUntil(clock.now() + 5); }
    clock.runUntil(1e6);
    expect(got.length).toBe(400 - p.stats.dropped);
    expect(p.stats.dropped).toBeGreaterThan(60);
    const order = got.map((g) => g.msg);
    expect(order.some((m, i) => i > 0 && m < order[i - 1])).toBe(true); // reordered by jitter
  });

  test('URL parameters', () => {
    expect(conditionsFrom('?net=local')).toBeNull();
    expect(conditionsFrom('?net=local&rtt=120&jitter=20&loss=0.02')).toEqual({ rttMs: 120, jitterMs: 20, loss: 0.02 });
    expect(() => conditionsFrom('?rtt=abc')).toThrow(/bad conditions/);
  });
});
