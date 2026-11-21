/**
 * Ocean wave model shared by the water shader (water.ts, TSL) and the CPU (`waveHeight`, for things that float).
 *
 * One generic implementation (`waveSum`) runs on two backends: plain numbers here, TSL nodes in water.ts, so the
 * GPU surface and `waveHeight` can't drift apart. Visual only: the gameplay water level (drowning, tide) is
 * `snapshot.waterY` and is never changed by any of this.
 *
 * Model: a sum of directional Gerstner trains. Each train has an open-sea amplitude and a harbor fraction; the
 * local "exposure" (0 inside the ring of backdrop quays → 1 out at sea) blends between them, so long swell only
 * rolls in out past the quays while the harbor keeps a short chop. Horizontal (choppy) displacement scales with
 * the effective amplitude, so crests sharpen further out. `setSeaState(0..1)` roughens everything (storm agent:
 * sudden death) and lets some of the swell into the harbor.
 */

/** Direction (deg), wavelength (m), open-sea amplitude (m), harbor fraction of that amplitude, phase (rad). */
export const WAVES: readonly (readonly [number, number, number, number, number])[] = [
  [18, 52, 0.34, 0.12, 0.0],
  [-27, 33, 0.21, 0.18, 1.7],
  [58, 21, 0.13, 0.32, 4.1],
  [-8, 13.5, 0.085, 0.5, 2.3],
  [36, 8.6, 0.05, 0.72, 5.2],
  [-58, 6.1, 0.032, 0.85, 0.9],
];
export const GRAVITY = 9.81;
/** Amplitude gain at sea state 1 (storm). */
export const STORM_GAIN = 0.9;
/** Peak crest pinch (Σ horizontal steepness) at full exposure in a full storm; < 1 so crests never loop. */
const MAX_PINCH = 0.88;

export type Train = { dx: number; dz: number; k: number; w: number; A: number; h: number; ph: number; c: number };
/** Precomputed per-train constants (the same numbers are baked into the shader as literals). */
export const TRAINS: readonly Train[] = WAVES.map(([deg, L, A, h, ph]) => {
  const a = (deg * Math.PI) / 180, k = (2 * Math.PI) / L;
  // horizontal factor: at full exposure and full storm Σ c·k·A·(1+G) = MAX_PINCH
  const c = MAX_PINCH / (k * A * WAVES.length * (1 + STORM_GAIN));
  return { dx: Math.cos(a), dz: Math.sin(a), k, w: Math.sqrt(GRAVITY * k), A, h, ph, c };
});

