import { describe, expect, test } from 'vitest';
import { PLAYER, WEAPONS } from '../../src/sim/constants';
import {
  beatsBetween, bloomAfterShot, currentBloom, falloff, magCap, nextBurst, recoilKick, reloadBeats, reloadTime, shellsLoadedBy, spreadDeg,
} from '../../src/sim/gunplay';
import type { WeaponKind } from '../../src/sim/types';

const still = { speed: 0, grounded: true };
const gun = (ads = false, bloom = 0, lastShotAt = -1e9) => ({ ads, bloom, lastShotAt });
const GUNS: WeaponKind[] = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'];

describe('spread', () => {
  test('aiming down sights is tighter than hip fire for every gun', () => {
    for (const k of GUNS) expect(spreadDeg(k, gun(true), 0, still)).toBeLessThan(spreadDeg(k, gun(false), 0, still));
  });
  test('rifle: hip fire is wild, aimed is pin-point', () => {
    expect(spreadDeg('rifle', gun(false), 0, still)).toBeGreaterThan(2);
    expect(spreadDeg('rifle', gun(true), 0, still)).toBeLessThan(0.2);
  });
  test('walking < sprinting < jumping', () => {
    const walk = spreadDeg('smg', gun(), 0, { speed: PLAYER.walk, grounded: true });
    const sprint = spreadDeg('smg', gun(), 0, { speed: PLAYER.sprint, grounded: true });
    const air = spreadDeg('smg', gun(), 0, { speed: 0, grounded: false });
    expect(spreadDeg('smg', gun(), 0, still)).toBeLessThan(walk);
    expect(walk).toBeLessThan(sprint);
    expect(sprint).toBeLessThan(air);
  });
  test('bloom grows per shot up to a cap and recovers over time', () => {
    let s = gun();
    const cone0 = spreadDeg('smg', s, 0, still);
    for (let i = 0; i < 5; i++) s = { ...s, bloom: bloomAfterShot('smg', s, i * 0.09), lastShotAt: i * 0.09 };
    const hot = spreadDeg('smg', s, 0.36, still);
    expect(hot).toBeGreaterThan(cone0 + 1);
    for (let i = 0; i < 100; i++) s = { ...s, bloom: bloomAfterShot('smg', s, 1 + i * 0.09), lastShotAt: 1 + i * 0.09 };
    expect(s.bloom).toBe(WEAPONS.smg.spread.max);
    expect(currentBloom('smg', s, s.lastShotAt + 5)).toBe(0);
    expect(spreadDeg('smg', s, s.lastShotAt + 5, still)).toBeCloseTo(cone0);
  });
});

describe('recoil', () => {
  test('pattern is deterministic for the same shot and seed', () => {
    for (const k of GUNS) for (let n = 0; n < 12; n++) expect(recoilKick(k, n, 1234)).toEqual(recoilKick(k, n, 1234));
  });
  test('always kicks up; a long burst climbs harder than its first shot', () => {
    for (let n = 0; n < 30; n++) expect(recoilKick('smg', n, 7).pitch).toBeGreaterThan(0);
    expect(recoilKick('rifle', 10, 7).pitch).toBeGreaterThan(recoilKick('rifle', 0, 7).pitch * 1.2);
  });
  test('the shotgun kicks much harder than the SMG; fists do not kick', () => {
    expect(recoilKick('shotgun', 0, 1).pitch).toBeGreaterThan(recoilKick('smg', 0, 1).pitch * 5);
    expect(recoilKick('fists', 0, 1)).toEqual({ pitch: 0, yaw: 0 });
  });
  test('burst counter resets after a pause', () => {
    expect(nextBurst('smg', { burst: 7, lastShotAt: 1 }, 1 + 1 / WEAPONS.smg.rps)).toBe(7);
    expect(nextBurst('smg', { burst: 7, lastShotAt: 1 }, 2)).toBe(0);
  });
});

