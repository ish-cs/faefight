import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { DEFAULT_BOT_PARAMS, STRENGTH, withParams } from '../../src/sim/bots/params';
import { nextPurchase, type Needs } from '../../src/sim/bots/plans';
import { WEAPONS } from '../../src/sim/constants';
import { eyePos } from '../../src/sim/combat';
import * as dm from '../../src/sim/dmath';
import { Match } from '../../src/sim/match';
import { mulberry32 } from '../../src/sim/rng';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type Difficulty, type PlayerInput, type PlayerState, type Snapshot } from '../../src/sim/types';
import { dist2D, v3 as vec3, yawOf } from '../../src/sim/vec';

// Strength vs a strong human (user replay 8a2134): rifle at range, bank before risky trips, endgame seal pressure,
// focus on the kill leader. Unit checks on the knobs (Ctx stubs: only what each helper reads), then a short series.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private helpers stubbed per test
type B = Record<string, any>;
// Only `outranged` is on by default since the 2026-11-27 knob A/B; the others are off but tunable. ON = every knob at
// the values the A/B tried, so these checks keep covering the code paths the ES trainer can switch on.
const ON = withParams({
  'strength.rifleAt.hard': 300, 'strength.rifleAt.pro': 300, 'strength.bankAway.hard': 0.8, 'strength.bankAway.pro': 0.85,
  'strength.endgameSeal.hard': 0.45, 'strength.endgameSeal.pro': 0.6, 'strength.leaderFocus.hard': 0.35, 'strength.leaderFocus.pro': 0.5,
});
const bot = (d: Difficulty, P: typeof DEFAULT_BOT_PARAMS = ON) => new Bot(1, d, mulberry32(1), undefined, P) as unknown as B;
const v3 = (x: number, z: number) => ({ x, y: 2, z });

describe('strength.rifleAt / outranged: the rifle comes early', () => {
  const needs: Needs = { scaffolds: 4, kit: 3, charge: false };
  const player = (cash: number) => {
    const p = newPlayer(1, 'b', true, 0, v3(0, 0), cash);
    p.inv.weapons = { pistol: { mag: 12, spare: 36 } } as typeof p.inv.weapons;
    p.hotbar[0] = 'pistol';
    p.equipped = 'pistol';
    return p;
  };
  test('with needs.rifle the rifle is bought before bridging gear; without it the decks come first', () => {
    expect(nextPurchase(player(500), { ...needs, rifle: true }, 'hard')).toBe('rifle');
    expect(nextPurchase(player(500), needs, 'hard')).toBe('scaffold');
    // Never saved up for: short of its price, the plan goes on to the decks.
    expect(nextPurchase(player(200), { ...needs, rifle: true }, 'hard')).toBe('scaffold');
  });
  test('wantsRifle: rich Hard/PRO (rifleAt), anyone out-ranged lately with its price; never with a rifle already', () => {
    const ctx = (cash: number, rifle = false, now = 100) => ({
      me: { inv: { cash, weapons: rifle ? { rifle: { mag: 25, spare: 50 } } : { pistol: { mag: 12, spare: 0 } } }, vault: { cash: 0 } },
      view: { now },
    }) as never;
    expect(bot('pro').wantsRifle(ctx(ON.strength.rifleAt.pro))).toBe(true);
    expect(bot('hard').wantsRifle(ctx(ON.strength.rifleAt.hard - 1))).toBe(false);
    expect(bot('medium').wantsRifle(ctx(5000))).toBe(false);
    expect(bot('pro').wantsRifle(ctx(5000, true))).toBe(false);
    // A rich-only rifle buyer (rifleAt above its price) still buys one once out-ranged.
    const b = bot('hard', withParams({ 'strength.rifleAt.hard': 900 }));
    expect(b.wantsRifle(ctx(320))).toBe(false);
    b.outranged = { id: 2, t: 90 };
    expect(b.wantsRifle(ctx(320))).toBe(true);
    expect(b.wantsRifle(ctx(320, false, 90 + STRENGTH.outrangedMemSec + 1))).toBe(false);
  });
  test('outrangedBy: a rifle that hit me lately from across the water, while my best gun is not a rifle', () => {
    const enemy = { id: 2, alive: true, pos: v3(45, 0) };
    const ctx = (o: { now?: number; rifle?: boolean; sd?: boolean } = {}) => ({
      me: { pos: v3(0, 0), inv: { weapons: o.rifle ? { rifle: { mag: 25, spare: 0 } } : { smg: { mag: 30, spare: 0 } } } },
      view: { now: o.now ?? 101, suddenDeath: o.sd ?? false, enemies: [enemy] },
    }) as never;
    const b = bot('pro');
    b.sameGround = () => false;
    expect(b.outrangedBy(ctx())).toBeNull();
    b.outranged = { id: 2, t: 100 };
    expect(b.outrangedBy(ctx())).toBe(enemy);
    expect(b.outrangedBy(ctx({ now: 100 + STRENGTH.outrangedSec + 0.1 }))).toBeNull();
    expect(b.outrangedBy(ctx({ rifle: true }))).toBeNull();
    expect(b.outrangedBy(ctx({ sd: true }))).toBeNull();
    // On the same ground I close in instead (the fight step rushes the gap).
    b.sameGround = () => true;
    expect(b.outrangedBy(ctx())).toBeNull();
  });
});

