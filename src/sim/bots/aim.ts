import { aimDir } from '../combat';
import type { Difficulty, Vec3 } from '../types';
import { sub, yawOf } from '../vec';

const DEG = Math.PI / 180;

/**
 * reactSec: time from first sighting to the first shot. coneRad: aim error radius (tightens while tracking).
 * turnRate: smoothing of the tracking (1/s). maxTurn: fastest flick a hand manages (rad/s).
 */
export type AimProfile = { reactSec: number; coneRad: number; turnRate: number; maxTurn: number };

export const AIM: Record<Difficulty, AimProfile> = {
  easy: { reactSec: 0.8, coneRad: 14 * DEG, turnRate: 4, maxTurn: 6 },
  medium: { reactSec: 0.5, coneRad: 8 * DEG, turnRate: 6, maxTurn: 8 },
  hard: { reactSec: 0.24, coneRad: 3 * DEG, turnRate: 11, maxTurn: 11 },
  // Human pro: ~0.2 s reaction, ~2° error that tightens to ~1.4° while tracking (still misses at range),
  // fast smooth tracking, flicks capped at ~690°/s.
  pro: { reactSec: 0.2, coneRad: 2 * DEG, turnRate: 14, maxTurn: 12 },
};

/** Losing sight longer than this makes the next sighting a fresh reaction. */
const FORGET_SEC = 1;
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

  constructor(private readonly p: AimProfile, private readonly rng: () => number) {}

  track(now: number, dt: number, eye: Vec3, point: Vec3, id: number, cur: Angles): AimResult {
    const fresh = id !== this.target || now - this.lastSeen > FORGET_SEC;
    if (fresh) { this.target = id; this.seenAt = now; this.nextErrAt = now; }
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
    const cone = this.p.coneRad * (1 - TIGHTEN * Math.min(1, tracked / TIGHTEN_SEC));
    const exact = lookAt(eye, point);
    const want = { yaw: exact.yaw + this.err.yaw * cone, pitch: exact.pitch + this.err.pitch * cone };
    const t = 1 - Math.exp(-this.p.turnRate * dt);
    const lim = this.p.maxTurn * dt;
    const clampStep = (x: number) => Math.max(-lim, Math.min(lim, x * t));
    const aim = { yaw: cur.yaw + clampStep(wrapAngle(want.yaw - cur.yaw)), pitch: cur.pitch + clampStep(want.pitch - cur.pitch) };
    const range = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
    const tolerance = cone + Math.atan2(0.6, Math.max(range, 0.1));
    return { ...aim, ready: tracked >= this.p.reactSec - 1e-9, onTarget: angleBetween(aim, exact) <= tolerance };
  }

  reset() { this.target = -1; this.lastSeen = -Infinity; }
}
