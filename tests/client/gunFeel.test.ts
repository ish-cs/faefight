import { describe, expect, test } from 'vitest';
import { SoundDirector } from '../../src/client/audio/events';
import { adsFov, reloadClock, reloadPose } from '../../src/client/firstPerson';
import { reloadBeats, reloadTime } from '../../src/sim/gunplay';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PlayerState, Snapshot } from '../../src/sim/types';

const reloading = (equipped: PlayerState['equipped'], magStart: number, start: number): PlayerState => {
  const p = newPlayer(2, 'bot', true, 1, { x: 40, y: 2, z: 0 });
  p.equipped = equipped;
  p.reloadSec = reloadTime(equipped, magStart, 99);
  p.reloadUntil = start + p.reloadSec;
  p.reloadMag = magStart;
  return p;
};
const snap = (time: number, players: PlayerState[]): Snapshot => ({
  time, tick: Math.round(time * 30), players, pieces: [], loot: [], projectiles: [], generators: [], sealed: [false, false],
  waterY: 0, suddenDeath: false, winner: null, events: [],
});

describe('reload clock + pose', () => {
  test('clock runs on sim time and stops when not reloading', () => {
    const p = reloading('rifle', 0, 10);
    expect(reloadClock(p, 11)!.elapsed).toBeCloseTo(1);
    expect(reloadClock(p, 11)!.duration).toBeCloseTo(reloadTime('rifle', 0));
    p.reloadUntil = 0;
    expect(reloadClock(p, 11)).toBeNull();
  });
  test('box mag: drops out after magOut, hidden, a new one rises and is home by magIn', () => {
    const beats = reloadBeats('rifle', 0);
    const t = (b: string) => beats.find((x) => x.beat === b)!.t;
    const d = reloadTime('rifle', 0);
    const pose = (e: number) => reloadPose('rifle', e, d, 0);
    expect(pose(0).magY).toBe(0);
    expect(pose(t('magOut') + 0.25).magY).toBeLessThan(-0.05);
    expect(pose(t('magIn')).magY).toBe(0);
    expect(pose(t('magIn')).magShow).toBe(true);
    expect(pose(t('magIn') - 0.1).hand).toBe(1);
    expect(pose(d * 0.5).tilt).toBe(1);
    expect(pose(0).tilt).toBe(0);
    expect(pose(t('rack') + 0.01).jolt).toBeGreaterThan(0.5);
  });
  test('shotgun: a shell shows in the hand before each shell beat and is gone after', () => {
    const beats = reloadBeats('shotgun', 3, 99).filter((b) => b.beat === 'shell');
    const d = reloadTime('shotgun', 3, 99);
    for (const b of beats) {
      expect(reloadPose('shotgun', b.t - 0.1, d, 3).magShow).toBe(true);
      expect(reloadPose('shotgun', b.t + 0.05, d, 3).magShow).toBe(false);
    }
  });
  test('rocket: the new rocket slides in from behind and is home at the load beat', () => {
    const load = reloadBeats('rocket', 0).find((b) => b.beat === 'load')!.t;
    expect(reloadPose('rocket', load - 0.5, 3, 0).magZ).toBeGreaterThan(0.3);
    expect(reloadPose('rocket', load, 3, 0).magZ).toBeCloseTo(0);
    expect(reloadPose('rocket', 0.2, 3, 0).magShow).toBe(false);
  });
});

describe('aiming FOV', () => {
  test('rifle zooms 2x (half-angle tangent halves); no zoom when not aiming', () => {
    const fov = adsFov(75, 'rifle', 1);
    expect(Math.tan((fov * Math.PI) / 360)).toBeCloseTo(Math.tan((75 * Math.PI) / 360) / 2);
    expect(adsFov(75, 'rifle', 0)).toBeCloseTo(75);
    expect(adsFov(75, 'pistol', 1)).toBeGreaterThan(fov);
  });
});

describe('reload sounds', () => {
  test('one cue per beat, on time, positional for others and 2D for me', () => {
    const map = buildMap(2);
    const d = new SoundDirector();
    d.setMap(map, 1);
    const me = newPlayer(1, 'me', false, 0, map[0].spawn);
    const bot = reloading('rifle', 0, 0);
    const cues: string[] = [];
    let positional = true;
    for (let t = 0; t <= 3.2; t += 1 / 15) {
      for (const c of d.update(snap(t, [me, bot]))) if (c.sound === 'reload') { cues.push(c.kind!); positional &&= c.pos !== null; }
    }
    expect(cues).toEqual(['rifle:release', 'rifle:magOut', 'rifle:magIn', 'rifle:rack']);
    expect(positional).toBe(true);

    const d2 = new SoundDirector();
    d2.setMap(map, 2);
    const mine = d2.update(snap(2.5, [me, bot])).filter((c) => c.sound === 'reload');
    expect(mine.every((c) => c.pos === null && c.own)).toBe(true);
  });
  test('shotgun: a cue per shell, then the pump', () => {
    const map = buildMap(2);
    const d = new SoundDirector();
    d.setMap(map, 1);
    const me = newPlayer(1, 'me', false, 0, map[0].spawn);
    const bot = reloading('shotgun', 0, 0);
    const cues: string[] = [];
    for (let t = 0; t <= 5; t += 1 / 30) for (const c of d.update(snap(t, [me, bot]))) if (c.sound === 'reload') cues.push(c.kind!);
    expect(cues).toEqual([...Array(6).fill('shotgun:shell'), 'shotgun:pump']);
  });
  test('dry fire clicks', () => {
    const map = buildMap(2);
    const d = new SoundDirector();
    d.setMap(map, 1);
    const me = newPlayer(1, 'me', false, 0, map[0].spawn);
    const s = snap(1, [me]);
    s.events = [{ t: 1, type: 'dry', data: { by: 1, weapon: 'pistol' } }];
    expect(d.update(s).find((c) => c.sound === 'dry')).toMatchObject({ pos: null, own: true });
  });
});