describe('strength.bankAway: rich away from home, walk home and bank', () => {
  const ctx = (o: { cash?: number; enemyDist?: number; homeReach?: boolean } = {}) => ({
    me: { pos: v3(0, 0), inv: { cash: o.cash ?? 2600 } },
    home: { vault: v3(60, 0) },
    view: { suddenDeath: false, now: 500 },
    homeReach: o.homeReach ?? true,
    enemy: o.enemyDist === undefined ? null : {}, enemyDist: o.enemyDist ?? Infinity,
  }) as never;
  const b = (d: Difficulty) => { const x = bot(d); x.stormPrep = () => false; x.trapped = () => false; return x; };
  test('scores by tier minus the walk; nothing for little cash, an enemy close, no walk home, or Easy/Medium', () => {
    expect(b('hard').bankAway(ctx())).toBeCloseTo(2 * ON.strength.bankAway.hard - 60 / 200);
    expect(b('hard').bankAway(ctx({ cash: STRENGTH.richCarry }))).toBeCloseTo(ON.strength.bankAway.hard - 60 / 200);
    expect(b('pro').bankAway(ctx({ cash: STRENGTH.richCarry - 1 }))).toBe(0);
    expect(b('pro').bankAway(ctx({ enemyDist: 12 }))).toBe(0);
    expect(b('pro').bankAway(ctx({ homeReach: false }))).toBe(0);
    expect(b('medium').bankAway(ctx())).toBe(0);
  });
});

describe('strength.endgameSeal / leaderFocus', () => {
  const others = (n: number, kills: number[] = []) => Array.from({ length: 7 }, (_, i) => ({ id: i + 2, eliminated: i >= n, kills: kills[i] ?? 0 }));
  test('endgameSeal: only with endgameLeft players or fewer still in, never in sudden death', () => {
    const c = (left: number, sd = false) => ({ view: { suddenDeath: sd, others: others(left - 1) } }) as never;
    expect(bot('pro').endgameSeal(c(2))).toBe(ON.strength.endgameSeal.pro);
    expect(bot('hard').endgameSeal(c(STRENGTH.endgameLeft))).toBe(ON.strength.endgameSeal.hard);
    expect(bot('hard').endgameSeal(c(STRENGTH.endgameLeft + 1))).toBe(0);
    expect(bot('hard').endgameSeal(c(2, true))).toBe(0);
    expect(bot('easy').endgameSeal(c(2))).toBe(0);
  });
  test('endgameKit: the shop trip for plugs in the endgame while short of a kit', () => {
    const c = (kit: number) => ({ view: { suddenDeath: false, others: others(1), sealed: [false, false] }, rivalIsl: { index: 1 }, openDoors: [{}, {}], me: { inv: { pieces: { metal: kit } } } }) as never;
    expect(bot('pro').endgameKit(c(0), ['metal'])).toBeCloseTo(0.55 + ON.strength.endgameSeal.pro);
    expect(bot('pro').endgameKit(c(0), ['medkit'])).toBe(0);
    expect(bot('pro').endgameKit(c(2), ['metal'])).toBe(0);
  });
  test('leaderFocus: the clear kill leader (2+ kills, more than mine)', () => {
    const view = (kills: number[], mine = 0) => ({ self: { kills: mine }, others: others(7, kills) }) as never;
    expect(bot('pro').leaderFocusId(view([5, 1, 2]), 2)).toBe(ON.strength.leaderFocus.pro);
    expect(bot('pro').leaderFocusId(view([5, 1, 2]), 3)).toBe(0);
    expect(bot('pro').leaderFocusId(view([1, 1]), 2)).toBe(0);
    expect(bot('pro').leaderFocusId(view([5], 6), 2)).toBe(0);
    expect(bot('easy').leaderFocusId(view([5]), 2)).toBe(0);
  });
});

