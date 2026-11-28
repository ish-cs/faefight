import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { DEFAULT_BOT_PARAMS, STRENGTH, withParams } from '../../src/sim/bots/params';
import { nextPurchase, type Needs } from '../../src/sim/bots/plans';
import { Match } from '../../src/sim/match';
import { mulberry32 } from '../../src/sim/rng';
import { newPlayer } from '../../src/sim/player';
import type { Difficulty, Snapshot } from '../../src/sim/types';

// Strength vs a strong human (user replay 8a2134): rifle at range, bank before risky trips, endgame seal pressure,
// focus on the kill leader. Unit checks on the knobs (Ctx stubs: only what each helper reads), then a short series.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private helpers stubbed per test
type B = Record<string, any>;
const bot = (d: Difficulty, P = DEFAULT_BOT_PARAMS) => new Bot(1, d, mulberry32(1), undefined, P) as unknown as B;
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
    expect(bot('pro').wantsRifle(ctx(STRENGTH.rifleAt.pro))).toBe(true);
    expect(bot('hard').wantsRifle(ctx(STRENGTH.rifleAt.hard - 1))).toBe(false);
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
    expect(b('hard').bankAway(ctx())).toBeCloseTo(2 * STRENGTH.bankAway.hard - 60 / 200);
    expect(b('hard').bankAway(ctx({ cash: STRENGTH.richCarry }))).toBeCloseTo(STRENGTH.bankAway.hard - 60 / 200);
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
    expect(bot('pro').endgameSeal(c(2))).toBe(STRENGTH.endgameSeal.pro);
    expect(bot('hard').endgameSeal(c(STRENGTH.endgameLeft))).toBe(STRENGTH.endgameSeal.hard);
    expect(bot('hard').endgameSeal(c(STRENGTH.endgameLeft + 1))).toBe(0);
    expect(bot('hard').endgameSeal(c(2, true))).toBe(0);
    expect(bot('easy').endgameSeal(c(2))).toBe(0);
  });
  test('endgameKit: the shop trip for plugs in the endgame while short of a kit', () => {
    const c = (kit: number) => ({ view: { suddenDeath: false, others: others(1), sealed: [false, false] }, rivalIsl: { index: 1 }, openDoors: [{}, {}], me: { inv: { pieces: { metal: kit } } } }) as never;
    expect(bot('pro').endgameKit(c(0), ['metal'])).toBeCloseTo(0.55 + STRENGTH.endgameSeal.pro);
    expect(bot('pro').endgameKit(c(0), ['medkit'])).toBe(0);
    expect(bot('pro').endgameKit(c(2), ['metal'])).toBe(0);
  });
  test('leaderFocus: the clear kill leader (2+ kills, more than mine)', () => {
    const view = (kills: number[], mine = 0) => ({ self: { kills: mine }, others: others(7, kills) }) as never;
    expect(bot('pro').leaderFocusId(view([5, 1, 2]), 2)).toBe(STRENGTH.leaderFocus.pro);
    expect(bot('pro').leaderFocusId(view([5, 1, 2]), 3)).toBe(0);
    expect(bot('pro').leaderFocusId(view([1, 1]), 2)).toBe(0);
    expect(bot('pro').leaderFocusId(view([5], 6), 2)).toBe(0);
    expect(bot('easy').leaderFocusId(view([5]), 2)).toBe(0);
  });
});

describe('strength in play', () => {
  // Main: Hard/PRO bought a rifle only with a Sniper personality (range > 0.75); the SMG was the end of the line.
  test('Hard/PRO pick up a rifle by 5:00 in most games (rifleAt, rifle slot kept free)', async () => {
    const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy'];
    const lines: string[] = [];
    let armed = 0, seats = 0;
    for (const seed of [1, 2, 3]) {
      const rifleAt: (number | null)[] = diffs.map(() => null);
      const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
      let snap: Snapshot = m.tick(new Map());
      for (let i = 0; i < 5 * 60 * 30 && snap.winner === null; i++) {
        snap = m.tick(new Map());
        for (const p of snap.players) if (p.inv.weapons.rifle && rifleAt[p.id - 1] === null) rifleAt[p.id - 1] = Math.round(snap.time);
      }
      m.dispose();
      lines.push(`seed ${seed}: first rifle (s) ${JSON.stringify(rifleAt)}`);
      seats += 2; armed += (rifleAt[0] !== null ? 1 : 0) + (rifleAt[1] !== null ? 1 : 0);
    }
    console.log(lines.join('\n'));
    expect(armed, lines.join('; ')).toBeGreaterThanOrEqual(Math.ceil(seats * 2 / 3));
  }, 600_000);
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
