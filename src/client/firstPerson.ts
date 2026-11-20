import { PLAYER } from '../sim/constants';
import type { Vec3 } from '../sim/types';

/**
 * Pure first-person maths (no three.js): camera-mode persistence, eye position and the viewmodel's
 * sway / bob / recoil / reload curves. viewmodel.ts turns these numbers into transforms.
 */

export type CameraMode = 'third' | 'first';
export const CAMERA_MODE_KEY = 'faefight.cameraMode';
export const FP_FOV = 75;

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

/** Stored camera mode; anything missing/invalid (or blocked storage) → third person. */
export function loadCameraMode(store: KV | null = defaultStore()): CameraMode {
  try {
    const v = store?.getItem(CAMERA_MODE_KEY);
    return v === 'first' ? 'first' : 'third';
  } catch { return 'third'; }
}

export function saveCameraMode(mode: CameraMode, store: KV | null = defaultStore()) {
  try { store?.setItem(CAMERA_MODE_KEY, mode); } catch (err) { console.warn('[firstPerson] could not persist camera mode', err); }
}

export const toggleMode = (m: CameraMode): CameraMode => (m === 'first' ? 'third' : 'first');

/** Camera position in first person: the sim's eye (feet + eye height). */
export function eyePosition(feet: Vec3): Vec3 {
  return { x: feet.x, y: feet.y + PLAYER.eyeHeight, z: feet.z };
}

/** Unit view direction for three.js look angles (yaw about +Y, 0 = -Z; pitch up positive). */
export function viewDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Walk/run bob: figure-eight offset (metres, view space) for a stride phase in radians. */
export function bobOffset(phase: number, speed: number): { x: number; y: number; roll: number } {
  const k = Math.min(1, speed / PLAYER.sprint);
  const amp = 0.011 + 0.013 * k; // run bobs harder than walk
  return { x: Math.sin(phase) * amp, y: -Math.abs(Math.cos(phase)) * amp * 0.9, roll: Math.sin(phase) * 0.02 * k };
}

/** Stride phase rate (rad/s) for a horizontal speed: a step every ~0.8 m. */
export const bobRate = (speed: number) => (speed < 0.3 ? 0 : (speed / 0.8) * Math.PI);

/** Slow breathing sway while standing still, in metres. */
export function idleSway(t: number): { x: number; y: number } {
  return { x: Math.sin(t * 0.9) * 0.0035, y: Math.sin(t * 1.8) * 0.0025 };
}

/** Recoil kick 0..1 (`since` = seconds after a shot): snaps up, settles over ~0.18 s. */
export function recoilKick(since: number): number {
  if (since < 0 || since > 0.25) return 0;
  const attack = 0.025;
  return since < attack ? since / attack : Math.exp(-(since - attack) * 22);
}

/** Reload dip 0..1 over the reload (`t` = 0..1 progress): eases down, holds, eases back up. */
export function reloadDip(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (t < 0.2) return ease(t / 0.2);
  if (t > 0.8) return ease((1 - t) / 0.2);
  return 1;
}

/** Shortest signed angle a - b, in (-π, π]. */
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Exponential approach factor for a rate (1/s) over dt seconds (frame-rate independent). */
export const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
