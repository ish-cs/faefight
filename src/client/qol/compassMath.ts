/**
 * Compass math (pure). Yaw follows the sim: forward(yaw) = (-sin yaw, 0, -cos yaw), so yaw 0 faces -z
 * ("north") and turning right lowers yaw (east = -π/2).
 */

export const wrapPi = (a: number) => {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};

/** The yaw that faces from `from` toward `to` (horizontal). */
export const yawToward = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** Signed angle of a target relative to where you look: positive = to your right (radians, -π..π). */
export const relAngle = (targetYaw: number, viewYaw: number) => wrapPi(viewYaw - targetYaw);

/** Compass heading in degrees (0 = N, 90 = E) for a view yaw. */
export const headingDeg = (yaw: number) => {
  const d = Math.round((-yaw * 180) / Math.PI) % 360;
  return d < 0 ? d + 360 : d + 0; // + 0: no "-0"
};

/** Horizontal position (px from the bar's centre) of something at `rel` radians, or null if off the bar. */
export function barX(rel: number, halfSpanRad: number, halfWidthPx: number): number | null {
  if (Math.abs(rel) > halfSpanRad) return null;
  return (rel / halfSpanRad) * halfWidthPx;
}
