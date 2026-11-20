import { describe, expect, it } from 'vitest';
import { Match } from '../../src/sim/match';
import { stateHash } from '../../src/sim/replay/hash';

const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, isBot: true, difficulty: 'pro' as const }));

describe('Match.fork', () => {
  it('a fork continues exactly like the original (bots, rng, physics, pieces)', async () => {
    const m = await Match.create({ players: bots(4), seed: 11 });
    for (let i = 0; i < 1500; i++) m.tick(new Map()); // 50 s: bots have bought, built, fought
    const f = m.fork();
    for (let i = 0; i < 900; i++) {
      const a = m.tick(new Map()), b = f.tick(new Map());
      if (i % 30 === 0 || i === 899) expect(stateHash(b), `tick ${a.tick}`).toBe(stateHash(a));
    }
    const s = m.tick(new Map());
    expect(s.pieces.length).toBeGreaterThan(0);
    m.dispose(); f.dispose();
  });

  it('the fork is independent: ticking it leaves the original alone', async () => {
    const m = await Match.create({ players: bots(2), seed: 3 });
    for (let i = 0; i < 300; i++) m.tick(new Map());
    const f = m.fork();
    const ref = await Match.create({ players: bots(2), seed: 3 });
    for (let i = 0; i < 300; i++) ref.tick(new Map());
    for (let i = 0; i < 600; i++) f.tick(new Map());
    for (let i = 0; i < 60; i++) expect(stateHash(m.tick(new Map()))).toBe(stateHash(ref.tick(new Map())));
    m.dispose(); f.dispose(); ref.dispose();
  });
});
