import { add, forward, right, scale } from '../sim/vec';

/**
 * The sim moves along the aim yaw, but the aim yaw is corrected toward the crosshair target and
 * differs from the camera yaw. Re-express the camera-relative move axes in the aim frame so W
 * always walks where the camera looks.
 */
export function moveForAim(moveX: number, moveZ: number, camYaw: number, aimYaw: number): { moveX: number; moveZ: number } {
  if (camYaw === aimYaw) return { moveX, moveZ };
  const w = add(scale(forward(camYaw), moveZ), scale(right(camYaw), moveX));
  const f = forward(aimYaw), r = right(aimYaw);
  return { moveX: w.x * r.x + w.z * r.z, moveZ: w.x * f.x + w.z * f.z };
}
