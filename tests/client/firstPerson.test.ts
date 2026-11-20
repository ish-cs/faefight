import { describe, expect, test } from 'vitest';
import {
  angleDelta, bobOffset, bobRate, CAMERA_MODE_KEY, eyePosition, idleSway, loadCameraMode, recoilKick, reloadDip,
  saveCameraMode, toggleMode, viewDir,
} from '../../src/client/firstPerson';
import { moveForAim } from '../../src/client/aim';
import { PLAYER } from '../../src/sim/constants';
import { forward } from '../../src/sim/vec';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('camera mode persistence', () => {
  test('defaults to third person', () => {
    expect(loadCameraMode(mem())).toBe('third');
    expect(loadCameraMode(null)).toBe('third');
  });
  test('round-trips through storage', () => {
    const s = mem();
    saveCameraMode('first', s);
    expect(s.m.get(CAMERA_MODE_KEY)).toBe('first');
    expect(loadCameraMode(s)).toBe('first');
    saveCameraMode('third', s);
    expect(loadCameraMode(s)).toBe('third');
  });
  test('garbage or throwing storage falls back to third person', () => {
    const s = mem();
    s.setItem(CAMERA_MODE_KEY, 'sideways');
    expect(loadCameraMode(s)).toBe('third');
    const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadCameraMode(boom)).toBe('third');
    expect(() => saveCameraMode('first', boom)).not.toThrow();
  });
  test('toggle flips', () => {
    expect(toggleMode('third')).toBe('first');
    expect(toggleMode('first')).toBe('third');
  });
});

describe('eye position', () => {
  test('is the feet raised by the eye height', () => {
    expect(eyePosition({ x: 3, y: 2, z: -7 })).toEqual({ x: 3, y: 2 + PLAYER.eyeHeight, z: -7 });
  });
  test('view direction matches the sim forward at zero pitch, and is unit length', () => {
    for (const yaw of [0, 0.7, -2.1, 3]) {
      const d = viewDir(yaw, 0), f = forward(yaw);
      expect(d.x).toBeCloseTo(f.x, 9);
      expect(d.z).toBeCloseTo(f.z, 9);
      const p = viewDir(yaw, 0.6);
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 9);
      expect(p.y).toBeCloseTo(Math.sin(0.6), 9);
    }
  });
  test('in first person aim yaw == camera yaw, so movement correction is the identity', () => {
    expect(moveForAim(0.5, 1, 1.3, 1.3)).toEqual({ moveX: 0.5, moveZ: 1 });
  });
});

describe('viewmodel motion curves', () => {
  test('bob: none when standing, bigger when running, bounded', () => {
    expect(bobRate(0)).toBe(0);
    expect(bobRate(PLAYER.sprint)).toBeGreaterThan(bobRate(PLAYER.walk));
    let walkMax = 0, runMax = 0;
    for (let ph = 0; ph < Math.PI * 2; ph += 0.05) {
      walkMax = Math.max(walkMax, Math.abs(bobOffset(ph, PLAYER.walk).x));
      runMax = Math.max(runMax, Math.abs(bobOffset(ph, PLAYER.sprint).x));
      expect(bobOffset(ph, PLAYER.sprint).y).toBeLessThanOrEqual(0); // only dips, never pokes up
    }
    expect(runMax).toBeGreaterThan(walkMax);
    expect(runMax).toBeLessThan(0.03);
  });
  test('idle sway is small and smooth', () => {
    for (let t = 0; t < 20; t += 0.1) {
      const s = idleSway(t), n = idleSway(t + 1 / 60);
      expect(Math.abs(s.x)).toBeLessThan(0.005);
      expect(Math.abs(s.y)).toBeLessThan(0.005);
      expect(Math.abs(n.x - s.x)).toBeLessThan(0.0002);
    }
  });
  test('recoil snaps up then decays to rest', () => {
    expect(recoilKick(-0.1)).toBe(0);
    expect(recoilKick(0.025)).toBeCloseTo(1, 6);
    expect(recoilKick(0.1)).toBeLessThan(0.3);
    expect(recoilKick(0.3)).toBe(0);
  });
  test('reload dip eases in, holds, eases out', () => {
    expect(reloadDip(0)).toBe(0);
    expect(reloadDip(0.1)).toBeCloseTo(0.5, 6);
    expect(reloadDip(0.5)).toBe(1);
    expect(reloadDip(0.9)).toBeCloseTo(0.5, 6);
    expect(reloadDip(1)).toBe(0);
  });
  test('angleDelta wraps', () => {
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(-0.2, 9);
  });
});
