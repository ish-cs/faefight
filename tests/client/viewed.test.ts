import { describe, expect, test } from 'vitest';
import { BODYCAM_SEC, BodyCam, SpectatorCamera, personalize, viewedPlayer, viewingOther, EARLY_KEY_MS, EarlyKey, KillerLock, followAfterDeath } from '../../src/client/viewed';
import { damageNumbers } from '../../src/client/damageFx';
import { SoundDirector } from '../../src/client/audio/events';
import { buildMap } from '../../src/sim/map';
import type { MatchEvent, Snapshot } from '../../src/sim/types';

const hit = (by: number, target: number, amount: number): MatchEvent => ({ t: 1, type: 'hit', data: { by, target, amount, shieldAmount: 0 } });

describe('viewed player (spectating shows their view)', () => {
  test('the followed player while spectating, else the local player', () => {
    expect(viewedPlayer(1, null)).toBe(1);
    expect(viewedPlayer(1, 3)).toBe(3);
    expect(viewedPlayer(0, 2)).toBe(2); // spectating host following someone
    expect(viewingOther(1, 3)).toBe(true);
    expect(viewingOther(1, 1)).toBe(false);
  });

  test("damage numbers are the viewed player's hits, not ours", () => {
    const events = [hit(3, 2, 25), hit(1, 3, 10), hit(3, 4, 12)];
    expect(damageNumbers(events, viewedPlayer(1, 3)).map((d) => d.target).sort()).toEqual([2, 4]);
    expect(damageNumbers(events, viewedPlayer(1, null)).map((d) => d.target)).toEqual([3]);
  });

  test("the hit tick is heard for the viewed player's hits", () => {
    const d = new SoundDirector();
    d.setMap(buildMap(4), 1);
    const snap = { time: 1, tick: 30, players: [], pieces: [], events: [hit(3, 2, 20)] } as unknown as Snapshot;
    expect(d.update(snap).some((c) => c.sound === 'hitmarker')).toBe(false);
    d.setViewed(3);
    expect(d.update({ ...snap, tick: 31 }).some((c) => c.sound === 'hitmarker')).toBe(true);
  });
});

describe('spectator camera mode follows the watched player', () => {
  test("their first/third person; bots third person; V flips it until the target or their camera changes", () => {
    const c = new SpectatorCamera();
    expect(c.firstPerson(2, undefined, 'third')).toBe(false); // a bot: over the shoulder
    expect(c.firstPerson(3, 1, 'third')).toBe(true); // a human in first person
    expect(c.firstPerson(3, 1, 'first')).toBe(false); // V pressed: flipped
    expect(c.firstPerson(3, 0, 'first')).toBe(false); // they switched to third person: follow them again
    expect(c.firstPerson(3, 1, 'first')).toBe(true);
    expect(c.firstPerson(2, undefined, 'first')).toBe(false); // someone new: their view, whatever the local setting
  });
});

describe('body cam (killcam fallback)', () => {
  const kill = (victim: number, killer: number | null) => ({ type: 'kill', data: { victim, killer } });
  test('the followed player dying starts it (looking at the killer), for BODYCAM_SEC', () => {
    const k = new BodyCam();
    k.onEvents([kill(4, 2)], 3, 10); // someone else died
    expect(k.active(3, 10)).toBe(false);
    k.onEvents([kill(3, 2)], 3, 10);
    expect(k.active(3, 10.5)).toBe(true);
    expect(k.killer).toBe(2);
    expect(k.active(3, 10 + BODYCAM_SEC + 0.01)).toBe(false);
    expect(k.active(5, 10.5)).toBe(false); // followed someone else meanwhile
    k.onEvents([kill(3, null)], 3, 20); // the storm
    expect(k.active(3, 20.1)).toBe(true);
    expect(k.killer).toBeNull();
  });
});

describe('bot-brain text names', () => {
  const names: Record<number, string> = { 1: 'You', 2: 'Marco' };
  const nameOf = (id: number) => names[id] ?? `#${id}`;
  test('the local player is you / your, others by name', () => {
    expect(personalize("no route to @1's island", 1, nameOf)).toBe('no route to your island');
    expect(personalize("@1's generator holds $200", 1, nameOf)).toBe('Your generator holds $200');
    expect(personalize('Going after @1 (seen 3 s ago)', 1, nameOf)).toBe('Going after you (seen 3 s ago)');
    expect(personalize("Sealing @2's bunker", 1, nameOf)).toBe("Sealing Marco's bunker");
    expect(personalize("no route to @2's island", 0, nameOf)).toBe("no route to Marco's island"); // spectating host: names only
  });
});

describe('a follow key pressed just before the spectator camera starts', () => {
  test('counts if spectating begins within EARLY_KEY_MS, once; a stale one does not', () => {
    const k = new EarlyKey();
    k.press(2, 1000);
    expect(k.take(1000 + EARLY_KEY_MS - 1)).toBe(2);
    expect(k.take(1001)).toBeNull(); // used up
    k.press(3, 1000);
    expect(k.take(1000 + EARLY_KEY_MS + 1)).toBeNull(); // pressed long before (e.g. a hotbar pick while playing)
    expect(new EarlyKey().take(0)).toBeNull();
  });
});

describe('after the followed player is killed: lock onto the killer', () => {
  const pl = (id: number, alive: boolean, eliminated = false, x = 0) => ({ id, alive, eliminated, pos: { x, z: 0 } });
  test('the killer while alive (players, bots, and whoever set off the barrel / fire: the credited killer)', () => {
    expect(followAfterDeath(2, 3, [pl(1, true), pl(2, false), pl(3, true)], 1)).toBe(3);
  });
  test('killer dead or eliminated, or no killer: stay on the victim until they respawn', () => {
    expect(followAfterDeath(2, 3, [pl(1, true), pl(2, false), pl(3, false)], 1)).toBe(2);
    expect(followAfterDeath(2, 3, [pl(1, true), pl(2, false), pl(3, false, true)], 1)).toBe(2);
    expect(followAfterDeath(2, null, [pl(1, true), pl(2, false)], 1)).toBe(2); // storm, water, fall
    expect(followAfterDeath(2, 2, [pl(1, true), pl(2, false)], 1)).toBe(2); // own grenade
  });
  test('victim eliminated with no killer to follow: the nearest living player (never yourself)', () => {
    const ps = [pl(1, true, false, 1), pl(2, false, true, 0), pl(3, true, false, 30), pl(4, true, false, 8)];
    expect(followAfterDeath(2, null, ps, 1)).toBe(4);
    expect(followAfterDeath(2, null, [pl(1, true), pl(2, false, true)], 1)).toBeNull();
  });
  test('the killer is never the local player: they can\'t be "followed"', () => {
    expect(followAfterDeath(2, 1, [pl(1, true), pl(2, false)], 1)).toBe(2);
  });
  test('manual target cycling after the death overrides the automatic switch', () => {
    const k = new KillerLock();
    const ps = [pl(1, true), pl(2, false), pl(3, true)];
    k.onDeath(2, 3, 1000);
    expect(k.resolve(ps, 1, 500)).toEqual({ target: 3, victim: 2 }); // last manual pick was before the death
    k.onDeath(2, 3, 1000);
    expect(k.resolve(ps, 1, 1200)).toBeNull(); // picked someone during the killcam
    expect(k.resolve(ps, 1, -Infinity)).toBeNull(); // nothing pending
  });
});
