import { HEAD, PLAYER } from './constants';
import { raySphere } from './physics';
import type { PlayerState, Vec3 } from './types';

/**
 * Lag compensation (server-side rewind). A remote player sees everyone else a little in the past
 * (network delay + interpolation delay), so their hitscan shots are resolved against where the
 * targets were at the time the shooter was looking at (the client sends that time with its input),
 * not where they are now on the host. Walls and pieces stay as they are now.
 */
export const LAG_COMP = {
  /** Hitbox history kept (s). */
  historySec: 0.6,
  /** Never rewind further than this (s): bounds what a lying or very laggy client can claim. */
  maxRewindSec: 0.4,
};

type Frame = { t: number; ids: number[]; xs: Float64Array; alive: Uint8Array };

/** Ring of per-tick player feet positions (alive only), interpolated at any time inside the window. */
export class HitboxHistory {
  private frames: Frame[] = [];

  record(t: number, players: Iterable<PlayerState>): void {
    const ids: number[] = [], pos: number[] = [], alive: number[] = [];
    for (const p of players) { ids.push(p.id); pos.push(p.pos.x, p.pos.y, p.pos.z); alive.push(p.alive ? 1 : 0); }
    this.frames.push({ t, ids, xs: Float64Array.from(pos), alive: Uint8Array.from(alive) });
    while (this.frames.length > 2 && this.frames[0].t < t - LAG_COMP.historySec) this.frames.shift();
  }

  get newest(): number | null { return this.frames.length ? this.frames[this.frames.length - 1].t : null; }
  get oldest(): number | null { return this.frames.length ? this.frames[0].t : null; }

  /**
   * Feet position of player `id` at time t (linear between ticks), or null if they weren't alive (in
   * either neighbouring tick) or t is outside the history. A teleport (respawn) between two ticks
   * is never blended: the nearer tick wins.
   */
  at(t: number, id: number, out: Vec3): Vec3 | null {
    const f = this.frames;
    if (!f.length || t < f[0].t - 1e-6 || t > f[f.length - 1].t + 1e-6) return null;
    let i = f.length - 1;
    while (i > 0 && f[i - 1].t >= t) i--;
    // f[i].t >= t > f[i-1].t (or i = 0)
    const b = f[i], a = i > 0 ? f[i - 1] : b;
    const ia = a.ids.indexOf(id), ib = b.ids.indexOf(id);
    if (ia < 0 || ib < 0 || !a.alive[ia] || !b.alive[ib]) return null;
    const h = b.t - a.t;
    let u = h > 1e-9 ? (t - a.t) / h : 1;
    const ax = a.xs[ia * 3], ay = a.xs[ia * 3 + 1], az = a.xs[ia * 3 + 2];
    const bx = b.xs[ib * 3], by = b.xs[ib * 3 + 1], bz = b.xs[ib * 3 + 2];
    if (Math.hypot(bx - ax, by - ay, bz - az) > 3) u = u < 0.5 ? 0 : 1;
    out.x = ax + (bx - ax) * u; out.y = ay + (by - ay) * u; out.z = az + (bz - az) * u;
    return out;
  }
}

const CAP_R = PLAYER.radius;
/** Capsule core segment, feet-relative heights (same shape as Physics.addPlayer's collider). */
const CAP_Y0 = PLAYER.radius, CAP_Y1 = PLAYER.height - PLAYER.radius;

/**
 * Distance along a unit ray to a player's capsule standing at `feet` (null = miss), and whether it's a
 * headshot (same rule as Physics.raycast: the ray also passes through the head sphere just behind the entry).
 */
export function rayPlayer(o: Vec3, d: Vec3, feet: Vec3, maxDist: number): { dist: number; part: 'head' | 'body' } | null {
  const t = rayCapsule(o, d, feet);
  if (t === null || t > maxDist) return null;
  const head = raySphere(o, d, { x: feet.x, y: feet.y + HEAD.y, z: feet.z }, HEAD.r);
  return { dist: t, part: head !== null && head - t < HEAD.r * 2 ? 'head' : 'body' };
}

/** Ray vs vertical capsule (core from feet.y+CAP_Y0 to feet.y+CAP_Y1, radius CAP_R). */
export function rayCapsule(o: Vec3, d: Vec3, feet: Vec3): number | null {
  const y0 = feet.y + CAP_Y0, y1 = feet.y + CAP_Y1;
  let best: number | null = null;
  // Infinite vertical cylinder around x=feet.x, z=feet.z, clipped to the core's height.
  const ox = o.x - feet.x, oz = o.z - feet.z;
  const a = d.x * d.x + d.z * d.z;
  const c = ox * ox + oz * oz - CAP_R * CAP_R;
  if (a > 1e-12) {
    const b = ox * d.x + oz * d.z;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const tt = t >= 0 ? t : c <= 0 ? 0 : null; // inside the cylinder: hit at 0
      if (tt !== null) {
        const y = o.y + d.y * tt;
        if (y >= y0 && y <= y1) best = tt;
      }
    }
  } else if (c <= 0 && o.y >= y0 - CAP_R && o.y <= y1 + CAP_R) {
    best = 0; // vertical ray starting inside
  }
  // End caps.
  for (const cy of [y0, y1]) {
    const t = raySphere(o, d, { x: feet.x, y: cy, z: feet.z }, CAP_R);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}
