import { MAP, PLAYER } from '../constants';
import * as dm from '../dmath';
import { bunkerSlitBoxes, type Bunker } from '../map';
import type { Vec3 } from '../types';
import { add, rotateY, scale, v3 } from '../vec';

/**
 * Shooting into (or out of) a sealed bunker through its firing slits (map.ts bunkerSlitBoxes: 0.6 m wide, 1.35-1.53 m
 * above the floor, in a 0.3 m wall). Bullets and sight pass a slit; a bot aims at the chest (1.2 m) from its eye
 * (1.6 m), so the line only threads the slit from one distance: where it crosses the slit's mid height. Pure geometry.
 */

/** Chest height bots aim and look at (bot.ts CHEST, match.ts botView). */
const CHEST = 1.2;
/** My body (capsule radius plus a margin) keeps this far out from a wall's outer face. */
const STAND_OFF = PLAYER.radius + 0.25;

export type SlitLine = {
  /** Index into bunkerSlitBoxes(b). */
  slit: number;
  /** Where to stand (feet, floor height): my eye-to-chest line on the target goes through the slit's middle. */
  stand: Vec3;
  /** Unit horizontal normal of the slit's wall, pointing out of the bunker. */
  out: Vec3;
  /** cos of the angle between that normal and the line (1 = square on). */
  cos: number;
};

/** Slit centres and outward normals of a bunker (bunkerSlitBoxes order). */
export function slitFrames(b: Bunker): { center: Vec3; out: Vec3 }[] {
  return bunkerSlitBoxes(b).map((s) => {
    const thin = rotateY(s.half.x < s.half.z ? v3(1, 0, 0) : v3(0, 0, 1), s.rotY);
    const side = (s.center.x - b.center.x) * thin.x + (s.center.z - b.center.z) * thin.z;
    return { center: s.center, out: side >= 0 ? thin : scale(thin, -1) };
  });
}

/**
 * Every slit of bunker `b` that a target standing on its floor at `t` can be shot through from outside (its line
 * within `maxAngle` rad of square on, and the stand clear of the wall), best angle first. The stand is on the line
 * from the target through the slit's middle, `mid / f` from the target, where f is the fraction of the way from
 * chest to eye at which the line reaches the slit's mid height.
 */
export function slitLines(b: Bunker, t: Vec3, maxAngle: number): SlitLine[] {
  const { slit, wall } = MAP.bunker;
  const f = ((slit.y0 + slit.y1) / 2 - CHEST) / (PLAYER.eyeHeight - CHEST);
  const minCos = dm.cos(maxAngle);
  const out: SlitLine[] = [];
  slitFrames(b).forEach((s, i) => {
    const dx = s.center.x - t.x, dz = s.center.z - t.z;
    const mid = Math.hypot(dx, dz);
    if (mid < 1e-3) return;
    const ux = dx / mid, uz = dz / mid;
    const cos = ux * s.out.x + uz * s.out.z;
    if (cos < minCos) return;
    const L = mid / f;
    // Out past the wall's outer face (measured along the normal) by a body's width.
    if ((L - mid) * cos < wall / 2 + STAND_OFF) return;
    out.push({ slit: i, stand: v3(t.x + ux * L, b.center.y, t.z + uz * L), out: s.out, cos });
  });
  return out.sort((a, c) => c.cos - a.cos);
}

/** Chest point of a player standing at `feet`. */
export function chestOf(feet: Vec3): Vec3 {
  return add(feet, v3(0, CHEST, 0));
}
