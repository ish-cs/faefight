import { describe, expect, test } from 'vitest';
import { DT, PLAYER } from '../../src/sim/constants';
import { accelerate, MOVE, newMoveState, stepMove, type MoveBody, type MoveCmd, type Mover } from '../../src/sim/movement';
import { v3 } from '../../src/sim/vec';

/** Flat floor at y = 0 with an optional ledge: beyond x > ledgeX the floor drops away. */
function flatBody(m: Mover, ledgeX = Infinity): MoveBody {
  return {
    movePlayer(d) {
      const x = m.pos.x + d.x, z = m.pos.z + d.z;
      let y = m.pos.y + d.y;
      const floor = x > ledgeX ? -100 : 0;
      const grounded = y <= floor + 1e-9;
      if (grounded) y = floor;
      return { pos: v3(x, y, z), grounded };
    },
  };
}

const mover = (): Mover => ({ pos: v3(), vel: v3(), mv: { ...newMoveState(), grounded: true } });
const cmd = (c: Partial<MoveCmd> = {}): MoveCmd => ({ seq: 0, moveX: 0, moveZ: 0, yaw: 0, jump: false, sprint: false, ...c });
const speed = (m: Mover) => Math.hypot(m.vel.x, m.vel.z);

/** Steps until horizontal speed reaches `target` (within 1 mm/s). */
function stepsTo(m: Mover, c: MoveCmd, target: number, body = flatBody(m)) {
  for (let i = 1; i <= 60; i++) {
    stepMove(m, c, DT, body);
    if (Math.abs(speed(m) - target) < 1e-3) return i;
  }
  return Infinity;
}

describe('accelerate (pure)', () => {
  test('ground: reaches walk speed in ~0.1 s and stops in under 0.1 s', () => {
    expect(MOVE.groundAccel).toBeGreaterThan(0);
    const toWalk = PLAYER.walk / MOVE.groundAccel;
    const toStop = PLAYER.walk / MOVE.groundDecel;
    expect(toWalk).toBeGreaterThanOrEqual(0.08);
    expect(toWalk).toBeLessThanOrEqual(0.12);
    expect(toStop).toBeGreaterThanOrEqual(0.06);
    expect(toStop).toBeLessThanOrEqual(0.1);
  });

  test('never overshoots the wish velocity', () => {
    const r = accelerate(4.9, 0, 5, 0, true, 0.1);
    expect(r).toEqual({ x: 5, z: 0 });
  });

  test('reversing direction brakes harder than plain acceleration', () => {
    const plain = accelerate(0, 0, 5, 0, true, DT);
    const reverse = accelerate(-5, 0, 5, 0, true, DT);
    expect(reverse.x - -5).toBeGreaterThan(plain.x - 0 + 1e-6);
  });

  test('air control is reduced and momentum is kept without input', () => {
    const ground = accelerate(0, 0, 5, 0, true, DT);
    const air = accelerate(0, 0, 5, 0, false, DT);
    expect(air.x).toBeGreaterThan(0);
    expect(air.x).toBeLessThan(ground.x * 0.5);
    expect(accelerate(5, 0, 0, 0, false, DT)).toEqual({ x: 5, z: 0 });
  });

  test('frame-rate independent: two half steps = one full step (constant accel)', () => {
    const half = accelerate(0, 0, 5, 0, true, DT / 2);
    const two = accelerate(half.x, half.z, 5, 0, true, DT / 2);
    const one = accelerate(0, 0, 5, 0, true, DT);
    expect(two.x).toBeCloseTo(one.x, 9);
  });
});