describe('strength in play', () => {
  // strength.outranged (on by default for Hard/PRO), played out in one fixed setup, no seed lottery. A scripted human
  // rifleman (id 2) on the next island taps at a bot (id 1, SMG + pistol) ~68 m away across the water, past SMG range,
  // one aimed shot a second while it can see it. The bot breaks off (disengage), sprints away to the lee of its bunker
  // and is out of sight in ~4.4 s (main 979bb0c8); handed a rifle's price, it buys one ~10-15 s later. With the knob
  // off (control) it walks on toward the shore and the shop and keeps its cash for other things.
  // Replaces "rifleAt on: Hard/PRO hold a rifle by 5:00 in 2/3 of seats over seeds 1-3", which measured seed luck
  // (4/6 on main, 7/16 over seeds 1-8) for a knob that is off by default.
  const BOT_X = -44, SHOOTER_X = 26, HITS = 4;
  async function outrangedRun(d: Difficulty, P: typeof DEFAULT_BOT_PARAMS = DEFAULT_BOT_PARAMS) {
    let bot: Bot | null = null;
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: d }, { name: 'rifle', isBot: false }], seed: 5 },
      { makeBot: (id, dd, rng) => (bot = new Bot(id, dd, rng, undefined, P)) });
    const sees = (m as unknown as { botView(p: PlayerState): { enemies: PlayerState[] } });
    const players = (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players;
    const me = players.get(1)!, rifleman = players.get(2)!;
    let snap: Snapshot = m.tick(new Map());
    m.debugTeleport(1, vec3(BOT_X, m.map[0].groundY + 0.05, 0));
    m.debugTeleport(2, vec3(SHOOTER_X, m.map[1].groundY + 0.05, 0));
    m.debugGive(1, { weapons: { smg: { mag: WEAPONS.smg.mag, spare: 60 } } });
    m.debugSetGenerator(0, 0);
    m.debugGive(2, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 50 } } });
    const inSight = () => sees.botView(rifleman).enemies.some((e) => e.id === 1);
    const aim = (fire: boolean): Map<number, PlayerInput> => {
      const eye = eyePos(rifleman), chest = vec3(me.pos.x, me.pos.y + 1.2, me.pos.z);
      const dx = chest.x - eye.x, dz = chest.z - eye.z;
      return new Map([[2, { ...NO_INPUT, slot: 'rifle', ads: true, fire, yaw: yawOf({ x: dx, z: dz }), pitch: dm.atan2(chest.y - eye.y, Math.hypot(dx, dz)) }]]);
    };
    for (let i = 0; i < 15; i++) snap = m.tick(aim(false)); // land, draw the rifle, settle the sights
    const seenAtStart = inSight(), dist0 = dist2D(me.pos, rifleman.pos);
    // Phase 1: one aimed tap a second while the bot is in sight, HITS hits at most (it lives): until it is out of sight.
    let hits = 0, firstHit = -1, hidden = -1, distHidden = -1, disengaged = false, hp = me.hp + me.shield;
    for (let i = 0; i < 12 * 30 && hidden < 0; i++) {
      snap = m.tick(aim(hits < HITS && i % 30 === 0 && inSight()));
      const now = me.hp + me.shield;
      if (now < hp) { hits++; if (firstHit < 0) firstHit = snap.time; }
      hp = now;
      if (firstHit >= 0 && bot!.currentGoal === 'disengage') disengaged = true;
      if (firstHit >= 0 && !inSight()) { hidden = snap.time; distHidden = dist2D(me.pos, rifleman.pos); }
    }
    // Phase 2: hold fire; give the bot a rifle's price and let it shop (outranged lately: the rifle is first, and urgent).
    m.debugGive(1, { cash: WEAPONS.rifle.price + 50 });
    let rifleAt = -1;
    const t2 = snap.time;
    for (let i = 0; i < 45 * 30 && rifleAt < 0; i++) {
      snap = m.tick(aim(false));
      if (me.inv.weapons.rifle) rifleAt = snap.time - t2;
    }
    const r = { seenAtStart, dist0, distHidden, hits, alive: me.alive, disengaged, hideSec: hidden < 0 ? -1 : hidden - firstHit, rifleAt };
    m.dispose();
    return r;
  }
  for (const d of ['hard', 'pro'] as Difficulty[]) {
    test(`${d}: hit by a rifle from across the water past SMG range → out of its sight in seconds; with the cash → buys a rifle`, async () => {
      const r = await outrangedRun(d);
      console.log(d, JSON.stringify(r));
      expect(r.seenAtStart).toBe(true);
      expect(r.dist0).toBeGreaterThan(WEAPONS.smg.range);
      expect(r.hits).toBeGreaterThan(0);
      expect(r.alive).toBe(true);
      expect(r.disengaged).toBe(true);
      expect(r.hideSec).toBeGreaterThanOrEqual(0);
      expect(r.hideSec).toBeLessThan(6);
      expect(r.distHidden).toBeGreaterThan(r.dist0 + 5); // away from the shooter (behind its bunker), not up to the shore
      expect(r.rifleAt).toBeGreaterThanOrEqual(0);
      expect(r.rifleAt).toBeLessThan(30);
    }, 60_000);
  }
  test('control: with strength.outranged off the same bot keeps its cash for other things (no rifle)', async () => {
    const r = await outrangedRun('pro', withParams({ 'strength.outranged.pro': 0 }));
    console.log('control', JSON.stringify(r));
    expect(r.hits).toBeGreaterThan(0);
    expect(r.rifleAt).toBe(-1);
  }, 60_000);
});

