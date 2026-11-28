import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { debugBrain } from '../../src/sim/bots/introspect';
import { DEFAULT_BOT_PARAMS, DISCIPLINE, PARAM_RANGES, PRE_DISCIPLINE_PARAMS, type BotParams } from '../../src/sim/bots/params';
import { preset } from '../../src/sim/bots/personality';
import { nextPurchase, PLAIN_STYLE, shoppingPlan } from '../../src/sim/bots/plans';
import type { BotView, OtherStatus } from '../../src/sim/bots/view';
import { lane, laneAt } from '../../src/sim/bots/nav';
import { MAP, PIECES, WEAPONS } from '../../src/sim/constants';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PieceKind, PieceState, PlayerState } from '../../src/sim/types';
import { add, forward, scale, v3, yawOf } from '../../src/sim/vec';

/**
 * Discipline fixes from the PRO match analysis (2026-11-27; seed 1, 1 PRO + 7 Hard on harbor, re-simulated exactly):
 * it lived ~8 min with plugged doorways, re-sealed a rival while its own bunker was sealed and was eliminated holding
 * $7,923. Hand-made views (no physics): each case is a decision the PRO got wrong, checked with the discipline knobs on
 * (defaults) and off (PRE_DISCIPLINE_PARAMS, the old brain), so each test fails on the old code.
 */
const map = buildMap(4);
const HOME = 0, RIVAL = 1;

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

let nextId = 1000;
/** A finished scaffold bridge from island a to b. */
function bridge(a: number, b: number): PieceState[] {
  const l = lane(map, a, b);
  const out: PieceState[] = [];
  for (let s = 18; s < l.length - 16; s += 3.8) {
    const p = laneAt(l, s);
    out.push({ id: nextId++, kind: 'scaffold', owner: 0, pos: v3(p.x, map[a].groundY - PIECES.scaffold.h, p.z), rotY: yawOf(l.dir), hp: 200 });
  }
  return out;
}

/** A plug of `kind` just outside each listed doorway of `island`'s bunker (owner 9: a rival). */
function plugs(island: number, doors: number[], kind: PieceKind): PieceState[] {
  return doors.map((i) => {
    const d = map[island].bunker.doorways[i];
    const out = forward(d.yaw), off = MAP.bunker.wall / 2 + PIECES[kind].d / 2 + 0.05;
    return { id: nextId++, kind, owner: 9, pos: v3(d.center.x + out.x * off, d.center.y - 0.01, d.center.z + out.z * off), rotY: d.yaw, hp: PIECES[kind].hp };
  });
}

const status = (id: number, island: number, over: Partial<OtherStatus> = {}): OtherStatus =>
  ({ id, island, alive: true, eliminated: false, respawnAt: null, kills: 0, ...over });

/** Me (id 0, home island 0), armed with an SMG, standing `where`. */
function me(where: 'home' | 'rival', inv: Partial<PlayerState['inv']> = {}): PlayerState {
  const isl = map[where === 'home' ? HOME : RIVAL];
  const p = where === 'home' ? add(isl.center, scale(forward(isl.bunker.facingYaw), 9))
    : add(isl.bunker.doorways[0].center, scale(forward(isl.bunker.doorways[0].yaw), 7));
  const pl = newPlayer(0, 'me', true, HOME, v3(p.x, isl.groundY, p.z));
  pl.inv.weapons.smg = { mag: WEAPONS.smg.mag, spare: 90 };
  pl.hotbar[1] = 'smg';
  pl.equipped = 'smg';
  Object.assign(pl.inv, inv);
  for (const k of Object.keys(inv.pieces ?? {}) as PieceKind[]) if (!pl.hotbar.includes(k)) pl.hotbar[pl.hotbar.indexOf(null)] = k;
  return pl;
}

function view(self: PlayerState, pieces: PieceState[], sealed: boolean[], others: OtherStatus[], now = 400): BotView {
  const onPieces = (x: number, z: number): number | null => {
    let top: number | null = null;
    for (const p of pieces) {
      const sz = PIECES[p.kind];
      const dx = x - p.pos.x, dz = z - p.pos.z, c = Math.cos(-p.rotY), sn = Math.sin(-p.rotY);
      const lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
      if (Math.abs(lx) <= sz.w / 2 && Math.abs(lz) <= sz.d / 2) top = Math.max(top ?? -Infinity, p.pos.y + sz.h);
    }
    return top;
  };
  return {
    now, self, enemies: [], others, map, pieces, generators: [0, 0, 0, 0], sealed, hurt: [], shots: [], feed: [], loot: [],
    waterY: 0, suddenDeath: false,
    groundAt: (x, z) => (map.some((i) => Math.hypot(x - i.center.x, z - i.center.z) <= i.radius) ? map[0].groundY : onPieces(x, z)),
    canPlace: () => ({ ok: false, reason: 'test' }),
  };
}

