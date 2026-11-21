import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetWaves, exposure, setSeaState, setWaveField, stepWaves, TRAINS, waveAt, waveHeight, waveSum, type WaveOps, WAVES,
} from '../../src/client/world/waves';

/** Independent Gerstner reference, written out by hand from the spectrum table (no shared code with waves.ts). */
function reference(x: number, z: number, t: number, e: number, sea: number) {
  let dx = 0, dy = 0, dz = 0;
  const G = 9.81, N = WAVES.length, storm = 1 + 0.9 * sea;
  for (const [deg, L, A, h, ph] of WAVES) {
    const a = (deg * Math.PI) / 180, k = (2 * Math.PI) / L, w = Math.sqrt(G * k);
    const amp = A * (h + (1 - h) * e) * storm;
    const c = 0.88 / (k * A * N * 1.9);
    const f = k * (x * Math.cos(a) + z * Math.sin(a)) - w * t + ph;
    dx += c * amp * Math.cos(a) * Math.cos(f);
    dz += c * amp * Math.sin(a) * Math.cos(f);
    dy += amp * Math.sin(f);
  }
  return { dx, dy, dz };
}

/** A symbolic backend: records the expression the shader would build, then evaluates it — same structure as TSL. */
type Expr = (env: Record<string, number>) => number;
const SYM: WaveOps<Expr> = {
  c: (n) => () => n,
  add: (a, b) => (v) => a(v) + b(v),
  sub: (a, b) => (v) => a(v) - b(v),
  mul: (a, b) => (v) => a(v) * b(v),
  sin: (a) => (v) => Math.sin(a(v)),
  cos: (a) => (v) => Math.cos(a(v)),
  smoothstep: (e0, e1, x) => (v) => { const t = Math.min(1, Math.max(0, (x(v) - e0) / (e1 - e0))); return t * t * (3 - 2 * t); },
  sqrt: (a) => (v) => Math.sqrt(a(v)),
};

describe('ocean waves', () => {
  beforeEach(() => {
    _resetWaves(0, 0);
    setWaveField({ cx: 0, cz: 0, r0: 140, r1: 210 });
  });

  it('the shared wave sum matches an independent Gerstner reference at sample points', () => {
    const pts = [[0, 0, 0], [12.5, -40, 3.2], [-300, 210, 17.9], [77, 5, 120.25], [160, -160, 999]];
    for (const [x, z, t] of pts) for (const sea of [0, 0.5, 1]) {
      const e = exposure(x, z, sea);
      const ref = reference(x, z, t, e, sea);
      const got = waveAt(x, z, t, sea);
      expect(got.dx).toBeCloseTo(ref.dx, 9);
      expect(got.dy).toBeCloseTo(ref.dy, 9);
      expect(got.dz).toBeCloseTo(ref.dz, 9);
    }
  });

  it('the shader expression (built through the same generic code) evaluates to the CPU values', () => {
    const X: Expr = (v) => v.x, Z: Expr = (v) => v.z, T: Expr = (v) => v.t, E: Expr = (v) => v.e, S: Expr = (v) => v.s, ONE: Expr = () => 1;
    const s = waveSum(SYM, X, Z, T, E, S, ONE);
    for (const [x, z, t] of [[3, 4, 5], [-90, 33, 61.5], [200, 10, 7]]) {
      const e = exposure(x, z, 0.3), env = { x, z, t, e, s: 0.3 };
      const cpu = waveAt(x, z, t, 0.3);
      expect(s.dy(env)).toBeCloseTo(cpu.dy, 12);
      expect(s.dx(env)).toBeCloseTo(cpu.dx, 12);
      expect(s.pinch(env)).toBeCloseTo(cpu.pinch, 12);
    }
  });

  it('waveHeight inverts the sideways motion: the surface point displaced over (x, z) has that height', () => {
    for (const [x, z, t] of [[5, 5, 1], [250, -30, 9], [-180, 400, 33]]) {
      const h = waveHeight(x, z, t, 1);
      // find a rest point q with q + D(q) = (x, z) by brute force near (x, z) and compare heights
      let best = { err: Infinity, dy: 0 };
      for (let i = -40; i <= 40; i++) for (let j = -40; j <= 40; j++) {
        const qx = x + i * 0.02, qz = z + j * 0.02, w = waveAt(qx, qz, t, 1);
        const err = Math.hypot(qx + w.dx - x, qz + w.dz - z);
        if (err < best.err) best = { err, dy: w.dy };
      }
      expect(Math.abs(h - best.dy)).toBeLessThan(0.02);
    }
  });

  it('the harbor is calmer than the open sea', () => {
    const rms = (x: number, z: number) => {
      let s = 0, n = 0;
      for (let t = 0; t < 60; t += 0.37) { const h = waveHeight(x, z, t); s += h * h; n++; }
      return Math.sqrt(s / n);
    };
    const harbor = rms(60, 20), open = rms(400, -150);
    expect(exposure(60, 20)).toBe(0);
    expect(exposure(400, -150)).toBe(1);
    expect(open).toBeGreaterThan(harbor * 2.5);
  });

  it('crests never loop over, even in a full storm out at sea', () => {
    let maxPinch = 0;
    for (let i = 0; i < 4000; i++) maxPinch = Math.max(maxPinch, waveAt(500 + i * 0.73, i * 1.31, i * 0.11, 1).pinch);
    expect(maxPinch).toBeLessThan(1);
    expect(TRAINS.length).toBe(WAVES.length);
  });

  it('setSeaState eases the sea rougher over a few seconds and is clamped', () => {
    const calm = (() => { let s = 0; for (let t = 0; t < 30; t += 0.5) s += Math.abs(waveHeight(60, 20, t)); return s; })();
    setSeaState(5);
    for (let i = 0; i < 100; i++) stepWaves(i * 0.1, 0.1);
    const rough = (() => { let s = 0; for (let t = 0; t < 30; t += 0.5) s += Math.abs(waveHeight(60, 20, t)); return s; })();
    expect(rough).toBeGreaterThan(calm * 1.8);
    setSeaState(Number.NaN); // ignored, no throw
  });
});
