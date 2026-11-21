import { MAP } from './constants';
import type { Vec3 } from './types';
import { add, forward, right, rotateY, scale, v3, yawOf } from './vec';

export type Doorway = { center: Vec3; yaw: number; width: number };
export type Bunker = { center: Vec3; facingYaw: number; doorways: Doorway[] };
export type IslandLayout = {
  index: number;
  center: Vec3;
  radius: number;
  groundY: number;
  bunker: Bunker;
  spawn: Vec3;
  generator: Vec3;
  vault: Vec3;
  shop: Vec3;
};
export type Box = { center: Vec3; half: Vec3; rotY: number };

export function buildMap(playerCount: number): IslandLayout[] {
  if (playerCount < 2 || playerCount > 8) throw new Error(`buildMap: playerCount must be 2..8, got ${playerCount}`);
  const r = MAP.islandRadius;
  const ring = (r + MAP.gap / 2) / Math.sin(Math.PI / playerCount);
  const g = MAP.groundY;
  const out: IslandLayout[] = [];
  for (let i = 0; i < playerCount; i++) {
    const a = Math.PI + (2 * Math.PI * i) / playerCount;
    const center = v3(Math.cos(a) * ring, 0, Math.sin(a) * ring);
    const inward = v3(-Math.cos(a), 0, -Math.sin(a));
    const facingYaw = yawOf(inward);
    const lat = right(facingYaw);
    const at = (fwd: number, side: number): Vec3 => {
      const p = add(add(center, scale(inward, fwd)), scale(lat, side));
      return v3(p.x, g, p.z);
    };
    const bunkerCenter = at(-(r - 7), 0);
    const off = MAP.bunker.interior / 2 + MAP.bunker.wall / 2;
    const doorways: Doorway[] = [0, Math.PI / 2, -Math.PI / 2].map((d) => {
      const yaw = facingYaw + d;
      const c = add(bunkerCenter, scale(forward(yaw), off));
      return { center: v3(c.x, g, c.z), yaw, width: MAP.bunker.doorWidth };
    });
    out.push({
      index: i,
      center,
      radius: r,
      groundY: g,
      bunker: { center: bunkerCenter, facingYaw, doorways },
      spawn: bunkerCenter,
      generator: at(6, -6),
      vault: at(8, 0),
      shop: at(6, 6),
    });
  }
  return out;
}

/** Static, indestructible concrete boxes that make up a bunker (walls with door gaps, lintels, roof). */
export function bunkerWallBoxes(b: Bunker): Box[] {
  const { interior, wall, height, doorWidth, doorHeight } = MAP.bunker;
  const outer = interior + 2 * wall;
  const boxes: Box[] = [];
  const push = (local: Vec3, half: Vec3) => {
    const c = add(b.center, rotateY(local, b.facingYaw));
    boxes.push({ center: c, half, rotY: b.facingYaw });
  };
  const off = interior / 2 + wall / 2;
  // Sides in bunker-local space: front (-Z), left (-X), right (+X) have doors; back (+Z) is solid.
  const sides: { normal: Vec3; door: boolean }[] = [
    { normal: v3(0, 0, -1), door: true },
    { normal: v3(-1, 0, 0), door: true },
    { normal: v3(1, 0, 0), door: true },
    { normal: v3(0, 0, 1), door: false },
  ];
  for (const s of sides) {
    const along = s.normal.x !== 0 ? v3(0, 0, 1) : v3(1, 0, 0);
    const base = scale(s.normal, off);
    const halfFor = (lenAlong: number, hy: number) =>
      s.normal.x !== 0 ? v3(wall / 2, hy, lenAlong / 2) : v3(lenAlong / 2, hy, wall / 2);
    if (!s.door) {
      push(v3(base.x, height / 2, base.z), halfFor(outer, height / 2));
      continue;
    }
    const seg = (outer - doorWidth) / 2;
    const segOff = doorWidth / 2 + seg / 2;
    for (const sign of [-1, 1]) {
      const p = add(base, scale(along, sign * segOff));
      push(v3(p.x, height / 2, p.z), halfFor(seg, height / 2));
    }
    const lintelH = height - doorHeight;
    push(v3(base.x, doorHeight + lintelH / 2, base.z), halfFor(doorWidth, lintelH / 2));
  }
  push(v3(0, height + 0.1, 0), v3(outer / 2, 0.1, outer / 2));
  return boxes;
}

/** Water between each playable disc and its harbor backdrop quay (local +Z behind the island). */
export const HARBOR_CHANNEL = 14;

/** Harbor backdrop frame in the island's local space (client scenery and the sim's crane share it). */
export function harborBackdropFrame(isl: IslandLayout, n: number) {
  const ring = Math.hypot(isl.center.x, isl.center.z);
  const z0 = isl.radius + HARBOR_CHANNEL;
  const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8));
  return { z0, hw, top: isl.groundY + 0.2 };
}

/** Ship-to-shore crane frame (client `crane()` in props.ts): legs at (±gx, ±gz), beams at lowBeamY and legH. */
export const CRANE = { legH: 28, gx: 8, gz: 8, lowBeamY: 10 };

/**
 * Solid parts of a crane players can build against and climb onto: the four legs, the low side beams
 * and the top girder frame (the boom, struts and machinery up top stay scenery). `base` = leg feet.
 */
export function craneBoxes(base: Vec3, yaw: number): Box[] {
  const { legH: LH, gx, gz, lowBeamY } = CRANE;
  const out: Box[] = [];
  const push = (x: number, y: number, z: number, half: Vec3) => {
    const c = add(base, rotateY(v3(x, 0, z), yaw));
    out.push({ center: v3(c.x, base.y + y, c.z), half, rotY: yaw });
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) push(sx * gx, LH / 2, sz * gz, v3(0.55, LH / 2, 0.55));
  for (const sx of [-1, 1]) {
    push(sx * gx, lowBeamY, 0, v3(0.5, 0.5, gz));
    push(sx * gx, LH, 0, v3(0.6, 0.7, gz + 0.6));
  }
  for (const sz of [-1, 1]) push(0, LH, sz * gz, v3(gx + 0.5, 0.7, 0.55));
  return out;
}

/** The harbor crane behind each island (client: `crane(b, at(hw * 0.55, top, z0 + 9))` in islands.ts). */
export function harborCraneBoxes(islands: readonly IslandLayout[]): Box[] {
  return islands.flatMap((isl) => {
    const { z0, hw, top } = harborBackdropFrame(isl, islands.length);
    const yaw = isl.bunker.facingYaw;
    const c = add(isl.center, rotateY(v3(hw * 0.55, 0, z0 + 9), yaw));
    return craneBoxes(v3(c.x, top, c.z), yaw);
  });
}
