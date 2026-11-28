import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { MatchStats } from '../../src/sim/stats';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type MatchEvent, type PlayerInput } from '../../src/sim/types';
import { add, forward, scale, v3 } from '../../src/sim/vec';

const ev = (type: MatchEvent['type'], data: Record<string, unknown>): MatchEvent => ({ t: 0, type, data });

describe('MatchStats', () => {
  test('counts damage dealt (not self-damage or falls), headshots, seals and pieces', () => {
    const a = newPlayer(1, 'a', false, 0, v3(0, 0, 0)), b = newPlayer(2, 'b', false, 1, v3(0, 0, 0));
    const s = new MatchStats();
    s.onTick([
      ev('hit', { target: 2, by: 1, amount: 30, part: 'head' }),
      ev('hit', { target: 2, by: 1, amount: 12.4, part: 'body' }),
      ev('hit', { target: 1, by: 1, amount: 50 }), // own rocket
      ev('hit', { target: 1, by: null, amount: 20 }), // fall
      ev('sealed', { island: 1, owner: 2, by: 1 }),
      ev('sealed', { island: 0, owner: 1, by: null }), // sudden death
      ev('placed', { by: 2 }), ev('placed', { by: 2 }),
    ], [a, b], 1);
    s.earned(2, 75);
    const [ra, rb] = s.totals([a, b], 1);
    expect(ra).toMatchObject({ id: 1, damage: 42, headshots: 1, seals: 1, built: 0, cash: 0 });
    expect(rb).toMatchObject({ id: 2, damage: 0, seals: 0, built: 2, cash: 75 });
  });

  test('longest life spans respawns and counts the life still going', () => {
    const a = newPlayer(1, 'a', false, 0, v3(0, 0, 0));
    const s = new MatchStats();
    s.onTick([], [a], 0);
    a.alive = false;
    s.onTick([], [a], 40); // died after 40 s
    a.alive = true;
    s.onTick([], [a], 45);
    expect(s.totals([a], 70)[0].longestLife).toBe(40);
    expect(s.totals([a], 100)[0].longestLife).toBe(55);
  });
});

describe('Match stats in snapshots', () => {
  const humans = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
  const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);

  test('absent mid-match, present once there is a winner (with generator cash)', async () => {
    const m = await Match.create(humans);
    const g = m.map[0].generator;
    m.debugTeleport(1, add(g, scale(forward(m.map[0].bunker.facingYaw), 1.5)));
    for (let i = 0; i < 300; i++) expect(m.tick(new Map()).stats).toBeUndefined();
    m.tick(inputs(1, { interact: true }));
    m.debugEliminate(2);
    const snap = m.tick(new Map());
    expect(snap.winner).toBe(1);
    const me = snap.stats!.find((r) => r.id === 1)!;
    expect(me.cash).toBeGreaterThanOrEqual(49);
    expect(me.longestLife).toBeGreaterThan(9);
    expect(snap.stats).toHaveLength(2);
  });

  test('grenade hits say so (death recap)', async () => {
    const m = await Match.create(humans);
    const p2 = m.map[1].spawn;
    m.debugTeleport(1, add(p2, v3(2, 0, 0)));
    for (let i = 0; i < 200; i++) m.tick(new Map()); // spawn protection off for both (they stand still; it ends on time)
    m.debugGive(1, { grenades: 1 });
    let hit: MatchEvent | undefined;
    // Throw straight down at our feet: both are inside the blast.
    // (It goes off on hitting the floor, so the blast can land in the throw's own tick.)
    hit = m.tick(inputs(1, { throwGrenade: true, pitch: -1.3 })).events.find((e) => e.type === 'hit');
    for (let i = 0; i < 120 && !hit; i++) hit = m.tick(new Map()).events.find((e) => e.type === 'hit');
    expect(hit?.data.weapon).toBe('grenade');
  });
});
