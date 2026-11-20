import { describe, expect, it } from 'vitest';
import { chooseClip, type AnimInput } from '../../src/client/characters/animState';

const base: AnimInput = { alive: true, vel: { x: 0, y: 0, z: 0 }, yaw: 0, equipped: 'rifle', flinching: false, punching: false, aiming: false };
const clip = (o: Partial<AnimInput>) => chooseClip({ ...base, ...o }).name;

describe('chooseClip', () => {
  it('idles in the gun pose when armed, plain idle with fists', () => {
    expect(clip({})).toBe('Idle_Gun_Pointing');
    expect(clip({ equipped: 'fists' })).toBe('Idle');
  });

  it('death and flinch override locomotion', () => {
    expect(clip({ alive: false, vel: { x: 0, y: 0, z: -7 } })).toBe('Death');
    expect(clip({ flinching: true, vel: { x: 0, y: 0, z: -5 } })).toBe('HitRecieve');
  });

  it('walks slowly, runs past the sprint threshold (yaw 0 faces -Z)', () => {
    expect(clip({ equipped: 'fists', vel: { x: 0, y: 0, z: -2 } })).toBe('Walk');
    expect(clip({ vel: { x: 0, y: 0, z: -7.5 } })).toBe('Run');
    expect(clip({ vel: { x: 0, y: 0, z: -7.5 }, aiming: true })).toBe('Run_Shoot');
    expect(clip({ equipped: 'fists', vel: { x: 0, y: 0, z: -5 } })).toBe('Run');
  });

  it('picks back/strafe clips relative to facing', () => {
    expect(clip({ vel: { x: 0, y: 0, z: 5 } })).toBe('Run_Back');
    expect(clip({ vel: { x: 5, y: 0, z: 0 } })).toBe('Run_Right');
    expect(clip({ vel: { x: -5, y: 0, z: 0 } })).toBe('Run_Left');
    // Facing +X (yaw -90°): moving +X is forward.
    expect(clip({ yaw: -Math.PI / 2, vel: { x: 7.5, y: 0, z: 0 } })).toBe('Run');
  });

  it('uses the airborne pose while jumping or falling', () => {
    expect(clip({ vel: { x: 0, y: 4.6, z: 0 } })).toBe('Air');
    expect(clip({ vel: { x: 0, y: -3, z: -5 } })).toBe('Air');
  });

  it('punches with fists only', () => {
    expect(clip({ equipped: 'fists', punching: true })).toBe('Punch_Right');
    expect(clip({ punching: true })).toBe('Idle_Gun_Pointing');
  });
});