/** The goal a fresh PRO picks on its first think, with these params. */
function decide(v: BotView, P: BotParams = DEFAULT_BOT_PARAMS, d: 'pro' | 'hard' = 'pro'): { goal: string; bot: Bot } {
  const bot = new Bot(0, d, mulberry32(7), preset('Vulture'), P);
  bot.watch(true);
  bot.think(v);
  return { goal: bot.currentGoal, bot };
}

const OTHERS = [status(1, RIVAL), status(2, 2, { eliminated: true }), status(3, 3, { eliminated: true })];

describe('discipline knobs: tunable, on for Hard/PRO, off = the old brain', () => {
  test('every knob has a search box and the defaults lie inside', () => {
    for (const k of ['homeFirst.pro', 'debtCap', 'debtDefend', 'debtSec.pro', 'chargeShop.pro', 'bankTripAt', 'bankRisk.pro', 'sticky.pro', 'commitSec.pro',
      'commitBonus', 'sealAbortSec.pro', 'cheapKit.pro', 'kitShop.pro']) expect(PARAM_RANGES[`discipline.${k}`]).toBeDefined();
    expect(DISCIPLINE.homeFirst.easy).toBe(0);
    expect(DISCIPLINE.homeFirst.pro).toBe(1);
  });
});

describe('1. sealed home is a hard override', () => {
  // The fatal minute: home sealed by metal, a charge in my pocket, a full kit, standing at a rival's open bunker.
  const pieces = () => [...bridge(HOME, RIVAL), ...plugs(HOME, [0, 1, 2], 'metal')];
  const inv = { charges: 1, cash: 300, pieces: { metal: 3 } };
  test('walks home to clear it instead of sealing the rival (old brain: seals)', () => {
    const sealed = [true, false, false, false];
    expect(decide(view(me('rival', inv), pieces(), sealed, OTHERS), PRE_DISCIPLINE_PARAMS).goal).toBe('seal');
    const { goal, bot } = decide(view(me('rival', inv), pieces(), sealed, OTHERS));
    expect(goal).toBe('defend');
    // Brain panel: the cap shows on the seal row.
    const seal = debugBrain(bot).scores.find((r) => r[0] === 'seal');
    expect(seal?.[3].some(([k]) => k.includes('sealed: clear it first'))).toBe(true);
  });
  test('an enemy within reach still gets fought (no cap with someone on top of me)', () => {
    const v = view(me('rival', inv), pieces(), [true, false, false, false], OTHERS);
    const foe = newPlayer(1, 'foe', true, RIVAL, add(v.self.pos, v3(4, 0, 0)));
    foe.inv.weapons.smg = { mag: 30, spare: 0 };
    foe.equipped = 'smg';
    v.enemies = [foe];
    expect(decide(v).goal).not.toBe('defend');
  });
});

