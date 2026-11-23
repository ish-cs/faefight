/**
 * Movement jitter statistics for headless bot runs (tests/sim/botMoveJitter.test.ts, scripts/ci/moveJitter.ts).
 * Measurement only: nothing in the game reads this.
 *
 * Per tick a bot has a wish direction (the world-space walk input, from Bot.moveDir) and a velocity. A *flip* is
 * the direction turning by more than FLIP_DEG within FLIP_SEC: a step one way, then straight back, faster than a
 * person changes their mind. A single flip is fine (a strafe changing sides); a *rapid* flip comes within RAPID_SEC of
 * the one before it (back and forth faster than a person taps A-D). An *episode* is jitter in place: FLIPS_MIN or more flips each within EPISODE_GAP_SEC
 * of the last, all while the body stays inside a circle of EPISODE_R m.
 */

export const FLIP_DEG = 120;
export const FLIP_SEC = 0.3;
export const EPISODE_GAP_SEC = 0.6;
export const EPISODE_R = 1;
export const FLIPS_MIN = 3;
export const RAPID_SEC = 0.4;
/** Below this the input counts as no input, and below VEL_MIN m/s the body as standing (no direction). */
const WISH_MIN = 0.1, VEL_MIN = 1;
const COS_FLIP = Math.cos((FLIP_DEG * Math.PI) / 180);

export type MoveSample = {
  alive: boolean;
  /** World-space wish direction (0, 0 = no input). */
  wx: number; wz: number;
  vx: number; vz: number;
  x: number; z: number;
};
export type JitterEpisode = { i0: number; i1: number; flips: number[] };
export type MoveStats = {
  aliveSec: number;
  /** Tick indices of wish-direction flips / velocity flips. */
  wishFlips: number[];
  velFlips: number[];
  /** Wish flips within RAPID_SEC of the previous one: the jitter rate. */
  rapidFlips: number[];
  episodes: JitterEpisode[];
  /** Seconds spent in episodes. */
  oscSec: number;
};

/** Tick indices where a direction (unit or null) flips by more than FLIP_DEG within `win` ticks of an earlier one. */
function flips(dirs: ({ x: number; z: number } | null)[], win: number): number[] {
  const out: number[] = [];
  let last = -Infinity, lastDir: { x: number; z: number } | null = null;
  for (let i = 0; i < dirs.length; i++) {
    const u = dirs[i];
    if (!u) continue;
    let hit = false;
    for (let j = Math.max(0, i - win); j < i && !hit; j++) {
      const v = dirs[j];
      if (v && u.x * v.x + u.z * v.z < COS_FLIP) hit = true;
    }
    if (!hit) continue;
    // One flip is one event: the ticks after it still see the old direction in the window.
    if (lastDir && i - last <= win && u.x * lastDir.x + u.z * lastDir.z >= COS_FLIP) continue;
    out.push(i);
    last = i;
    lastDir = u;
  }
  return out;
}

export function moveStats(track: readonly MoveSample[], dt: number): MoveStats {
  const win = Math.round(FLIP_SEC / dt);
  const unit = (x: number, z: number, min: number) => {
    const l = Math.hypot(x, z);
    return l < min ? null : { x: x / l, z: z / l };
  };
  // A death breaks the run (the window never spans a respawn).
  const wish = track.map((s) => (s.alive ? unit(s.wx, s.wz, WISH_MIN) : null));
  const vel = track.map((s) => (s.alive ? unit(s.vx, s.vz, VEL_MIN) : null));
  for (let i = 1; i < track.length; i++) if (!track[i - 1].alive && track[i].alive) for (let j = Math.max(0, i - win); j < i; j++) wish[j] = vel[j] = null;
  const wishFlips = flips(wish, win), velFlips = flips(vel, win);
  const episodes: JitterEpisode[] = [];
  const gap = EPISODE_GAP_SEC / dt;
  let run: number[] = [];
  const close = () => {
    if (run.length >= FLIPS_MIN) {
      const i0 = run[0] - win, i1 = run[run.length - 1];
      let cx = 0, cz = 0, n = 0;
      for (let i = Math.max(0, i0); i <= i1; i++) { cx += track[i].x; cz += track[i].z; n++; }
      cx /= n; cz /= n;
      let inPlace = true;
      for (let i = Math.max(0, i0); i <= i1 && inPlace; i++) if (Math.hypot(track[i].x - cx, track[i].z - cz) > EPISODE_R) inPlace = false;
      if (inPlace) episodes.push({ i0: Math.max(0, i0), i1, flips: run });
    }
    run = [];
  };
  for (const i of wishFlips) {
    if (run.length && (i - run[run.length - 1] > gap || !track.slice(run[run.length - 1], i + 1).every((s) => s.alive))) close();
    run.push(i);
  }
  close();
  return {
    aliveSec: track.filter((s) => s.alive).length * dt,
    wishFlips, velFlips, episodes,
    rapidFlips: wishFlips.filter((i, k) => k > 0 && i - wishFlips[k - 1] < RAPID_SEC / dt && track.slice(wishFlips[k - 1], i + 1).every((s) => s.alive)),
    oscSec: episodes.reduce((a, e) => a + (e.i1 - e.i0) * dt, 0),
  };
}
