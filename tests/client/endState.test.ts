import { describe, expect, test } from 'vitest';
import { endState } from '../../src/client/endState';

const players = [{ id: 1, name: 'You' }, { id: 2, name: 'Bot (hard)' }];

describe('endState', () => {
  test('running match with you alive shows nothing', () => {
    expect(endState(null, 1, false, players)).toBeNull();
  });
  test('you win', () => {
    expect(endState(1, 1, false, players)).toEqual({ state: 'won', title: 'VICTORY', sub: 'Last one standing.' });
  });
  test('the bot wins', () => {
    expect(endState(2, 1, true, players)).toEqual({ state: 'lost', title: 'ELIMINATED', sub: 'Bot (hard) wins.' });
  });
  test('everyone out at once is a draw, not a loss', () => {
    expect(endState(-1, 1, true, players)).toEqual({ state: 'draw', title: 'DRAW', sub: 'The tide took everyone.' });
  });
  test('eliminated while others still play', () => {
    expect(endState(null, 1, true, players)).toEqual({ state: 'lost', title: 'ELIMINATED', sub: 'Your bunker was sealed when you died.' });
  });
});
