import { PLAYER } from './constants';
import type { Vec3 } from './types';

/**
 * Player movement model, shared by the authoritative sim (match.ts) and the client's local
 * prediction (client/predict.ts) so the two can't drift: same inputs + same collision world → same
 * result. Everything here is deterministic; the only side effect is the body's collision move.
 */

export const MOVE = {
  /** m/s² toward the wished velocity on the ground: 0 → walk (5 m/s) in 0.1 s. */
  groundAccel: 50,
  /** m/s² braking with no input: walk → stop in ~0.077 s. Also added (scaled) when reversing. */
  groundDecel: 65,
  /** m/s² in the air (reduced control; momentum is kept with no input). */
  airAccel: 12,
  /** A jump still works this long after walking off an edge. */
  coyoteSec: 0.1,
  /** A jump pressed this long before landing fires on landing. */
  jumpBufferSec: 0.1,
};

/** Movement state carried between steps (and in snapshots, so a client can resume prediction). */
export type MoveState = {
  grounded: boolean;
  /** Seconds since last grounded (capped at 1; set to 1 by a jump so coyote time can't double-jump). */
  airTime: number;
  /** Seconds left on a buffered jump press. */
  jumpBuf: number;
  /** Last movement-command sequence number applied (0 = none). */
  ack: number;
};

/** One fixed (1/30 s) movement step's worth of input, numbered by the client for reconciliation. */
export type MoveCmd = { seq: number; moveX: number; moveZ: number; yaw: number; jump: boolean; sprint: boolean };

export type Mover = { pos: Vec3; vel: Vec3; mv: MoveState };
/** The collision side: move the capsule by `desired` (sliding), return the new feet position. */
export type MoveBody = { movePlayer(desired: Vec3): { pos: Vec3; grounded: boolean } };

export const newMoveState = (): MoveState => ({ grounded: false, airTime: 0, jumpBuf: 0, ack: 0 });

const EPS = 1e-6;
const AIR_CAP = 1;

/** Wished horizontal velocity for move axes in the yaw frame (three.js yaw: 0 looks toward -Z). */
export function wishVelocity(moveX: number, moveZ: number, yaw: number, sprint: boolean): { x: number; z: number } {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  // forward(yaw) = (-s, 0, -c), right(yaw) = (c, 0, -s)
  let x = -s * moveZ + c * moveX, z = -c * moveZ - s * moveX;
  const l = Math.hypot(x, z);
  if (l > 1) { x /= l; z /= l; }
  const speed = sprint ? PLAYER.sprint : PLAYER.walk;
  return { x: x * speed, z: z * speed };
}

/**
 * Move the horizontal velocity toward the wished one at a bounded rate (linear, so it's
 * frame-rate independent). Ground: accelerate, brake harder when reversing, decelerate with no
 * input. Air: reduced acceleration toward the wish, no braking.
 */
export function accelerate(vx: number, vz: number, wx: number, wz: number, grounded: boolean, dt: number): { x: number; z: number } {
  const wl = Math.hypot(wx, wz);
  let rate: number;
  if (!grounded) rate = wl < EPS ? 0 : MOVE.airAccel;
  else if (wl < EPS) rate = MOVE.groundDecel;
  else {
    const vl = Math.hypot(vx, vz);
    const cos = vl < EPS ? 1 : (vx * wx + vz * wz) / (vl * wl);
    rate = MOVE.groundAccel + MOVE.groundDecel * Math.max(0, -cos);
  }
  const dx = wx - vx, dz = wz - vz;
  const d = Math.hypot(dx, dz), step = rate * dt;
  if (d <= step) return rate > 0 ? { x: wx, z: wz } : { x: vx, z: vz };
  return { x: vx + (dx / d) * step, z: vz + (dz / d) * step };
}

/**
 * Advance one mover by dt with one command (mutates m). Returns the landing speed (m/s, > 0 only on
 * the step that touched down) so the sim can apply fall damage.
 */
export function stepMove(m: Mover, cmd: MoveCmd, dt: number, body: MoveBody): { landingSpeed: number } {
  const mv = m.mv;
  const wish = wishVelocity(cmd.moveX, cmd.moveZ, cmd.yaw, cmd.sprint);
  const h = accelerate(m.vel.x, m.vel.z, wish.x, wish.z, mv.grounded, dt);
  m.vel.x = h.x;
  m.vel.z = h.z;

  if (cmd.jump) mv.jumpBuf = MOVE.jumpBufferSec;
  const canJump = mv.grounded || mv.airTime < MOVE.coyoteSec + EPS;
  let jumped = false;
  if (mv.jumpBuf > EPS && canJump) {
    m.vel.y = PLAYER.jumpVelocity;
    mv.jumpBuf = 0;
    mv.airTime = AIR_CAP;
    jumped = true;
  } else {
    m.vel.y -= PLAYER.gravity * dt;
  }

  const wasGrounded = mv.grounded;
  const r = body.movePlayer({ x: m.vel.x * dt, y: m.vel.y * dt, z: m.vel.z * dt });
  m.pos = r.pos;
  mv.grounded = r.grounded;
  const landingSpeed = !wasGrounded && r.grounded ? Math.max(0, -m.vel.y) : 0;
  if (r.grounded && m.vel.y < 0) m.vel.y = 0;
  if (r.grounded) mv.airTime = 0;
  else mv.airTime = Math.min(AIR_CAP, mv.airTime + dt);
  if (!jumped) mv.jumpBuf = Math.max(0, mv.jumpBuf - dt);
  return { landingSpeed };
}
