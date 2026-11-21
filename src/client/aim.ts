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

/**
 * The sim turns a player to face out of their bunker's front doorway when they respawn and says so with a
 * 'spawn' event. Adopt that look (and the selected slot) once, at that moment only, so the stale pre-death
 * aim isn't sent back. Returns true when it snapped.
 */
export function adoptSpawnLook(
  look: { yaw: number; pitch: number; selected: number },
  events: readonly { type: string; data: Record<string, unknown> }[],
  humanId: number,
): boolean {
  let hit: Record<string, unknown> | null = null;
  for (const e of events) if (e.type === 'spawn' && e.data.player === humanId) hit = e.data;
  if (!hit) return false;
  if (typeof hit.yaw !== 'number') { console.warn('[aim] spawn event without a yaw', hit); return false; }
  look.yaw = hit.yaw;
  look.pitch = 0;
  if (typeof hit.selected === 'number') look.selected = hit.selected;
  return true;
}
