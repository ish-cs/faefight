import { wrapAngle } from './aim';

/**
 * Gaze statistics: where a player's view points while walking, fighting and getting hit. Measurement only (nothing in
 * the game reads this): scripts/gazeStats.ts runs it on human replays and headless bot matches so bot gaze (gaze.ts)
 * can be compared with how people look around.
 *
 * Per tick: the view yaw, the walk direction relative to the view (null = not walking), whether the trigger is held,
 * the yaw from me to every live enemy and how far they are, and who hit me this tick. A tick is *engaged* when I fired
 * within ENGAGE_FIRE_SEC or was hit within ENGAGE_HIT_SEC; otherwise it is *calm*.
 */
export type GazeSample = {
  alive: boolean;
  yaw: number;
  /** Walk direction relative to the view (rad, 0 = straight ahead), null = not walking. */
  moveRel: number | null;
  fire: boolean;
  foes: { id: number; yaw: number; dist: number }[];
  /** Attacker id when I was hit this tick. */
  hitBy: number | null;
};

const DEG = Math.PI / 180;
export const ALIGN_DEG = 30;
export const ENGAGE_FIRE_SEC = 1.5;
export const ENGAGE_HIT_SEC = 3;
/** An enemy this close counts as "in view range" for the look-at shares. */
export const NEAR_M = 40;
/** Looking at a foe: view yaw within this of the direction to them. */
export const ON_FOE_DEG = 15;
/** A scan/glance: the view swings more than SCAN_DEG within SCAN_SEC (calm only). */
export const SCAN_DEG = 45;
export const SCAN_SEC = 1;
/** Reaction: a hit out of the blue (none in REACT_QUIET_SEC, attacker more than REACT_OFF_DEG off my view) and the time until my view is within REACT_ON_DEG of them. */
export const REACT_QUIET_SEC = 3;
export const REACT_OFF_DEG = 30;
export const REACT_ON_DEG = 30;
/** Stare-walk: walking more than STARE_WALK_DEG off the view while the view is on a foe (strafing round them, eyes fixed). */
export const STARE_WALK_DEG = 45;
export const REACT_CAP_SEC = 3;

export type GazeStats = {
  aliveSec: number;
  /** Share of walking ticks with the walk within ALIGN_DEG of the view (all / calm only). */
  aligned: number;
  alignedCalm: number;
  /** Calm glances per minute (view swings > SCAN_DEG within SCAN_SEC). */
  scansPerMin: number;
  /** With a foe within NEAR_M: share of ticks looking at one (calm / engaged). */
  onFoeCalm: number;
  onFoeEngaged: number;
  /** Mean length (s) of a run of looking at a foe (calm / engaged). */
  trackCalmSec: number;
  trackEngagedSec: number;
  /** Calm, walking, a foe within NEAR_M: share of ticks eyes on the foe while walking > STARE_WALK_DEG off the view. */
  stareWalk: number;
  /** Hits out of the blue: count, median time to face the attacker (s, capped), share faced within 1 s. */
  reactions: number;
  reactMedianSec: number;
  reactWithin1s: number;
  /** Yaw speed percentiles (°/s) over alive ticks, and the share of ticks below 10 °/s. */
  yawP50: number;
  yawP90: number;
  yawP99: number;
  still: number;
};