describe('stepMove', () => {
  test('walk speed reached in ~3 ticks (0.1 s), stop in ~3 ticks', () => {
    const m = mover();
    expect(stepsTo(m, cmd({ moveZ: 1 }), PLAYER.walk)).toBe(3);
    expect(stepsTo(m, cmd(), 0)).toBeLessThanOrEqual(3);
  });

  test('sprint transitions are short and symmetric-ish', () => {
    const m = mover();
    stepsTo(m, cmd({ moveZ: 1 }), PLAYER.walk);
    const up = stepsTo(m, cmd({ moveZ: 1, sprint: true }), PLAYER.sprint);
    const down = stepsTo(m, cmd({ moveZ: 1 }), PLAYER.walk);
    expect(up).toBeLessThanOrEqual(2);
    expect(down).toBeLessThanOrEqual(2);
  });

  test('moves along the yaw frame (yaw 0 → -Z)', () => {
    const m = mover();
    for (let i = 0; i < 10; i++) stepMove(m, cmd({ moveZ: 1 }), DT, flatBody(m));
    expect(m.pos.z).toBeLessThan(-0.5);
    expect(Math.abs(m.pos.x)).toBeLessThan(1e-9);
  });

  test('jump from the ground', () => {
    const m = mover();
    stepMove(m, cmd({ jump: true }), DT, flatBody(m));
    expect(m.vel.y).toBeCloseTo(PLAYER.jumpVelocity, 6);
    expect(m.pos.y).toBeGreaterThan(0);
    expect(m.mv.grounded).toBe(false);
  });

  test('no double jump in the air', () => {
    const m = mover();
    stepMove(m, cmd({ jump: true }), DT, flatBody(m));
    stepMove(m, cmd(), DT, flatBody(m));
    const vy = m.vel.y;
    stepMove(m, cmd({ jump: true }), DT, flatBody(m));
    expect(m.vel.y).toBeLessThan(vy);
  });

  test('coyote time: a jump just after walking off a ledge still works (≤0.1 s)', () => {
    const m = mover();
    m.vel.x = 5;
    m.pos.x = -0.01;
    const body = flatBody(m, 0);
    const side = cmd({ moveX: 1, yaw: 0 });
    stepMove(m, side, DT, body); // walks off: airborne now
    expect(m.mv.grounded).toBe(false);
    stepMove(m, side, DT, body); // 1 tick of falling
    stepMove(m, cmd({ moveX: 1, jump: true }), DT, body);
    expect(m.vel.y).toBeCloseTo(PLAYER.jumpVelocity, 6);
  });

  test('coyote time expires', () => {
    const m = mover();
    m.vel.x = 5;
    m.pos.x = -0.01;
    const body = flatBody(m, 0);
    for (let i = 0; i < 5; i++) stepMove(m, cmd({ moveX: 1 }), DT, body); // > 0.1 s airborne
    stepMove(m, cmd({ moveX: 1, jump: true }), DT, body);
    expect(m.vel.y).toBeLessThan(0);
  });

  test('jump buffering: pressing jump shortly before landing jumps on landing', () => {
    const m = mover();
    m.mv = { ...m.mv, grounded: false, airTime: 1 };
    m.pos.y = 0.05;
    m.vel.y = -1.5; // lands next tick
    stepMove(m, cmd({ jump: true }), DT, flatBody(m)); // pressed in the air: can't jump yet
    expect(m.mv.grounded).toBe(true);
    stepMove(m, cmd(), DT, flatBody(m)); // released, but the buffered press fires now
    expect(m.vel.y).toBeCloseTo(PLAYER.jumpVelocity, 6);
  });

  test('jump buffer expires after ~0.1 s', () => {
    const m = mover();
    m.mv = { ...m.mv, grounded: false, airTime: 1 };
    m.pos.y = 10;
    stepMove(m, cmd({ jump: true }), DT, flatBody(m));
    for (let i = 0; i < 3; i++) stepMove(m, cmd(), DT, flatBody(m));
    m.pos.y = 0; m.vel.y = -1; // force a landing now
    stepMove(m, cmd(), DT, flatBody(m));
    stepMove(m, cmd(), DT, flatBody(m));
    expect(m.vel.y).toBeLessThanOrEqual(0);
  });

  test('reports landing speed for fall damage', () => {
    const m = mover();
    m.mv = { ...m.mv, grounded: false, airTime: 1 };
    m.pos.y = 0.1;
    m.vel.y = -12;
    const r = stepMove(m, cmd(), DT, flatBody(m));
    expect(r.landingSpeed).toBeGreaterThan(12);
    expect(m.vel.y).toBe(0);
  });

  test('deterministic: same commands → identical state', () => {
    const run = () => {
      const m = mover();
      const cmds = [cmd({ moveZ: 1 }), cmd({ moveZ: 1, jump: true, yaw: 0.3 }), cmd({ moveX: -1, sprint: true }), cmd()];
      for (let k = 0; k < 20; k++) stepMove(m, cmds[k % cmds.length], DT, flatBody(m));
      return m;
    };
    expect(run()).toEqual(run());
  });
});
