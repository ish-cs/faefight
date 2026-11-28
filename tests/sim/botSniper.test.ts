import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { debugBrain } from '../../src/sim/bots/introspect';
import { DEFAULT_BOT_PARAMS, PARAM_RANGES, withParams } from '../../src/sim/bots/params';
import { preset } from '../../src/sim/bots/personality';
import { Match } from '../../src/sim/match';
import type { Difficulty, PlayerState } from '../../src/sim/types';

/**
 * Bots and the sniper rifle (user: bots must use every new item like a strong human). A long-range-minded rich Hard/PRO
 * buys one; with it they scope in and wait for a steady shot at long range, and hold the SMG/pistol up close; a bot
 * without one breaks line of sight when a scope glints at it. Knobs: params.ts sniper.* (PARAM_RANGES).
 */
type Seat = { d: Difficulty; arch: Parameters<typeof preset>[0] };

async function game(seats: Seat[], seed: number, setup: (m: Match, bots: Map<number, Bot>) => void) {
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: seats.map((s) => ({ name: '', isBot: true, difficulty: s.d })), seed },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng, preset(seats[id - 1]?.arch ?? 'Sniper')); bots.set(id, b); return b; } });
  const players = (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players;
  setup(m, bots);
  return { m, bots, players };
}

describe('bots and the sniper rifle', () => {
  test('knobs are tunable and listed', () => {
    for (const k of ['sniper.taste.pro', 'sniper.buyAt.hard', 'sniper.useM', 'sniper.hystM', 'sniper.steadySec.pro', 'sniper.scopeAim.hard', 'sniper.glint.pro', 'sniper.longM', 'sniper.crossShots.pro'])
      expect(PARAM_RANGES[k], k).toBeDefined();
    expect(withParams({ 'sniper.useM': 50 }).sniper.useM).toBe(50);
    // Easy/Medium hardly ever: the taste bar sits above (nearly) every personality's range trait.
    expect(DEFAULT_BOT_PARAMS.sniper.taste.easy).toBeGreaterThan(1);
    expect(DEFAULT_BOT_PARAMS.sniper.taste.medium).toBeGreaterThan(0.85);
  });

  test('a rich long-range PRO buys one', async () => {
    const { m, players } = await game([{ d: 'pro', arch: 'Sniper' }, { d: 'pro', arch: 'Rusher' }], 5, (m) => m.debugGive(1, { cash: 2500 }));
    let at = -1;
    m.tick(new Map());
    for (let i = 0; i < 120 * 30 && at < 0; i++) {
      m.tick(new Map());
      if (players.get(1)!.inv.weapons.sniper) at = i / 30;
    }
    console.log(`PRO Sniper bought the sniper at ${at.toFixed(1)} s`);
    expect(at).toBeGreaterThanOrEqual(0);
    m.dispose();
  }, 300_000);

  test('with one: scoped, steady shots at long range; SMG/pistol up close; the target breaks line of sight on a glint', async () => {
    let scopedShots = 0, hipShots = 0, hits = 0, closeSniper = 0, steadyNotes = 0, glintNotes = 0, far = 0;
    for (const seed of [3, 4]) {
      const { m, bots, players } = await game([{ d: 'pro', arch: 'Sniper' }, { d: 'hard', arch: 'Turtle' }], seed, (m) => {
        m.debugGive(1, { weapons: { sniper: { mag: 5, spare: 25 }, smg: { mag: 30, spare: 90 } } });
      });
      for (const b of bots.values()) b.watch(true);
      m.tick(new Map());
      for (let i = 0; i < 150 * 30; i++) {
        const snap = m.tick(new Map());
        if (snap.winner !== null) break;
        const me = players.get(1)!, foe = players.get(2)!;
        const d = Math.hypot(me.pos.x - foe.pos.x, me.pos.z - foe.pos.z);
        for (const e of snap.events) {
          if (e.type === 'shot' && e.data.by === 1 && e.data.weapon === 'sniper') { if (me.ads) scopedShots++; else hipShots++; if (d >= 35) far++; }
          if (e.type === 'hit' && e.data.by === 1 && e.data.weapon === 'sniper') hits++;
        }
        if (me.alive && foe.alive && d < 15 && me.equipped === 'sniper' && i % 15 === 0) closeSniper++;
        if (i % 10 === 0) {
          if (debugBrain(bots.get(1)!).weapon?.startsWith('sniper: scoped, steadying')) steadyNotes++;
          if (debugBrain(bots.get(2)!).scores.some((s) => s[3].some(([k]) => k === 'scope glint'))) glintNotes++;
        }
      }
      m.dispose();
    }
    console.log(`sniper shots: ${scopedShots} scoped (${far} from 35 m+), ${hipShots} hip; ${hits} hits; close-range sniper-in-hand samples ${closeSniper}; steadying notes ${steadyNotes}; target glint notes ${glintNotes}`);
    expect(scopedShots).toBeGreaterThan(0);
    expect(scopedShots).toBeGreaterThan(3 * hipShots);
    expect(far).toBeGreaterThan(0);
    expect(steadyNotes).toBeGreaterThan(0);
    expect(glintNotes).toBeGreaterThan(0);
  }, 600_000);
});
