import { PLAYER } from '../constants';
import { STAMINA } from '../movement';
import type { PlayerState, Vec3 } from '../types';
import { v3 } from '../vec';
import type { ParkourSkill, ParkourTuning } from './params';

/**
 * Bot parkour: jumping gaps and hopping up onto ledges the way a player does, within exactly what the movement model
 * allows (movement.ts: jump velocity, gravity, sprint speed, stamina). Nav finds where a jump is part of the route
 * (Nav.leapHint: a gap in a bridge or pier, a ledge to climb); a Leaper carries it out: run-up, takeoff at the edge
 * (early by the skill's slop), then the air steering in Bot.think brings it down on solid ground. A jump whose flight
 * (Nav.landsOnGround) wouldn't land is never taken: the bot balks at the edge and backs off instead.
 */

const G = PLAYER.gravity, VY = PLAYER.jumpVelocity;
/** Highest a jump lifts the feet (m): ~1.08. The controller's autostep (0.35) adds a little on a ledge. */
export const JUMP_APEX = (VY * VY) / (2 * G);
/** Body centre this far past the far edge on landing (the capsule needs most of its base on the deck). */
export const LAND_PAD = 0.6;
/** Takeoff happens at least this far before the edge (never with the centre over it). */
const EDGE_KEEP = 0.12;
/** Run-up: closer than this to the edge without speed, back off to `RUNUP` first. */
const RUNUP_MIN = 0.9, RUNUP = 1.8;
/** A hint farther than this along the way is not for now. */
const HINT_NEAR = 4.5;
/** Bridge decks go down this far apart (bot.ts SCAFFOLD_STEP): a jumped gap saves ceil(gap / this) decks. */
const DECK_STEP = 3.8;
/** Same edge balked at: leave it this long (then the route builds instead, see Nav.leapBan). */
export const BALK_BAN_SEC = 12;

/** Flight time until the feet come back down to `dh` above takeoff (null: a jump never gets that high). */
export function flightTime(dh: number): number | null {
  const disc = VY * VY - 2 * G * dh;
  return disc < 0 ? null : (VY + Math.sqrt(disc)) / G;
}

/** Horizontal distance a jump at `speed` covers before coming down to `dh` above takeoff (0: can't reach dh). */
export function jumpReach(speed: number, dh: number): number {
  const t = flightTime(dh);
  return t === null ? 0 : speed * t;
}

/** Can I sprint now (the stamina rules in movement.ts stepStamina)? */
export function canSprint(me: PlayerState): boolean {
  const mv = me.mv;
  if (!mv) return true;
  return !mv.exhausted && (mv.sprinting || mv.stamina >= STAMINA.startMin);
}

/** Can a jump at this speed clear a `gap` landing `dh` higher, taking off up to `early` m before the edge? */
export function makeable(gap: number, dh: number, early: number, speed: number, margin: number): boolean {
  return jumpReach(speed, dh) >= (gap + early + EDGE_KEEP + LAND_PAD) * margin;
}

/** Where a jump is part of the route: take off at `edge` heading `dir`; solid again at `land` (feet height `landY`). */
export type LeapHint = { kind: 'gap' | 'climb'; edge: Vec3; land: Vec3; dir: Vec3; gap: number; landY: number; key: string };

export type ParkourStats = {
  /** Gap jumps landed on the far side; climbs landed on top. */
  jumps: number; climbs: number;
  /** Took off and came down in the water (or back short of the far side). */
  fails: number;
  /** Reached the edge and didn't trust the flight: stopped and backed off (recoverable, no harm). */
  balks: number;
  /** Bridge/pier gaps (distinct) left open because jumping them was enough, and the decks that saved. */
  gapsSkipped: number; decksSaved: number;
  /** Ramp-rush chains started, ramps placed in them. */
  rushes: number; rushRamps: number;
};
export const newStats = (): ParkourStats => ({ jumps: 0, climbs: 0, fails: 0, balks: 0, gapsSkipped: 0, decksSaved: 0, rushes: 0, rushRamps: 0 });