describe('2. a plugged own doorway is a debt', () => {
  test('one metal plug, no charge, money: buys the charge (defend > 0; old brain: defend 0, goes out)', () => {
    const v = () => view(me('home', { cash: 400, pieces: { metal: 3 } }), [...bridge(HOME, RIVAL), ...plugs(HOME, [1], 'metal')], [false, false, false, false], OTHERS);
    const old = decide(v(), PRE_DISCIPLINE_PARAMS);
    expect(debugBrain(old.bot).scores.find((r) => r[0] === 'defend')?.[2] ?? 0).toBe(0);
    const { goal, bot } = decide(v());
    expect(goal).toBe('defend');
    expect(debugBrain(bot).why).toContain('buying a charge');
  });
  test('carrying a charge with a plug in a doorway: clears it before any offence (never leaves with it)', () => {
    const v = () => view(me('home', { charges: 1, cash: 100, pieces: { metal: 3 } }), [...bridge(HOME, RIVAL), ...plugs(HOME, [2], 'metal')], [false, false, false, false],
      [status(1, RIVAL, { alive: false, respawnAt: 405 }), status(2, 2, { eliminated: true }), status(3, 3, { eliminated: true })]);
    expect(decide(v(), PRE_DISCIPLINE_PARAMS).goal).not.toBe('defend');
    expect(decide(v()).goal).toBe('defend');
  });
  test('time box: no plug gone and no nearer home for debtSec lifts the cap (clear, then go), and it re-arms', () => {
    const lim = DISCIPLINE.debtSec.pro;
    const inv = { charges: 1, cash: 100, pieces: { metal: 3 } };
    const v = (now: number) => view(me('rival', inv), [...bridge(HOME, RIVAL), ...plugs(HOME, [0, 1, 2], 'metal')], [true, false, false, false], OTHERS, now);
    const { goal, bot } = decide(v(400));
    expect(goal).toBe('defend');
    bot.think(v(400 + lim - 5));
    expect(bot.currentGoal).toBe('defend');
    bot.think(v(400 + lim + 1));
    expect(bot.currentGoal).toBe(decide(v(400 + lim + 1), PRE_DISCIPLINE_PARAMS).goal); // the old brain's pick: 'seal'
    expect(bot.currentGoal).not.toBe('defend');
    bot.think(v(400 + 2 * lim + 3));
    expect(bot.currentGoal).toBe('defend');
  });
  test('camping a dead rival\'s respawn window with a kit: the kill/seal is not capped by my plugged doorway', () => {
    const v = view(me('rival', { charges: 1, cash: 100, pieces: { metal: 3 } }), [...bridge(HOME, RIVAL), ...plugs(HOME, [1], 'metal')], [false, false, false, false],
      [status(1, RIVAL, { alive: false, respawnAt: 406 }), status(2, 2, { eliminated: true }), status(3, 3, { eliminated: true })]);
    const { goal, bot } = decide(v);
    expect(bot.respawnWindow?.id).toBe(1);
    expect(['seal', 'attack']).toContain(goal);
  });
});

describe('3. bank before risk', () => {
  test('rich, away, own doorway plugged and nothing to clear it with: walks home to bank (old brain: 0 off my island)', () => {
    // Wood plug, no gun to shoot it, no charge for sale (cash all carried; plan says ammo first): no debt to clear.
    const v = view(me('rival', { cash: 2500 }), [...bridge(HOME, RIVAL), ...plugs(HOME, [0], 'wood')], [false, false, false, false], OTHERS);
    const bank = (P: BotParams) => debugBrain(decide(v, P).bot).scores.find((r) => r[0] === 'bank')?.[2] ?? 0;
    expect(bank(PRE_DISCIPLINE_PARAMS)).toBe(0);
    expect(bank(DEFAULT_BOT_PARAMS)).toBeGreaterThan(0.6);
  });
  test('rich on my island: banks before heading out (after a due shop trip), unhalved by the push', () => {
    const self = me('home', { cash: 1500, pieces: { metal: 3, scaffold: 10 } });
    self.vault.cash = 300; // rebuy insurance already banked (its own 0.8 trip isn't what's tested)
    const v = view(self, bridge(HOME, RIVAL), [false, false, false, false], OTHERS);
    const bank = (P: BotParams) => debugBrain(decide(v, P).bot).scores.find((r) => r[0] === 'bank')?.[2] ?? 0;
    expect(bank(PRE_DISCIPLINE_PARAMS)).toBeLessThan(0.6);
    // A shop trip is due here (shop > 0): it shops first, then banks on the way out (botHeals: banking ahead of the
    // trip reshuffled it and a refilled ramp took the slot kept for the medkit).
    const { bot } = decide(v);
    type In = { context(v: BotView): unknown; score(g: string, c: unknown): number; bankRisk(c: unknown): number };
    const b = bot as unknown as In, c = b.context(v);
    expect(b.score('shop', c)).toBeGreaterThan(0);
    expect(b.bankRisk(c)).toBe(0);
    // Nothing to buy: banks before heading out, unhalved by the push.
    const score = b.score.bind(b);
    b.score = (g, cc) => (g === 'shop' ? 0 : score(g, cc));
    expect(b.bankRisk(c)).toBeCloseTo(DISCIPLINE.bankRisk.pro);
  });
});

