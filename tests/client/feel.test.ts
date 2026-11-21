import { describe, expect, test } from 'vitest';
import { blastShake, bobOffset, cameraBob, heavyHit, HIT_STOP, hitStopScale, idleSway } from '../../src/client/firstPerson';
import { RECOVER_DELAY, RECOVER_FRAC, RecoilRecovery } from '../../src/client/recoil';
import { defaultSettings, sanitizeSettings } from '../../src/client/settings/store';
import { PLAYER } from '../../src/sim/constants';

const run = (r: RecoilRecovery, sec: number, dt = 1 / 120) => {
  let p = 0, y = 0;
  for (let t = 0; t < sec - 1e-9; t += dt) { r.step(dt); p += r.dPitch; y += r.dYaw; }
  return { p, y };
};

describe('recoil recovery (client look only; the sim kick itself is unchanged)', () => {
  test('a kick is delivered in full within ~0.1 s', () => {
    const r = new RecoilRecovery();
    r.kick(0.02, 0.005);
    const { p, y } = run(r, RECOVER_DELAY * 0.9);
    expect(p).toBeGreaterThan(0.02 * 0.97);
    expect(y).toBeGreaterThan(0.005 * 0.97);
  });
  test('after the burst, part of the climb (not all) eases back', () => {
    const r = new RecoilRecovery();
    r.kick(0.02, 0.004);
    const { p, y } = run(r, 1.5);
    expect(p).toBeCloseTo(0.02 * (1 - RECOVER_FRAC), 4);
    expect(y).toBeCloseTo(0.004 * (1 - RECOVER_FRAC), 4);
  });
  test('no recovery while still firing (kicks closer than the delay)', () => {
    const r = new RecoilRecovery();
    let p = 0;
    for (let i = 0; i < 10; i++) { r.kick(0.01, 0); for (let f = 0; f < 8; f++) { r.step(1 / 120); p += r.dPitch; } }
    expect(p).toBeGreaterThan(0.1 * 0.97); // the full climb of a spray stays until it stops
  });
  test('pulling down against the climb pays the recovery off (no double correction)', () => {
    const r = new RecoilRecovery();
    r.kick(0.02, 0);
    const a = run(r, 0.05);
    r.mouse(-0.02, 0); // the player pulled the whole climb back down themselves
    const b = run(r, 1.5);
    expect(a.p + b.p).toBeCloseTo(0.02, 4); // the kick arrives in full, nothing is taken back on top
  });
  test('moving the mouse up does not add recovery; reset drops everything', () => {
    const r = new RecoilRecovery();
    r.kick(0.02, 0);
    r.mouse(0.05, 0);
    r.reset();
    const { p, y } = run(r, 1);
    expect(p).toBe(0);
    expect(y).toBe(0);
  });
  test('step allocates nothing (numbers on the instance)', () => {
    const r = new RecoilRecovery();
    r.kick(0.01, 0.01);
    r.step(1 / 60);
    expect(typeof r.dPitch).toBe('number');
  });
});

describe('hit-stop (visual time only)', () => {
  test('near-frozen at the start, back to normal speed at the end', () => {
    expect(hitStopScale(HIT_STOP.kill, HIT_STOP.kill)).toBeLessThan(0.15);
    expect(hitStopScale(0, HIT_STOP.kill)).toBe(1);
    expect(hitStopScale(-1, HIT_STOP.kill)).toBe(1);
    expect(hitStopScale(HIT_STOP.kill * 0.05, HIT_STOP.kill)).toBeGreaterThan(0.8);
  });
  test('a few frames long at most', () => {
    expect(HIT_STOP.kill).toBeLessThanOrEqual(0.1);
    expect(HIT_STOP.heavy).toBeLessThan(HIT_STOP.kill);
  });
  test('heavy = big damage or a headshot', () => {
    expect(heavyHit(12, 'body')).toBe(false);
    expect(heavyHit(12, 'head')).toBe(true);
    expect(heavyHit(110, 'body')).toBe(true);
  });
});

describe('screen shake / camera bob', () => {
  test('explosion shake falls off with distance and is gone by 30 m', () => {
    expect(blastShake(0, false)).toBeGreaterThan(blastShake(10, false));
    expect(blastShake(10, false)).toBeGreaterThan(blastShake(20, false));
    expect(blastShake(30, false)).toBe(0);
    expect(blastShake(5, true)).toBeLessThan(blastShake(5, false));
  });
  test('camera bob is subtle (cm / fraction of a degree) and zero when standing', () => {
    const o = { x: 0, y: 0, roll: 0 };
    for (let ph = 0; ph < 7; ph += 0.3) {
      cameraBob(ph, PLAYER.sprint, o);
      expect(Math.abs(o.x)).toBeLessThan(0.02);
      expect(Math.abs(o.y)).toBeLessThan(0.02);
      expect(Math.abs(o.roll)).toBeLessThan(0.01);
    }
    cameraBob(1, 0, o);
    expect(o.x).toBe(0); expect(o.y).toBe(0); expect(o.roll).toBe(0);
  });
  test('viewmodel bob / sway can write into a reused object', () => {
    const o = { x: 0, y: 0, roll: 0 };
    expect(bobOffset(1, 3, o)).toBe(o);
    const s = { x: 0, y: 0 };
    expect(idleSway(2, s)).toBe(s);
    expect(bobOffset(1, 3)).toEqual(o);
  });
});

describe('feel settings', () => {
  test('defaults: full shake, bob on', () => {
    expect(defaultSettings().gameplay.screenShake).toBe(1);
    expect(defaultSettings().gameplay.cameraBob).toBe(true);
  });
  test('sanitized: shake clamped 0..1, bob boolean', () => {
    const s = sanitizeSettings({ gameplay: { screenShake: 7, cameraBob: 'no' } });
    expect(s.gameplay.screenShake).toBe(1);
    expect(s.gameplay.cameraBob).toBe(true);
    expect(sanitizeSettings({ gameplay: { screenShake: -2, cameraBob: false } }).gameplay).toMatchObject({ screenShake: 0, cameraBob: false });
  });
});