type Plan = LeapHint & { early: number; phase: 'run' | 'backup' | 'air'; startY: number; at: number };
export type LeapMove = { dir: Vec3; jump: boolean; sprint: boolean; note: string };

/**
 * In the air, aiming to come down on `aim`: the horizontal velocity to wish for (capped at `speed`): whatever
 * covers the distance left in the time left before the feet reach the aim's height (moving straight there when
 * already level or below it).
 */
export function airWish(x: number, z: number, y: number, vy: number, aim: Vec3, speed: number): { x: number; z: number } {
  const dh = aim.y - y;
  const disc = vy * vy - 2 * G * dh;
  const t = disc < 0 ? 0.05 : Math.max(0.05, (vy + Math.sqrt(disc)) / G);
  let wx = (aim.x - x) / t, wz = (aim.z - z) / t;
  const l = Math.hypot(wx, wz);
  if (l > speed) { wx *= speed / l; wz *= speed / l; }
  return { x: wx, z: wz };
}

const dot2 = (a: Vec3, b: Vec3) => a.x * b.x + a.z * b.z;

export class Leaper {
  plan: Plan | null = null;
  readonly stats = newStats();
  /** Edges I balked at: key → until when they're off (Nav reads this to stop routing over them). */
  readonly banned = new Map<string, number>();
  /** Gaps jumped at least once (each would have taken decks to close). */
  private readonly skipped = new Set<string>();
  /** Last thing done, for spectators: text and when. */
  note: { t: number; text: string } | null = null;

  constructor(private readonly rng: () => number) {}

  reset() { this.plan = null; }

  /** Where the jump in progress means to come down (null: none). */
  get aim(): Vec3 | null { return this.plan ? aimOf(this.plan) : null; }

  isBanned(key: string, now: number): boolean { return (this.banned.get(key) ?? -Infinity) > now; }

