import type { Vec3 } from '../sim/types';

/**
 * Display-rate interpolation of remote entities (pure; no three.js).
 *
 * RenderClock turns irregular snapshot arrivals into a smooth playback clock in sim time that runs a
 * little behind the newest snapshot; the delay adapts to the measured arrival jitter. PlayerTrack
 * keeps a short history per player and samples it at that clock with a cubic Hermite curve
 * (velocity-aware tangents), so motion stays smooth between 15–30 Hz snapshots.
 */

/** Positions that jump further than this between snapshots are teleports (respawn): no blending. */
export const TELEPORT_DIST = 3;
/** Past the newest snapshot, keep moving along the last velocity for at most this long, then hold. */
export const MAX_EXTRAPOLATE = 0.1;

const WINDOW = 48;
/** Slew rate limit: playback runs at most this much faster/slower than real time while converging. */
const MAX_SLEW = 0.08;
const SNAP_ERR = 0.25;

/** Adaptive playback clock: `delay` behind the freshest estimate of sim time, tracking jitter. */
export class RenderClock {
  private offsets: number[] = []; // simTime - arrival (s)
  private times: number[] = [];
  private t: number | null = null;
  private lastNow = 0;
  /** Current target delay (s), for debugging. */
  delay = 0;

  /** Freshest offset and target delay, recomputed only when a snapshot arrives (advance() runs every frame). */
  private freshest = 0;
  private targetDelay = 0;

  /** A snapshot of sim time `simTime` arrived at wall time `now` (seconds). */
  push(simTime: number, now: number) {
    if (this.times.length && simTime <= this.times[this.times.length - 1]) return;
    this.offsets.push(simTime - now);
    this.times.push(simTime);
    if (this.offsets.length > WINDOW) { this.offsets.shift(); this.times.shift(); }
    let f = -Infinity;
    for (const o of this.offsets) if (o > f) f = o;
    this.freshest = f;
    this.targetDelay = Math.min(0.3, this.interval() + this.jitter() + 0.005);
  }

  /** Nominal snapshot spacing (median of recent sim-time gaps). */
  interval(): number {
    const n = this.times.length;
    if (n < 2) return 1 / 30;
    const gaps: number[] = [];
    for (let i = Math.max(1, n - 16); i < n; i++) gaps.push(this.times[i] - this.times[i - 1]);
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  }

  /** Arrival jitter (s): spread between the freshest and a typical late arrival. */
  jitter(): number {
    const n = this.offsets.length;
    if (n < 2) return 0;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return sorted[n - 1] - sorted[Math.floor(n * 0.1)];
  }

  /** Playback sim time for wall time `now` (s). Call once per frame. */
  advance(now: number): number | null {
    if (!this.offsets.length) return this.t;
    this.delay = this.targetDelay;
    const target = now + this.freshest - this.delay;
    if (this.t === null || Math.abs(target - this.t) > SNAP_ERR) this.t = target;
    else {
      const dt = Math.max(0, now - this.lastNow);
      const rate = 1 + Math.max(-MAX_SLEW, Math.min(MAX_SLEW, (target - (this.t + dt)) * 2));
      this.t += dt * rate;
    }
    this.lastNow = now;
    return this.t;
  }
}

export type TrackSample = { t: number; pos: Vec3; yaw: number; pitch: number };

/** Cubic Hermite on one axis: endpoints p0/p1, tangents m0/m1 (units per second), span h, s in [0,1]. */
export function hermite(p0: number, m0: number, p1: number, m1: number, h: number, s: number): { p: number; v: number } {
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s, d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
  return {
    p: h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1,
    v: h > 0 ? (d00 * p0 + d01 * p1) / h + d10 * m0 + d11 * m1 : 0,
  };
}