describe('belief.ts: per-enemy beliefs from the view only', () => {
  test('a rifle seen in their hands and hitting me from 45 m makes them a rifle user; an SMG at 20 m does not', async () => {
    const { Beliefs } = await import('../../src/sim/bots/belief');
    const b = new Beliefs();
    const view = (now: number, hurt: { t: number; by: number; amount: number }[], gun: string, x: number) => ({
      now, self: { id: 1, pos: v3(0, 0) }, others: [{ id: 2, kills: 3 }],
      enemies: [{ id: 2, pos: v3(x, 0), equipped: gun }], hurt,
    }) as never;
    b.update(view(1, [{ t: 1, by: 2, amount: 22 }], 'rifle', 45));
    b.update(view(2, [{ t: 1, by: 2, amount: 22 }, { t: 2, by: 2, amount: 22 }], 'rifle', 45));
    const e = b.of.get(2)!;
    expect(e.dmgToMe).toBe(44);
    expect(e.engageDist).toBeCloseTo(45);
    expect(e.kills).toBe(3);
    expect(b.rifleUser(30)?.id).toBe(2);
    const c = new Beliefs();
    c.update(view(1, [{ t: 1, by: 2, amount: 12 }], 'smg', 20));
    expect(c.rifleUser(30)).toBeNull();
  });
});
