import * as dm from './dmath';
import type { Vec3 } from './types';

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
export const dist2D = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
export const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return scale(a, 1 / l); };
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

// Yaw convention matches three.js: yaw 0 looks toward -Z, positive yaw turns left (toward -X).
export const forward = (yaw: number): Vec3 => ({ x: -dm.sin(yaw), y: 0, z: -dm.cos(yaw) });
export const right = (yaw: number): Vec3 => ({ x: dm.cos(yaw), y: 0, z: -dm.sin(yaw) });
export const yawOf = (dir: { x: number; z: number }) => dm.atan2(-dir.x, -dir.z);

/** Rotate a local-space offset by rotY (three.js Y rotation). */
export const rotateY = (p: Vec3, rotY: number): Vec3 => {
  const c = dm.cos(rotY), s = dm.sin(rotY);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
};
