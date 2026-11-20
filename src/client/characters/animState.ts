import type { Vec3, WeaponKind } from '../../sim/types';

/** Speeds (m/s, horizontal) for the locomotion states. Sim walk = 5, sprint = 7.5. */
export const WALK_MIN = 0.4;
export const JOG_MIN = 3.2;
export const SPRINT_MIN = 6;
/** |vel.y| above this = jumping/falling (the sim zeroes vel.y while grounded). */
export const AIR_VY = 0.6;

export type AnimInput = {
  alive: boolean;
  vel: Vec3;
  yaw: number;
  equipped: WeaponKind;
  flinching: boolean; // took a hit just now
  punching: boolean; // threw a punch just now
  aiming: boolean; // fired a gun just now
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which rig clip to play and at what speed (pure; the Avatar crossfades to it). */
export function chooseClip(s: AnimInput): { name: string; ts: number } {
  if (!s.alive) return { name: 'Death', ts: 1 };
  if (s.flinching) return { name: 'HitRecieve', ts: 1.6 };
  const armed = s.equipped !== 'fists';
  if (!armed && s.punching) return { name: 'Punch_Right', ts: 1.5 };
  if (Math.abs(s.vel.y) > AIR_VY) return { name: 'Air', ts: 0 };
  const speed = Math.hypot(s.vel.x, s.vel.z);
  const aiming = armed && s.aiming;
  // Armed and standing: the aim pose (the Avatar lowers it to a low ready unless we just fired).
  if (speed < WALK_MIN) return { name: armed ? 'Idle_Gun_Pointing' : 'Idle', ts: 1 };
  // Direction of travel relative to facing (yaw 0 faces -Z): forward / back / strafe clips exist.
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  const fwd = (s.vel.x * fx + s.vel.z * fz) / speed;
  const side = (s.vel.x * -fz + s.vel.z * fx) / speed; // + = right
  if (speed < JOG_MIN && fwd > 0.3) return aiming ? { name: 'Run_Shoot', ts: 0.6 } : { name: 'Walk', ts: clamp(speed / 1.7, 0.7, 1.6) };
  const ts = clamp(speed / 6.5, 0.55, 1.2);
  if (fwd < -0.5) return { name: 'Run_Back', ts };
  if (side > 0.6) return { name: 'Run_Right', ts };
  if (side < -0.6) return { name: 'Run_Left', ts };
  if (speed > SPRINT_MIN) return { name: aiming ? 'Run_Shoot' : 'Run', ts: clamp(speed / 7, 0.9, 1.25) };
  return { name: armed ? 'Run_Shoot' : 'Run', ts };
}
