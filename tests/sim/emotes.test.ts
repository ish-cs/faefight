import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import {
  DEFAULT_WHEEL, EMOTES, QUIP_SHOW_SEC, WHEEL_COOLDOWN_SEC, WHEEL_DEADZONE_PX, WHEEL_IDS, WheelLimiter,
  emoteEnd, isWheelId, quipLines, wheelSlot,
} from '../../src/sim/emotes';
import { Banter, BANTER } from '../../src/sim/bots/banter';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type MatchEvent, type PlayerInput, type PlayerState } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);
const me = (m: Match) => m.tick(new Map()).players[0];

describe('wheel angle → slot', () => {
  test('8 slots clockwise from straight up (screen y grows downward)', () => {
    const r = 100;
    expect(wheelSlot(0, -r)).toBe(0); // up
    expect(wheelSlot(r, -r)).toBe(1); // up-right
    expect(wheelSlot(r, 0)).toBe(2); // right
    expect(wheelSlot(r, r)).toBe(3);
    expect(wheelSlot(0, r)).toBe(4); // down
    expect(wheelSlot(-r, r)).toBe(5);
    expect(wheelSlot(-r, 0)).toBe(6); // left
    expect(wheelSlot(-r, -r)).toBe(7);
  });

  test('each slot owns a 45° wedge centred on its direction; edges wrap', () => {
    const at = (deg: number) => wheelSlot(Math.sin((deg * Math.PI) / 180) * 80, -Math.cos((deg * Math.PI) / 180) * 80);
    expect(at(22)).toBe(0);
    expect(at(23)).toBe(1);
    expect(at(-22)).toBe(0);
    expect(at(-23)).toBe(7);
    expect(at(359)).toBe(0);
    expect(at(180 + 22)).toBe(4);
    expect(at(180 + 23)).toBe(5);
  });

  test('inside the dead zone (or garbage) picks nothing; other slot counts work', () => {
    expect(wheelSlot(0, 0)).toBe(-1);
    expect(wheelSlot(WHEEL_DEADZONE_PX - 1, 0)).toBe(-1);
    expect(wheelSlot(WHEEL_DEADZONE_PX + 1, 0)).toBe(2);
    expect(wheelSlot(NaN, 50)).toBe(-1);
    expect(wheelSlot(50, 0, 4)).toBe(1);
    expect(wheelSlot(0, 50, 4)).toBe(2);
    expect(() => wheelSlot(1, 1, 0)).toThrow();
  });

  test('the default wheel has 8 distinct catalog entries with quick chat and emotes', () => {
    expect(DEFAULT_WHEEL).toHaveLength(8);
    expect(new Set(DEFAULT_WHEEL).size).toBe(8);
    expect(DEFAULT_WHEEL.every(isWheelId)).toBe(true);
    expect(DEFAULT_WHEEL).toContain('gg');
    expect(DEFAULT_WHEEL).toContain('wave');
  });
});

describe('rate limit', () => {
  test('one action per 2 s per key; rejected tries do not extend the wait', () => {
    const l = new WheelLimiter();
    expect(l.allow('a', 10)).toBe(true);
    expect(l.allow('a', 10.5)).toBe(false);
    expect(l.allow('a', 11.99)).toBe(false);
    expect(l.allow('b', 10.5)).toBe(true); // per player
    expect(l.allow('a', 10 + WHEEL_COOLDOWN_SEC)).toBe(true);
    expect(l.allow('a', 12.5)).toBe(false);
  });

  test('the sim applies at most one wheel action per player per 2 s', async () => {
    const m = await Match.create(humans1v1);
    m.tick(new Map());
    m.wheel(1, 'gg');
    m.wheel(1, 'wave'); // same tick: dropped
    let s = m.tick(new Map());
    expect(s.events.filter((e) => e.type === 'wheel')).toEqual([expect.objectContaining({ data: { by: 1, id: 'gg' } })]);
    expect(s.players[0].quip?.id).toBe('gg');
    expect(s.players[0].emote).toBeUndefined();
    for (let i = 0; i < 30; i++) s = m.tick(new Map()); // 1 s later: still cooling down
    m.wheel(1, 'wave');
    s = m.tick(new Map());
    expect(s.players[0].emote).toBeUndefined();
    for (let i = 0; i < 31; i++) s = m.tick(new Map());
    m.wheel(1, 'wave');
    s = m.tick(new Map());
    expect(s.players[0].emote).toMatchObject({ id: 'wave', at: s.time });
    m.wheel(2, 'niceShot'); // the other player has their own budget
    expect(m.tick(new Map()).players[1].quip?.id).toBe('niceShot');
  });

  test('unknown ids throw in the sim (callers sanitize first)', async () => {
    const m = await Match.create(humans1v1);
    expect(() => m.wheel(1, 'moonwalk' as never)).toThrow(/unknown wheel id/);
    expect(() => m.wheel(9, 'gg')).toThrow();
  });
});