describe('4. commitment and hysteresis (off by default since the mixed ×120 A/B; knobs kept for the trainer)', () => {
  const ON: BotParams = { ...DEFAULT_BOT_PARAMS, discipline: { ...DISCIPLINE, commitSec: { ...DISCIPLINE.commitSec, pro: 2 }, sealAbortSec: { ...DISCIPLINE.sealAbortSec, pro: 20 }, bridgeShort: { ...DISCIPLINE.bridgeShort, pro: 5 } } };
  test('defaults: off for every tier', () => {
    expect(DISCIPLINE.commitSec.pro).toBe(0);
    expect(DISCIPLINE.sealAbortSec.pro).toBe(0);
    expect(DISCIPLINE.bridgeShort.pro).toBe(Infinity);
  });
  type Inner = { goal: string; switchAt: number; goalBan: Map<string, number>; sealTry: unknown; sealWatch(c: unknown, now: number): void; P: BotParams };
  test('a seal attempt that closes no door and gets no nearer for sealAbortSec is dropped', () => {
    const b = new Bot(0, 'pro', mulberry32(1), preset('Vulture'), ON) as unknown as Inner;
    b.goal = 'seal';
    const c = { rival: { id: 1 }, rivalIsl: map[RIVAL], openDoors: [{}, {}, {}], me: { pos: add(map[RIVAL].bunker.center, v3(10, 0, 0)) } };
    for (let t = 0; t <= ON.discipline.sealAbortSec.pro + 0.5; t += 0.5) b.sealWatch(c, t);
    expect(b.goalBan.get('seal')).toBeGreaterThan(ON.discipline.sealAbortSec.pro);
    // Closing a doorway is progress: no ban.
    const b2 = new Bot(0, 'pro', mulberry32(1), preset('Vulture'), ON) as unknown as Inner;
    b2.goal = 'seal';
    for (let t = 0; t <= ON.discipline.sealAbortSec.pro + 0.5; t += 0.5) b2.sealWatch({ ...c, openDoors: t < 10 ? [{}, {}, {}] : [{}, {}] }, t);
    expect(b2.goalBan.get('seal')).toBeUndefined();
    // Old brain: never.
    const b3 = new Bot(0, 'pro', mulberry32(1), preset('Vulture'), PRE_DISCIPLINE_PARAMS) as unknown as Inner;
    b3.goal = 'seal';
    for (let t = 0; t <= 60; t += 0.5) b3.sealWatch(c, t);
    expect(b3.goalBan.get('seal')).toBeUndefined();
  });
  test('well short of decks with the shop selling them: buys first instead of laying a partial bridge', () => {
    const v = () => view(me('home', { cash: 400, pieces: { metal: 3, scaffold: 1 } }), [], [false, false, false, false], OTHERS);
    const bridgeBase = (P: BotParams) => debugBrain(decide(v(), P).bot).scores.find((r) => r[0] === 'bridge')?.[2] ?? 0;
    expect(bridgeBase(PRE_DISCIPLINE_PARAMS)).toBeGreaterThan(0);
    expect(bridgeBase(ON)).toBe(0);
    expect(bridgeBase(DEFAULT_BOT_PARAMS)).toBeGreaterThan(0);
  });
});

describe('5. seal kit before camping, cheapest working kit', () => {
  const hard = () => {
    const p = newPlayer(1, 'p', false, 0, v3());
    p.inv.weapons.smg = { mag: 30, spare: 90 };
    p.equipped = 'smg';
    return p;
  };
  const needs = (cheapKit: boolean) => ({ scaffolds: 0, kit: 3, charge: false, hardKit: 1, cheapKit });
  test('$100 for 3 doors: three wood plugs, not one metal and one wood (hardKit never blocks a seal)', () => {
    const p = hard(); p.inv.cash = 100;
    const old = shoppingPlan(p, needs(false), 'pro', PLAIN_STYLE).items.filter((i) => i === 'metal' || i === 'wood');
    expect(old.length).toBeLessThan(3);
    const now = shoppingPlan(p, needs(true), 'pro', PLAIN_STYLE).items.filter((i) => i === 'metal' || i === 'wood');
    expect(now).toEqual(['wood', 'wood', 'wood']);
  });
  test('enough for metal: still metal', () => {
    const p = hard(); p.inv.cash = 3 * PIECES.metal.price;
    expect(nextPurchase(p, needs(true), 'pro', PLAIN_STYLE)).toBe('metal');
  });
  test('camping a dead rival\'s door with no kit: goes and buys one', () => {
    const v = view(me('rival', { cash: 200 }), bridge(HOME, RIVAL), [false, false, false, false],
      [status(1, RIVAL, { alive: false, respawnAt: 406 }), status(2, 2, { eliminated: true }), status(3, 3, { eliminated: true })]);
    const shop = (P: BotParams) => debugBrain(decide(v, P).bot).scores.find((r) => r[0] === 'shop');
    expect(shop(DEFAULT_BOT_PARAMS)?.[3].some(([k]) => k === 'camping without a kit')).toBe(true);
    expect(shop(PRE_DISCIPLINE_PARAMS)?.[3].some(([k]) => k === 'camping without a kit') ?? false).toBe(false);
  });
});
