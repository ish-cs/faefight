import * as dm from '../dmath';
import { aimDir } from '../combat';
import type { Difficulty, Vec3 } from '../types';
import { sub, yawOf } from '../vec';
import type { AimFeel } from './params';

const DEG = Math.PI / 180;

/**
 * reactSec: time from first sighting to the first shot. coneRad: aim error radius (tightens while tracking).
 * maxTurn: fastest flick a hand manages (rad/s); how the hand eases into and out of turns is AimFeel (params.ts).
 * recoilComp: share of each recoil kick pulled straight back down (0 = rides the climb, 1 = perfect); per skill in
 * params.ts GUN_SKILL (trainer-tunable), joined onto AIM when a Bot is made.
 * farGrow: extra error per 40 m beyond FAR_FROM (a small far-away head is harder to place a crosshair on).
 * lagSec: perception lag behind a moving target: error grows with the target's angular speed × this
 * (strafing, juking and jumping targets are harder to track).
 */
export type AimProfile = { reactSec: number; coneRad: number; maxTurn: number; recoilComp: number; farGrow: number; lagSec: number };

export const AIM: Record<Difficulty, Omit<AimProfile, 'recoilComp'>> = {
  easy: { reactSec: 0.95, coneRad: 17 * DEG, maxTurn: 6, farGrow: 1.1, lagSec: 0.24 },
  medium: { reactSec: 0.5, coneRad: 8 * DEG, maxTurn: 8, farGrow: 1, lagSec: 0.18 },
  hard: { reactSec: 0.24, coneRad: 3 * DEG, maxTurn: 11, farGrow: 0.9, lagSec: 0.14 },
  // Human pro: ~0.2 s reaction, ~2° error that tightens to ~1.4° while tracking (still misses at range),
  // fast smooth tracking, flicks capped at ~690°/s (spray control: params.ts GUN_SKILL).
  // Still human at range: error grows past 20 m and against a strafing target.
  pro: { reactSec: 0.18, coneRad: 1.5 * DEG, maxTurn: 12, farGrow: 0.7, lagSec: 0.09 },
};

/** Losing sight longer than this makes the next sighting a fresh reaction. */
const FORGET_SEC = 1;
/** A shorter break in line of sight still costs a partial re-acquire (this share of the reaction time). */
const REACQUIRE_SEC = 0.2, REACQUIRE_SHARE = 0.6;
/** Distance beyond which aim error starts growing (m). */
const FAR_FROM = 20;
/** Smoothing of the perceived angular speed (1/s). */
const OMEGA_RATE = 8;
const TIGHTEN = 0.3;
const TIGHTEN_SEC = 1;
/** Per-axis spread of the aim error (in cone radii): the old uniform-disk error had this standard deviation. */
const ERR_SD = 0.5;
/** Spring integration sub-step: keeps ω·h small so the explicit spring stays smooth and stable. */
const MAX_OMEGA_H = 0.25;

export type Angles = { yaw: number; pitch: number };
export type AimResult = Angles & { ready: boolean; onTarget: boolean };

export const wrapAngle = (a: number) => dm.atan2(dm.sin(a), dm.cos(a));

export function lookAt(from: Vec3, to: Vec3): Angles {
  const d = sub(to, from);
  return { yaw: yawOf(d), pitch: dm.atan2(d.y, Math.hypot(d.x, d.z)) };
}

export function angleBetween(a: Angles, b: Angles): number {
  const u = aimDir(a.yaw, a.pitch), v = aimDir(b.yaw, b.pitch);
  return dm.acos(Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y + u.z * v.z)));
}

/** Rotate toward `want` at most `rate` rad/s (constant speed: no easing; bots use Aim.look instead). */
export function turnToward(cur: Angles, want: Angles, rate: number, dt: number): Angles {
  const step = rate * dt;
  const dy = wrapAngle(want.yaw - cur.yaw), dp = want.pitch - cur.pitch;
  return { yaw: cur.yaw + Math.max(-step, Math.min(step, dy)), pitch: cur.pitch + Math.max(-step, Math.min(step, dp)) };
}

/** Roughly standard normal from three uniforms (Irwin–Hall): no trig/log, deterministic everywhere. */
const gauss = (rng: () => number) => (rng() + rng() + rng() - 1.5) * 2;

/**
 * Human-feel aim. Every look the bot takes goes through one view "hand" (`look`): a damped spring on yaw/pitch
 * with an angular speed cap (maxTurn) and an acceleration cap, so the view eases into a turn, flicks with a small
 * overshoot (damping < 1) and settles, and never snaps. Tracking one target (`track`) aims at a point offset by an
 * error that drifts smoothly (Ornstein–Uhlenbeck noise, low-passed) inside a cone that tightens with continuous
 * tracking; shooting is gated by a reaction delay per sighting.
 */
export class Aim {
  private target = -1;
  private seenAt = 0;
  private lastSeen = -Infinity;
  /** Current aim error in cone radii (smooth), and the OU noise driving it. */
  private err: Angles = { yaw: 0, pitch: 0 };
  private noise: Angles = { yaw: 0, pitch: 0 };
  /** View angular velocity (rad/s) carried between ticks. */
  private vel: Angles = { yaw: 0, pitch: 0 };
  /** What the hand put out last tick: the sim adds recoil on top, so `cur - last` is the kick to fight. */
  private last: Angles | null = null;
  private lastExact: Angles | null = null;
  /** Perceived angular speed of the target across my view (rad/s), smoothed. */
  private omega = 0;

  constructor(private readonly p: AimProfile, private readonly rng: () => number, private readonly feel: AimFeel) {}