describe('emote cancel conditions', () => {
  const p = (over: Partial<PlayerState> = {}): PlayerState => ({ ...newPlayer(1, 'a', false, 0, v3()), emote: { id: 'dance', at: 10 }, lastDamagedAt: 5, ...over });
  test('keeps playing while standing still and untouched', () => {
    expect(emoteEnd(p(), NO_INPUT, [], 11)).toBeNull();
    expect(emoteEnd(p(), { ...NO_INPUT, yaw: 2, pitch: 0.3, select: 3 }, undefined, 11)).toBeNull(); // looking around is fine
  });
  test('moving, jumping, shooting, damage, death and time each end it', () => {
    expect(emoteEnd(p(), { ...NO_INPUT, moveZ: 1 }, undefined, 11)).toBe('moved');
    expect(emoteEnd(p(), { ...NO_INPUT, moveX: -1 }, undefined, 11)).toBe('moved');
    expect(emoteEnd(p(), { ...NO_INPUT, jump: true }, undefined, 11)).toBe('moved');
    expect(emoteEnd(p(), NO_INPUT, [{ seq: 4, moveX: 0, moveZ: 1, yaw: 0, jump: false, sprint: false }], 11)).toBe('moved');
    expect(emoteEnd(p(), { ...NO_INPUT, fire: true }, undefined, 11)).toBe('fired');
    expect(emoteEnd(p(), { ...NO_INPUT, throwGrenade: true }, undefined, 11)).toBe('fired');
    expect(emoteEnd(p({ lastDamagedAt: 10.5 }), NO_INPUT, undefined, 11)).toBe('damaged');
    expect(emoteEnd(p({ alive: false }), NO_INPUT, undefined, 11)).toBe('dead');
    expect(emoteEnd(p(), NO_INPUT, undefined, 10 + EMOTES.dance.sec)).toBe('done');
    expect(emoteEnd(p({ emote: undefined }), { ...NO_INPUT, moveZ: 1 }, undefined, 11)).toBeNull();
  });

  test('in a match: moving ends the emote; standing still lets it run its length', async () => {
    const m = await Match.create(humans1v1);
    m.tick(new Map());
    m.wheel(1, 'salute');
    expect(me(m).emote?.id).toBe('salute');
    expect(m.tick(inputs(1, { moveZ: 1 })).players[0].emote).toBeUndefined();

    for (let i = 0; i < 61; i++) m.tick(new Map());
    m.wheel(1, 'wave');
    let s = m.tick(new Map());
    expect(s.players[0].emote?.id).toBe('wave');
    for (let i = 0; i < Math.ceil(EMOTES.wave.sec * 30) - 2; i++) s = m.tick(new Map());
    expect(s.players[0].emote?.id).toBe('wave');
    for (let i = 0; i < 3; i++) s = m.tick(new Map());
    expect(s.players[0].emote).toBeUndefined();
  });

  test('in a match: firing or taking damage ends it; dead players cannot start one', async () => {
    const m = await Match.create(humans1v1);
    let s0 = m.tick(new Map());
    while (s0.time <= s0.players[0].invulnUntil) s0 = m.tick(new Map()); // spawn invulnerability: no damage yet
    m.wheel(1, 'dance');
    m.tick(new Map());
    expect(m.tick(inputs(1, { fire: true })).players[0].emote).toBeUndefined();

    for (let i = 0; i < 61; i++) m.tick(new Map());
    m.wheel(1, 'dance');
    m.tick(new Map());
    m.debugDamagePlayer(1, 10);
    expect(m.tick(new Map()).players[0].emote).toBeUndefined();

    for (let i = 0; i < 61; i++) m.tick(new Map());
    m.debugKill(1);
    m.wheel(1, 'wave');
    const s = m.tick(new Map());
    expect(s.players[0].alive).toBe(false);
    expect(s.players[0].emote).toBeUndefined();
  });

  test('quick chat: bubble state for 2 s, and a chat line from the player', async () => {
    const m = await Match.create(humans1v1);
    m.tick(new Map());
    m.wheel(2, 'thanks');
    let s = m.tick(new Map());
    expect(quipLines(s.events, s.players)).toEqual([{ from: 'friend', text: 'Thanks!' }]);
    expect(s.players[1].quip?.id).toBe('thanks');
    for (let i = 0; i < QUIP_SHOW_SEC * 30 + 1; i++) s = m.tick(new Map());
    expect(s.players[1].quip).toBeUndefined();
  });
});

