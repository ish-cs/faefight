import * as dm from '../dmath';
import { aimDir } from '../combat';
import type { Difficulty, Vec3 } from '../types';
import { sub, yawOf } from '../vec';

const DEG = Math.PI / 180;

/**
 * reactSec: time from first sighting to the first shot. coneRad: aim error radius (tightens while tracking).
 * turnRate: smoothing of the tracking (1/s). maxTurn: fastest flick a hand manages (rad/s).
 * recoilComp: share of each recoil kick pulled straight back down (0 = rides the climb, 1 = perfect).
 */
export type AimProfile = { reactSec: number; coneRad: number; turnRate: number; maxTurn: number; recoilComp: number };

export const AIM: Record<Difficulty, AimProfile> = {
  easy: { reactSec: 0.8, coneRad: 14 * DEG, turnRate: 4, maxTurn: 6, recoilComp: 0.25 },
  medium: { reactSec: 0.5, coneRad: 8 * DEG, turnRate: 6, maxTurn: 8, recoilComp: 0.6 },
  hard: { reactSec: 0.24, coneRad: 3 * DEG, turnRate: 11, maxTurn: 11, recoilComp: 0.85 },
  // Human pro: ~0.2 s reaction, ~2° error that tightens to ~1.4° while tracking (still misses at range),
  // fast smooth tracking, flicks capped at ~690°/s, near-perfect spray control.
  pro: { reactSec: 0.18, coneRad: 1.5 * DEG, turnRate: 16, maxTurn: 12, recoilComp: 0.95 },
};

/** Losing sight longer than this makes the next sighting a fresh reaction. */
const FORGET_SEC = 1;
const TIGHTEN = 0.3;
const TIGHTEN_SEC = 1;
const WOBBLE_RATE = 6;

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

  constructor(private readonly p: AimProfile, private readonly rng: () => number) {}

  track(now: number, dt: number, eye: Vec3, point: Vec3, id: number, cur: Angles): AimResult {
    cur = this.compensate(cur);
    const fresh = id !== this.target || now - this.lastSeen > FORGET_SEC;
    if (fresh) { this.target = id; this.seenAt = now; this.nextErrAt = now; }
    this.lastSeen = now;
    if (now >= this.nextErrAt) {
      const a = this.rng() * 2 * Math.PI, r = Math.sqrt(this.rng());
      this.errGoal = { yaw: dm.cos(a) * r, pitch: dm.sin(a) * r };
      this.nextErrAt = now + 0.25 + 0.2 * this.rng();
      if (fresh) this.err = { ...this.errGoal };
    }
    const w = 1 - dm.exp(-WOBBLE_RATE * dt);
    this.err = { yaw: this.err.yaw + (this.errGoal.yaw - this.err.yaw) * w, pitch: this.err.pitch + (this.errGoal.pitch - this.err.pitch) * w };

    const tracked = now - this.seenAt;
    const cone = this.p.coneRad * (1 - TIGHTEN * Math.min(1, tracked / TIGHTEN_SEC));
    const exact = lookAt(eye, point);
    const want = { yaw: exact.yaw + this.err.yaw * cone, pitch: exact.pitch + this.err.pitch * cone };
    const t = 1 - dm.exp(-this.p.turnRate * dt);
    const lim = this.p.maxTurn * dt;
    const clampStep = (x: number) => Math.max(-lim, Math.min(lim, x * t));
    const aim = { yaw: cur.yaw + clampStep(wrapAngle(want.yaw - cur.yaw)), pitch: cur.pitch + clampStep(want.pitch - cur.pitch) };
    const range = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
    const tolerance = cone + dm.atan2(0.6, Math.max(range, 0.1));
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

  reset() { this.target = -1; this.lastSeen = -Infinity; this.last = null; }
}
