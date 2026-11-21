import { describe, expect, test } from 'vitest';
import { adoptSpawnLook, moveForAim } from '../../src/client/aim';
import { InputAccumulator } from '../../src/client/inputAccum';
import { NO_INPUT } from '../../src/sim/types';
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

describe('adoptSpawnLook', () => {
  const spawn = (player: number, yaw: number, selected = 2) => ({ type: 'spawn', data: { player, yaw, selected } });
  test('my spawn event snaps yaw, levels pitch and selects the pistol slot, once', () => {
    const look = { yaw: 2.5, pitch: -0.7, selected: 4 };
    expect(adoptSpawnLook(look, [spawn(1, -1.2)], 1)).toBe(true);
    expect(look).toEqual({ yaw: -1.2, pitch: 0, selected: 2 });
    // Later snapshots carry no spawn event: the mouse is free again.
    look.yaw = 0.4; look.pitch = 0.1;
    expect(adoptSpawnLook(look, [], 1)).toBe(false);
    expect(adoptSpawnLook(look, [{ type: 'kill', data: { victim: 1 } }], 1)).toBe(false);
    expect(look).toEqual({ yaw: 0.4, pitch: 0.1, selected: 2 });
  });
  test("someone else's spawn leaves my look alone", () => {
    const look = { yaw: 1, pitch: 0.2, selected: 0 };
    expect(adoptSpawnLook(look, [spawn(2, -3)], 1)).toBe(false);
    expect(look).toEqual({ yaw: 1, pitch: 0.2, selected: 0 });
  });
});

describe('InputAccumulator', () => {
  test('not started until the first sample (the sim keeps the spawn look meanwhile)', () => {
    const a = new InputAccumulator();
    expect(a.started).toBe(false);
    a.push({ ...NO_INPUT, yaw: 1.3 });
    expect(a.started).toBe(true);
    expect(a.take().yaw).toBe(1.3);
  });
});
