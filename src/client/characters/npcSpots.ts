import type * as THREE from 'three/webgpu';

/**
 * Where the shop keepers stand, registered by the static map art (world/props.ts, mapProps.ts) and read by
 * NpcSystem (npcs.ts), which builds animated keepers there.
 */
export type NpcRole = 'shop' | 'potion';
export type NpcSpot = { role: NpcRole; matrix: THREE.Matrix4 };
let spots: NpcSpot[] = [];
let version = 0;

/** Map art: forget the previous map's keepers. */
export function clearNpcSpots() { spots = []; version++; }
/** Map art: a keeper stands at this world transform (feet at the origin, facing local +Z). */
export function addNpcSpot(role: NpcRole, matrix: THREE.Matrix4) { spots.push({ role, matrix: matrix.clone() }); version++; }
export function npcSpots(): readonly NpcSpot[] { return spots; }
export function npcSpotsVersion() { return version; }
