import { describe, expect, test } from 'vitest';
import { moveForAim } from '../../src/client/aim';
import { add, forward, right, scale } from '../../src/sim/vec';

/** World direction the sim will move us, given move axes in the aim-yaw frame (mirrors Match.move). */
const simDir = (mx: number, mz: number, aimYaw: number) => add(scale(forward(aimYaw), mz), scale(right(aimYaw), mx));

describe('moveForAim', () => {
  test('W walks where the camera looks even when the gun aims elsewhere', () => {
    const camYaw = 0.3, aimYaw = 0.39;
    const m = moveForAim(0, 1, camYaw, aimYaw);
    const d = simDir(m.moveX, m.moveZ, aimYaw);
    const want = forward(camYaw);
    expect(d.x).toBeCloseTo(want.x, 6);
    expect(d.z).toBeCloseTo(want.z, 6);
  });
  test('strafe right follows the camera too', () => {
    const m = moveForAim(1, 0, -1.2, -1.0);
    const d = simDir(m.moveX, m.moveZ, -1.0);
    const want = right(-1.2);
    expect(d.x).toBeCloseTo(want.x, 6);
    expect(d.z).toBeCloseTo(want.z, 6);
  });
  test('no correction when camera and aim agree', () => {
    expect(moveForAim(0.5, -1, 2, 2)).toEqual({ moveX: 0.5, moveZ: -1 });
  });
});
