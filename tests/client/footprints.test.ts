import { describe, expect, test } from 'vitest';
import { FootTrail, printOn, STEP_M, type Print } from '../../src/client/world/footprints';

describe('footprints', () => {
  test('a print every step, alternating feet either side of the path, facing the way of travel', () => {
    const t = new FootTrail();
    const prints: Print[] = [];
    for (let i = 0; i <= 300; i++) { const p = t.step(1, 4, -2 + i * 0.02); if (p) prints.push(p); } // 6 m along +z
    expect(prints.length).toBe(Math.floor(6 / STEP_M));
    for (let i = 0; i < prints.length; i++) {
      const p = prints[i];
      expect(Math.abs(p.yaw)).toBeLessThan(1e-6); // +z
      expect(Math.abs(p.x - 4)).toBeCloseTo(0.11, 5);
      if (i) expect(p.side).toBe(-prints[i - 1].side);
      expect(Math.sign(4 - p.x)).toBe(p.side); // side 1 = right of +z travel = −x
    }
  });

  test('standing still or teleporting leaves nothing; walkers are tracked apart', () => {
    const t = new FootTrail();
    t.step(1, 0, 0); t.step(2, 10, 0);
    expect(t.step(1, 0, 0)).toBeNull();
    expect(t.step(1, 50, 50)).toBeNull(); // respawn jump
    expect(t.step(1, 50, 50.5)).toBeNull();
    expect(t.step(2, 10, 0.5)).toBeNull();
    expect(t.step(1, 50, 50.8)).not.toBeNull(); // 0.8 m since the teleport
  });

  test('which ground takes a print', () => {
    expect(printOn('sand', 0)!.strength).toBeGreaterThan(printOn('gravel', 0)!.strength);
    expect(printOn('sand', 1)!.strength).toBeGreaterThan(printOn('sand', 0)!.strength); // rain: sharper prints
    expect(printOn('concrete', 0)).toBeNull(); // dry docks: none
    expect(printOn('quay', 0.8)!.strength).toBeGreaterThan(0.2); // wet docks: yes
    expect(printOn('water', 1)).toBeNull();
    expect(printOn('grass', 1)).toBeNull();
  });
});
