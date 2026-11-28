/// <reference types="node" />
/**
 * Bot-cognition P0 tooling: UserProxy tree + features, the macro labeller, the CART fit, replay reconstruction, the
 * vs-user CSV, and the measure.ts helpers. None of it changes how normal bots play (the goalBias test pins that).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { labelReplay } from '../../scripts/replays/macros';
import { fidelity, reconstruct } from '../../scripts/replays/reconstruct';
import { crossValidate, fitTree } from '../../scripts/replays/userproxy';
import { ingest, parseCsv, rolling, toCsvLine, type VsRow } from '../../scripts/replays/vs-user';
import { proxySeat, tierStats, wilson, type GameOut } from '../../scripts/ci/measure';
import { writeReplay } from '../../scripts/replays/selfplay';
import { Bot } from '../../src/sim/bots/bot';
import { features, gunClass, goalBiasFor, MACROS, predict, whereOf, type TreeNode, type UserProxyModel } from '../../src/sim/bots/userProxy';
import { PRESETS } from '../../src/sim/bots/personality';
import { buildMap } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { decodeReplay } from '../../src/sim/replay/codec';
import type { LogEvent, Replay, SecondSummary } from '../../src/sim/replay/format';
import { recordHeadlessMatch } from '../../src/sim/replay/headless';
import { stateHash } from '../../src/sim/replay/hash';
import type { BotView } from '../../src/sim/bots/view';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogp0-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('UserProxy model', () => {
  const map = buildMap(2);
  it('features: gun class, where, nearest enemy, seals', () => {
    expect(gunClass([])).toBe(0);
    expect(gunClass(['pistol'])).toBe(1);
    expect(gunClass(['pistol', 'smg'])).toBe(2);
    expect(gunClass(['smg', 'rifle'])).toBe(3);
    expect(whereOf(map, 0, map[0].center)).toBe(0);
    expect(whereOf(map, 0, map[1].center)).toBe(1);
    const mid = { x: (map[0].center.x + map[1].center.x) / 2, z: (map[0].center.z + map[1].center.z) / 2 };
    expect(whereOf(map, 0, mid)).toBe(2); // centroid of the islands = the centre
    const x = features({ hp: 80, shield: 20, cash: 300, guns: ['rifle'], pos: map[0].center, island: 0, enemies: [{ x: map[0].center.x + 30, z: map[0].center.z }],
      map, sealed: [0, 1], rivalIslands: [1], now: 120, hurtRecently: true });
    expect(x).toEqual([100, 300, 3, 30, 0, 0, 1, 1, 2, 1]);
  });

  it('predict walks the tree; goalBias favours only the predicted macro\'s goals', () => {
    const tree: TreeNode = { f: 3, v: 36.5, l: { leaf: MACROS.indexOf('fight') }, r: { leaf: MACROS.indexOf('push') } };
    expect(MACROS[predict(tree, [100, 0, 3, 10, 1, 0, 0, 1, 1, 0])]).toBe('fight');
    expect(MACROS[predict(tree, [100, 0, 3, 90, 1, 0, 0, 1, 1, 0])]).toBe('push');
    const model: UserProxyModel = { version: 1, tree, bias: 0.4, difficulty: 'hard', traits: { ...PRESETS.Sniper } };
    const bias = goalBiasFor(model);
    const me = { id: 1, hp: 100, shield: 0, pos: { x: map[0].center.x, y: 2, z: map[0].center.z }, island: 0, inv: { cash: 0, weapons: {} } };
    const view = { now: 1, self: me, enemies: [], others: [{ id: 2, island: 1, eliminated: false }], map, sealed: [false, false], hurt: [] } as unknown as BotView;
    expect(bias('bridge', view)).toBe(0.4); // nobody in sight → push → bridge/attack
    expect(bias('attack', view)).toBe(0.4);
    expect(bias('fight', view)).toBe(0);
  });

  it('a goalBias that adds 0 plays bit-identically to a normal bot (the hook changes nothing by itself)', async () => {
    const run = async (hook: boolean) => {
      const m = await Match.create({ players: [1, 2].map((i) => ({ name: `b${i}`, isBot: true, difficulty: 'hard' as const })), seed: 7 },
        { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); if (hook) b.goalBias = () => 0; return b; } });
      let s = m.tick(new Map());
      for (let i = 0; i < 900; i++) s = m.tick(new Map());
      const h = stateHash(s);
      m.dispose();
      return h;
    };
    expect(await run(true)).toBe(await run(false));
  });
});

describe('CART fit', () => {
  it('fits a separable rule exactly and respects the depth cap', () => {
    const rows = Array.from({ length: 200 }, (_, i) => { const x = [i % 150, (i * 7) % 50, 0, 0, 0, 0, 0, 0, 0, 0]; return { x, y: x[0] > 75 ? 2 : x[1] > 25 ? 6 : 9 }; });
    const t = fitTree(rows, 3, 5);
    expect(rows.every((r) => predict(t, r.x) === r.y)).toBe(true);
    const depth = (n: TreeNode): number => ('leaf' in n ? 0 : 1 + Math.max(depth(n.l), depth(n.r)));
    expect(depth(fitTree(rows, 1, 5))).toBeLessThanOrEqual(1);
  });

  it('leave-one-replay-out scores each replay on a model fit without it', () => {
    const ms = ['a', 'b'].flatMap((rep) => Array.from({ length: 40 }, (_, i) => ({ replay: rep, x: [i, 0, 0, 0, 0, 0, 0, 0, 0, 0], y: i < 20 ? 0 : 1 })));
    const cv = crossValidate(ms as never, 3, 5);
    expect(cv.byReplay.map((b) => b.replay)).toEqual(['a', 'b']);
    expect(cv.acc).toBe(1);
    expect(cv.majorityAcc).toBe(0.5);
  });
});

/** Two players, 0 (human, island 0) and 1's bunker at island 1: summaries every second for 30 s plus `events`. */
function miniReplay(events: LogEvent[], rowsAt: (t: number) => (number | string)[][]): Replay {
  const map = buildMap(2);
  const seconds: SecondSummary[] = Array.from({ length: 30 }, (_, t) => ({ t, tick: t * 30, p: rowsAt(t), pieces: 0, sealed: [0, 0], waterY: 0 }));
  return {
    header: { format: 2, id: 'x', matchId: 'x', segment: 0, startTick: 0, kind: 'solo', recordedAt: 0, build: 't', setup: { players: [{ name: 'h', isBot: false }, { name: 'b', isBot: true, difficulty: 'hard' }], seed: 1 },
      localId: 1, players: [{ id: 1, name: 'h', isBot: false, island: 0 }, { id: 2, name: 'b', isBot: true, difficulty: 'hard', island: 1 }], map },
    footer: { ticks: 900, duration: 30, winner: null, unfinished: true }, ticks: [], ops: [], hashes: [], events, seconds, checkpoint: null,
  };
}

