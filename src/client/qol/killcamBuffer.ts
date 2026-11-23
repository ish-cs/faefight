import type { Snapshot, Vec3 } from '../../sim/types';
import { smoothstep } from '../camPath';

/**
 * Killcam data (pure): a ring buffer of the last few seconds of snapshots as this client received them,
 * the plan for a replay window ending at your death, and sampling players in between snapshots.
 * Built from snapshots (not re-simulated) because guests don't run the sim; what a guest didn't receive
 * (interest management hides far players) simply isn't in the window, and the plan trims or skips.
 */

/** History kept (s of sim time). */
export const HISTORY_SEC = 6;
/** Wanted replay length (s of real time, slow motion included). */
export const KILLCAM_SEC = 4.5;
/** Shorter than this isn't worth showing (s). */
export const KILLCAM_MIN_SEC = 1.2;
/** The replay ends this long before the respawn (s), so the respawn flow never waits on it. */
export const RESPAWN_MARGIN = 0.35;
/** The replay runs on past the death a little (the fall), at most this long (s). */
export const TAIL_SEC = 0.6;
/** Gaps in the killer's track longer than this (s) cut the window: earlier frames aren't used. */
export const MAX_GAP_SEC = 0.4;
/** Slow motion on the killing shot: time scale held this low... */
export const SLOWMO = 0.35;
/** ...easing in over [killT - SLOW_IN, killT - SLOW_HOLD_PRE], held to killT + SLOW_HOLD_POST, easing out by killT + SLOW_OUT (sim s). */
export const SLOW_IN = 0.3, SLOW_HOLD_PRE = 0.1, SLOW_HOLD_POST = 0.12, SLOW_OUT = 0.32;
/** The killing shot is looked for this far before the death (s); older → the death itself is the beat. */
export const KILL_SHOT_WINDOW = 1.5;
/** Positions that jump further than this between snapshots are teleports: no blending. */
const TELEPORT = 3;

export class SnapshotHistory {
  readonly frames: Snapshot[] = [];

  constructor(private keepSec = HISTORY_SEC) {}

  /** Add a snapshot (in arrival order; older/duplicate times are ignored). Drops frames older than keepSec. */
  push(s: Snapshot) {
    const last = this.frames[this.frames.length - 1];
    if (last && s.time <= last.time) return;
    this.frames.push(s);
    const cut = s.time - this.keepSec;
    let n = 0;
    while (n < this.frames.length - 1 && this.frames[n].time < cut) n++;
    if (n) this.frames.splice(0, n);
  }

  clear() { this.frames.length = 0; }

  get oldest(): number | null { return this.frames[0]?.time ?? null; }
  get newest(): number | null { return this.frames[this.frames.length - 1]?.time ?? null; }

  /** Frames with from <= time <= to. */
  range(from: number, to: number): Snapshot[] {
    return this.frames.filter((f) => f.time >= from && f.time <= to);
  }

  /** The frames around sim time t: a = frames[i] (last at or before t) and b (first after; = a past the end), u in [0,1]. */
  bracket(t: number): { a: Snapshot; b: Snapshot; u: number; i: number } | null {
    const f = this.frames;
    if (!f.length) return null;
    if (t <= f[0].time) return { a: f[0], b: f[0], u: 0, i: 0 };
    let i = f.length - 1;
    while (i > 0 && f[i].time > t) i--;
    const a = f[i], b = f[Math.min(f.length - 1, i + 1)];
    const h = b.time - a.time;
    return { a, b, u: h > 0 ? Math.min(1, (t - a.time) / h) : 0, i };
  }
}

/** Whether `id` is in a frame and perceivable there (not hidden by interest management). */
export function seenIn(s: Snapshot, id: number): boolean {
  return !s.hidden?.includes(id) && s.players.some((p) => p.id === id);
}

export type KillcamPlan = {
  /** Sim window replayed. */
  from: number; to: number; duration: number;
  /** Sim time of the killing shot (the slow-motion beat). */
  killT: number;
  /** Real seconds the replay takes (slow motion included). */
  real: number;
};

