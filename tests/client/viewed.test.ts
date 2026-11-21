import { describe, expect, test } from 'vitest';
import { viewedPlayer, viewingOther } from '../../src/client/viewed';
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
