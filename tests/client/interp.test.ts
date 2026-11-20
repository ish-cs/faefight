import { describe, expect, test } from 'vitest';
import { hermite, MAX_EXTRAPOLATE, PlayerTrack, RenderClock, VerticalSmoother } from '../../src/client/interp';

const out = () => ({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 });
const at = (t: number, x: number, yaw = 0) => ({ t, pos: { x, y: 0, z: 0 }, yaw, pitch: 0 });

describe('hermite', () => {
  test('hits the endpoints and their tangents', () => {
    expect(hermite(1, 2, 5, 3, 0.5, 0)).toEqual({ p: 1, v: 2 });
    const e = hermite(1, 2, 5, 3, 0.5, 1);
    expect(e.p).toBeCloseTo(5, 12);
    expect(e.v).toBeCloseTo(3, 12);
  });
  test('constant velocity is reproduced exactly (no wobble)', () => {
    for (const s of [0.1, 0.33, 0.5, 0.9]) {
      const r = hermite(0, 4, 0.4, 4, 0.1, s);
      expect(r.p).toBeCloseTo(0.4 * s, 12);
      expect(r.v).toBeCloseTo(4, 12);
    }
  });
});

describe('PlayerTrack', () => {
  test('uniform motion at 15 Hz samples smoothly at display rate', () => {
    const tr = new PlayerTrack();
    for (let i = 0; i < 10; i++) tr.push(at(i / 15, i * (5 / 15)));
    const o = out();
    let prev = -Infinity;
    for (let t = 2 / 15; t < 8 / 15; t += 1 / 144) {
      tr.sample(t, o);
      expect(o.pos.x).toBeCloseTo(5 * t, 6);
      expect(o.vel.x).toBeCloseTo(5, 6);
      expect(o.pos.x).toBeGreaterThan(prev);
      prev = o.pos.x;
    }
  });

  test('velocity is continuous across snapshot boundaries when accelerating', () => {
    const tr = new PlayerTrack();
    for (let i = 0; i < 10; i++) { const t = i / 15; tr.push(at(t, 0.5 * 10 * t * t)); } // a = 10 m/s²
    const o = out();
    const v = (t: number) => (tr.sample(t, o), o.vel.x);
    const b = 4 / 15;
    expect(Math.abs(v(b - 1e-6) - v(b + 1e-6))).toBeLessThan(1e-3);
  });

  test('teleports snap instead of sliding across the map', () => {
    const tr = new PlayerTrack();
    tr.push(at(0, 0)); tr.push(at(0.1, 0.5)); tr.push(at(0.2, 50)); tr.push(at(0.3, 50.5));
    const o = out();
    tr.sample(0.15, o);
    expect(o.pos.x).toBeLessThan(1);
    tr.sample(0.2001, o);
    expect(o.pos.x).toBeGreaterThan(49);
  });

  test('buffer underrun: extrapolates briefly, then holds', () => {
    const tr = new PlayerTrack();
    tr.push(at(0, 0)); tr.push(at(0.1, 0.5));
    const o = out();
    tr.sample(0.15, o);
    expect(o.pos.x).toBeCloseTo(0.75, 6);
    tr.sample(1, o);
    expect(o.pos.x).toBeCloseTo(0.5 + 5 * MAX_EXTRAPOLATE, 6);
    expect(o.vel.x).toBe(0);
  });

  test('yaw interpolates the short way around', () => {
    const tr = new PlayerTrack();
    tr.push(at(0, 0, 3.1)); tr.push(at(0.1, 0, -3.1));
    const o = out();
    tr.sample(0.05, o);
    expect(Math.abs(Math.abs(o.yaw) - Math.PI)).toBeLessThan(0.01);
  });
});

describe('RenderClock', () => {
  test('steady 15 Hz: plays about one interval behind and advances at real-time rate', () => {
    const c = new RenderClock();
    for (let i = 0; i < 30; i++) c.push(i / 15, 10 + i / 15);
    const t0 = c.advance(10 + 29 / 15)!;
    expect(29 / 15 - t0).toBeGreaterThan(1 / 15 - 0.001);
    expect(29 / 15 - t0).toBeLessThan(1 / 15 + 0.02);
    const t1 = c.advance(10 + 29 / 15 + 0.016)!;
    expect(t1 - t0).toBeCloseTo(0.016, 3);
  });

  test('jittery arrivals → larger delay, but the clock still moves smoothly', () => {
    const c = new RenderClock();
    let now = 0, last: number | null = null;
    const steps: number[] = [];
    for (let i = 0; i < 60; i++) {
      const jitter = [0, 0.04, 0.01, 0.03][i % 4];
      c.push(i / 15, 5 + i / 15 + jitter);
      // render a few frames between snapshots
      for (let f = 0; f < 4; f++) {
        now = 5 + i / 15 + f / 60;
        const t = c.advance(now)!;
        if (last !== null && i > 20) steps.push(t - last);
        last = t;
      }
    }
    expect(c.delay).toBeGreaterThan(1 / 15 + 0.03);
    // frame-to-frame advance stays within ±10% of 1/60 (no stutter)
    for (const s of steps) { expect(s).toBeGreaterThan((1 / 60) * 0.9); expect(s).toBeLessThan((1 / 60) * 1.1); }
  });

  test('a long stall resyncs instead of crawling', () => {
    const c = new RenderClock();
    for (let i = 0; i < 10; i++) c.push(i / 30, i / 30);
    c.advance(9 / 30);
    for (let i = 10; i < 70; i++) c.push(i / 30, 3 + i / 30); // 1 s gap
    const t = c.advance(3 + 69 / 30)!;
    expect(69 / 30 - t).toBeLessThan(0.3);
  });
});

describe('VerticalSmoother', () => {
  test('a 0.35 m step is eased in over ~0.2 s, not popped', () => {
    const v = new VerticalSmoother();
    v.update(2, 0, 1 / 60);
    const first = v.update(2.35, 0, 1 / 60);
    expect(first).toBeLessThan(2.1); // under a third of the step shows on the first frame
    let y = first;
    for (let i = 0; i < 12; i++) y = v.update(2.35, 0, 1 / 60); // 0.2 s
    expect(y).toBeGreaterThan(2.33);
  });
  test('real vertical motion (a jump) passes straight through', () => {
    const v = new VerticalSmoother();
    let y = 2, vy = 4.6;
    v.update(y, vy, 1 / 60);
    for (let i = 0; i < 20; i++) {
      vy -= 9.81 / 60; y += vy / 60;
      expect(v.update(y, vy, 1 / 60)).toBeCloseTo(y, 2);
    }
  });
  test('teleports snap; no velocity → no smoothing', () => {
    const v = new VerticalSmoother();
    v.update(2, 0, 1 / 60);
    expect(v.update(20, 0, 1 / 60)).toBe(20);
    expect(v.update(20.3, null, 1 / 60)).toBe(20.3);
  });
});
