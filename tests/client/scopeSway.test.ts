import { describe, expect, test } from 'vitest';
import { ScopeSway, STILL, SWAY_RAD } from '../../src/client/scopeSway';

/** Sniper scope sway: drifts while scoped (less standing still), back to no offset when unscoped. */
const run = (s: ScopeSway, sec: number, scoped: boolean, speed: number) => {
  let yaw = 0, pitch = 0, maxR = 0;
  for (let i = 0; i < sec * 60; i++) {
    s.step(1 / 60, scoped, speed);
    yaw += s.dYaw; pitch += s.dPitch;
    maxR = Math.max(maxR, Math.hypot(yaw, pitch));
  }
  return { yaw, pitch, maxR };
};

describe('scope sway', () => {
  test('moving sways more than standing still, within a mild radius', () => {
    const walk = run(new ScopeSway(), 8, true, 3), still = run(new ScopeSway(), 8, true, 0);
    expect(walk.maxR).toBeGreaterThan(SWAY_RAD * 0.5);
    expect(walk.maxR).toBeLessThan(SWAY_RAD * 2);
    expect(still.maxR).toBeLessThan(walk.maxR * (STILL + 0.25));
  });
  test('unscoping eases the offset back to zero (no lasting drift of the aim)', () => {
    const s = new ScopeSway();
    const a = run(s, 5, true, 3), b = run(s, 5, false, 3);
    expect(Math.hypot(a.yaw + b.yaw, a.pitch + b.pitch)).toBeLessThan(1e-5);
  });
  test('never sways when not scoped', () => {
    expect(run(new ScopeSway(), 3, false, 5).maxR).toBe(0);
  });
});
