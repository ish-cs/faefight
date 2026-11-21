import * as dm from './dmath';
import { GRAPPLE, PLAYER } from './constants';
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

/**
 * Stamina ("stress"): sprinting drains it, resting refills it, taking damage stresses you (an
 * immediate drain plus slower recovery for a while). Part of the movement state so the client's
 * prediction replays it exactly like the sim.
 */
export const STAMINA = {
  max: 100,
  /** Per second while sprinting (full → empty in ~5.5 s). */
  drainPerSec: 18,
  /** Per second once rested `regenDelaySec` without sprinting. */
  regenPerSec: 12,
  /** Regen multiplier when standing still (no move input). */
  idleRegenMul: 1.6,
  regenDelaySec: 0.8,
  /** Can't START sprinting below this. */
  startMin: 15,
  /** Emptied: exhausted (no sprint at all) until back above this. */
  recoverAt: 30,
  jumpCost: 5,
  /** Immediate drain per point of damage taken. */
  damagePerHp: 0.6,
  /** After damage, regen runs at `stressRegenMul` for this long. */
  stressSec: 3,
  stressRegenMul: 0.35,
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
  /** Stamina 0..STAMINA.max. */
  stamina: number;
  /** Ran dry: no sprinting until stamina is back over STAMINA.recoverAt. */
  exhausted: boolean;
  /** Sprinted on the last step (a sprint already going may continue below STAMINA.startMin). */
  sprinting: boolean;
  /** Seconds since stamina was last spent sprinting (regen starts at STAMINA.regenDelaySec; capped there). */
  rest: number;
  /** Seconds of damage stress left (slower regen). */
  stress: number;
  /**
   * On a grappling hook's rope (sim/grapple.ts): pulled toward feet target (x, y, z) for at most `left` more
   * seconds. `yank`: someone else's hook dragging you (your own movement is off). Absent = free.
   */
  pull?: { x: number; y: number; z: number; left: number; yank?: true };
};

/** One fixed (1/30 s) movement step's worth of input, numbered by the client for reconciliation. */
export type MoveCmd = { seq: number; moveX: number; moveZ: number; yaw: number; jump: boolean; sprint: boolean };

export type Mover = { pos: Vec3; vel: Vec3; mv: MoveState };
/** The collision side: move the capsule by `desired` (sliding), return the new feet position. */
export type MoveBody = { movePlayer(desired: Vec3): { pos: Vec3; grounded: boolean } };

export const newMoveState = (): MoveState => ({
  grounded: false, airTime: 0, jumpBuf: 0, ack: 0, stamina: STAMINA.max, exhausted: false, sprinting: false, rest: STAMINA.regenDelaySec, stress: 0,
});

/** Full stamina, no stress (respawn). */
export function refillStamina(mv: MoveState): void {
  mv.stamina = STAMINA.max;
  mv.exhausted = false;
  mv.sprinting = false;
  mv.rest = STAMINA.regenDelaySec;
  mv.stress = 0;
}

/** Taking `damage` stresses you: an immediate drain proportional to it, and slow regen for a while. */
export function stressFromDamage(mv: MoveState, damage: number): void {
  if (!(damage > 0)) return;
  mv.stamina = Math.max(0, mv.stamina - damage * STAMINA.damagePerHp);
  mv.stress = STAMINA.stressSec;
}

/**
 * One step of stamina: returns whether this step sprints. `want` = sprint held while moving.
 * Sprint can't start below startMin, stops at 0 (exhausted until over recoverAt); not sprinting
 * regenerates after a short pause (faster standing still, slower while stressed).
 */
export function stepStamina(mv: MoveState, want: boolean, moving: boolean, dt: number): boolean {
  if (mv.exhausted && mv.stamina >= STAMINA.recoverAt) mv.exhausted = false;
  const on = want && !mv.exhausted && (mv.sprinting || mv.stamina >= STAMINA.startMin);
  if (on) {
    mv.stamina -= STAMINA.drainPerSec * dt;
    mv.rest = 0;
    if (mv.stamina <= 0) { mv.stamina = 0; mv.exhausted = true; }
  } else {
    mv.rest = Math.min(STAMINA.regenDelaySec, mv.rest + dt);
    if (mv.rest >= STAMINA.regenDelaySec - EPS) {
      const rate = STAMINA.regenPerSec * (moving ? 1 : STAMINA.idleRegenMul) * (mv.stress > 0 ? STAMINA.stressRegenMul : 1);
      mv.stamina = Math.min(STAMINA.max, mv.stamina + rate * dt);
    }
  }
  mv.stress = Math.max(0, mv.stress - dt);
  mv.sprinting = on && !mv.exhausted;
  return on;
}

