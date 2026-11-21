import { wrapAngle } from './aim';

/** One tick of a player's view, as the snapshot shows it. */
export type AimSample = { yaw: number; pitch: number; alive: boolean };

/** Yaw speed (°/s) both sides of a sign flip must exceed for it to count as the view flicking back. */
export const REVERSAL_MIN_DPS = 30;
/** Yaw speed (°/s) both sides of a sign flip must exceed for it to count as a fast flick-back (visible twitch). */
export const FLICKBACK_DPS = 180;
/** Change of angular velocity within one tick (°/s per tick) that counts as a jerk. */
export const SPIKE_DPS = 600;

const DEG = 180 / Math.PI;

/**
 * Jitter metrics over per-tick view tracks (dead ticks break the run): yaw reversals/s (> REVERSAL_MIN_DPS both
 * sides), fast flick-backs/s (> FLICKBACK_DPS both sides), yaw jerks/s (|Δω| > SPIKE_DPS in one tick), p99 yaw
 * acceleration (°/s²), p99 and max angular speed (°/s). Respawn teleports are skipped
 * (the first tick after a dead stretch has no velocity).
 */
export function aimStats(tracks: AimSample[][], dt: number) {
  let reversals = 0, flickBacks = 0, spikes = 0, aliveTicks = 0;
  const speeds: number[] = [], accels: number[] = [];
  for (const t of tracks) {
    let prevYawW: number | null = null;
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1], b = t[i];
      if (!a.alive || !b.alive) { prevYawW = null; continue; }
      aliveTicks++;
      const wy = (wrapAngle(b.yaw - a.yaw) / dt) * DEG, wp = ((b.pitch - a.pitch) / dt) * DEG;
      const w = Math.hypot(wy, wp);
      speeds.push(w);
      if (prevYawW !== null && Math.sign(wy) !== Math.sign(prevYawW) &&
          Math.abs(wy) > REVERSAL_MIN_DPS && Math.abs(prevYawW) > REVERSAL_MIN_DPS) {
        reversals++;
        if (Math.abs(wy) > FLICKBACK_DPS && Math.abs(prevYawW) > FLICKBACK_DPS) flickBacks++;
      }
      if (prevYawW !== null) {
        const dw = Math.abs(wy - prevYawW);
        accels.push(dw / dt);
        if (dw > SPIKE_DPS) spikes++;
      }
      prevYawW = wy;
    }
  }
  speeds.sort((x, y) => x - y);
  accels.sort((x, y) => x - y);
  const aliveSec = aliveTicks * dt;
  return {
    reversalsPerSec: reversals / Math.max(aliveSec, 1e-9),
    flickBacksPerSec: flickBacks / Math.max(aliveSec, 1e-9),
    spikesPerSec: spikes / Math.max(aliveSec, 1e-9),
    /** p99 yaw angular acceleration (°/s²). */
    accelP99: accels.length ? accels[Math.floor(0.99 * (accels.length - 1))] : 0,
    p99: speeds.length ? speeds[Math.floor(0.99 * (speeds.length - 1))] : 0,
    max: speeds.length ? speeds[speeds.length - 1] : 0,
    aliveSec,
  };
}
