import type { Snapshot, Vec3 } from '../../sim/types';

/**
 * Killcam data (pure): a ring buffer of the last few seconds of snapshots as this client received them,
 * the plan for a replay window ending at your death, and sampling players in between snapshots.
 * Built from snapshots (not re-simulated) because guests don't run the sim; what a guest didn't receive
 * (interest management hides far players) simply isn't in the window, and the plan trims or skips.
 */

/** History kept (s of sim time). */
export const HISTORY_SEC = 6;
/** Wanted replay length (s). */
export const KILLCAM_SEC = 5;
/** Shorter than this isn't worth showing (s). */
export const KILLCAM_MIN_SEC = 1.2;
/** The replay ends this long before the respawn (s), so the respawn flow never waits on it. */
export const RESPAWN_MARGIN = 0.35;
/** The replay runs on past the death a little (the fall), at most this long (s). */
export const TAIL_SEC = 0.6;
/** Gaps in the killer's track longer than this (s) cut the window: earlier frames aren't used. */
export const MAX_GAP_SEC = 0.4;
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

  /** The frames around sim time t: a (last at or before t) and b (first after; = a past the end), u in [0,1]. */
  bracket(t: number): { a: Snapshot; b: Snapshot; u: number } | null {
    const f = this.frames;
    if (!f.length) return null;
    if (t <= f[0].time) return { a: f[0], b: f[0], u: 0 };
    let i = f.length - 1;
    while (i > 0 && f[i].time > t) i--;
    const a = f[i], b = f[Math.min(f.length - 1, i + 1)];
    const h = b.time - a.time;
    return { a, b, u: h > 0 ? Math.min(1, (t - a.time) / h) : 0 };
  }
}

/** Whether `id` is in a frame and perceivable there (not hidden by interest management). */
export function seenIn(s: Snapshot, id: number): boolean {
  return !s.hidden?.includes(id) && s.players.some((p) => p.id === id);
}

export type KillcamPlan = { from: number; to: number; duration: number };

/**
 * The replay window for a death at `deathT` by `killer`:
 * - length: KILLCAM_SEC, cut to fit before the respawn (`respawnIn` s from now; null = no respawn coming)
 * - ends a little after the death (TAIL_SEC, less when short), starts that length earlier
 * - starts no earlier than the history goes back, and only where the killer is continuously seen up to
 *   the death (a gap > MAX_GAP_SEC, or not seen at all, trims the start)
 * Null (skip the killcam) when there's no killer or what's left is shorter than KILLCAM_MIN_SEC.
 */
export function planKillcam(frames: readonly Snapshot[], deathT: number, killer: number | null, respawnIn: number | null): KillcamPlan | null {
  if (killer === null) return null;
  const maxLen = respawnIn === null ? KILLCAM_SEC : Math.min(KILLCAM_SEC, respawnIn - RESPAWN_MARGIN);
  if (maxLen < KILLCAM_MIN_SEC) return null;
  const to = deathT + Math.min(TAIL_SEC, maxLen * 0.15);
  let from = to - maxLen;
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
  return { from, to, duration: to - from };
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

/** Events of frames in (after, upTo]: what happened since the last replay frame (shots, hits, booms). */
export function eventsBetween(frames: readonly Snapshot[], after: number, upTo: number): Snapshot['events'] {
  const out: Snapshot['events'] = [];
  for (const f of frames) if (f.time > after && f.time <= upTo) out.push(...f.events);
  return out;
}