export const angleLerp = (a: number, b: number, s: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * s;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
let setOut: { pos: Vec3; vel: Vec3; yaw: number; pitch: number } = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
/** Writes into the `out` of the sample() call in progress (module-level so sample() allocates no closure). */
function setSample(p: Vec3, v: Vec3, yaw: number, pitch: number) {
  const out = setOut;
  out.pos.x = p.x; out.pos.y = p.y; out.pos.z = p.z;
  out.vel.x = v.x; out.vel.y = v.y; out.vel.z = v.z;
  out.yaw = yaw; out.pitch = pitch;
}

/** Short per-player history, sampled at the render clock. */
export class PlayerTrack {
  private s: TrackSample[] = [];

  push(x: TrackSample) {
    const last = this.s[this.s.length - 1];
    if (last && x.t <= last.t) return;
    this.s.push({ t: x.t, pos: { ...x.pos }, yaw: x.yaw, pitch: x.pitch });
    if (this.s.length > 32) this.s.shift();
  }

  get newest(): TrackSample | undefined { return this.s[this.s.length - 1]; }

  /** Tangent (velocity) at sample i from its neighbours; teleports break the curve. */
  private tangent(i: number): Vec3 {
    const s = this.s;
    let a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
    if (dist(a.pos, s[i].pos) > TELEPORT_DIST) a = s[i];
    if (dist(b.pos, s[i].pos) > TELEPORT_DIST) b = s[i];
    const dt = b.t - a.t;
    if (dt <= 0) return { x: 0, y: 0, z: 0 };
    return { x: (b.pos.x - a.pos.x) / dt, y: (b.pos.y - a.pos.y) / dt, z: (b.pos.z - a.pos.z) / dt };
  }

  /** Position/velocity/angles at sim time t. Returns false with no history. */
  sample(t: number, out: { pos: Vec3; vel: Vec3; yaw: number; pitch: number }): boolean {
    const s = this.s;
    if (!s.length) return false;
    const set = setSample;
    setOut = out;
    const zero = ZERO;
    if (t <= s[0].t) { set(s[0].pos, zero, s[0].yaw, s[0].pitch); return true; }
    const n = s.length - 1;
    if (t >= s[n].t) {
      // Buffer ran dry: extrapolate briefly along the last motion, then hold.
      const v = n > 0 && dist(s[n].pos, s[n - 1].pos) <= TELEPORT_DIST ? this.tangentBack(n) : zero;
      const e = Math.min(t - s[n].t, MAX_EXTRAPOLATE);
      const moving = t - s[n].t < MAX_EXTRAPOLATE ? v : zero;
      set({ x: s[n].pos.x + v.x * e, y: s[n].pos.y + v.y * e, z: s[n].pos.z + v.z * e }, moving, s[n].yaw, s[n].pitch);
      return true;
    }
    let i = n - 1;
    while (i > 0 && s[i].t > t) i--;
    const a = s[i], b = s[i + 1];
    const h = b.t - a.t;
    const u = (t - a.t) / h;
    if (dist(a.pos, b.pos) > TELEPORT_DIST) {
      const p = u < 1 ? a : b;
      set(p.pos, zero, p.yaw, p.pitch);
      return true;
    }
    const ma = this.tangent(i), mb = this.tangent(i + 1);
    const x = hermite(a.pos.x, ma.x, b.pos.x, mb.x, h, u);
    const y = hermite(a.pos.y, ma.y, b.pos.y, mb.y, h, u);
    const z = hermite(a.pos.z, ma.z, b.pos.z, mb.z, h, u);
    set({ x: x.p, y: y.p, z: z.p }, { x: x.v, y: y.v, z: z.v }, angleLerp(a.yaw, b.yaw, u), a.pitch + (b.pitch - a.pitch) * u);
    return true;
  }

  /** Velocity over the last segment. */
  private tangentBack(n: number): Vec3 {
    const a = this.s[n - 1], b = this.s[n];
    const dt = b.t - a.t;
    return dt > 0 ? { x: (b.pos.x - a.pos.x) / dt, y: (b.pos.y - a.pos.y) / dt, z: (b.pos.z - a.pos.z) / dt } : { x: 0, y: 0, z: 0 };
  }
}

/** Vertical jumps in a frame beyond what the velocity explains, above this, are smoothed (steps, corrections)… */
const STEP_MIN = 0.02;
/** …up to this; anything larger is a teleport and snaps. */
const STEP_MAX = 1.2;
/** 1/s decay of the smoothed-away step (≈95% gone in 0.2 s). */
const STEP_RATE = 15;

/**
 * Camera-height smoothing for stairs/ramps: the character controller climbs a 0.35 m step in one
 * tick, which would jolt the view. Height changes the vertical velocity doesn't account for are
 * absorbed into an offset that decays exponentially (frame-rate independent); real vertical motion
 * (jumps, falls) passes straight through.
 */
export class VerticalSmoother {
  private last: number | null = null;
  private offset = 0;

  /** y = raw feet height, vy = its vertical velocity (null: no smoothing, e.g. not predicting). */
  update(y: number, vy: number | null, dt: number): number {
    if (vy === null || this.last === null) { this.last = y; this.offset = 0; return y; }
    const excess = y - this.last - vy * dt;
    this.last = y;
    if (Math.abs(excess) >= STEP_MAX) this.offset = 0;
    else if (Math.abs(excess) > STEP_MIN) this.offset -= excess;
    this.offset *= Math.exp(-STEP_RATE * dt);
    this.offset = Math.max(-0.5, Math.min(0.5, this.offset));
    return y + this.offset;
  }
}

/** Shortest signed angle from a to b (radians, in [-π, π]). */
export const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** View smoothing time constant (s) for a watched player's camera: hides 30 Hz kinks, ~1 frame of lag at 30 fps. */
export const LOOK_TAU = 0.03;
/** A view change bigger than this within one frame is a cut (respawn, new target): snap, don't swing. */
export const LOOK_SNAP = 1.5;

/**
 * Light smoothing of a watched player's view angles (spectator / mirror camera only — never the local player's
 * own camera, which must not lag their mouse). Exponential follow of the interpolated yaw/pitch, frame-rate
 * independent; the yaw step is wrapped so a ±π crossing turns the short way instead of spinning round. Snaps on
 * a new player or a cut larger than LOOK_SNAP.
 */
export class LookSmoother {
  private id: number | null = null;
  yaw = 0;
  pitch = 0;

  update(id: number, yaw: number, pitch: number, dt: number): { yaw: number; pitch: number } {
    const dy = angleDiff(this.yaw, yaw), dp = pitch - this.pitch;
    if (id !== this.id || Math.abs(dy) > LOOK_SNAP || Math.abs(dp) > LOOK_SNAP) {
      this.id = id; this.yaw = yaw; this.pitch = pitch;
    } else {
      const k = 1 - Math.exp(-Math.max(0, dt) / LOOK_TAU);
      this.yaw += dy * k;
      this.pitch += dp * k;
    }
    return { yaw: this.yaw, pitch: this.pitch };
  }
}
