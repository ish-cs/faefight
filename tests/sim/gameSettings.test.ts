import { describe, expect, test } from 'vitest';
import { CENTER, ECONOMY, LIFECYCLE } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { MatchSetup } from '../../src/sim/matchApi';
import { clampSetting, clampSettings, DEFAULT_SETTINGS, resolveColors, SETTING_KEYS, SETTING_RANGES } from '../../src/sim/settings';

const humans: MatchSetup = { players: [{ name: 'A', isBot: false }, { name: 'B', isBot: false }] };
const tickN = (m: Match, n: number) => { let s; for (let i = 0; i < n; i++) s = m.tick(new Map()); return s!; };

describe('game settings: defaults and clamping', () => {
  test('defaults equal today\'s constants exactly', () => {
    expect(DEFAULT_SETTINGS).toEqual({ startCash: ECONOMY.startCash, suddenDeathSec: LIFECYCLE.suddenDeathAt, genMult: 1, teamMode: 0 });
    expect(clampSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings({})).toEqual(DEFAULT_SETTINGS);
    // Defaults sit on a slider step, so clamping them is a no-op.
    for (const k of SETTING_KEYS) expect(clampSetting(k, DEFAULT_SETTINGS[k])).toBe(DEFAULT_SETTINGS[k]);
  });

  test('match length range is 8–25 min, generator speed 0.5×–2×', () => {
    expect(SETTING_RANGES.suddenDeathSec).toMatchObject({ min: 480, max: 1500 });
    expect(SETTING_RANGES.genMult).toMatchObject({ min: 0.5, max: 2 });
  });

  test('clamps out-of-range values, snaps to the step, rejects junk', () => {
    expect(clampSettings({ startCash: 1e9, suddenDeathSec: -5, genMult: 99 })).toEqual({ startCash: 1000, suddenDeathSec: 480, genMult: 2, teamMode: 0 });
    expect(clampSettings({ startCash: 123, suddenDeathSec: 1000, genMult: 1.3 })).toEqual({ startCash: 120, suddenDeathSec: 1020, genMult: 1.25, teamMode: 0 });
    expect(clampSettings({ startCash: NaN, suddenDeathSec: '600', genMult: Infinity })).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings({ startCash: null, genMult: { valueOf: () => 2 } })).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(clampSettings({ evil: 1, startCash: 200 }))).toEqual(['startCash', 'suddenDeathSec', 'genMult', 'teamMode']);
  });
});

describe('colours', () => {
  test('no picks = 0, 1, 2… (today); picks kept and unique; rest take the lowest free', () => {
    expect(resolveColors([undefined, undefined, undefined])).toEqual([0, 1, 2]);
    expect(resolveColors([3, undefined, 0])).toEqual([3, 1, 0]);
    expect(resolveColors([2, 2, null])).toEqual([2, 0, 1]); // duplicate pick: the later one gets a free colour
    expect(resolveColors([9, -1, 1.5])).toEqual([0, 1, 2]); // invalid picks ignored
    const eight = resolveColors([7, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(new Set(eight).size).toBe(8);
  });

  test('the match exposes its colours and settings on the map def (sent to every client)', async () => {
    const m = await Match.create({ players: [{ name: 'A', isBot: false, color: 5 }, { name: 'B', isBot: false }], settings: { startCash: 100, suddenDeathSec: 600, genMult: 1.5, teamMode: 0 } });
    expect(m.def.colors).toEqual([5, 0]);
    expect(m.def.settings).toEqual({ startCash: 100, suddenDeathSec: 600, genMult: 1.5, teamMode: 0 });
  });
});

describe('the sim honours each setting', () => {
  test('no settings: same as today (start cash, generator, sudden death)', async () => {
    const m = await Match.create(humans);
    expect(m.settings).toEqual(DEFAULT_SETTINGS);
    const s = tickN(m, 1);
    for (const p of s.players) expect(p.inv.cash).toBe(ECONOMY.startCash);
  });

  test('starting cash', async () => {
    const m = await Match.create({ ...humans, settings: { ...DEFAULT_SETTINGS, startCash: 370 } });
    for (const p of tickN(m, 1).players) expect(p.inv.cash).toBe(370);
  });

  test('starting cash is clamped by the sim too', async () => {
    const m = await Match.create({ ...humans, settings: { ...DEFAULT_SETTINGS, startCash: 1e7 } });
    for (const p of tickN(m, 1).players) expect(p.inv.cash).toBe(1000);
  });

  test('generator speed multiplier scales home and center generators', async () => {
    const base = await Match.create(humans);
    const fast = await Match.create({ ...humans, settings: { ...DEFAULT_SETTINGS, genMult: 2 } });
    const slow = await Match.create({ ...humans, settings: { ...DEFAULT_SETTINGS, genMult: 0.5 } });
    const [b, f, sl] = [tickN(base, 300), tickN(fast, 300), tickN(slow, 300)]; // 10 s
    expect(b.generators[0].stored).toBeCloseTo(10 * ECONOMY.generatorRate, 0);
    expect(f.generators[0].stored).toBeCloseTo(2 * b.generators[0].stored, 1);
    expect(sl.generators[0].stored).toBeCloseTo(0.5 * b.generators[0].stored, 1);
    expect(b.center!.gold).toBeCloseTo(10 * CENTER.goldRate, 0);
    expect(f.center!.gold).toBeCloseTo(2 * b.center!.gold, 1);
  });

  test('sudden death starts at the setting\'s time, not the constant', async () => {
    const m = await Match.create({ ...humans, settings: { ...DEFAULT_SETTINGS, suddenDeathSec: 480 } });
    (m as any).s.time = 479.9;
    let s = tickN(m, 1);
    expect(s.suddenDeath).toBe(false);
    s = tickN(m, 3);
    expect(s.suddenDeath).toBe(true);
    // Default match: still running normally at the same moment.
    const d = await Match.create(humans);
    (d as any).s.time = 481;
    expect(tickN(d, 1).suddenDeath).toBe(false);
    (d as any).s.time = LIFECYCLE.suddenDeathAt;
    expect(tickN(d, 1).suddenDeath).toBe(true);
  });

  test('bots see the match\'s sudden-death time', async () => {
    const m = await Match.create({ players: [{ name: 'A', isBot: false }, { name: 'B', isBot: true, difficulty: 'easy' }], settings: { ...DEFAULT_SETTINGS, suddenDeathSec: 600 } });
    const view = (m as any).botView((m as any).s.players.get(2));
    expect(view.suddenDeathAt).toBe(600);
  });

  test('replays: the same setup (settings included) replays the same match', async () => {
    const setup: MatchSetup = {
      players: [{ name: 'A', isBot: true, difficulty: 'hard' }, { name: 'B', isBot: true, difficulty: 'medium' }, { name: 'C', isBot: true, difficulty: 'pro' }],
      seed: 7, map: 'yard', settings: { startCash: 400, suddenDeathSec: 600, genMult: 1.75, teamMode: 0 },
    };
    // A recording stores the setup as JSON: round-trip it the same way.
    const recorded = JSON.parse(JSON.stringify(setup)) as MatchSetup;
    const a = await Match.create(setup), b = await Match.create(recorded);
    const sig = (s: any) => JSON.stringify(s.players.map((p: any) => [p.pos, p.inv.cash, p.hp]));
    for (let i = 0; i < 20; i++) expect(sig(tickN(b, 15))).toBe(sig(tickN(a, 15)));
  });
});
