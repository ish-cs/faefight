import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { debugBrain } from '../../src/sim/bots/introspect';
import { Match } from '../../src/sim/match';
import type { Difficulty, PlayerState } from '../../src/sim/types';

/**
 * Weapon commitment: bots used to flip between the rocket launcher and a gun every few ticks (a pier shot or a
 * torch target came and went), and since a switch cancels the reload, the rocket hardly ever got reloaded. Over a
 * 4-bot free-for-all where everyone carries a rocket and a rifle: switches per bot-minute stay low, and a rocket
 * reload that starts mostly finishes.
 */
describe('bots commit to a weapon', () => {
  test('few switches; rocket reloads complete', async () => {
    const diffs: Difficulty[] = ['pro', 'hard', 'pro', 'hard'];
    const bots = new Map<number, Bot>();
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed: 1 },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
    const players = (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players;
    for (const id of bots.keys()) m.debugGive(id, { weapons: { rocket: { mag: 1, spare: 8 }, rifle: { mag: 25, spare: 100 } } });
    const prev = new Map<number, { eq: string; rl: number; mag: number }>();
    let switches = 0, rocketSwitches = 0, starts = 0, done = 0, cancelled = 0, botSec = 0;
    const whys = new Set<string>();
    m.tick(new Map());
    for (let i = 0; i < 3 * 60 * 30; i++) {
      const snap = m.tick(new Map());
      if (snap.winner !== null) break;
      for (const [id, p] of players) {
        if (!p.alive) { prev.delete(id); continue; }
        botSec += 1 / 30;
        const cur = { eq: p.equipped, rl: p.reloadUntil, mag: p.inv.weapons.rocket?.mag ?? 0 };
        const was = prev.get(id);
        if (was && was.eq !== cur.eq) {
          switches++;
          if (was.eq === 'rocket' || cur.eq === 'rocket') rocketSwitches++;
          if (was.eq === 'rocket' && was.rl > 0) cancelled++;
        }
        if (was && was.eq === 'rocket' && cur.eq === 'rocket') {
          if (was.rl === 0 && cur.rl > 0) starts++;
          if (was.mag === 0 && cur.mag === 1) done++;
        }
        prev.set(id, cur);
        if (i % 30 === 0) { const g = debugBrain(bots.get(id)!).weapon; if (g) whys.add(g.split(':')[0]); }
      }
    }
    const perMin = (n: number) => n / (botSec / 60);
    console.log(`switches ${perMin(switches).toFixed(2)}/bot-min (rocket ${perMin(rocketSwitches).toFixed(2)}), rocket reloads ${done}/${starts} done, ${cancelled} cancelled by a switch; intents: ${[...whys].join(' | ')}`);
    // Before the fix (seed 1): 8.9 switches/bot-min (6.8 rocket), 1 of 33 rocket reloads done, 31 cancelled.
    // After: ~3.2 (1.6 rocket), 5 of 8 done; the cancels left are a real threat up close (draw the loaded rifle).
    // 2026-11-23 (bots seal and storm sooner: more fights): seeds 1-4 measure 4.1-5.9 on the seal branch, 4.5-5.5 with the
    // storm fix; any path change moves seed 1 across 4.5. The bar is there to catch the flip-flop (8.9), not that noise.
    expect(perMin(switches)).toBeLessThan(5.5);
    expect(perMin(rocketSwitches)).toBeLessThan(3);
    expect(done).toBeGreaterThan(0);
    expect(done).toBeGreaterThanOrEqual(starts / 2);
    expect(cancelled).toBeLessThanOrEqual(done);
    // The brain panel says which weapon the bot wants in hand and why.
    expect(whys.size).toBeGreaterThan(0);
  }, 300_000);
});