const EPS = 1e-6;
const AIR_CAP = 1;

/** Wished horizontal velocity for move axes in the yaw frame (three.js yaw: 0 looks toward -Z). */
export function wishVelocity(moveX: number, moveZ: number, yaw: number, sprint: boolean): { x: number; z: number } {
  const s = dm.sin(yaw), c = dm.cos(yaw);
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
/** `speedMult` scales the wished speed (speed potion). */
export function stepMove(m: Mover, cmd: MoveCmd, dt: number, body: MoveBody, speedMult = 1): { landingSpeed: number } {
  const mv = m.mv;
  const moving = Math.hypot(cmd.moveX, cmd.moveZ) > EPS;
  if (mv.pull && stepPull(m, cmd, moving, dt, body)) return { landingSpeed: 0 };
  const sprint = stepStamina(mv, cmd.sprint && moving, moving, dt);
  const w0 = wishVelocity(cmd.moveX, cmd.moveZ, cmd.yaw, sprint);
  const wish = { x: w0.x * speedMult, z: w0.z * speedMult };
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
    mv.stamina = Math.max(0, mv.stamina - STAMINA.jumpCost);
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

/**
 * One step on a grappling rope (mv.pull). Returns false when the rope let go this step (arrived, timed out,
 * or jump pressed on your own hook) so the caller runs a normal step instead. Pulls never hurt on landing.
 * Your own hook eases you up to GRAPPLE.pullSpeed toward the point; a yank sets the velocity outright.
 */
function stepPull(m: Mover, cmd: MoveCmd, moving: boolean, dt: number, body: MoveBody): boolean {
  const mv = m.mv, pl = mv.pull!;
  if (!pl.yank && cmd.jump) { delete mv.pull; return false; }
  const dx = pl.x - m.pos.x, dy = pl.y - m.pos.y, dz = pl.z - m.pos.z;
  const d = Math.hypot(dx, dy, dz);
  // A fresh object, never mutated in place: prediction shares it with snapshots and render-time part steps.
  const left = pl.left - dt;
  mv.pull = { ...pl, left };
  if (d <= (pl.yank ? GRAPPLE.yankStop : GRAPPLE.arriveDist) || left <= EPS) {
    delete mv.pull;
    if (pl.yank) { m.vel.x *= GRAPPLE.yankKeep; m.vel.y = Math.min(m.vel.y, 0); m.vel.z *= GRAPPLE.yankKeep; }
    else if (d <= GRAPPLE.arriveDist) {
      // Arrived: shed most of the speed and pop up a little, so you land on the ledge instead of sailing past.
      m.vel.x *= GRAPPLE.arriveKeep; m.vel.z *= GRAPPLE.arriveKeep;
      m.vel.y = Math.max(m.vel.y * GRAPPLE.arriveKeep, GRAPPLE.arrivePop);
    }
    return false;
  }
  stepStamina(mv, false, moving, dt);
  const speed = pl.yank ? GRAPPLE.yankSpeed : GRAPPLE.pullSpeed;
  const k = pl.yank ? 1 : Math.min(1, GRAPPLE.pullResponse * dt);
  m.vel.x += (dx / d * speed - m.vel.x) * k;
  m.vel.y += (dy / d * speed - m.vel.y) * k;
  m.vel.z += (dz / d * speed - m.vel.z) * k;
  const r = body.movePlayer({ x: m.vel.x * dt, y: m.vel.y * dt, z: m.vel.z * dt });
  m.pos = r.pos;
  mv.grounded = r.grounded;
  mv.airTime = r.grounded ? 0 : Math.min(AIR_CAP, mv.airTime + dt);
  mv.jumpBuf = 0;
  return true;
}
