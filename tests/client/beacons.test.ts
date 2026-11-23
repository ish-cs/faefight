import { describe, expect, it } from 'vitest';
import { BEACON, BeaconStates } from '../../src/client/world/beaconState';

const p = (island: number, eliminated = false) => ({ island, eliminated });
const run = (b: BeaconStates, sec: number) => { for (let t = 0; t < sec; t += 1 / 60) b.step(1 / 60); };

describe('island beacon state machine', () => {
  it('first sight: open bunkers open, sealed ones sealed (snapped, no fade), eliminated players have none', () => {
    const b = new BeaconStates();
    expect(b.sync([p(0), p(1), p(2, true)], [false, true, false], false)).toEqual([]);
    expect(b.at(0)).toMatchObject({ phase: 'open', seal: 0, cut: 1 });
    expect(b.at(1)).toMatchObject({ phase: 'sealed', seal: 1 });
    expect(b.at(2).phase).toBe('gone');
    expect(b.at(3).phase).toBe('gone'); // no owner
  });

  it('open → sealed → open eases the seal amount both ways', () => {
    const b = new BeaconStates();
    b.sync([p(0)], [false], false);
    b.sync([p(0)], [true], false);
    expect(b.at(0).phase).toBe('sealed');
    b.step(BEACON.sealSec / 2);
    expect(b.at(0).seal).toBeGreaterThan(0.2);
    expect(b.at(0).seal).toBeLessThan(0.8);
    run(b, BEACON.sealSec);
    expect(b.at(0).seal).toBe(1);
    b.sync([p(0)], [false], false);
    expect(b.at(0).phase).toBe('open');
    run(b, BEACON.sealSec + 0.1);
    expect(b.at(0).seal).toBe(0);
  });

  it('eliminated → shutdown animation (flash, collapse) → removed; reported once for the sound', () => {
    const b = new BeaconStates();
    b.sync([p(0), p(1)], [true, false], false);
    expect(b.sync([p(0, true), p(1)], [true, false], false)).toEqual([0]);
    expect(b.sync([p(0, true), p(1)], [true, false], false)).toEqual([]); // not again
    const s = b.at(0);
    expect(s.phase).toBe('down');
    b.step(0.05);
    expect(s.flash).toBeGreaterThan(0.5);
    expect(s.cut).toBeGreaterThan(0.9);
    run(b, BEACON.downSec * 0.7);
    expect(s.phase).toBe('down');
    expect(s.cut).toBeLessThan(0.7);
    expect(s.flash).toBeLessThan(0.2);
    run(b, BEACON.downSec * 0.4);
    expect(s.phase).toBe('gone');
    expect(s.cut).toBe(0);
    expect(b.at(1).phase).toBe('open');
  });

  it('sudden death: every living beam goes to the sealed state together', () => {
    const b = new BeaconStates();
    b.sync([p(0), p(1), p(2)], [false, true, false], false);
    b.sync([p(0), p(1), p(2)], [false, false, false], true);
    expect([0, 1, 2].map((i) => b.at(i).phase)).toEqual(['sealed', 'sealed', 'sealed']);
    run(b, BEACON.sealSec + 0.1);
    expect([0, 1, 2].map((i) => b.at(i).seal)).toEqual([1, 1, 1]);
  });

  it('replay seek back to before the elimination brings the beam back; reset() skips the animation', () => {
    const b = new BeaconStates();
    b.sync([p(0)], [false], false);
    b.sync([p(0, true)], [false], false);
    run(b, BEACON.downSec + 0.1);
    expect(b.at(0).phase).toBe('gone');
    b.sync([p(0)], [false], false); // seek back
    expect(b.at(0)).toMatchObject({ phase: 'open', cut: 1, flash: 0 });
    b.reset(); // seek forward past the elimination: no shutdown, no sound
    expect(b.sync([p(0, true)], [false], false)).toEqual([]);
    expect(b.at(0).phase).toBe('gone');
  });

  it('teams: an island stays lit while any of its owners is in the game', () => {
    const b = new BeaconStates();
    b.sync([p(0), p(0)], [false], false);
    expect(b.sync([p(0, true), p(0)], [false], false)).toEqual([]);
    expect(b.at(0).phase).toBe('open');
  });
});

describe('Island beacons setting', () => {
  it('defaults on, keeps an explicit off, ignores junk', async () => {
    const { defaultSettings, sanitizeSettings } = await import('../../src/client/settings/store');
    expect(defaultSettings().gameplay.islandBeacons).toBe(true);
    expect(sanitizeSettings({ gameplay: { islandBeacons: false } }).gameplay.islandBeacons).toBe(false);
    expect(sanitizeSettings({ gameplay: { islandBeacons: 'no' } }).gameplay.islandBeacons).toBe(true);
  });
});
