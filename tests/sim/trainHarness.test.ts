import { describe, expect, test } from 'vitest';
import { DEFAULT_BOT_PARAMS, PARAM_RANGES, flattenParams } from '../../src/sim/bots/params';
import { DEFAULT_ES, initEs, update } from '../../scripts/train/es';
import { HAND_PARAMS, TRAIN_KEYS, decode, encode, sanitize, toBotParams } from '../../scripts/train/params';
import { runGeneration, type TrainConfig } from '../../scripts/train/generation';
import { proxyBonus, runMatch, seatFitness, type MatchResult, type MatchSpec, type SeatResult } from '../../scripts/train/runMatch';

describe('ES trainer harness', () => {
  test('search vector: Hard/PRO keys only (strength.* included), easy/medium stay at hand values', () => {
    expect(TRAIN_KEYS.length).toBeGreaterThan(50);
    expect(TRAIN_KEYS.some((k) => /(^|\.)(easy|medium)(\.|$)/.test(k))).toBe(false);
    expect(TRAIN_KEYS).toContain('strength.rifleAt.pro');
    expect(TRAIN_KEYS).toContain('strength.leaderFocus.hard');
    expect(TRAIN_KEYS).toContain('strength.endgameLeft');
    const x = encode(HAND_PARAMS).map(() => 1);
    const flat = flattenParams(toBotParams(decode(x)));
    const hand = flattenParams(DEFAULT_BOT_PARAMS);
    for (const k of Object.keys(PARAM_RANGES)) if (!TRAIN_KEYS.includes(k)) expect(flat[k], k).toBe(hand[k]);
    expect(flat['strength.leaderFocus.pro']).toBe(PARAM_RANGES['strength.leaderFocus.pro'][1]);
  });

  test('encode/decode round-trip and sanitize clamps into the box', () => {
    const back = decode(encode(HAND_PARAMS));
    for (const k of TRAIN_KEYS) expect(back[k], k).toBeCloseTo(HAND_PARAMS[k], 9);
    const x = TRAIN_KEYS.map((_, i) => (i % 7) / 6);
    const again = encode(decode(x));
    x.forEach((v, i) => expect(again[i]).toBeCloseTo(v, 9));
    const [lo, hi] = PARAM_RANGES['strength.rifleAt.pro'];
    const s = sanitize({ 'strength.rifleAt.pro': hi + 999, 'drive.plinkRange': -1e9, 'aim.commitSec': NaN, 'not.a.key': 5 });
    expect(s['strength.rifleAt.pro']).toBe(hi);
    expect(s['drive.plinkRange']).toBe(PARAM_RANGES['drive.plinkRange'][0]);
    expect(s['aim.commitSec']).toBe(HAND_PARAMS['aim.commitSec']);
    expect('not.a.key' in s).toBe(false);
    expect(lo).toBeLessThan(hi);
    expect(() => decode([0.5])).toThrow(/entries/);
  });

  test('ES moves its mean toward the fitter candidates', () => {
    const next = update(initEs([0.5, 0.5]), [[0.8, 0.5], [0.2, 0.5], [0.6, 0.5], [0.4, 0.5]], [3, 0, 2, 1], { ...DEFAULT_ES, lambda: 4 });
    expect(next.mean[0]).toBeGreaterThan(0.6);
  });

  test('fitness: seal → kill → out beats kills; beating the human proxy pays', () => {
    const base: SeatResult = { place: 2, kills: 0, deaths: 0, seals: 0, elims: 0, survived: 600, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0, sealScore: 0, elimScore: 0, raidSec: 0, hoardSec: 0, wasted: 0, hitDists: [], longestHomeIdle: 0, aliveSec: 600, attackSec: 0, killed: [], healsFight: 0, lowHpDeaths: 0 };
    const r = (seat: SeatResult, other: Partial<SeatResult> = {}): MatchResult => ({ seed: 1, winner: null, time: 600, decisive: false, msPerTick: 0, seats: [seat, { ...base, place: 1.5, ...other }] });
    const killer = seatFitness(r({ ...base, kills: 10 }), 0), sealer = seatFitness(r({ ...base, seals: 1, elims: 1, sealScore: 1.5, elimScore: 1.5 }), 0);
    expect(sealer).toBeGreaterThan(killer + 0.3);
    expect(seatFitness(r({ ...base, healsFight: 3 }), 0)).toBeGreaterThan(seatFitness(r(base), 0));
    expect(seatFitness(r({ ...base, longestHomeIdle: 240 }), 0)).toBeLessThan(seatFitness(r(base), 0) - 1);
    expect(proxyBonus(r({ ...base, place: 1, killed: [1] }, { place: 2 }), 0, [1])).toBeCloseTo(1.0, 9);
    expect(proxyBonus(r(base, { place: 1 }), 0, [1])).toBe(0);
    expect(proxyBonus(r(base), 0, [])).toBe(0);
  });

  test('generation plan: 2 human proxies per 8-seat FFA, tiers alternate Hard/PRO, duels vs the proxy, ES steps', async () => {
    const cfg: TrainConfig = { es: DEFAULT_ES, games: 4, candSeats: 4, players: 8, maxSec: 60, seed: 1, duels: 6, duelWeight: 1.5, proxySeats: 2 };
    let seen: MatchSpec[] = [];
    const fake = async (specs: MatchSpec[]) => {
      seen = specs;
      return specs.map((s, g): MatchResult => ({ seed: s.seed, winner: null, time: 60, decisive: false, msPerTick: 0, seats: s.seats.map((_, i) => ({
        place: 1 + ((i + g) % s.seats.length), kills: 0, deaths: 0, seals: 0, elims: 0, survived: 60, closeDmg: 0, longShots: 0, longHits: 0, scaffolds: 0, plugs: 0, idleHome: 0, sealScore: 0, elimScore: 0, raidSec: 0, hoardSec: 0, wasted: 0, hitDists: [], longestHomeIdle: 0, aliveSec: 60, attackSec: (i * 7 + g) % 60, killed: [], healsFight: 0, lowHpDeaths: 0,
      })) }));
    };
    const st = initEs(encode(HAND_PARAMS));
    const { next, stats } = await runGeneration(st, { ...HAND_PARAMS }, [], cfg, fake);
    const ffas = seen.filter((s) => s.seats.length === 8), duels = seen.filter((s) => s.seats.length === 2);
    expect(ffas).toHaveLength(14);
    expect(duels).toHaveLength(6);
    for (const s of ffas) expect(s.seats.filter((x) => x.kind === 'proxy')).toHaveLength(2);
    for (const s of duels) expect(s.seats.filter((x) => x.kind === 'proxy')).toHaveLength(1);
    const tier = (s: MatchSpec) => (s.seats.find((x) => x.kind === 'new') as { difficulty: string }).difficulty;
    expect(new Set(ffas.map(tier))).toEqual(new Set(['pro', 'hard']));
    expect(new Set(duels.map(tier))).toEqual(new Set(['pro', 'hard']));
    expect(next.gen).toBe(1);
    expect(next.mean).not.toEqual(st.mean);
    expect(Number.isFinite(stats.meanFit)).toBe(true);
    expect(stats.beatProxy).not.toBeNull();
  });

  test('one short match (Hard + PRO + human proxy) returns finite fitness for every seat', async () => {
    const res = await runMatch({
      seed: 7, maxSec: 45,
      seats: [
        { kind: 'new', params: { ...HAND_PARAMS }, difficulty: 'pro' },
        { kind: 'new', params: decode(encode(HAND_PARAMS).map((v) => Math.min(1, v + 0.1))), difficulty: 'hard' },
        { kind: 'proxy' },
        { kind: 'new', params: { ...HAND_PARAMS }, difficulty: 'hard' },
      ],
    });
    expect(res.seats).toHaveLength(4);
    expect(res.time).toBeGreaterThan(40);
    expect(res.time).toBeLessThanOrEqual(46);
    res.seats.forEach((_, i) => {
      expect(Number.isFinite(seatFitness(res, i, 45))).toBe(true);
      expect(Number.isFinite(proxyBonus(res, i, [2]))).toBe(true);
    });
  }, 300_000);
});