const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Stats over several tracks (one per player life-span / replay), pooled. */
export function gazeStats(tracks: readonly (readonly GazeSample[])[], dt: number): GazeStats {
  let alive = 0, walk = 0, aligned = 0, walkCalm = 0, alignedCalm = 0, calmSec = 0, scans = 0;
  let nearCalm = 0, onCalm = 0, nearEng = 0, onEng = 0, walkNearCalm = 0, stare = 0;
  const runsCalm: number[] = [], runsEng: number[] = [], reacts: number[] = [], speeds: number[] = [];
  const fireWin = Math.round(ENGAGE_FIRE_SEC / dt), hitWin = Math.round(ENGAGE_HIT_SEC / dt), scanWin = Math.round(SCAN_SEC / dt);
  for (const tr of tracks) {
    let lastFire = -Infinity, lastHit = -Infinity, scanUntil = -1, calmSince = 0;
    let run = 0, runEng = false;
    const endRun = () => { if (run > 0) (runEng ? runsEng : runsCalm).push(run * dt); run = 0; };
    for (let i = 0; i < tr.length; i++) {
      const s = tr[i];
      if (!s.alive) { endRun(); lastFire = lastHit = -Infinity; calmSince = i + 1; continue; }
      alive++;
      // Out-of-the-blue hit: time to turn onto the attacker.
      if (s.hitBy !== null && i - lastHit > REACT_QUIET_SEC / dt) {
        const f = s.foes.find((x) => x.id === s.hitBy);
        if (f && Math.abs(wrapAngle(f.yaw - s.yaw)) > REACT_OFF_DEG * DEG) {
          let t = REACT_CAP_SEC;
          for (let k = i; k < tr.length && (k - i) * dt < REACT_CAP_SEC; k++) {
            const q = tr[k], g = q.alive ? q.foes.find((x) => x.id === s.hitBy) : undefined;
            if (!g) break;
            if (Math.abs(wrapAngle(g.yaw - q.yaw)) <= REACT_ON_DEG * DEG) { t = (k - i) * dt; break; }
          }
          reacts.push(t);
        }
      }
      if (s.fire) lastFire = i;
      if (s.hitBy !== null) lastHit = i;
      const engaged = i - lastFire <= fireWin || i - lastHit <= hitWin;
      if (engaged) calmSince = i + 1;
      if (i > 0 && tr[i - 1].alive) speeds.push(Math.abs(wrapAngle(s.yaw - tr[i - 1].yaw)) / dt / DEG);
      if (s.moveRel !== null) {
        const ok = Math.abs(wrapAngle(s.moveRel)) <= ALIGN_DEG * DEG;
        walk++; if (ok) aligned++;
        if (!engaged) { walkCalm++; if (ok) alignedCalm++; }
      }
      if (!engaged) {
        calmSec += dt;
        if (i >= scanUntil && i - calmSince >= scanWin) {
          for (let k = 1; k <= scanWin; k++) {
            if (Math.abs(wrapAngle(s.yaw - tr[i - k].yaw)) > SCAN_DEG * DEG) { scans++; scanUntil = i + scanWin; break; }
          }
        }
      }
      const near = s.foes.filter((f) => f.dist <= NEAR_M);
      const on = near.some((f) => Math.abs(wrapAngle(f.yaw - s.yaw)) <= ON_FOE_DEG * DEG);
      if (near.length) {
        if (engaged) { nearEng++; if (on) onEng++; } else { nearCalm++; if (on) onCalm++; }
        if (!engaged && s.moveRel !== null) { walkNearCalm++; if (on && Math.abs(wrapAngle(s.moveRel)) > STARE_WALK_DEG * DEG) stare++; }
      }
      if (on && run > 0 && runEng !== engaged) endRun();
      if (on) { run++; runEng = engaged; } else endRun();
    }
    endRun();
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    aliveSec: alive * dt,
    aligned: aligned / Math.max(1, walk),
    alignedCalm: alignedCalm / Math.max(1, walkCalm),
    scansPerMin: scans / Math.max(1e-9, calmSec / 60),
    onFoeCalm: onCalm / Math.max(1, nearCalm),
    onFoeEngaged: onEng / Math.max(1, nearEng),
    trackCalmSec: mean(runsCalm),
    trackEngagedSec: mean(runsEng),
    stareWalk: stare / Math.max(1, walkNearCalm),
    reactions: reacts.length,
    reactMedianSec: pct(reacts, 0.5),
    reactWithin1s: reacts.filter((t) => t <= 1).length / Math.max(1, reacts.length),
    yawP50: pct(speeds, 0.5),
    yawP90: pct(speeds, 0.9),
    yawP99: pct(speeds, 0.99),
    still: speeds.filter((v) => v < 10).length / Math.max(1, speeds.length),
  };
}