describe('bot banter', () => {
  const players = (n: number, bots = true) => new Map(Array.from({ length: n }, (_, i) => {
    const p = newPlayer(i + 1, `p${i + 1}`, bots, i, v3());
    return [p.id, p] as const;
  }));
  const ev = (type: MatchEvent['type'], data: Record<string, unknown>, t = 0): MatchEvent => ({ t, type, data });

  test('match end: some bots say GG, staggered, once', () => {
    const b = new Banter(() => 0.1);
    const ps = players(8);
    const due: { id: number; what: string }[] = [];
    due.push(...b.onTick([ev('win', { winner: 3 })], ps, 100));
    for (let t = 100; t < 110; t += 1 / 30) due.push(...b.onTick([ev('win', { winner: 3 })], ps, t));
    expect(due.filter((d) => d.what === 'gg').length).toBe(8);
    expect(due.find((d) => d.id === 3 && d.what !== 'gg')).toBeTruthy(); // the winner celebrates
    expect(new Set(due.map((d) => `${d.id}:${d.what}`)).size).toBe(due.length); // nothing twice
  });

  test('mid-match: rare, only after an even fight, and never spammy', () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const b = new Banter(rng);
    const ps = players(8);
    const hurt = ps.get(1)!;
    hurt.hp = 30;
    let lines = 0;
    // A kill every 2 s for 10 minutes, every one of them an even fight.
    for (let t = 0; t < 600; t += 1 / 30) {
      const kill = Math.abs(t % 2) < 1 / 60 ? [ev('kill', { killer: 1, victim: 2 + Math.floor(t) % 7 })] : [];
      lines += b.onTick(kill, ps, t).length;
    }
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThanOrEqual(600 / BANTER.quietSec);
    // A one-sided kill (killer healthy) never triggers anything.
    const calm = new Banter(() => 0);
    hurt.hp = 100;
    expect(calm.onTick([ev('kill', { killer: 1, victim: 2 })], ps, 1)).toEqual([]);
    for (let t = 1; t < 5; t += 0.1) expect(calm.onTick([], ps, t)).toEqual([]);
  });

  test('humans never get banter', () => {
    const b = new Banter(() => 0);
    const ps = players(2, false);
    const out = [];
    for (let t = 0; t < 10; t += 0.1) out.push(...b.onTick(t === 0 ? [ev('win', { winner: 1 })] : [], ps, t));
    expect(out).toEqual([]);
  });

  test('two minutes of an 6-bot match stay quiet', async () => {
    const m = await Match.create({ players: Array.from({ length: 6 }, () => ({ name: 'Bot (hard)', isBot: true, difficulty: 'hard' as const })), seed: 3 });
    const lines: string[] = [];
    for (let i = 0; i < 30 * 120; i++) {
      const s = m.tick(new Map());
      for (const l of quipLines(s.events, s.players)) lines.push(l.text);
    }
    expect(lines.length).toBeLessThanOrEqual(120 / BANTER.quietSec);
    expect(lines.every((t) => ['GG', 'Nice shot!'].includes(t))).toBe(true);
  }, 120_000);
});

test('every catalog id is a valid wheel id and nothing else is', () => {
  for (const id of WHEEL_IDS) expect(isWheelId(id)).toBe(true);
  for (const bad of ['', 'GG', 'toString', '__proto__', 'constructor', 1, null, undefined, {}]) expect(isWheelId(bad)).toBe(false);
});
