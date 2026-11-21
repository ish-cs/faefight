import { describe, expect, test } from 'vitest';
import { PracticeStats } from '../../src/client/practicePanel';
import type { MatchEvent } from '../../src/sim/types';

const shot = (t: number, by = 1): MatchEvent => ({ t, type: 'shot', data: { by } });
const hit = (t: number, amount: number, part: 'head' | 'body' = 'body', by = 1, target = 5): MatchEvent => ({ t, type: 'hit', data: { by, target, amount, part } });

describe('PracticeStats', () => {
  test('accuracy per trigger pull, headshot share per hit, own self-damage and others ignored', () => {
    const s = new PracticeStats();
    s.onEvents([shot(1), hit(1, 30, 'head')], 1);
    s.onEvents([shot(1.2)], 1); // miss
    s.onEvents([shot(1.4), hit(1.4, 9), hit(1.4, 9), hit(1.4, 9, 'head')], 1); // shotgun: one pull, three pellets
    s.onEvents([shot(1.5, 2), hit(1.5, 20, 'body', 2), hit(1.6, 50, 'body', 1, 1)], 1);
    expect(s.shots).toBe(3);
    expect(s.hitShots).toBe(2);
    expect(s.accuracy).toBeCloseTo(2 / 3);
    expect(s.hits).toBe(4);
    expect(s.headshotRate).toBe(0.5);
    expect(s.damage).toBe(57);
  });

  test('DPS over the latest string of shots (at least 1 s); a pause starts a new string; reset clears', () => {
    const s = new PracticeStats();
    expect(s.dps).toBeNull();
    for (let i = 0; i < 5; i++) s.onEvents([shot(i * 0.5), hit(i * 0.5, 30)], 1); // 150 over 2 s
    expect(s.dps).toBeCloseTo(75);
    s.onEvents([shot(10), hit(10, 40)], 1); // after a pause: 40 over the 1 s minimum
    expect(s.dps).toBeCloseTo(40);
    s.reset();
    expect([s.shots, s.hits, s.accuracy, s.dps]).toEqual([0, 0, null, null]);
  });
});
