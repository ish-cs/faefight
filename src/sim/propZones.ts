import { PLAYER } from './constants';
import type { IslandLayout } from './map';
import { CENTER_PROP_HALF, PROP_HALF } from './physics';
import type { Vec3 } from './types';
import { rotateY, v3 } from './vec';

/**
 * No-build zones around NPCs, the generator and the vault, which gameplay props (props.ts) must also keep out of.
 *
 * TODO(building agent aec5df652b24304f3): this is a stand-in with the exact names and signatures of the zone API
 * on its branch (src/sim/building.ts: NoBuildZone, islandNoBuildZones, generatorZone, vaultZone, shopZone,
 * potionZone, boxesOverlap). When that branch lands, replace this file's body with
 *   export { type NoBuildZone, islandNoBuildZones, generatorZone, vaultZone, shopZone, potionZone, boxesOverlap } from './building';
 */

/** Oriented box (Y rotation only), base at center.y - half.y. */
export type NoBuildZone = { center: Vec3; half: Vec3; rotY: number; reason: string };

const CLEAR = 0.75;
const zone = (base: Vec3, half: Vec3, rotY: number, reason: string): NoBuildZone =>
  ({ center: v3(base.x, base.y + half.y, base.z), half: v3(half.x + CLEAR, half.y + CLEAR, half.z + CLEAR), rotY, reason });

export const generatorZone = (base: Vec3, yaw: number) => zone(base, PROP_HALF.generator, yaw, 'generator');
export const vaultZone = (base: Vec3, yaw: number) => zone(base, PROP_HALF.vault, yaw, 'vault');
export const shopZone = (base: Vec3, yaw: number) => zone(base, PROP_HALF.shop, yaw, 'shop');
export const potionZone = (base: Vec3) => zone(base, v3(CENTER_PROP_HALF.potionShop.x, PLAYER.height / 2, CENTER_PROP_HALF.potionShop.z), 0, 'potion');

export function islandNoBuildZones(isl: IslandLayout): NoBuildZone[] {
  const y = isl.bunker.facingYaw;
  return [generatorZone(isl.generator, y), vaultZone(isl.vault, y), shopZone(isl.shop, y)];
}

/** Does the oriented box (center, half, rotY) overlap zone z? Separating-axis test in the XZ plane + a Y range test. */
export function boxesOverlap(center: Vec3, half: Vec3, rotY: number, z: NoBuildZone): boolean {
  if (Math.abs(center.y - z.center.y) > half.y + z.half.y) return false;
  const axes = [rotateY(v3(1, 0, 0), rotY), rotateY(v3(0, 0, 1), rotY), rotateY(v3(1, 0, 0), z.rotY), rotateY(v3(0, 0, 1), z.rotY)];
  const ex = (h: Vec3, r: number, a: Vec3) => {
    const u = rotateY(v3(1, 0, 0), r), w = rotateY(v3(0, 0, 1), r);
    return h.x * Math.abs(u.x * a.x + u.z * a.z) + h.z * Math.abs(w.x * a.x + w.z * a.z);
  };
  const dx = z.center.x - center.x, dz = z.center.z - center.z;
  for (const a of axes) if (Math.abs(dx * a.x + dz * a.z) > ex(half, rotY, a) + ex(z.half, z.rotY, a)) return false;
  return true;
}