/** Playback speed at sim time t: 1, easing down to SLOWMO around the killing shot at killT and back. */
export function timeScale(t: number, killT: number): number {
  const d = t - killT;
  if (d <= -SLOW_IN || d >= SLOW_OUT) return 1;
  const k = d < -SLOW_HOLD_PRE ? smoothstep((d + SLOW_IN) / (SLOW_IN - SLOW_HOLD_PRE))
    : d <= SLOW_HOLD_POST ? 1 : 1 - smoothstep((d - SLOW_HOLD_POST) / (SLOW_OUT - SLOW_HOLD_POST));
  return 1 - (1 - SLOWMO) * k;
}

/** How slowed (0 = full speed, 1 = SLOWMO) playback is at t: drives the zoom, bars and shot emphasis. */
export function slowAmount(t: number, killT: number): number {
  return (1 - timeScale(t, killT)) / (1 - SLOWMO);
}

/** Real seconds to play the sim span [from, to] (midpoint rule; the slow beat is smooth). */
export function realSpan(from: number, to: number, killT: number): number {
  if (to <= from) return 0;
  const n = Math.max(8, Math.ceil((to - from) * 240));
  const h = (to - from) / n;
  let r = 0;
  for (let i = 0; i < n; i++) r += h / timeScale(from + (i + 0.5) * h, killT);
  return r;
}

/**
 * The replay window for a death at `deathT` by `killer`, its killing shot at `killT` (default: the death):
 * - real length: KILLCAM_SEC (slow motion included), cut to fit before the respawn (`respawnIn` s from now;
 *   null = no respawn coming)
 * - ends a little after the death (TAIL_SEC, less when short), starts as early as the real length allows
 * - starts no earlier than the history goes back, and only where the killer is continuously seen up to
 *   the death (a gap > MAX_GAP_SEC, or not seen at all, trims the start)
 * Null (skip the killcam) when there's no killer or what's left is shorter than KILLCAM_MIN_SEC.
 */
export function planKillcam(frames: readonly Snapshot[], deathT: number, killer: number | null, respawnIn: number | null, killT = deathT): KillcamPlan | null {
  if (killer === null) return null;
  const maxReal = respawnIn === null ? KILLCAM_SEC : Math.min(KILLCAM_SEC, respawnIn - RESPAWN_MARGIN);
  if (maxReal < KILLCAM_MIN_SEC) return null;
  const to = deathT + Math.min(TAIL_SEC, maxReal * 0.15);
  // The slow beat's extra real time comes out of the sim window.
  const lead = killT - SLOW_IN - 0.01;
  const extra = realSpan(lead, to, killT) - (to - lead);
  let from = to - Math.max(KILLCAM_MIN_SEC, maxReal - extra);
  // Walk back from the death while the killer stays in view.
  let start: number | null = null;
  let prevT: number | null = null;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.time > deathT) continue;
    if (f.time < from) break;
    if (!seenIn(f, killer)) { if (start === null) return null; break; }
    if (prevT !== null && prevT - f.time > MAX_GAP_SEC) break;
    start = f.time;
    prevT = f.time;
  }
  if (start === null) return null;
  from = Math.max(from, start);
  if (deathT - from < KILLCAM_MIN_SEC * 0.75 || to - from < KILLCAM_MIN_SEC) return null;
  // Still too long in real time (short window, so the slow beat is a bigger share): start later.
  let real = realSpan(from, to, killT);
  while (real > maxReal + 1e-6 && to - from > KILLCAM_MIN_SEC) { from += 1 / 30; real = realSpan(from, to, killT); }
  if (real > maxReal + 1e-6) return null;
  return { from, to, duration: to - from, killT, real };
}

export type KillShot = {
  /** Sim time of the hit (or shot) that killed. */
  t: number;
  /** Shot line (eye to where it landed), when the shot is on record. */
  from: Vec3 | null;
  to: Vec3 | null;
  headshot: boolean;
};

