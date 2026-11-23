import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { debugBrain } from '../../src/sim/bots/introspect';
import { rivalScore, spoilsBonus, type RivalFacts } from '../../src/sim/bots/mind';
import { DEFAULT_BOT_PARAMS, PARAM_RANGES } from '../../src/sim/bots/params';
import { preset } from '../../src/sim/bots/personality';
import type { BotView, OtherStatus } from '../../src/sim/bots/view';
import { PIECES, WEAPONS } from '../../src/sim/constants';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PieceState, PlayerState } from '../../src/sim/types';
import { lane, laneAt } from '../../src/sim/bots/nav';
import { add, forward, scale, v3, yawOf } from '../../src/sim/vec';

// Spoils of war in the bots' rival choice: hunt rich sealed players, finish trapped ones.
const map = buildMap(4);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const status = (id: number, island: number, over: Partial<OtherStatus> = {}): OtherStatus =>
  ({ id, island, alive: true, eliminated: false, respawnAt: null, kills: 0, ...over });

function self(): PlayerState {
  const isl = map[0];
  const p = add(isl.center, scale(forward(isl.bunker.facingYaw), 6));
  const me = newPlayer(0, 'me', true, 0, v3(p.x, isl.groundY, p.z));
  me.inv.cash = 0;
  me.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: 36 };
  me.equipped = 'pistol';
  return me;
}

/** A finished scaffold bridge along the lane from island a to b (both rivals reachable). */
function bridge(a: number, b: number): PieceState[] {
  const l = lane(map, a, b);
  const out: PieceState[] = [];
  for (let s = 18; s < l.length - 16; s += 3.8) {
    const p = laneAt(l, s);
    out.push({ id: 500 + a * 100 + b * 10 + out.length, kind: 'scaffold', owner: 0, pos: v3(p.x, map[a].groundY - PIECES.scaffold.h, p.z), rotY: yawOf(l.dir), hp: 200 });
  }
  return out;
}
const PIECES_ON = [...bridge(0, 1), ...bridge(0, 2)];

function onPieces(x: number, z: number): number | null {
  let top: number | null = null;
  for (const p of PIECES_ON) {
    const sz = PIECES[p.kind];
    const dx = x - p.pos.x, dz = z - p.pos.z, c = Math.cos(-p.rotY), sn = Math.sin(-p.rotY);
    const lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
    if (Math.abs(lx) <= sz.w / 2 && Math.abs(lz) <= sz.d / 2) top = Math.max(top ?? -Infinity, p.pos.y + sz.h);
  }
  return top;
}

function view(me: PlayerState, others: OtherStatus[], sealed: boolean[]): BotView {
  return {
    now: 100, self: me, enemies: [], others, map, pieces: PIECES_ON, generators: [0, 0, 0, 0], sealed, hurt: [], shots: [], feed: [], loot: [],
    waterY: 0, suddenDeath: false,
    groundAt: (x, z) => onPieces(x, z) ?? (map.some((i) => Math.hypot(x - i.center.x, z - i.center.z) <= i.radius) ? map[0].groundY : null),
    canPlace: () => ({ ok: false, reason: 'test' }),
  };
}

/** The rival a fresh PRO bot picks (it scores rivals on its first think). */
function pick(others: OtherStatus[], sealed: boolean[]): { id: number | null; bot: Bot } {
  const bot = new Bot(0, 'pro', mulberry32(3), preset('Vulture'));
  bot.watch(true);
  bot.think(view(self(), others, sealed));
  return { id: bot.currentTarget, bot };
}

const facts = (over: Partial<RivalFacts>): RivalFacts => ({
  id: 1, reach: true, scaffolds: 0, dist: 60, respawning: false, sinceDeath: Infinity, sealed: false, seenHp: null, grudge: 0,
  busy: false, kills: 0, leaderKills: 0, onMyIsland: false, away: false, ...over,
});

describe('spoils of war in rival choice', () => {
  const W = { perK: DEFAULT_BOT_PARAMS.drive.spoilsTarget, trapped: DEFAULT_BOT_PARAMS.drive.finishTrapped };

  test('the knobs are trainable (PARAM_RANGES)', () => {
    const keys = Object.keys(PARAM_RANGES);
    expect(keys).toContain('drive.spoilsTarget');
    expect(keys).toContain('drive.finishTrapped');
  });

  test('bounty only counts when their death would eliminate them (sealed or trapped); trapped in reach adds the finish', () => {
    expect(spoilsBonus(facts({ bounty: 1000 }), W)).toBe(0);
    expect(spoilsBonus(facts({ sealed: true, bounty: 1000 }), W)).toBeCloseTo(W.perK);
    expect(spoilsBonus(facts({ sealed: true, bounty: 9000 }), W)).toBeCloseTo(W.perK * 1.5);
    expect(spoilsBonus(facts({ sealed: true, trapped: true, bounty: 0 }), W)).toBeCloseTo(W.trapped);
    expect(spoilsBonus(facts({ sealed: true, trapped: true, reach: false, scaffolds: 4 }), W)).toBe(0);
    const t = preset('Vulture');
    expect(rivalScore(facts({ sealed: true, bounty: 1200 }), t.traits, 0.6, W)).toBeGreaterThan(rivalScore(facts({ sealed: true }), t.traits, 0.6, W));
  });

  test('two sealed rivals: goes after the rich one, even farther away; equal bounties → the nearer one', () => {
    const me = self();
    const d = (i: number) => Math.hypot(map[i].center.x - me.pos.x, map[i].center.z - me.pos.z);
    const [a, b] = d(1) < d(2) ? [1, 2] : [2, 1];
    const sealed = [false, true, true, false];
    const plain = pick([status(1, 1), status(2, 2), status(3, 3, { eliminated: true })], sealed);
    expect(plain.id).toBe(a);
    const rich = pick([status(1, 1, { bounty: b === 1 ? 1500 : 0 }), status(2, 2, { bounty: b === 2 ? 1500 : 0 }), status(3, 3, { eliminated: true })], sealed);
    expect(rich.id).toBe(b);
    // Spectator brain panel says why.
    expect(debugBrain(rich.bot).target?.why).toContain('spoils $1500');
  });

  test('a rival trapped mid-breakout gets finished over a nearer sealed one', () => {
    const me = self();
    const d = (i: number) => Math.hypot(map[i].center.x - me.pos.x, map[i].center.z - me.pos.z);
    const [a, b] = d(1) < d(2) ? [1, 2] : [2, 1];
    const sealed = [false, true, true, false];
    const r = pick([status(a, a), status(b, b, { trapped: true }), status(3, 3, { eliminated: true })], sealed);
    expect(r.id).toBe(b);
    expect(debugBrain(r.bot).target?.why).toContain('trapped');
  });
});
