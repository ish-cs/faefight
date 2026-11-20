import { describe, expect, test } from 'vitest';
import { LIFECYCLE } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const LIMIT = 25 * 60 * 30;

describe('8-bot free-for-all', () => {
  test('bots fight each other and the match ends with a winner', async () => {
    const diffs: Difficulty[] = ['easy', 'medium', 'hard'];
    const bots = new Map<number, Bot>();
    const m = await Match.create({
      players: Array.from({ length: 8 }, (_, i) => ({ name: `Bot (${diffs[i % 3]})`, isBot: true, difficulty: diffs[i % 3] })),
      seed: 11,
    }, { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
    let snap: Snapshot = m.tick(new Map());
    const names = new Map(snap.players.map((p) => [p.id, p.name]));
    const kills = new Map<number, number>();
    let botKills = 0, drowned = 0, earlyDrowned = 0, preSdSeals = 0, preSdElims = 0;
    let ms = 0;
    for (let i = 0; i < LIMIT && snap.winner === null; i++) {
      const t0 = performance.now();
      snap = m.tick(new Map());
      ms += performance.now() - t0;
      for (const e of snap.events) {
        if (e.type === 'kill') {
          const k = e.data.killer as number | null;
          if (k == null) { drowned++; if (e.t < LIFECYCLE.suddenDeathAt) earlyDrowned++; }
          else if (k !== e.data.victim) { botKills++; kills.set(k, (kills.get(k) ?? 0) + 1); }
        }
        if (e.type === 'sealed' && e.t < LIFECYCLE.suddenDeathAt) preSdSeals++;
        if (e.type === 'eliminated' && e.t < LIFECYCLE.suddenDeathAt) preSdElims++;
      }
    }
    const banked = snap.players.reduce((n, p) => n + p.vault.cash, 0);
    const lines = snap.players.map((p) => `  #${p.id} ${p.name.padEnd(15)} ${p.isBot ? `${bots.get(p.id)!.difficulty.padEnd(6)} ${bots.get(p.id)!.personality.archetype.padEnd(9)}` : ''} kills ${kills.get(p.id) ?? 0}${p.eliminated ? '  (out)' : ''}`);
    console.log([
      `FFA seed 11: winner ${snap.winner === null ? 'none' : `#${snap.winner} ${names.get(snap.winner) ?? 'draw'}`} at ${(snap.time / 60).toFixed(1)} min`,
      `  bot kills ${botKills}, drowned ${drowned} (${earlyDrowned} before sudden death), pre-sudden-death seals ${preSdSeals}, eliminations ${preSdElims}, still banked $${banked}`,
      ...lines,
      `  ${(ms / snap.tick).toFixed(2)} ms/tick avg over ${snap.tick} ticks`,
    ].join('\n'));

    expect(snap.winner).not.toBeNull();
    expect(new Set([...bots.values()].map((b) => b.personality.archetype)).size).toBeGreaterThanOrEqual(2);
    // Human-looking nicknames, unique, short, no difficulty/archetype in them.
    expect(new Set([...names.values()].map((n) => n.toLowerCase())).size).toBe(8);
    for (const n of names.values()) { expect(n.length).toBeLessThan(16); expect(n).not.toMatch(/bot \(|easy|medium|hard|rusher|turtle|vulture|economist|sniper/i); }
    expect(botKills).toBeGreaterThanOrEqual(5);
    expect(new Set(kills.keys()).size).toBeGreaterThanOrEqual(3);
    expect(preSdSeals + preSdElims).toBeGreaterThan(0);
  }, 600_000);

  test('8 hard bots fit easily in the 33 ms tick', async () => {
    const m = await Match.create({ players: Array.from({ length: 8 }, () => ({ name: 'Bot (hard)', isBot: true, difficulty: 'hard' as const })), seed: 3 });
    for (let i = 0; i < 30 * 60; i++) m.tick(new Map()); // warm up into the build-up phase
    const n = 30 * 60;
    // Median tick: robust to a busy machine stalling a few ticks.
    const times: number[] = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); m.tick(new Map()); times.push(performance.now() - t0); }
    times.sort((x, y) => x - y);
    const ms = times[Math.floor(n / 2)];
    console.log(`8 hard bots: ${ms.toFixed(2)} ms/tick (minutes 1–2)`);
    expect(ms).toBeLessThan(15);
  }, 300_000);
});
