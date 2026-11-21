import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { BUILD_SKILL as BS_FROM_BUILD, BUILD_TUNING as BT_FROM_BUILD } from '../../src/sim/bots/build';
import { BUILD_SKILL, BUILD_TUNING, DEFAULT_BOT_PARAMS, DRIVE, PARAM_RANGES, flattenParams, withParams } from '../../src/sim/bots/params';
import { Match } from '../../src/sim/match';

describe('bot params (trainer-tunable DRIVE, BUILD_SKILL, BUILD_TUNING)', () => {
  test('the defaults are the tables the bots always used, re-exported where they lived', () => {
    expect(DEFAULT_BOT_PARAMS.drive).toBe(DRIVE);
    expect(DEFAULT_BOT_PARAMS.buildSkill).toBe(BUILD_SKILL);
    expect(DEFAULT_BOT_PARAMS.buildTuning).toBe(BUILD_TUNING);
    expect(BS_FROM_BUILD).toBe(BUILD_SKILL);
    expect(BT_FROM_BUILD).toBe(BUILD_TUNING);
  });

  test('flat keys round-trip; overrides land where they belong and leave the defaults alone', () => {
    const flat = flattenParams();
    expect(flat['drive.push.pro']).toBe(DRIVE.push.pro);
    expect(flat['buildSkill.hard.coverChance']).toBe(BUILD_SKILL.hard.coverChance);
    expect(flat['buildTuning.coverScore']).toBe(BUILD_TUNING.coverScore);
    expect(flat['drive.offenseAt.easy']).toBeUndefined(); // Infinity: not tunable
    const p = withParams({ 'drive.push.pro': 0.9, 'buildTuning.coverDist.1': 2 });
    expect(p.drive.push.pro).toBe(0.9);
    expect(p.buildTuning.coverDist[1]).toBe(2);
    expect(DRIVE.push.pro).not.toBe(0.9);
    expect(withParams(flat)).toEqual(structuredClone(DEFAULT_BOT_PARAMS));
  });

  test('PARAM_RANGES: every tunable default sits inside its search box; safety geometry has none', () => {
    const flat = flattenParams();
    for (const [k, [lo, hi]] of Object.entries(PARAM_RANGES)) {
      expect(lo, k).toBeLessThan(hi);
      expect(flat[k], k).toBeGreaterThanOrEqual(lo);
      expect(flat[k], k).toBeLessThanOrEqual(hi);
    }
    for (const k of ['buildTuning.ownBunkerCheck', 'buildTuning.clearanceMargin', 'buildTuning.doorKeepOut']) expect(PARAM_RANGES[k]).toBeUndefined();
    expect(Object.keys(PARAM_RANGES).length).toBeGreaterThan(80);
  });

  test('typos and non-numbers fail loudly', () => {
    expect(() => withParams({ 'drive.pushh.pro': 1 })).toThrow(/unknown/);
    expect(() => withParams({ 'buildSkill.pro.highGround': 1 })).toThrow(/non-numeric/);
    expect(() => withParams({ 'drive.push.pro': NaN })).toThrow(/finite/);
  });

  test('a bot plays with the params it is given', async () => {
    // Never on offense, never pushes: the drive layer is off, so no bridge/attack/seal bonus shows in its scores.
    const calm = withParams({ 'drive.offenseAt.pro': 1e9, 'drive.offenseCash.pro': 1e9 });
    const bots: Bot[] = [];
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: true, difficulty: 'pro' }], seed: 3 },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng, undefined, id === 1 ? calm : undefined); bots.push(b); return b; } });
    for (let i = 0; i < 30 * 60; i++) m.tick(new Map());
    expect(bots).toHaveLength(2);
    expect((bots[0] as unknown as { P: unknown }).P).toBe(calm);
    expect((bots[1] as unknown as { P: unknown }).P).toBe(DEFAULT_BOT_PARAMS);
  }, 60_000);
});