describe('macro labeller', () => {
  const map = buildMap(2);
  const home = map[0], rival = map[1];
  const row = (id: number, p: { x: number; z: number }, cash = 100, hp = 100) => [id, p.x, 2, p.z, hp, 0, 1, cash, 0, 0, 'pistol', 0, 0];
  it('labels seal, fight, bank and hold windows', () => {
    const r = miniReplay([
      [5 * 30 + 10, 'placed', { piece: 1, kind: 'wood', by: 1, pos: { x: rival.bunker.center.x + 2, y: 2, z: rival.bunker.center.z }, rotY: 0 }],
      [10 * 30 + 3, 'hit', { by: 1, target: 2, amount: 10, weapon: 'pistol', dist: 10 }],
    ], (t) => [row(1, t >= 15 && t < 20 ? home.vault : home.center, t >= 17 && t < 20 ? 20 : 100), row(2, rival.center)]);
    const ms = labelReplay('mini', r, { humansOnly: true });
    expect(ms.map((m) => [m.t, m.macro])).toEqual([[5, 'seal'], [10, 'fight'], [15, 'bank'], [20, 'hold']]);
    expect(ms[0].x[2]).toBe(1); // pistol in hand → gun class 1
  });
});

describe('reconstruct', () => {
  it('rebuilds a recorded moment on a fresh match: players, pieces and clock match the recording', async () => {
    const setup = { players: [1, 2, 3, 4].map((i) => ({ name: `Bot ${i}`, isBot: true, difficulty: 'pro' as const })) };
    const rec = await recordHeadlessMatch(setup, 3, 2400);
    const r = await decodeReplay(fs.readFileSync(writeReplay(path.join(tmp, 'rec'), rec.bytes, rec.header)));
    const tick = 2100;
    const rb = await reconstruct(r, tick);
    try {
      expect(rb.second.tick).toBe(2100);
      const snap = rb.match.tick(new Map());
      const f = fidelity(snap, rb.second);
      expect(f.why).toEqual([]);
      expect(f.usable).toBe(true);
      expect(f.pieces).toBe(rb.second.pieces);
      expect(snap.time).toBeCloseTo(70 + 1 / 30, 3);
    } finally { rb.match.dispose(); }
  });
});

