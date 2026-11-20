import { aimDir } from '../combat';
import type { Difficulty, Vec3 } from '../types';
import { sub, yawOf } from '../vec';

const DEG = Math.PI / 180;

/**
 * reactSec: time from first sighting to the first shot. coneRad: aim error radius (tightens while tracking).
 * turnRate: smoothing of the tracking (1/s). maxTurn: fastest flick a hand manages (rad/s).
 * recoilComp: share of each recoil kick pulled straight back down (0 = rides the climb, 1 = perfect).
 * farGrow: extra error per 40 m beyond FAR_FROM (a small far-away head is harder to place a crosshair on).
 * lagSec: perception lag behind a moving target: error grows with the target's angular speed × this
 * (strafing, juking and jumping targets are harder to track).
 */
export type AimProfile = {
  reactSec: number; coneRad: number; turnRate: number; maxTurn: number; recoilComp: number; farGrow: number; lagSec: number;
};

export const AIM: Record<Difficulty, AimProfile> = {
  easy: { reactSec: 0.8, coneRad: 14 * DEG, turnRate: 4, maxTurn: 6, recoilComp: 0.25, farGrow: 1, lagSec: 0.2 },
  medium: { reactSec: 0.5, coneRad: 8 * DEG, turnRate: 6, maxTurn: 8, recoilComp: 0.6, farGrow: 0.9, lagSec: 0.15 },
  hard: { reactSec: 0.24, coneRad: 3 * DEG, turnRate: 11, maxTurn: 11, recoilComp: 0.85, farGrow: 0.8, lagSec: 0.12 },
  // Human pro: ~0.2 s reaction, ~2° error that tightens to ~1.4° while tracking (still misses at range),
  // fast smooth tracking, flicks capped at ~690°/s, near-perfect spray control.
  // Still human at range: error grows past 20 m and against a strafing target.
  pro: { reactSec: 0.18, coneRad: 1.5 * DEG, turnRate: 16, maxTurn: 12, recoilComp: 0.95, farGrow: 0.7, lagSec: 0.09 },
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
const WOBBLE_RATE = 6;

export type Angles = { yaw: number; pitch: number };
export type AimResult = Angles & { ready: boolean; onTarget: boolean };

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function lookAt(from: Vec3, to: Vec3): Angles {
  const d = sub(to, from);
  return { yaw: yawOf(d), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

export function angleBetween(a: Angles, b: Angles): number {
  const u = aimDir(a.yaw, a.pitch), v = aimDir(b.yaw, b.pitch);
  return Math.acos(Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y + u.z * v.z)));
}

/** Rotate toward `want` at most `rate` rad/s. */
export function turnToward(cur: Angles, want: Angles, rate: number, dt: number): Angles {
  const step = rate * dt;
  const dy = wrapAngle(want.yaw - cur.yaw), dp = want.pitch - cur.pitch;
  return { yaw: cur.yaw + Math.max(-step, Math.min(step, dy)), pitch: cur.pitch + Math.max(-step, Math.min(step, dp)) };
}

/**
 * Human-feel aim at one target: smooth exponential tracking toward a point offset by a wandering error
 * inside a cone that tightens with continuous tracking; shooting is gated by a reaction delay per sighting.
 */
export class Aim {
  private target = -1;
  private seenAt = 0;
  private lastSeen = -Infinity;
  private err: Angles = { yaw: 0, pitch: 0 };
  private errGoal: Angles = { yaw: 0, pitch: 0 };
  private nextErrAt = 0;
  /** What we aimed at last tick: the sim adds recoil on top, so `cur - last` is the kick to fight. */
  private last: Angles | null = null;
  private lastExact: Angles | null = null;
  /** Perceived angular speed of the target across my view (rad/s), smoothed. */
  private omega = 0;

  constructor(private readonly p: AimProfile, private readonly rng: () => number) {}

  track(now: number, dt: number, eye: Vec3, point: Vec3, id: number, cur: Angles): AimResult {
    cur = this.compensate(cur);
    const fresh = id !== this.target || now - this.lastSeen > FORGET_SEC;
    if (fresh) { this.target = id; this.seenAt = now; this.nextErrAt = now; this.lastExact = null; this.omega = 0; }
    else if (now - this.lastSeen > REACQUIRE_SEC) {
      // Lost them behind something for a moment: find them again (partial reaction, fresh error).
      this.seenAt = Math.max(this.seenAt, now - this.p.reactSec * (1 - REACQUIRE_SHARE));
      this.nextErrAt = now;
      this.lastExact = null;
    }
    this.lastSeen = now;
    if (now >= this.nextErrAt) {
      const a = this.rng() * 2 * Math.PI, r = Math.sqrt(this.rng());
      this.errGoal = { yaw: Math.cos(a) * r, pitch: Math.sin(a) * r };
      this.nextErrAt = now + 0.25 + 0.2 * this.rng();
      if (fresh) this.err = { ...this.errGoal };
    }
    const w = 1 - Math.exp(-WOBBLE_RATE * dt);
    this.err = { yaw: this.err.yaw + (this.errGoal.yaw - this.err.yaw) * w, pitch: this.err.pitch + (this.errGoal.pitch - this.err.pitch) * w };

    const tracked = now - this.seenAt;
    const exact = lookAt(eye, point);
    const range = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
    if (this.lastExact && dt > 0) {
      const w = angleDelta(exact, this.lastExact) / dt;
      this.omega += (w - this.omega) * (1 - Math.exp(-OMEGA_RATE * dt));
    }
    this.lastExact = exact;
    const far = 1 + (this.p.farGrow * Math.max(0, range - FAR_FROM)) / 40;
    const cone = this.p.coneRad * (1 - TIGHTEN * Math.min(1, tracked / TIGHTEN_SEC)) * far + this.omega * this.p.lagSec;
    const want = { yaw: exact.yaw + this.err.yaw * cone, pitch: exact.pitch + this.err.pitch * cone };
    const t = 1 - Math.exp(-this.p.turnRate * dt);
    const lim = this.p.maxTurn * dt;
    const clampStep = (x: number) => Math.max(-lim, Math.min(lim, x * t));
    const aim = { yaw: cur.yaw + clampStep(wrapAngle(want.yaw - cur.yaw)), pitch: cur.pitch + clampStep(want.pitch - cur.pitch) };
    const tolerance = cone + Math.atan2(0.6, Math.max(range, 0.1));
    this.last = { yaw: aim.yaw, pitch: aim.pitch };
    return { ...aim, ready: tracked >= this.p.reactSec - 1e-9, onTarget: angleBetween(aim, exact) <= tolerance };
  }

  /** Recoil compensation: pull back `recoilComp` of the kick the last shot added to our aim. */
  compensate(cur: Angles): Angles {
    const last = this.last;
    if (!last) return cur;
    const k = this.p.recoilComp;
    return { yaw: cur.yaw - wrapAngle(cur.yaw - last.yaw) * k, pitch: cur.pitch - (cur.pitch - last.pitch) * k };
  }

  reset() { this.target = -1; this.lastSeen = -Infinity; this.last = null; this.lastExact = null; this.omega = 0; }
}

/** Angle between two view directions given as yaw/pitch (rad). */
function angleDelta(a: Angles, b: Angles): number {
  const dy = wrapAngle(a.yaw - b.yaw) * Math.cos((a.pitch + b.pitch) / 2);
  return Math.hypot(dy, a.pitch - b.pitch);
}
