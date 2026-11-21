import { describe, expect, test } from 'vitest';
import { HAND_PARAMS, encode } from '../../src/sim/bots/params';
import { DEFAULT_ES, initEs, update } from '../../scripts/train/es';
import { runGeneration, type TrainConfig } from '../../scripts/train/generation';
import { imitationPenalty } from '../../scripts/train/hooks';
import { runMatch, seatFitness, type MatchResult, type MatchSpec } from '../../scripts/train/runMatch';

const run = async (specs: MatchSpec[]) => { const out: MatchResult[] = []; for (const s of specs) out.push(await runMatch(s)); return out; };

describe('self-play training harness', () => {
  test('two tiny generations are deterministic and move the optimizer', async () => {
    const cfg: TrainConfig = { es: { ...DEFAULT_ES, lambda: 2 }, games: 5, candSeats: 5, players: 8, maxSec: 8, seed: 3 };
    const train = async () => {
      let st = initEs(encode(HAND_PARAMS), cfg.es);
      const log: unknown[] = [];
      for (let g = 0; g < 2; g++) {
        const r = await runGeneration(st, HAND_PARAMS, [], cfg, run);
        log.push({ fitness: r.fitness, stats: { ...r.stats, msPerTick: 0 } });
        st = r.next;
      }
      return { st, log };
    };
    const a = await train(), b = await train();
    expect(a.st.gen).toBe(2);
    expect(a.log).toEqual(b.log);
    expect(a.st.mean).toEqual(b.st.mean);
    expect(a.st.mean).not.toEqual(encode(HAND_PARAMS));
  }, 120_000);

  test('ES moves its mean toward the fitter candidates', () => {
    const st = initEs([0.5, 0.5]);
    const next = update(st, [[0.8, 0.5], [0.2, 0.5], [0.6, 0.5], [0.4, 0.5]], [3, 0, 2, 1], { ...DEFAULT_ES, lambda: 4 });
    expect(next.mean[0]).toBeGreaterThan(0.6);
  });

  test('fitness: eliminating someone via a seal is worth far more than kills', () => {
    const base = { place: 2, kills: 0, deaths: 0, seals: 0, elims: 0, survived: 600, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0, sealScore: 0, elimScore: 0, raidSec: 0, hoardSec: 0, wasted: 0, hitDists: [] as number[], longestHomeIdle: 0, aliveSec: 600, attackSec: 0 };
    const r = (seat: typeof base): MatchResult => ({ seed: 1, winner: null, time: 600, decisive: false, msPerTick: 0, seats: [seat, { ...base, place: 1.5 }] });
    const killer = seatFitness(r({ ...base, kills: 10 }), 0), sealer = seatFitness(r({ ...base, seals: 1, elims: 1, sealScore: 1.5, elimScore: 1.5 }), 0);
    expect(sealer).toBeGreaterThan(killer + 0.3);
    const fast = { seed: 1, winner: 1, time: 300, decisive: true, msPerTick: 0, seats: [{ ...base, place: 1 }, { ...base, place: 2 }] };
    expect(seatFitness(fast, 0)).toBeGreaterThan(seatFitness({ ...fast, time: 900 }, 0));
  });

  test('fitness shaping: real fights and mission work beat plinking and hiding at home', () => {
    const base = { place: 2, kills: 0, deaths: 0, seals: 0, elims: 0, survived: 600, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0, sealScore: 0, elimScore: 0, raidSec: 0, hoardSec: 0, wasted: 0, hitDists: [] as number[], longestHomeIdle: 0, aliveSec: 600, attackSec: 0 };
    const r = (seat: typeof base): MatchResult => ({ seed: 1, winner: null, time: 600, decisive: false, msPerTick: 0, seats: [seat, { ...base, place: 1.5 }] });
    const plain = seatFitness(r(base), 0);
    expect(seatFitness(r({ ...base, closeDmg: 150 }), 0)).toBeGreaterThan(plain + 0.15);
    expect(seatFitness(r({ ...base, scaffolds: 10, plugs: 3 }), 0)).toBeGreaterThan(plain + 0.1);
    expect(seatFitness(r({ ...base, longShots: 100, longHits: 5 }), 0)).toBeLessThan(plain - 0.15);
    expect(seatFitness(r({ ...base, idleHome: 400 }), 0)).toBeLessThan(plain - 0.15);
  });

  test('imitation penalty is zero at the human mean and grows away from it', () => {
    const t = { mean: { killsPerMin: 1, deathsPerMin: 1, sealsPerMin: 0.1, elimsPerMin: 0.05 }, std: { killsPerMin: 0.5, deathsPerMin: 0.5, sealsPerMin: 0.1, elimsPerMin: 0.05 } };
    expect(imitationPenalty(t.mean, t)).toBe(0);
    expect(imitationPenalty({ ...t.mean, killsPerMin: 3 }, t)).toBeGreaterThan(0.5);
  });

  test('scenario starts fail loudly until the replay pipeline can restore states', async () => {
    await expect(runMatch({ seed: 1, maxSec: 1, seats: [], scenario: 'x' })).rejects.toThrow(/scenario/);
  });
});
