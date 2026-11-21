import { describe, expect, test } from 'vitest';
import { burnedBy, damageNumbers, hitDirection } from '../../src/client/damageFx';
import type { MatchEvent } from '../../src/sim/types';

const hit = (target: number, by: number, amount: number, shieldAmount = 0): MatchEvent => ({ t: 1, type: 'hit', data: { target, by, amount, shieldAmount } });

describe('damageNumbers', () => {
  test('only shows damage dealt by me', () => {
    expect(damageNumbers([hit(2, 1, 20), hit(1, 2, 30)], 1)).toEqual([{ target: 2, amount: 20, shield: 0 }]);
  });
  test('combines shotgun pellets on the same target into one number', () => {
    const evs = Array.from({ length: 7 }, () => hit(3, 1, 8));
    expect(damageNumbers(evs, 1)).toEqual([{ target: 3, amount: 56, shield: 0 }]);
  });
  test('separate targets stay separate, rounded', () => {
    expect(damageNumbers([hit(2, 1, 12.4), hit(3, 1, 30.6)], 1)).toEqual([{ target: 2, amount: 12, shield: 0 }, { target: 3, amount: 31, shield: 0 }]);
  });
  test('splits the part the shield soaked from the part that reached health', () => {
    expect(damageNumbers([hit(2, 1, 30, 30), hit(2, 1, 30, 10)], 1)).toEqual([{ target: 2, amount: 60, shield: 40 }]);
  });
  test('ignores other events', () => {
    expect(damageNumbers([{ t: 1, type: 'shot', data: { by: 1 } }], 1)).toEqual([]);
  });
});

describe('hitDirection', () => {
  // Camera yaw convention: yaw 0 looks toward -Z. Result: 0 = attacker straight ahead, +PI/2 = to my right, PI = behind.
  test('attacker straight ahead is 0', () => {
    expect(hitDirection({ x: 0, z: 0 }, { x: 0, z: -10 }, 0)).toBeCloseTo(0);
  });
  test('attacker to the right is +90°', () => {
    expect(hitDirection({ x: 0, z: 0 }, { x: 10, z: 0 }, 0)).toBeCloseTo(Math.PI / 2);
  });
  test('attacker behind is 180°', () => {
    expect(Math.abs(hitDirection({ x: 0, z: 0 }, { x: 0, z: 10 }, 0))).toBeCloseTo(Math.PI);
  });
  test('turning the camera left makes a fixed attacker swing right', () => {
    expect(hitDirection({ x: 0, z: 0 }, { x: 0, z: -10 }, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });
});

describe('burning indicator', () => {
  test('lights up only for fire damage to me', () => {
    const hit = (target: number, weapon: string): MatchEvent => ({ t: 1, type: 'hit', data: { target, by: 2, amount: 3, weapon } });
    expect(burnedBy([hit(1, 'fire')], 1)).toBe(true);
    expect(burnedBy([hit(2, 'fire'), hit(1, 'rifle')], 1)).toBe(false);
    expect(burnedBy([], 1)).toBe(false);
  });
});
