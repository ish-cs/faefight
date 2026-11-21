/// <reference types="node" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractStats, loadReplays, mineScenarios } from '../../scripts/replays/extract';
import { writeReplay } from '../../scripts/replays/selfplay';
import { buildMap } from '../../src/sim/map';
import { encodeReplay } from '../../src/sim/replay/codec';
import type { LogEvent, Replay, SecondSummary, TickInput } from '../../src/sim/replay/format';
import { matchFromReplay, recordHeadlessMatch } from '../../src/sim/replay/headless';
import { Bot } from '../../src/sim/bots/bot';
import { zip } from '../../src/client/replay/zip';
import { NO_INPUT } from '../../src/sim/types';

/**
 * Fixture: 2 players, human (1, island 0) vs bot (2, island 1). The human buys wood then an SMG, bridges toward
 * the bot, walls its bunker (sealed at 11.3 s), shoots it from 12 m while strafing with sights up, and kills it.
 */
function fixture(): Replay {
  const map = buildMap(2);
  const mid = { x: (map[0].center.x + map[1].center.x) / 2, y: 2, z: (map[0].center.z + map[1].center.z) / 2 };
  const bunker = map[1].bunker.center;
  const events: LogEvent[] = [
    [60, 'bought', { by: 1, item: 'wood', cost: 20 }],
    [90, 'bought', { by: 1, item: 'smg', cost: 150 }],
    [95, 'bought', { by: 2, item: 'pistol', cost: 50 }],
    [120, 'placed', { piece: 10, kind: 'wood', by: 1, pos: mid, rotY: 0 }],
    [300, 'placed', { piece: 11, kind: 'wood', by: 1, pos: { x: bunker.x + 5, y: 2, z: bunker.z }, rotY: 0 }],
    [330, 'placed', { piece: 12, kind: 'metal', by: 1, pos: { x: bunker.x - 5, y: 2, z: bunker.z }, rotY: 0 }],
    [340, 'sealed', { island: 1, owner: 2, by: 1 }],
    [400, 'hit', { target: 2, by: 1, amount: 20, weapon: 'smg', dist: 12 }],
    [405, 'hit', { target: 2, by: 1, amount: 20, weapon: 'smg', dist: 45 }],
    [406, 'hit', { target: 1, by: 2, amount: 10, weapon: 'pistol', dist: 12 }],
    [410, 'kill', { victim: 2, killer: 1, inWater: false }],
    [410, 'eliminated', { player: 2 }],
    [411, 'win', { winner: 1 }],
  ];
  const ticks: TickInput[][] = [];
  for (let t = 1; t <= 450; t++) {
    const combat = t >= 390 && t <= 440;
    const input = { ...NO_INPUT, moveZ: 1, moveX: combat ? (Math.floor(t / 5) % 2 ? 1 : -1) : 0, fire: combat && t % 2 === 0, ads: combat, select: 1, jump: t === 100 };
    ticks.push([{ id: 1, input, moves: [] }]);
  }
  const seconds: SecondSummary[] = [];
  for (let k = 1; k <= 15; k++) {
    const tick = k * 30;
    seconds.push({ t: k, tick, p: [[1, 0, 2, 0, 100, 0, 1, 100, 0, 0, 'smg', 0, 0], [2, 50, 2, 0, 100, 0, tick > 410 ? 0 : 1, 100, 0, 0, 'pistol', 0, tick > 410 ? 1 : 0]], pieces: 3, sealed: [0, tick >= 340 ? 1 : 0], waterY: -1 });
  }
  return {
    header: {
      format: 2, id: 'fixture', matchId: 'fixture', segment: 0, startTick: 0, kind: 'solo', recordedAt: 0, build: 'test', setup: { players: [{ name: 'Ann', isBot: false }, { name: 'Bot (pro)', isBot: true, difficulty: 'pro' }], seed: 1 },
      localId: 1, players: [{ id: 1, name: 'Ann', isBot: false, island: 0 }, { id: 2, name: 'Zed', isBot: true, difficulty: 'pro', island: 1 }], map,
    },
    footer: { ticks: 450, duration: 15, winner: 1, unfinished: false },
    ticks, ops: [], hashes: [], events, seconds, checkpoint: null,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faereplay-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('learning pipeline (scripts/replays/extract.ts)', { timeout: 240_000 }, () => {
  it('loadReplays reads .faereplay files and zip exports, recursively, skipping junk', async () => {
    const bytes = await encodeReplay(fixture());
    fs.mkdirSync(path.join(tmp, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a/b/one.faereplay'), bytes);
    fs.writeFileSync(path.join(tmp, 'a/export.zip'), zip([{ name: 'two.faereplay', data: bytes }]));
    fs.writeFileSync(path.join(tmp, 'a/broken.faereplay'), new Uint8Array([1, 2, 3]));
    fs.writeFileSync(path.join(tmp, 'a/notes.txt'), 'hi');
    const got = await loadReplays(path.join(tmp, 'a'));
    expect(got.map((g) => path.basename(g.file)).sort()).toEqual(['export.zip#two.faereplay', 'one.faereplay']);
    expect(got[0].replay.header.id).toBe('fixture');
  });

  it('extractStats: purchases, builds, bridge, seals, engagement, strafing/ADS, outcome', () => {
    const s = extractStats([{ file: 'f', replay: fixture() }]);
    expect(s.humans).toHaveLength(1);
    const h = s.humans[0];
    expect(h.purchases.map((p) => p.item)).toEqual(['wood', 'smg']);
    expect(h.purchases[0].t).toBe(2);
    expect(h.builds.map((b) => b.kind)).toEqual(['wood', 'wood', 'metal']);
    expect(h.builds[0].bridge).toBe(true);
    expect(h.firstBridge).toEqual({ t: 4, toward: 1 });
    expect(h.seals).toEqual({ attempts: 1, successes: 1, times: [340 / 30] });
    expect(h.engagement.hits).toBe(2);
    expect(h.engagement.buckets).toEqual([0, 0, 1, 0, 1, 0]);
    expect(h.engagement.meanDist).toBe(28.5);
    expect(h.place).toBe(1);
    expect(h.won).toBe(true);
    expect(h.kills).toBe(1);
    expect(h.movement!.ticks).toBe(450);
    expect(h.movement!.strafeInCombat).toBeGreaterThan(0.9);
    expect(h.movement!.strafeFlipsPerMin).toBeGreaterThan(30);
    expect(h.movement!.adsWhenFiring).toBe(1);
    expect(h.movement!.jumpsPerMin).toBeCloseTo(1 / (450 / 30 / 60));
    const b = s.bots[0];
    expect(b.place).toBe(2);
    expect(b.survived).toBeCloseTo(410 / 30);
    expect(b.movement).toBeNull();
    expect(s.human.purchaseOrder.wood).toEqual({ meanRank: 0, meanFirstT: 2, n: 1 });
    expect(s.human.sealSuccessRate).toBe(1);
    expect(s.human.winRate).toBe(1);
  });

  it('mineScenarios: the bot-lost-to-human situations with the state before and what the human did', () => {
    const sc = mineScenarios([{ file: 'f', replay: fixture() }], { killLookback: 1, sealLookback: 2 });
    expect(sc.map((x) => [x.kind, x.startTick, x.eventTick, x.human, x.bot])).toEqual([['seal', 280, 340, 1, 2], ['kill', 380, 410, 1, 2]]);
    const kill = sc[1];
    expect(kill.state?.tick).toBe(360);
    expect(kill.humanDid.events.map((e) => e[1])).toEqual(['hit', 'hit', 'hit', 'kill']);
    expect(kill.humanDid.inputs!.ticks).toBe(31);
    expect(kill.humanDid.inputs!.ads).toBeCloseTo(21 / 31); // sights up from tick 390
  });

  it('self-play recordings feed the same pipeline, and matchFromReplay starts a match from a mined tick', async () => {
    const setup = { players: [1, 2, 3].map((i) => ({ name: `Bot (pro) ${i}`, isBot: true, difficulty: 'pro' as const })) };
    const r = await recordHeadlessMatch(setup, 5, 600);
    const file = writeReplay(path.join(tmp, 'selfplay'), r.bytes, r.header);
    expect(fs.existsSync(file)).toBe(true);
    const loaded = await loadReplays(path.join(tmp, 'selfplay'));
    const s = extractStats(loaded);
    expect(s.humans).toHaveLength(0);
    expect(s.bots).toHaveLength(3);
    expect(s.bots.some((b) => b.purchases.length > 0)).toBe(true);
    const made: number[] = [];
    const m = await matchFromReplay(loaded[0].replay, 450, (id, d, rng) => { made.push(id); return new Bot(id, d, rng); });
    expect(made.sort()).toEqual([1, 2, 3]);
    const snap = m.tick(new Map());
    expect(snap.tick).toBe(451);
    m.dispose();
  });
});
