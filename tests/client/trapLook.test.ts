import { describe, expect, test } from 'vitest';
import { SPIKE_ANIM_SEC, spikeExtension } from '../../src/client/world/traps';
import { nearestTrap } from '../../src/client/damageFx';
import type { TrapNet } from '../../src/sim/types';

describe('spike trap look', () => {
  test('spikes snap out fast, hold, then sink back to rest', () => {
    expect(spikeExtension(-1)).toBe(0); // never fired / not yet
    expect(spikeExtension(0)).toBe(0);
    expect(spikeExtension(0.03)).toBeCloseTo(0.5, 5);
    expect(spikeExtension(0.06)).toBe(1);
    expect(spikeExtension(0.3)).toBe(1);
    const back = [0.5, 0.6, 0.7, 0.8, 0.9].map(spikeExtension);
    for (let i = 1; i < back.length; i++) expect(back[i]).toBeLessThan(back[i - 1]);
    expect(spikeExtension(SPIKE_ANIM_SEC)).toBe(0);
    expect(spikeExtension(5)).toBe(0);
    expect(spikeExtension(NaN)).toBe(0);
  });

  test('a trap hit points its arrow at the nearest trap', () => {
    const t = (id: number, x: number, z: number): TrapNet => ({ id, owner: 1, pos: { x, y: 0, z }, rotY: 0, wall: false, hp: 150, fired: -1, arm: 0 });
    expect(nearestTrap(undefined, { x: 0, z: 0 })).toBeNull();
    expect(nearestTrap([t(1, 10, 0), t(2, 0.3, 0.2), t(3, -5, 5)], { x: 0, z: 0 })).toEqual({ x: 0.3, y: 0, z: 0.2 });
  });
});