  /**
   * One tick: the movement a jump in progress (or a fresh hint) wants, or null when there is none. `lands(dir,
   * sprint)` flies a jump from here (Nav.landsOnGround with jump velocity). A death mid-air counts as a fail
   * (call `died()`).
   */
  step(me: PlayerState, now: number, hint: LeapHint | null, skill: ParkourSkill, tune: ParkourTuning,
    lands: (dir: Vec3, sprint: boolean, aim: Vec3) => boolean): LeapMove | null {
    const grounded = me.mv ? me.mv.grounded : Math.abs(me.vel.y) < 0.05;
    let p = this.plan;
    if (p && p.phase === 'air') {
      if (!grounded || now - p.at < 0.1) {
        // Steer for the landing spot (pull back rather than sail past a short deck).
        const w = airWish(me.pos.x, me.pos.z, me.pos.y, me.vel.y, aimOf(p), PLAYER.sprint);
        return { dir: v3(w.x / PLAYER.sprint, 0, w.z / PLAYER.sprint), jump: false, sprint: true, note: this.say(p, 'in the air') };
      }
      // Down again: on the far side, or short (back where I started).
      const past = dot2(me.pos, p.dir) - dot2(p.edge, p.dir);
      const made = p.kind === 'gap' ? past > p.gap * 0.5 : me.pos.y > p.startY + 0.3;
      if (made && p.kind === 'gap') {
        this.stats.jumps++;
        if (!this.skipped.has(p.key)) { this.skipped.add(p.key); this.stats.gapsSkipped++; this.stats.decksSaved += Math.max(1, Math.ceil(p.gap / DECK_STEP)); }
      } else if (made) this.stats.climbs++;
      else { this.stats.fails++; this.banned.set(p.key, now + BALK_BAN_SEC); }
      this.note = { t: now, text: made ? (p.kind === 'gap' ? `Jumped a ${p.gap.toFixed(1)} m gap` : 'Climbed up') : 'Came up short' };
      this.plan = null;
      return null;
    }
    if (!grounded) return null;
    if (p && hint && hint.key !== p.key) p = this.plan = null;
    if (!p) {
      if (!hint || this.isBanned(hint.key, now)) return null;
      const ahead = dot2(hint.edge, hint.dir) - dot2(me.pos, hint.dir);
      if (ahead < -0.2 || ahead > HINT_NEAR) return null;
      p = this.plan = { ...hint, early: this.rng() * skill.slop, phase: 'run', startY: me.pos.y, at: now };
    }
    // Route moved on (another way, or a goal change): drop it.
    if (!hint || hint.key !== p.key) { this.plan = null; return null; }
    const toEdge = dot2(p.edge, p.dir) - dot2(me.pos, p.dir);
    const sprint = canSprint(me);
    const speed = sprint ? PLAYER.sprint : PLAYER.walk;
    const along = dot2(me.vel, p.dir);
    // Hold the line: steer back onto the takeoff point's lateral position while running at the edge.
    const lat = v3(p.edge.x - me.pos.x - p.dir.x * toEdge, 0, p.edge.z - me.pos.z - p.dir.z * toEdge);
    const steer = (k: number) => {
      const d = v3(p!.dir.x * k + lat.x * 0.8, 0, p!.dir.z * k + lat.z * 0.8);
      const l = Math.hypot(d.x, d.z) || 1;
      return v3(d.x / l, 0, d.z / l);
    };
    if (p.phase === 'backup') {
      if (toEdge >= RUNUP) p.phase = 'run';
      else return { dir: steer(-1), jump: false, sprint: false, note: this.say(p, 'backing up for a run-up') };
    }
    // Climb: take off where the arc is near its top as the body meets the face; a gap: at the edge, early by the slop.
    const takeoff = p.kind === 'climb' ? climbTakeoff(p.landY - me.pos.y, speed) : EDGE_KEEP + p.early;
    if (takeoff === null || (p.kind === 'gap' && !makeable(p.gap, p.landY - me.pos.y, p.early, speed, tune.margin))) {
      // Can't make it from here at this speed (winded): not a jump for now.
      this.balk(p, now, 'too far for me now');
      return null;
    }
    if (toEdge > takeoff) {
      if (toEdge < RUNUP_MIN && along < 0.6 * speed) { p.phase = 'backup'; return { dir: steer(-1), jump: false, sprint: false, note: this.say(p, 'backing up for a run-up') }; }
      return { dir: steer(1), jump: false, sprint: true, note: this.say(p, 'run-up') };
    }
    // At the takeoff point: jump only with the speed for it and a flight that comes down on something solid.
    const fast = along >= 0.8 * speed;
    if (fast && (p.kind === 'climb' || lands(p.dir, sprint, aimOf(p)))) {
      p.phase = 'air'; p.at = now; p.startY = me.pos.y;
      return { dir: p.dir, jump: true, sprint: true, note: this.say(p, 'jump') };
    }
    if (toEdge < 0.05 || p.kind === 'climb') {
      this.balk(p, now, fast ? "wouldn't land it" : 'no speed');
      return { dir: steer(-1), jump: false, sprint: false, note: 'Balked at the edge' };
    }
    return { dir: steer(1), jump: false, sprint: true, note: this.say(p, 'run-up') };
  }

  /** Died while a jump was in the air: it went into the water. */
  died(now: number) {
    if (this.plan?.phase === 'air') { this.stats.fails++; this.banned.set(this.plan.key, now + BALK_BAN_SEC); }
    this.plan = null;
  }

  private balk(p: Plan, now: number, why: string) {
    this.stats.balks++;
    this.banned.set(p.key, now + BALK_BAN_SEC);
    this.note = { t: now, text: `Didn't jump: ${why}` };
    this.plan = null;
  }

  private say(p: Plan, what: string): string {
    return p.kind === 'gap' ? `Jumping a ${p.gap.toFixed(1)} m gap: ${what}` : `Climbing up ${Math.max(0, p.landY - p.startY).toFixed(1)} m: ${what}`;
  }
}