  /** Fastest this hand turns (rad/s). */
  get maxTurn(): number { return this.p.maxTurn; }

  /**
   * One tick of the view hand toward `want`, at most `maxTurn` rad/s. `recoil`: pull back the share of last
   * tick's recoil kick this skill controls (only while shooting at someone).
   */
  look(cur: Angles, want: Angles, dt: number, maxTurn: number, recoil = false): Angles {
    if (recoil) cur = this.compensate(cur);
    const f = this.feel, w = f.spring, z = f.damping;
    let ey = wrapAngle(want.yaw - cur.yaw), ep = want.pitch - cur.pitch;
    let vy = this.vel.yaw, vp = this.vel.pitch;
    let y = 0, p = 0;
    const n = Math.max(1, Math.ceil((w * dt) / MAX_OMEGA_H)), h = dt / n;
    for (let i = 0; i < n; i++) {
      let ay = w * w * ey - 2 * z * w * vy, ap = w * w * ep - 2 * z * w * vp;
      const a = Math.hypot(ay, ap);
      if (a > f.maxAccel) { ay *= f.maxAccel / a; ap *= f.maxAccel / a; }
      vy += ay * h; vp += ap * h;
      const v = Math.hypot(vy, vp);
      if (v > maxTurn) { vy *= maxTurn / v; vp *= maxTurn / v; }
      y += vy * h; p += vp * h; ey -= vy * h; ep -= vp * h;
    }
    this.vel = { yaw: vy, pitch: vp };
    const out = { yaw: cur.yaw + y, pitch: cur.pitch + p };
    this.last = out;
    return out;
  }

  track(now: number, dt: number, eye: Vec3, point: Vec3, id: number, cur: Angles): AimResult {
    const fresh = id !== this.target || now - this.lastSeen > FORGET_SEC;
    if (!fresh && now - this.lastSeen > REACQUIRE_SEC) {
      // Lost them behind something for a moment: find them again (partial reaction).
      this.seenAt = Math.max(this.seenAt, now - this.p.reactSec * (1 - REACQUIRE_SHARE));
      this.lastExact = null;
    }
    if (fresh) {
      this.target = id; this.seenAt = now; this.lastExact = null; this.omega = 0;
      // A new sighting starts somewhere in the cone, then drifts from there.
      const a = this.rng() * 2 * Math.PI, r = Math.sqrt(this.rng());
      this.err = { yaw: dm.cos(a) * r, pitch: dm.sin(a) * r };
      this.noise = { ...this.err };
    }
    this.lastSeen = now;
    this.drift(dt);

    const tracked = now - this.seenAt;
    const exact = lookAt(eye, point);
    const range = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
    if (this.lastExact && dt > 0) {
      const w = angleDelta(exact, this.lastExact) / dt;
      this.omega += (w - this.omega) * (1 - dm.exp(-OMEGA_RATE * dt));
    }
    this.lastExact = exact;
    const far = 1 + (this.p.farGrow * Math.max(0, range - FAR_FROM)) / 40;
    const cone = this.p.coneRad * (1 - TIGHTEN * Math.min(1, tracked / TIGHTEN_SEC)) * far + this.omega * this.p.lagSec;
    const want = { yaw: exact.yaw + this.err.yaw * cone, pitch: exact.pitch + this.err.pitch * cone };
    const aim = this.look(cur, want, dt, this.p.maxTurn, true);
    const tolerance = cone + dm.atan2(0.6, Math.max(range, 0.1));
    return { ...aim, ready: tracked >= this.p.reactSec - 1e-9, onTarget: angleBetween(aim, exact) <= tolerance };
  }

  /**
   * Low-frequency aim error: OU noise (mean-reverting at driftHz) smoothed by a low-pass twice as fast, so the
   * error wanders like a hand, never jumps tick to tick. Kept inside the unit disk (one cone radius).
   */
  private drift(dt: number) {
    const th = this.feel.driftHz, lp = 1 - dm.exp(-2 * th * dt);
    // Stationary SD after the low-pass is ERR_SD (OU variance σ² shrinks by λ/(λ+θ) = 2/3 through it).
    const s = ERR_SD * Math.sqrt(1.5) * Math.sqrt(2 * th * dt);
    const decay = dm.exp(-th * dt);
    this.noise = { yaw: this.noise.yaw * decay + s * gauss(this.rng), pitch: this.noise.pitch * decay + s * gauss(this.rng) };
    let ey = this.err.yaw + (this.noise.yaw - this.err.yaw) * lp, ep = this.err.pitch + (this.noise.pitch - this.err.pitch) * lp;
    const r = Math.hypot(ey, ep);
    if (r > 1) { ey /= r; ep /= r; }
    this.err = { yaw: ey, pitch: ep };
  }

  /** Recoil compensation: pull back `recoilComp` of the kick the sim added on top of what the hand put out last tick. */
  compensate(cur: Angles): Angles {
    const l = this.last;
    if (!l) return cur;
    const k = this.p.recoilComp;
    return { yaw: cur.yaw - wrapAngle(cur.yaw - l.yaw) * k, pitch: cur.pitch - (cur.pitch - l.pitch) * k };
  }

  reset() { this.target = -1; this.lastSeen = -Infinity; this.last = null; this.vel = { yaw: 0, pitch: 0 }; this.lastExact = null; this.omega = 0; }
}

/** Angle between two view directions given as yaw/pitch (rad). */
function angleDelta(a: Angles, b: Angles): number {
  const dy = wrapAngle(a.yaw - b.yaw) * dm.cos((a.pitch + b.pitch) / 2);
  return Math.hypot(dy, a.pitch - b.pitch);
}
