import { describe, expect, test } from 'vitest';
import { scoreRows, statusOf, STATUS_LABEL } from '../../src/client/scoreboard';
import { newPlayer } from '../../src/sim/player';
import type { PlayerState, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

const player = (id: number, over: Partial<PlayerState> = {}): PlayerState =>
  ({ ...newPlayer(id, `p${id}`, false, id - 1, v3(0, 0, 0)), ...over });

const snapOf = (players: PlayerState[], sealed: boolean[] = players.map(() => false)) =>
  ({ players, sealed } as unknown as Snapshot);

describe('scoreboard status', () => {
  test('alive / trapped / dead / eliminated / spectating', () => {
    expect(statusOf(player(1))).toBe('alive');
    expect(statusOf(player(1, { breakoutUntil: 12 }))).toBe('trapped');
    expect(statusOf(player(1, { alive: false, respawnAt: 5 }))).toBe('dead');
    expect(statusOf(player(1, { alive: false, eliminated: true, isBot: true }))).toBe('eliminated');
    // An eliminated human stays in the game watching it.
    expect(statusOf(player(1, { alive: false, eliminated: true }))).toBe('spectating');
    expect(STATUS_LABEL.spectating).toBe('Spectating');
  });
});

describe('scoreboard rows', () => {
  test('alive first, then by kills (more first), then fewer deaths, then id', () => {
    const snap = snapOf([
      player(1, { kills: 5, alive: false, eliminated: true }),
      player(2, { kills: 1 }),
      player(3, { kills: 3, deaths: 2 }),
      player(4, { kills: 3, deaths: 1 }),
      player(5, { kills: 9, alive: false, respawnAt: 3 }),
      player(6, { kills: 0, breakoutUntil: 20 }),
    ]);
    expect(scoreRows(snap, { humanId: 2, hostId: null }).map((r) => r.id)).toEqual([4, 3, 2, 6, 5, 1]);
  });

  test('row fields: name, bot tag, you, host, kills/deaths, sealed bunker by island', () => {
    const snap = snapOf(
      [player(1, { name: 'Alice' }), player(2, { name: 'Mossy', isBot: true, kills: 2, deaths: 1, island: 1, bounty: 350 })],
      [false, true],
    );
    const rows = scoreRows(snap, { humanId: 1, hostId: 1 });
    expect(rows.find((r) => r.id === 2)).toEqual({
      id: 2, name: 'Mossy', island: 1, isBot: true, isYou: false, isHost: false, kills: 2, deaths: 1, status: 'alive', sealed: true, bounty: 350,
    });
    expect(rows.find((r) => r.id === 1)).toMatchObject({ isYou: true, isHost: true, sealed: false, isBot: false });
  });

  test('vs bot (no host): nobody is marked host', () => {
    const rows = scoreRows(snapOf([player(1), player(2, { isBot: true })]), { humanId: 1, hostId: null });
    expect(rows.every((r) => !r.isHost)).toBe(true);
  });

  test('missing stats (older snapshot) read as 0', () => {
    const p = player(1);
    delete (p as Partial<PlayerState>).kills;
    delete (p as Partial<PlayerState>).deaths;
    expect(scoreRows(snapOf([p]), { humanId: 1, hostId: null })[0]).toMatchObject({ kills: 0, deaths: 0 });
  });
});