describe('vs-user tracker', () => {
  const mk = (date: string, tiers: string, won: string, finished = '1'): VsRow => ({ date, replay_id: date, file: 'f', tiers, bots: '7', minutes: '10', finished, user_won: won, placement: '1', players: '8', kills: '1', deaths: '0', seals: '0' });
  it('CSV round-trips (quoted cells) and the rolling rate counts finished games with that tier only', () => {
    const rows = [mk('2026-01-01', 'hard×7', '0'), mk('2026-01-02', 'hard×7', '1'), mk('2026-01-03', 'medium×7', '0'), mk('2026-01-04', 'pro×1 hard×1', '0'), mk('2026-01-05', 'hard×7', '', '0')];
    rows[0].file = 'a, "b"';
    const text = 'date,replay_id,file,tiers,bots,minutes,finished,user_won,placement,players,kills,deaths,seals\n' + rows.map(toCsvLine).join('\n') + '\n';
    expect(parseCsv(text)).toEqual(rows);
    const x = rolling(rows, 'hard', 10);
    expect([x.games, x.botWins]).toEqual([3, 2]);
    expect(rolling(rows, 'hard', 2).games).toBe(2);
  });
  it('ingests replays with a human once (all-bot games skipped)', async () => {
    const csv = path.join(tmp, 'vs.csv');
    const dir = path.join(tmp, 'rec');
    expect((await ingest([dir], csv)).added).toHaveLength(0); // the self-play recording has no human
    const map = buildMap(2);
    const r = miniReplay([[600, 'kill', { victim: 2, killer: 1 }]], () => [[1, map[0].center.x, 2, map[0].center.z, 100, 0, 1, 0, 1, 0, 'pistol', 0, 0]]);
    r.footer = { ticks: 900, duration: 30, winner: 1, unfinished: false };
    const { encodeReplay } = await import('../../src/sim/replay/codec');
    fs.writeFileSync(path.join(tmp, 'h.faereplay'), await encodeReplay(r));
    const a = await ingest([path.join(tmp, 'h.faereplay')], csv);
    expect(a.added.map((x) => [x.user_won, x.kills, x.tiers])).toEqual([['1', '1', 'hard×1']]);
    expect((await ingest([path.join(tmp, 'h.faereplay')], csv)).added).toHaveLength(0);
  });
});

describe('measure.ts helpers', () => {
  it('proxy seats alternate in 1v1 and rotate in FFA; Wilson interval', () => {
    expect([1, 2].map((s) => proxySeat('1v1-hard-vs-userproxy', s))).toEqual([1, 0]);
    expect([1, 2, 9].map((s) => proxySeat('ffa8-userproxy-vs-7hard', s))).toEqual([0, 1, 0]);
    expect(proxySeat('ffa8-mixed', 1)).toBe(-1);
    const [lo, hi] = wilson(70, 100);
    expect(lo).toBeCloseTo(0.604, 2);
    expect(hi).toBeCloseTo(0.781, 2);
  });
  it('per-tier stats pool seats of a tier from the same games', () => {
    const seat = (difficulty: string, o: Record<string, number>) => ({ difficulty, kills: 0, deaths: 0, aliveSec: 0, attackSec: 0, idleHome: 0, longestHomeIdle: 0, hitDists: [10, 30], eliminatedAt: null, damage: 40, seals: 1, hits: 2, headshots: 1, rifleHits: 0, elimsBy: 0, inGameSec: 120, ...o });
    const g = { seats: [seat('pro', { kills: 2, deaths: 1 }), seat('hard', { kills: 1, deaths: 2 }), seat('pro', { kills: 0, deaths: 1 })] } as unknown as GameOut;
    const t = tierStats([g])!;
    expect(t.pro!.seats).toBe(2);
    expect(t.pro!.kd).toBe(1);
    expect(t.pro!.hitsPerMin).toBe(1); // 4 hits in 4 min
    expect(t.pro!.headshotPct).toBe(50);
    expect(t.pro!.dmgPerHit).toBe(20);
    expect(t.hard!.sealsPerMin).toBe(0.5);
  });
});