/**
 * The shot that killed `victim`: the killer's last hit on them in the KILL_SHOT_WINDOW before the death, and the
 * shot it came from. No hit on record (an explosion off-screen, a debug kill): the death itself is the beat.
 */
export function findKillShot(frames: readonly Snapshot[], deathT: number, killer: number, victim: number): KillShot {
  let hit: Snapshot['events'][number] | null = null;
  let shot: Snapshot['events'][number] | null = null;
  for (let i = frames.length - 1; i >= 0 && !hit; i--) {
    const f = frames[i];
    if (f.time > deathT + 1e-6) continue;
    if (f.time < deathT - KILL_SHOT_WINDOW) break;
    for (let j = f.events.length - 1; j >= 0; j--) {
      const e = f.events[j];
      if (e.type === 'hit' && e.data.by === killer && e.data.target === victim) { hit = e; break; }
    }
  }
  const before = hit ? hit.t : deathT;
  for (let i = frames.length - 1; i >= 0 && !shot; i--) {
    const f = frames[i];
    if (f.time > before + 1e-6) continue;
    if (f.time < before - 0.5) break;
    for (let j = f.events.length - 1; j >= 0; j--) {
      const e = f.events[j];
      if (e.type === 'shot' && e.data.by === killer && e.t <= before + 1e-6) { shot = e; break; }
    }
  }
  const v = (x: unknown) => (x && typeof x === 'object' && 'x' in x ? (x as Vec3) : null);
  const to = v(hit?.data.pos) ?? v(shot?.data.to);
  return { t: hit?.t ?? shot?.t ?? deathT, from: v(shot?.data.from), to, headshot: hit?.data.part === 'head' };
}

export type PlayerSample = { pos: Vec3; vel: Vec3; yaw: number; pitch: number };

