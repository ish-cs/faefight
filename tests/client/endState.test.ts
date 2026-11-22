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
    expect(endState(-1, 1, true, players)).toEqual({ state: 'draw', title: 'DRAW', sub: 'The storm took everyone.' });
  });
  test('a spectator (no player) sees only the result', () => {
    expect(endState(null, 0, false, players)).toBeNull();
    expect(endState(2, 0, false, players)).toEqual({ state: 'draw', title: 'MATCH OVER', sub: 'Bot (hard) wins.' });
    expect(endState(-1, 0, false, players)?.title).toBe('DRAW');
  });
  test('eliminated while others still play', () => {
    expect(endState(null, 1, true, players)).toEqual({ state: 'lost', title: 'ELIMINATED', sub: 'Your bunker was sealed when you died.' });
  });
});

describe('endState in a teams match', () => {
  const team = [{ id: 1, name: 'Me', team: 0 }, { id: 2, name: 'Foe', team: 1 }, { id: 3, name: 'Mate', team: 0 }];
  test('your teammate surviving is your victory', () => {
    expect(endState(3, 1, true, team)).toEqual({ state: 'won', title: 'VICTORY', sub: 'Your team is the last one standing.' });
  });
  test('the other team winning names the team', () => {
    expect(endState(2, 1, true, team)).toEqual({ state: 'lost', title: 'ELIMINATED', sub: 'Team 2 wins.' });
    expect(endState(2, 0, false, team)).toEqual({ state: 'draw', title: 'MATCH OVER', sub: 'Team 2 wins.' });
  });
});
