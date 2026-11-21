import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

/**
 * Shader uniforms the day/night cycle (dayNight.ts) drives and world materials read. Uniform writes only: changing
 * the time of day never recompiles a shader.
 */
export const lightU = {
  /** Unit vector toward the key light (sun by day, moon by night): water glints / subsurface glow. */
  keyDir: uniform(new THREE.Vector3(0, 1, 0)),
  /** Unit vector toward the sun (even below the horizon): sky dome glow, warm haze. */
  sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  /** Unit vector toward the moon (fixed; the night key light once the sun has gone): moon disc in the sky. */
  moonDir: uniform(new THREE.Vector3(0, 1, 0)),
  /** Water glint colour × strength (white sun sparkle → faint blue moon path). */
  glint: uniform(new THREE.Vector3(1, 1, 1)),
  /** Lamp heads / floodlights self-illumination, 0 by day → 1 at night. */
  lamps: uniform(0),
  /** 0 = day → 1 = night: night sky (stars, moon disc) strength. */
  night: uniform(0),
  /** 0 → 1 → 0 around dusk: blue-hour sky glow. */
  twilight: uniform(0),
  /** Unlit far billboards (impostors, baked at the day sun): scale toward the current light. */
  impostor: uniform(new THREE.Color(1, 1, 1)),
};

/** Plain-number mirror for CPU-side effects (muzzle / explosion lights). */
export const dayNightState = {
  night: 0,
  /** key light intensity / ambient relative to the day start (1, 1 at phase 0) */
  key: 1, env: 1,
  keyColor: new THREE.Color(0xffe9cc),
};
