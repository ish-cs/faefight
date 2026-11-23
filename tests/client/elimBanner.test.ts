import { describe, expect, it } from 'vitest';
import { elimView } from '../../src/client/elimBanner';
import type { MatchEvent } from '../../src/sim/types';

const ME = 1;
const names: Record<number, string> = { 1: 'You', 2: 'Salty', 3: 'Leo' };
const name = (id: unknown) => (typeof id === 'number' ? names[id] ?? null : null);
const ev = (data: Record<string, unknown>): MatchEvent => ({ t: 10, type: 'elimination', data: { assists: [], shares: [], spoils: 0, how: 'killed', ...data } });

describe('elimination banner (glory)', () => {
  it('everyone gets "X ELIMINATED" by whom, with the spoils', () => {
    const g = elimView(ev({ victim: 2, by: 3, spoils: 420, shares: [[3, 420]] }), ME, name)!;
    expect(g.banner).toEqual({ title: 'SALTY ELIMINATED', sub: 'by Leo · $420 spoils', mine: false });
    expect(g.feed).toBe('Leo eliminated Salty · +$420');
  });

  it('your own elimination credit: gold banner with your spoils and the surge', () => {
    const g = elimView(ev({ victim: 2, by: ME, spoils: 300, assists: [3], shares: [[ME, 225], [3, 75]] }), ME, name)!;
    expect(g.banner).toEqual({ title: 'SALTY ELIMINATED', sub: '+$300 spoils · victory surge', mine: true });
    expect(g.feed).toBe('You eliminated Salty · +$300 (assist: Leo)');
  });

  it('an assist shows your cut; sealed-in wording for a seal credit', () => {
    const g = elimView(ev({ victim: 2, by: 3, how: 'trapped', spoils: 400, assists: [ME], shares: [[3, 300], [ME, 100]] }), ME, name)!;
    expect(g.banner?.sub).toBe('Assist · +$100');
    expect(g.feed).toBe('Leo sealed in Salty · +$400 (assist: You)');
  });

  it('no banner when you are the one out (the end screen says it) and nothing for an uncredited elimination', () => {
    const g = elimView(ev({ victim: ME, by: 3, spoils: 50 }), ME, name)!;
    expect(g.banner).toBeNull();
    expect(g.feed).toBe('Leo eliminated You · +$50');
    expect(elimView(ev({ victim: 2, by: null }), ME, name)).toBeNull();
  });
});