/** Arithmetic the wave sum needs: numbers on the CPU, TSL nodes on the GPU. */
export interface WaveOps<T> {
  c(n: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  sin(a: T): T;
  cos(a: T): T;
  smoothstep(e0: number, e1: number, x: T): T;
  sqrt(a: T): T;
}

export type WaveSample<T> = {
  /** displacement of the surface point that rests at (x, z) */
  dx: T; dy: T; dz: T;
  /** unnormalised analytic normal (nx, ny, nz) */
  nx: T; ny: T; nz: T;
  /** crest pinch (Σ horizontal steepness · sin): > ~0.35 = a sharp crest (whitecaps) */
  pinch: T;
};

/** Harbor field: exposure ramps from 0 at `r0` (backdrop quay faces) to 1 at `r1` around (`cx`, `cz`). */
export type WaveField = { cx: number; cz: number; r0: number; r1: number };

/** Exposure at (x, z): 0 in the harbor, 1 out at sea; the storm lets half of the open sea into the harbor. */
export function exposureOf<T>(o: WaveOps<T>, x: T, z: T, f: { cx: T; cz: T; r0: number; r1: number }, sea: T): T {
  const ex = o.sub(x, f.cx), ez = o.sub(z, f.cz);
  const e = o.smoothstep(f.r0, f.r1, o.sqrt(o.add(o.mul(ex, ex), o.mul(ez, ez))));
  // e + (1 - e)·0.5·sea
  return o.add(e, o.mul(o.sub(o.c(1), e), o.mul(sea, o.c(0.5))));
}

/**
 * The wave sum at rest position (x, z), time t. `e` = exposure (0..1), `sea` = sea state (0..1), `fade` = extra
 * amplitude factor (the shader fades far, coarse rings to 0; the CPU passes 1).
 */
export function waveSum<T>(
  o: WaveOps<T>, x: T, z: T, t: T, e: T, sea: T, fade: T, trains: readonly Train[] = TRAINS,
  /** optional per-train extra fade by wavelength (the shader's distance LOD) */
  fadeFor?: (wavelength: number) => T,
): WaveSample<T> {
  let dx = o.c(0), dy = o.c(0), dz = o.c(0), nx = o.c(0), ny = o.c(0), nz = o.c(0), pinch = o.c(0);
  const storm = o.add(o.c(1), o.mul(sea, o.c(STORM_GAIN)));
  for (const w of trains) {
    // effective amplitude: A · mix(h, 1, e) · storm · fade (fade may depend on the wavelength: shader LOD)
    const f0 = fadeFor ? o.mul(fade, fadeFor((2 * Math.PI) / w.k)) : fade;
    const amp = o.mul(o.add(o.c(w.A * w.h), o.mul(e, o.c(w.A * (1 - w.h)))), o.mul(storm, f0));
    const f = o.add(o.sub(o.add(o.mul(x, o.c(w.k * w.dx)), o.mul(z, o.c(w.k * w.dz))), o.mul(t, o.c(w.w))), o.c(w.ph));
    const s = o.sin(f), c = o.cos(f);
    const ac = o.mul(amp, c), as = o.mul(amp, s);
    dx = o.add(dx, o.mul(ac, o.c(w.c * w.dx)));
    dz = o.add(dz, o.mul(ac, o.c(w.c * w.dz)));
    dy = o.add(dy, as);
    nx = o.add(nx, o.mul(ac, o.c(w.k * w.dx)));
    nz = o.add(nz, o.mul(ac, o.c(w.k * w.dz)));
    const p = o.mul(as, o.c(w.c * w.k));
    ny = o.add(ny, p);
    pinch = o.add(pinch, p);
  }
  return { dx, dy, dz, nx: o.sub(o.c(0), nx), ny: o.sub(o.c(1), ny), nz: o.sub(o.c(0), nz), pinch };
}

// ------------------------------------------------------------------------------------------------ CPU side

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const NUM: WaveOps<number> = {
  c: (n) => n, add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b,
  sin: Math.sin, cos: Math.cos, smoothstep: smooth, sqrt: Math.sqrt,
};

let field: WaveField = { cx: 0, cz: 0, r0: 60, r1: 140 };
let seaTarget = 0;
let sea = 0;
let clock = 0;

/** Called by the ocean when a map is built. */
export function setWaveField(f: WaveField) { field = { ...f }; }
export function waveField(): Readonly<WaveField> { return field; }

/**
 * Storm hook: 0 = calm (default), 1 = full storm. The surface eases toward it over a few seconds (shader and
 * `waveHeight` together). Purely visual; the drowning water level is untouched.
 */
export function setSeaState(s: number) {
  if (!Number.isFinite(s)) { console.warn(`[waves] setSeaState ignored non-finite ${s}`); return; }
  seaTarget = Math.min(1, Math.max(0, s));
}
/** Current (eased) sea state and the target it is heading to. */
export function seaState() { return { current: sea, target: seaTarget }; }

/** Wave clock (s) the shader is using this frame: pass it to `waveHeight` for things drawn this frame. */
export function waveTime() { return clock; }

/** Advance the shared wave clock + ease the sea state (the ocean calls this once per frame). */
export function stepWaves(nowSec: number, dt: number) {
  clock = nowSec;
  const rate = 0.25; // full calm → storm in ~4 s
  sea += Math.max(-rate * dt, Math.min(rate * dt, seaTarget - sea));
}

/** Test hook: force the eased state immediately. */
export function _resetWaves(s = 0, t = 0) { seaTarget = sea = s; clock = t; }

/** Exposure (0 harbor .. 1 open sea) at world (x, z) for the current sea state. */
export function exposure(x: number, z: number, s = sea) {
  return exposureOf(NUM, x, z, field, s);
}

/** Raw wave sum at REST position (x, z): what the shader computes for the vertex that rests there. */
export function waveAt(x: number, z: number, t = clock, s = sea): WaveSample<number> {
  return waveSum(NUM, x, z, t, exposure(x, z, s), s, 1);
}

/**
 * Visual water surface height above the sea level at world (x, z), time t (seconds, `waveTime()` for this frame).
 * Gerstner waves move surface points sideways too, so this inverts the horizontal displacement (fixed-point, 4
 * steps, < 1 mm error) to find the point that ends up over (x, z), then returns its height. Add `snapshot.waterY`
 * for a world Y. Matches the shader within 70 m of the camera (further out the shader fades the swell out on its
 * coarse rings).
 */
export function waveHeight(x: number, z: number, t = clock, s = sea): number {
  let qx = x, qz = z;
  for (let i = 0; i < 4; i++) {
    const w = waveAt(qx, qz, t, s);
    qx = x - w.dx; qz = z - w.dz;
  }
  return waveAt(qx, qz, t, s).dy;
}

/** Surface normal at world (x, z) (same inversion as `waveHeight`), for tilting floating things. */
export function waveNormal(x: number, z: number, t = clock, s = sea): { x: number; y: number; z: number } {
  let qx = x, qz = z;
  for (let i = 0; i < 4; i++) {
    const w = waveAt(qx, qz, t, s);
    qx = x - w.dx; qz = z - w.dz;
  }
  const w = waveAt(qx, qz, t, s);
  const l = Math.hypot(w.nx, w.ny, w.nz) || 1;
  return { x: w.nx / l, y: w.ny / l, z: w.nz / l };
}