const angleLerp = (a: number, b: number, u: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * u;

/**
 * Player `id` between two frames: linear position (velocity from the pair), shortest-way yaw. A teleport
 * or a frame where they're missing/hidden holds whichever frame has them. Null if neither does.
 */
export function samplePlayer(a: Snapshot, b: Snapshot, u: number, id: number, out?: PlayerSample): PlayerSample | null {
  const pa = seenIn(a, id) ? a.players.find((p) => p.id === id) : undefined;
  const pb = seenIn(b, id) ? b.players.find((p) => p.id === id) : undefined;
  const o = out ?? { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  if (!pa && !pb) return null;
  const h = b.time - a.time;
  const jump = pa && pb ? Math.hypot(pb.pos.x - pa.pos.x, pb.pos.y - pa.pos.y, pb.pos.z - pa.pos.z) > TELEPORT : true;
  if (!pa || !pb || jump || h <= 0) {
    const p = pa && (!pb || u < 0.5 || h <= 0) ? pa : pb!;
    o.pos.x = p.pos.x; o.pos.y = p.pos.y; o.pos.z = p.pos.z;
    o.vel.x = p.vel.x; o.vel.y = p.vel.y; o.vel.z = p.vel.z;
    o.yaw = p.yaw; o.pitch = p.pitch;
    return o;
  }
  o.pos.x = pa.pos.x + (pb.pos.x - pa.pos.x) * u;
  o.pos.y = pa.pos.y + (pb.pos.y - pa.pos.y) * u;
  o.pos.z = pa.pos.z + (pb.pos.z - pa.pos.z) * u;
  o.vel.x = (pb.pos.x - pa.pos.x) / h; o.vel.y = (pb.pos.y - pa.pos.y) / h; o.vel.z = (pb.pos.z - pa.pos.z) / h;
  o.yaw = angleLerp(pa.yaw, pb.yaw, u);
  o.pitch = pa.pitch + (pb.pitch - pa.pitch) * u;
  return o;
}

const find = (f: Snapshot | undefined, id: number) => (f && seenIn(f, id) ? f.players.find((p) => p.id === id) : undefined);
const near = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) <= TELEPORT;
const unwrap = (ref: number, a: number) => ref + Math.atan2(Math.sin(a - ref), Math.cos(a - ref));

/** Cubic Hermite with Catmull-Rom tangents over non-uniform times: value and d/dt at u in [0,1] of [t1, t2]. */
function hermite(p0: number, p1: number, p2: number, p3: number, t0: number, t1: number, t2: number, t3: number, u: number, out: { v: number; d: number }) {
  const h = t2 - t1;
  const m1 = t2 > t0 ? ((p2 - p0) / (t2 - t0)) * h : p2 - p1;
  const m2 = t3 > t1 ? ((p3 - p1) / (t3 - t1)) * h : p2 - p1;
  const u2 = u * u, u3 = u2 * u;
  out.v = (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
  out.d = ((6 * u2 - 6 * u) * p1 + (3 * u2 - 4 * u + 1) * m1 + (-6 * u2 + 6 * u) * p2 + (3 * u2 - 2 * u) * m2) / h;
}
const _h = { v: 0, d: 0 };

/**
 * Player `id` at u between frames[i] and frames[i+1], on a smooth curve through the recorded positions and look
 * angles (Catmull-Rom tangents from the neighbouring frames): exact at every snapshot, no velocity steps between
 * them, so slow motion doesn't stutter at the snapshot rate. Neighbours that are missing, hidden or across a
 * teleport fall back to the bracket's own frames; a missing/teleporting bracket falls back to samplePlayer.
 */
export function sampleSmooth(frames: readonly Snapshot[], i: number, u: number, id: number, out?: PlayerSample): PlayerSample | null {
  const a = frames[i], b = frames[Math.min(frames.length - 1, i + 1)];
  if (!a) return null;
  const pa = find(a, id), pb = find(b, id);
  if (!pa || !pb || b.time <= a.time || !near(pa.pos, pb.pos)) return samplePlayer(a, b, u, id, out);
  const o = out ?? { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  const f0 = frames[i - 1], f3 = frames[i + 2];
  let p0 = find(f0, id), p3 = find(f3, id);
  if (p0 && !near(p0.pos, pa.pos)) p0 = undefined;
  if (p3 && !near(p3.pos, pb.pos)) p3 = undefined;
  // Missing neighbour: mirror the segment (a straight, even-speed end) rather than invent a turn.
  const t0 = p0 ? f0!.time : a.time - (b.time - a.time), t3 = p3 ? f3!.time : b.time + (b.time - a.time);
  const axis = (k: 'x' | 'y' | 'z') => {
    const v0 = p0 ? p0.pos[k] : 2 * pa.pos[k] - pb.pos[k], v3 = p3 ? p3.pos[k] : 2 * pb.pos[k] - pa.pos[k];
    hermite(v0, pa.pos[k], pb.pos[k], v3, t0, a.time, b.time, t3, u, _h);
    o.pos[k] = _h.v; o.vel[k] = _h.d;
  };
  axis('x'); axis('y'); axis('z');
  const ya = pa.yaw, yb = unwrap(ya, pb.yaw);
  const y0 = p0 ? unwrap(ya, p0.yaw) : 2 * ya - yb, y3 = p3 ? unwrap(yb, p3.yaw) : 2 * yb - ya;
  hermite(y0, ya, yb, y3, t0, a.time, b.time, t3, u, _h);
  o.yaw = _h.v;
  const q0 = p0 ? p0.pitch : 2 * pa.pitch - pb.pitch, q3 = p3 ? p3.pitch : 2 * pb.pitch - pa.pitch;
  hermite(q0, pa.pitch, pb.pitch, q3, t0, a.time, b.time, t3, u, _h);
  o.pitch = _h.v;
  return o;
}

/** Events of frames in (after, upTo]: what happened since the last replay frame (shots, hits, booms). */
export function eventsBetween(frames: readonly Snapshot[], after: number, upTo: number): Snapshot['events'] {
  const out: Snapshot['events'] = [];
  for (const f of frames) if (f.time > after && f.time <= upTo) out.push(...f.events);
  return out;
}