describe('falloff', () => {
  test('full damage close, reduced far; the rifle keeps most of it at range', () => {
    expect(falloff('smg', 5)).toBe(1);
    expect(falloff('smg', 100)).toBe(WEAPONS.smg.falloff.minMult);
    expect(falloff('shotgun', 20)).toBeLessThan(0.4);
    expect(falloff('rifle', 80)).toBeGreaterThan(0.9);
    expect(falloff('rifle', 200)).toBe(0.85);
  });
});

describe('reload', () => {
  test('tactical reload keeps one in the chamber; empty does not', () => {
    expect(magCap('rifle', 5)).toBe(26);
    expect(magCap('rifle', 0)).toBe(25);
    expect(magCap('shotgun', 3)).toBe(6);
    expect(magCap('rocket', 0)).toBe(1);
  });
  test('tactical reloads are faster than empty ones', () => {
    for (const k of ['pistol', 'smg', 'rifle'] as const) expect(reloadTime(k, 5)).toBeLessThan(reloadTime(k, 0));
    expect(reloadTime('rocket', 0)).toBe(3);
  });
  test('box-mag beats: release, out, in; the rack only when empty; all before the end', () => {
    expect(reloadBeats('rifle', 10).map((b) => b.beat)).toEqual(['release', 'magOut', 'magIn']);
    expect(reloadBeats('rifle', 0).map((b) => b.beat)).toEqual(['release', 'magOut', 'magIn', 'rack']);
    for (const k of ['pistol', 'smg', 'rifle', 'rocket', 'shotgun'] as const) for (const m of [0, 1]) {
      const beats = reloadBeats(k, m, 99);
      expect(beats.at(-1)!.t).toBeLessThan(reloadTime(k, m, 99));
      for (let i = 1; i < beats.length; i++) expect(beats[i].t).toBeGreaterThan(beats[i - 1].t);
    }
  });
  test('shotgun: one shell beat per missing shell (limited by spare), pump only from empty', () => {
    expect(reloadBeats('shotgun', 2, 99).map((b) => b.beat)).toEqual(['shell', 'shell', 'shell', 'shell']);
    expect(reloadBeats('shotgun', 0, 99).filter((b) => b.beat === 'shell')).toHaveLength(6);
    expect(reloadBeats('shotgun', 0, 99).at(-1)!.beat).toBe('pump');
    expect(reloadBeats('shotgun', 0, 2).filter((b) => b.beat === 'shell')).toHaveLength(2);
    expect(shellsLoadedBy(2, 99, 0)).toBe(0);
    expect(shellsLoadedBy(2, 99, 10)).toBe(4);
  });
  test('rocket: one heavy load beat', () => {
    expect(reloadBeats('rocket', 0).map((b) => b.beat)).toEqual(['magOut', 'load']);
  });
  test('beatsBetween picks the beats crossed in a window, each once', () => {
    const beats = reloadBeats('rifle', 0);
    const seen = [0, 0.5, 1, 1.5, 2, 2.5, 3].slice(1).flatMap((t, i, a) => beatsBetween(beats, i === 0 ? 0 : a[i - 1], t));
    expect(seen).toEqual(beats);
  });
});

describe('bot recoil compensation', () => {
  test('hard bots pull most of a kick back, easy bots ride it', async () => {
    const { Aim, AIM } = await import('../../src/sim/bots/aim');
    const residual = (d: 'easy' | 'hard') => {
      const aim = new Aim(AIM[d], () => 0.5);
      const eye = { x: 0, y: 1.6, z: 0 }, target = { x: 0, y: 1.6, z: -20 };
      let cur = { yaw: 0, pitch: 0 };
      for (let i = 0; i < 30; i++) cur = aim.track(i / 30, 1 / 30, eye, target, 2, cur);
      const kicked = { yaw: cur.yaw, pitch: cur.pitch + 0.05 }; // the sim added a 0.05 rad kick after the shot
      return aim.compensate(kicked).pitch - cur.pitch;
    };
    expect(residual('hard')).toBeLessThan(0.01);
    expect(residual('easy')).toBeGreaterThan(0.03);
  });
});