/** Where a jump aims to come down: a little past the far edge (the whole body on it), at its height. */
function aimOf(p: LeapHint): Vec3 {
  const k = p.kind === 'gap' ? LAND_PAD + 0.5 : LAND_PAD;
  return v3(p.land.x + p.dir.x * k, p.landY, p.land.z + p.dir.z * k);
}

/**
 * Distance before a ledge `rise` m up to take off at `speed` so the body meets the face near the top of its arc
 * (feet within the autostep of the top), or null when the jump can't clear it.
 */
export function climbTakeoff(rise: number, speed: number): number | null {
  const need = rise - 0.3; // autostep lifts the last bit
  if (need > JUMP_APEX - 0.02) return null;
  if (need <= 0) return 0.6;
  // Feet at or above `need` between t1 and t2 (VY t - G t²/2 = need); meet the face (front of the capsule) mid-way.
  const disc = Math.sqrt(VY * VY - 2 * G * need);
  const t1 = (VY - disc) / G, t2 = (VY + disc) / G;
  return PLAYER.radius + speed * (0.4 * t1 + 0.6 * Math.min(t2, VY / G));
}

type GroundAt = (x: number, z: number) => number | null;

/**
 * Walking from `from` (feet) toward `to`: the face of the first ledge on the way (top more than a step and at most
 * `up` above my feet, solid for a body's width on top) and its top height, or null (flat, or too high to jump).
 */
export function ledgeOnWay(groundAt: GroundAt, from: Vec3, to: Vec3, up: number): { face: Vec3; top: number } | null {
  const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
  if (len < 0.2) return null;
  const ux = dx / len, uz = dz / len;
  for (let k = 0.1; k <= len + 0.3; k += 0.1) {
    const x = from.x + ux * k, z = from.z + uz * k;
    const g = groundAt(x, z);
    if (g === null) return null;
    const rise = g - from.y;
    if (rise <= 0.4) continue;
    if (rise > up) return null;
    // A pad on top, a body wide and deep (not a post or a wall top).
    for (const [ox, oz] of [[ux * 0.4, uz * 0.4], [ux * 0.3 - uz * 0.3, uz * 0.3 + ux * 0.3], [ux * 0.3 + uz * 0.3, uz * 0.3 - ux * 0.3]]) {
      const t = groundAt(x + ox, z + oz);
      if (t === null || Math.abs(t - g) > 0.15) return null;
    }
    return { face: v3(x, from.y, z), top: g };
  }
  return null;
}

/**
 * High spots to hop up onto near `me` (feet): tops between a step and `up` above my ground, with room to stand,
 * nearest first; at most `n`. Sampled on rings (1 m apart, every 22.5°) out to `range`.
 */
export function perchesNear(groundAt: GroundAt, me: Vec3, up: number, range: number, n = 3): Vec3[] {
  const out: { p: Vec3; d: number }[] = [];
  for (let r = 1.5; r <= range; r += 1) for (let a = 0; a < 16; a++) {
    const [cx, cz] = RING[a]; // fixed unit vectors: no runtime trig in the sim
    const x = me.x + cx * r, z = me.z + cz * r;
    const g = groundAt(x, z);
    if (g === null || g - me.y <= 0.45 || g - me.y > up) continue;
    let flat = true;
    for (const [ox, oz] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
      const t = groundAt(x + ox, z + oz);
      if (t === null || Math.abs(t - g) > 0.12) { flat = false; break; }
    }
    if (flat) out.push({ p: v3(x, g, z), d: r });
    if (out.length >= n) return out.map((o) => o.p);
  }
  return out.map((o) => o.p);
}
/** Unit vectors every 22.5° (exact constants: no runtime trig). */
const C1 = 0.9238795325112867, S1 = 0.3826834323650898, H = Math.SQRT1_2;
const RING: [number, number][] = [
  [1, 0], [C1, S1], [H, H], [S1, C1], [0, 1], [-S1, C1], [-H, H], [-C1, S1],
  [-1, 0], [-C1, -S1], [-H, -H], [-S1, -C1], [0, -1], [S1, -C1], [H, -H], [C1, -S1],
];
