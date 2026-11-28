import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { debugBrain } from '../../src/sim/bots/introspect';
import { Match } from '../../src/sim/match';
import type { Difficulty, PlayerState } from '../../src/sim/types';

/**
 * Weapon commitment: bots used to flip between the rocket launcher and a gun every few ticks (a pier shot or a
 * torch target came and went), and since a switch cancels the reload, the rocket hardly ever got reloaded. Over
 * 4-bot free-for-alls where everyone carries a rocket and a rifle: switches per bot-minute stay low, and a rocket
 * reload that starts mostly finishes.
 *
 * Pooled over seeds 1–16 (it was seed 1 alone: neutral branches read 3.05 vs < 3 and 4.54 vs ≤ 4.5).
 * Caps from main (0974cc78) over seeds 1–32 (ci/seedstats-measure): pooled ratio R and its per-seed spread v
 * (ratio estimator, v = var(xᵢ − R·yᵢ)/ȳ²); cap = R ± 2·sqrt(v/16 + v/32), i.e. a fresh 16-seed draw with the real
 * rate unchanged crosses it ~2.3% of the time.
 *   switches/bot-min   R 2.75 → cap 3.13   (main seeds 1–16: 2.80)   [old cap 4.5]
 *   rocket switches    R 1.72 → cap 2.04   (1.80)                    [old cap < 3]
 *   reloads done/start R 0.72 → floor 0.63 (0.72)                    [old ≥ 0.5]
 *   cancelled/done     R 0.33 → cap 0.48   (0.33)                    [old ≤ 1]
 */
const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
const SECS = 180;

async function game(seed: number) {
  const diffs: Difficulty[] = ['pro', 'hard', 'pro', 'hard'];
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  const players = (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players;
  for (const id of bots.keys()) m.debugGive(id, { weapons: { rocket: { mag: 1, spare: 8 }, rifle: { mag: 25, spare: 100 } } });
  const prev = new Map<number, { eq: string; rl: number; mag: number }>();
  const c = { switches: 0, rocketSwitches: 0, starts: 0, done: 0, cancelled: 0, botSec: 0, whys: 0 };
  m.tick(new Map());
  for (let i = 0; i < SECS * 30; i++) {
    const snap = m.tick(new Map());
    if (snap.winner !== null) break;
    for (const [id, p] of players) {
      if (!p.alive) { prev.delete(id); continue; }
      c.botSec += 1 / 30;
      const cur = { eq: p.equipped, rl: p.reloadUntil, mag: p.inv.weapons.rocket?.mag ?? 0 };
      const was = prev.get(id);
      if (was && was.eq !== cur.eq) {
        // Coordinator's definition: gun-to-gun switches only. A hand going empty (fists) is a respawn, an empty gun,
        // a hook or a heal in hand, not the weapon thrash this test guards against.
        if (was.eq !== 'fists' && cur.eq !== 'fists') c.switches++;
        if (was.eq === 'rocket' || cur.eq === 'rocket') c.rocketSwitches++;
        if (was.eq === 'rocket' && was.rl > 0) c.cancelled++;
      }
      if (was && was.eq === 'rocket' && cur.eq === 'rocket') {
        if (was.rl === 0 && cur.rl > 0) c.starts++;
        if (was.mag === 0 && cur.mag === 1) c.done++;
      }
      prev.set(id, cur);
      // The brain panel says which weapon the bot wants in hand and why.
      if (i % 30 === 0 && debugBrain(bots.get(id)!).weapon) c.whys++;
    }
  }
  m.dispose();
  return c;
}

describe('bots commit to a weapon', () => {
  test(`few switches; rocket reloads complete (4-bot FFA, ${SECS} s, seeds 1–16 pooled)`, async () => {
    const t = { switches: 0, rocketSwitches: 0, starts: 0, done: 0, cancelled: 0, botSec: 0, whys: 0 };
    for (const seed of SEEDS) {
      const c = await game(seed);
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += c[k];
    }
    const perMin = (n: number) => n / (t.botSec / 60);
    console.log(`switches ${perMin(t.switches).toFixed(2)}/bot-min (rocket ${perMin(t.rocketSwitches).toFixed(2)}), rocket reloads ${t.done}/${t.starts} done, ${t.cancelled} cancelled by a switch`);
    // Before the fix (seed 1): 8.9 switches/bot-min (6.8 rocket), 1 of 33 rocket reloads done, 31 cancelled.
    expect(perMin(t.switches)).toBeLessThanOrEqual(3.13);
    expect(perMin(t.rocketSwitches)).toBeLessThanOrEqual(2.04);
    expect(t.done).toBeGreaterThanOrEqual(0.63 * t.starts);
    expect(t.cancelled).toBeLessThanOrEqual(0.48 * t.done);
    expect(t.whys).toBeGreaterThan(0);
  }, 900_000);
});
