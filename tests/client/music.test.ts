import { describe, expect, it } from 'vitest';
import { emptyInventory } from '../../src/sim/economy';
import type { MatchEvent, MatchEventType, PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { COMBAT_HOLD, MusicDirector, chordAt, PROGRESSIONS } from '../../src/client/audio/music';

const ME = 1, BOT = 2;
const v = (x: number): Vec3 => ({ x, y: 0, z: 0 });

function player(id: number, pos: Vec3): PlayerState {
  return {
    id, name: `p${id}`, isBot: id !== ME, island: id - 1, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hp: 100, shield: 0,
    alive: true, eliminated: false, kills: 0, deaths: 0, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv: emptyInventory(), vault: emptyInventory(), locked: [], hotbar: Array(9).fill(null), selected: 0, equipped: 'fists', healAt: null, drinking: null, healLeft: 0, speedUntil: 0, reloadUntil: 0, reloadSec: 0, reloadMag: 0, nextFireAt: 0, busyUntil: 0, ads: false, bloom: 0, lastShotAt: -1e9, burst: 0, stamina: 100,
  };
}

function snap(time: number, events: [MatchEventType, Record<string, unknown>][] = [], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    time, tick: Math.round(time * 30), players: [player(ME, v(0)), player(BOT, v(30))], pieces: [], loot: [], projectiles: [], generators: [], genLevels: [1, 1],
    sealed: [false, false], waterY: 0, suddenDeath: false, winner: null, potionShops: [],
    events: events.map(([type, data]): MatchEvent => ({ t: time, type, data })), ...extra,
  };
}

function director() {
  const d = new MusicDirector();
  d.setViewed(ME);
  return d;
}

describe('MusicDirector: calm → tense → intense', () => {
  it('calm while building; a nearby gunfight makes it tense; far-off shots do not', () => {
    const d = director();
    expect(d.update(snap(1))).toBe('calm');
    expect(d.update(snap(2, [['shot', { by: BOT, weapon: 'rifle', from: v(120), to: v(110) }]]))).toBe('calm');
    expect(d.update(snap(3, [['shot', { by: BOT, weapon: 'rifle', from: v(30), to: v(1) }]]))).toBe('tense');
  });

  it('your own shots, hits on you and nearby explosions count as combat', () => {
    expect(director().update(snap(1, [['shot', { by: ME, weapon: 'smg', from: v(0), to: v(10) }]]))).toBe('tense');
    expect(director().update(snap(1, [['hit', { target: ME, by: BOT, amount: 10 }]]))).toBe('tense');
    expect(director().update(snap(1, [['explosion', { kind: 'grenade', pos: v(20) }]]))).toBe('tense');
    // Fists swung at the air are not a fight.
    expect(director().update(snap(1, [['shot', { by: ME, weapon: 'fists', from: v(0), to: v(0) }]]))).toBe('calm');
  });

  it('teams: a hit between teammates is not a fight; a hit from an enemy is', () => {
    const mates = [{ ...player(ME, v(0)), team: 0 }, { ...player(BOT, v(30)), team: 0 }];
    expect(director().update(snap(1, [['hit', { target: ME, by: BOT, amount: 10 }]], { players: mates }))).toBe('calm');
    const foes = [{ ...player(ME, v(0)), team: 0 }, { ...player(BOT, v(30)), team: 1 }];
    expect(director().update(snap(1, [['hit', { target: ME, by: BOT, amount: 10 }]], { players: foes }))).toBe('tense');
  });

  it('tension holds for COMBAT_HOLD seconds after the last shot, then relaxes', () => {
    const d = director();
    d.update(snap(1, [['hit', { target: ME, by: BOT, amount: 10 }]]));
    expect(d.update(snap(1 + COMBAT_HOLD - 0.5))).toBe('tense');
    expect(d.update(snap(1 + COMBAT_HOLD + 0.5))).toBe('calm');
  });

  it('the storm (sudden death) is intense; the result fades the music out', () => {
    const d = director();
    expect(d.update(snap(1, [], { suddenDeath: true }))).toBe('intense');
    expect(d.update(snap(2, [], { suddenDeath: true, winner: ME }))).toBe('off');
  });

  it('a new match starts calm again', () => {
    const d = director();
    d.update(snap(100, [['hit', { target: ME, by: BOT, amount: 10 }]]));
    d.reset();
    expect(d.update(snap(1))).toBe('calm');
  });
});

describe('progressions', () => {
  it('every chord has 4 voices; chordAt cycles bars', () => {
    for (const p of Object.values(PROGRESSIONS)) for (const c of p) expect(c.notes.length).toBe(4);
    const p = PROGRESSIONS.calm;
    expect(chordAt(p, 0)).toBe(p[0]);
    expect(chordAt(p, p.length * 2 * 3 + 2)).toBe(p[1]); // 2 bars per chord
  });
});
