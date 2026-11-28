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
   * On a grappling hook's rope (sim/grapple.ts): roped to feet target (x, y, z) for at most `left` more
   * seconds.
   * `yank`: someone else's hook dragging you (your own movement is off). Absent = free.
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

/** A release off your own rope keeps its velocity, capped at GRAPPLE.flingMax (a fling, never a cannon: reach rule). */
export function capFling(vel: Vec3): void {
  const sp = Math.hypot(vel.x, vel.y, vel.z);
  if (sp <= GRAPPLE.flingMax) return;
  const k = GRAPPLE.flingMax / sp;
  vel.x *= k; vel.y *= k; vel.z *= k;
}

/**
 * One step on a grappling rope (mv.pull). Returns false when the rope let go this step (arrived, timed out,
 * or jump pressed on your own hook) so the caller runs a normal step instead. Pulls never hurt on landing.
 *
 * Your own hook pulls you straight at the point, like the old hook, with a light elastic layer (GRAPPLE, see there):
 * the speed along the rope eases up at pullAccel to pullSpeed and brakes on the way in (arriveSpeed/pullBrake, and
 * easeLead/easeSec for short hooks); sideways speed carries and dies off at swingDamp, a sagGravity share of gravity
 * bows the path and strafe nudges it. A wall in the way runs the rope's clock stallDrain× faster (no pinning). On
 * arrival you hop onto the ledge (arriveStep on, enough up to clear the point). A yank sets the velocity outright.
 */
function stepPull(m: Mover, cmd: MoveCmd, moving: boolean, dt: number, body: MoveBody): boolean {
  const mv = m.mv, pl = mv.pull!;
  if (!pl.yank && cmd.jump) { delete mv.pull; capFling(m.vel); return false; }
  const dx = pl.x - m.pos.x, dy = pl.y - m.pos.y, dz = pl.z - m.pos.z;
  const d = Math.hypot(dx, dy, dz);
  const left = pl.left - dt;
  // A fresh object, never mutated in place: prediction shares it with snapshots and render-time part steps.
  mv.pull = { ...pl, left };
  if (d <= (pl.yank ? GRAPPLE.yankStop : GRAPPLE.arriveDist) || left <= EPS) {
    delete mv.pull;
    if (pl.yank) { m.vel.x *= GRAPPLE.yankKeep; m.vel.y = Math.min(m.vel.y, 0); m.vel.z *= GRAPPLE.yankKeep; }
    else if (d <= GRAPPLE.arriveDist) arrive(m, dx, dy, dz);
    else capFling(m.vel);
    return false;
  }
  stepStamina(mv, false, moving, dt);
  const nx = dx / d, ny = dy / d, nz = dz / d;
  if (pl.yank) {
    m.vel.x = nx * GRAPPLE.yankSpeed;
    m.vel.y = ny * GRAPPLE.yankSpeed;
    m.vel.z = nz * GRAPPLE.yankSpeed;
  } else {
    m.vel.y -= PLAYER.gravity * GRAPPLE.sagGravity * dt;
    if (Math.abs(cmd.moveX) > EPS) {
      const rx = dm.cos(cmd.yaw) * cmd.moveX * GRAPPLE.swingSteer * dt, rz = -dm.sin(cmd.yaw) * cmd.moveX * GRAPPLE.swingSteer * dt;
      m.vel.x += rx; m.vel.z += rz;
    }
    // Along the rope: ease toward the braking profile's speed. Across it: keep, dying off (a mild swing).
    const togo = Math.max(0, d - GRAPPLE.arriveDist);
    const want = Math.min(GRAPPLE.pullSpeed, Math.sqrt(GRAPPLE.arriveSpeed * GRAPPLE.arriveSpeed + 2 * GRAPPLE.pullBrake * togo),
      (togo + GRAPPLE.easeLead) / GRAPPLE.easeSec);
    const along = m.vel.x * nx + m.vel.y * ny + m.vel.z * nz;
    const next = along + Math.min(GRAPPLE.pullAccel * dt, want - along);
    const keep = dm.exp(-GRAPPLE.swingDamp * dt);
    m.vel.x = nx * next + (m.vel.x - along * nx) * keep;
    m.vel.y = ny * next + (m.vel.y - along * ny) * keep;
    m.vel.z = nz * next + (m.vel.z - along * nz) * keep;
  }
  const p0 = m.pos;
  const r = body.movePlayer({ x: m.vel.x * dt, y: m.vel.y * dt, z: m.vel.z * dt });
  m.pos = r.pos;
  mv.grounded = r.grounded;
  if (!pl.yank) {
    // Whatever stopped the capsule takes that part of the velocity (none stored up behind a wall), and a pull that
    // isn't getting closer burns its clock fast: it lets go instead of pinning you against the wall.
    const ax = (r.pos.x - p0.x) / dt, ay = (r.pos.y - p0.y) / dt, az = (r.pos.z - p0.z) / dt;
    if (Math.abs(ax) < Math.abs(m.vel.x) - 1e-6) m.vel.x = ax;
    if (Math.abs(ay) < Math.abs(m.vel.y) - 1e-6) m.vel.y = ay;
    if (Math.abs(az) < Math.abs(m.vel.z) - 1e-6) m.vel.z = az;
    const gained = (ax * nx + ay * ny + az * nz) * dt;
    if (gained < 0.25 * GRAPPLE.arriveSpeed * dt) mv.pull = { ...mv.pull!, left: left - (GRAPPLE.stallDrain - 1) * dt };
  } else if (r.grounded && m.vel.y < 0) m.vel.y = 0;
  mv.airTime = r.grounded ? 0 : Math.min(AIR_CAP, mv.airTime + dt);
  mv.jumpBuf = 0;
  return true;
}

/**
 * Arrived (within GRAPPLE.arriveDist of the point, (dx, dy, dz) away): shed most of the speed, step on toward the point
 * and hop up enough to clear it when it's above you, so you land on the ledge instead of sailing past or dropping back.
 */
function arrive(m: Mover, dx: number, dy: number, dz: number): void {
  m.vel.x *= GRAPPLE.arriveKeep; m.vel.z *= GRAPPLE.arriveKeep;
  const h = Math.hypot(dx, dz);
  if (h > 0.2) {
    const on = (m.vel.x * dx + m.vel.z * dz) / h;
    if (on < GRAPPLE.arriveStep) { m.vel.x += dx / h * (GRAPPLE.arriveStep - on); m.vel.z += dz / h * (GRAPPLE.arriveStep - on); }
  }
  const clear = dy > 0 ? Math.min(GRAPPLE.mantleMax, Math.sqrt(2 * PLAYER.gravity * (dy + 0.35))) : 0;
  m.vel.y = Math.max(m.vel.y * GRAPPLE.arriveKeep, GRAPPLE.arrivePop, clear);
}
