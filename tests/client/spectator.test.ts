import { describe, expect, test } from 'vitest';
import { flyStep, followOrder, SPECTATE } from '../../src/client/spectator';

const keys = (k: Partial<Record<'fwd' | 'back' | 'left' | 'right' | 'up' | 'down' | 'fast', boolean>>) =>
  ({ fwd: false, back: false, left: false, right: false, up: false, down: false, fast: false, ...k });

describe('spectator free fly', () => {
  test('W flies along the look direction (yaw 0 = -Z), pitch included', () => {
    const p = flyStep({ x: 0, y: 10, z: 0 }, 0, 0, keys({ fwd: true }), 1);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
    expect(p.z).toBeCloseTo(-SPECTATE.speed);
    const up = flyStep({ x: 0, y: 10, z: 0 }, 0, Math.PI / 4, keys({ fwd: true }), 1);
    expect(up.y).toBeGreaterThan(10);
  });

  test('D strafes right, Space rises, down sinks, Shift is faster', () => {
    expect(flyStep({ x: 0, y: 10, z: 0 }, 0, 0, keys({ right: true }), 1).x).toBeCloseTo(SPECTATE.speed);
    expect(flyStep({ x: 0, y: 10, z: 0 }, 0, 0, keys({ up: true }), 1).y).toBeCloseTo(10 + SPECTATE.speed);
    expect(flyStep({ x: 0, y: 10, z: 0 }, 0, 0, keys({ down: true }), 0.1).y).toBeCloseTo(10 - SPECTATE.speed * 0.1);
    expect(flyStep({ x: 0, y: 10, z: 0 }, 0, 0, keys({ fwd: true, fast: true }), 1).z).toBeCloseTo(-SPECTATE.speed * SPECTATE.fastMul);
  });

  test('diagonals are not faster; no keys = no motion; height is clamped', () => {
    const d = flyStep({ x: 0, y: 10, z: 0 }, 0, 0, keys({ fwd: true, right: true }), 1);
    expect(Math.hypot(d.x, d.z)).toBeCloseTo(SPECTATE.speed);
    expect(flyStep({ x: 1, y: 2, z: 3 }, 1, 0.3, keys({}), 1)).toEqual({ x: 1, y: 2, z: 3 });
    expect(flyStep({ x: 0, y: 0, z: 0 }, 0, 0, keys({ down: true }), 100).y).toBe(SPECTATE.minY);
    expect(flyStep({ x: 0, y: 0, z: 0 }, 0, 0, keys({ up: true }), 100).y).toBe(SPECTATE.maxY);
  });
});

describe('spectator follow order', () => {
  const ps = [
    { id: 3, alive: true }, { id: 1, alive: true }, { id: 2, alive: false }, { id: 4, alive: true },
  ];
  test('living players other than you, by id', () => {
    expect(followOrder(ps, 1)).toEqual([3, 4]);
    expect(followOrder(ps, 2)).toEqual([1, 3, 4]);
  });
});
