import { expect, test } from 'vitest';
import { Commentator, type ShotEvent } from '../../src/client/cinematic/commentary/commentator';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

// A real 8-bot match fed to the commentator (silent voice, clock = sim time): a recorded transcript.
// Proves the lines come from real events at a sane rate, with no repeats and no unfilled templates.
const SIM_SEC = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.COMMENTARY_SIM_SEC ?? 150);

test(`commentary over ${SIM_SEC} s of an 8-bot match`, async () => {
  const diffs: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
  const m = await Match.create({
    players: Array.from({ length: 8 }, (_, i) => ({ name: `Bot (${diffs[i % 4]})`, isBot: true, difficulty: diffs[i % 4] })),
    seed: 11,
  });
  let snap: Snapshot = m.tick(new Map());
  let seed = 7;
  const c = new Commentator({
    tts: { available: false, speaking: false, speak: (_t, o) => o.onEnd?.(), cancel() {} },
    now: () => snap.time, rng: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
  });
  c.setActive(true);
  // A stand-in for the director: a duel shot now and then between the two closest live players.
  let nextShot = 20;
  while (snap.time < SIM_SEC && snap.winner === null) {
    snap = m.tick(new Map());
    c.onSnapshot(snap);
    if (snap.time >= nextShot) {
      nextShot += 25;
      const live = snap.players.filter((p) => p.alive);
      if (live.length >= 2) c.onShot({ playerId: live[0].id, otherId: live[1].id, reason: 'duel', kind: 'shoulder', score: 1, t: snap.time } satisfies ShotEvent);
    }
  }
  const log = c.log;
  console.log(`[commentary] ${log.length} lines over ${snap.time.toFixed(0)} s (winner ${snap.winner ?? 'none'})\n${log.map((l) => `${l.at.toFixed(1).padStart(6)}s ${l.persona.padEnd(6)} ${l.key.padEnd(15)} ${l.text}`).join('\n')}`);

  expect(log.length).toBeGreaterThan(snap.time / 15);
  // Never more than a line every ~2 s on average, and nothing unfilled.
  expect(log.length).toBeLessThan(snap.time / 2);
  expect(log.every((l) => !/[{}]/.test(l.text))).toBe(true);
  // Real events were called, not only colour.
  expect(log.filter((l) => l.persona === 'pbp' && l.key !== 'start').length).toBeGreaterThanOrEqual(5);
  // Variety: no exact text twice within REPEAT_SEC.
  for (let i = 0; i < log.length; i++)
    for (let j = i + 1; j < log.length && log[j].at - log[i].at < 180; j++) expect(log[j].text === log[i].text && log[j].key === log[i].key ? `${log[i].text}` : '').toBe('');
}, 900_000);
