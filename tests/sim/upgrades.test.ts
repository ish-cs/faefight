import { describe, expect, test } from 'vitest';
import { GENERATOR_LEVELS, LOCK_PRICE_MULT, WEAPONS } from '../../src/sim/constants';
import { buy, grantLockedGuns, lockPrice, tickGenerator } from '../../src/sim/economy';
import { Match } from '../../src/sim/match';
import { nextPurchase, PLAIN_STYLE, shoppingPlan } from '../../src/sim/bots/plans';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type PlayerInput } from '../../src/sim/types';
import { add, forward, scale, v3 } from '../../src/sim/vec';

const player = (cash = 0, island = 0) => {
  const p = newPlayer(1, 'p', false, island, v3());
  p.inv.cash = cash;
  return p;
};
const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);

describe('generator upgrade', () => {
  test('levels, prices, rates and caps', () => {
    expect(GENERATOR_LEVELS.map((l) => [l.price, l.rate, l.cap])).toEqual([
      [0, 5, 500], [150, 8, 700], [400, 12, 1000], [900, 18, 1500],
    ]);
    expect(tickGenerator(0, 2, true, 1)).toBeCloseTo(10);
    expect(tickGenerator(0, 2, true, 2)).toBeCloseTo(16);
    expect(tickGenerator(0, 2, true, 3)).toBeCloseTo(24);
    expect(tickGenerator(0, 2, true, 4)).toBeCloseTo(36);
    expect(tickGenerator(699, 10, true, 2)).toBe(700);
    expect(tickGenerator(999, 10, true, 3)).toBe(1000);
    expect(tickGenerator(1499, 10, true, 4)).toBe(1500);
    expect(tickGenerator(499, 10, true)).toBe(500); // default level 1
  });

  test('buys the next level of your own island, charging its price', () => {
    const p = player(2000, 1);
    const levels = [1, 1];
    expect(buy(p, { buy: 'genUpgrade' }, levels)).toEqual({ ok: true });
    expect(levels).toEqual([1, 2]);
    expect(p.inv.cash).toBe(2000 - 150);
    buy(p, { buy: 'genUpgrade' }, levels);
    buy(p, { buy: 'genUpgrade' }, levels);
    expect(levels).toEqual([1, 4]);
    expect(p.inv.cash).toBe(2000 - 150 - 400 - 900);
  });

  test('max level rejects and charges nothing', () => {
    const p = player(5000);
    const levels = [4, 1];
    const r = buy(p, { buy: 'genUpgrade' }, levels);
    expect(r.ok).toBe(false);
    expect(levels).toEqual([4, 1]);
    expect(p.inv.cash).toBe(5000);
  });

  test('not enough cash rejects', () => {
    const p = player(149);
    const levels = [1];
    expect(buy(p, { buy: 'genUpgrade' }, levels).ok).toBe(false);
    expect(levels).toEqual([1]);
  });

  test('in a match: upgrade at home shop, survives death, faster accrual, enemy collects the bigger pile', async () => {
    const m = await Match.create(humans1v1);
    const yaw = m.map[0].bunker.facingYaw;
    m.debugGive(1, { cash: 1500 });
    m.debugTeleport(1, add(m.map[0].shop, scale(forward(yaw), 1.5)));
    let snap = m.tick(new Map());
    expect(snap.genLevels).toEqual([1, 1]);
    for (let i = 0; i < 3; i++) { snap = m.tick(inputs(1, { shop: { buy: 'genUpgrade' } })); m.tick(new Map()); }
    snap = m.tick(new Map());
    expect(snap.genLevels).toEqual([4, 1]);
    expect(snap.players[0].inv.cash).toBe(1550 - 1450);

    m.debugKill(1);
    for (let i = 0; i < 30 * 4; i++) snap = m.tick(new Map());
    expect(snap.players[0].alive).toBe(true);
    expect(snap.genLevels).toEqual([4, 1]);

    // Level 4 out-earns the level 1 enemy generator, and caps at 1500.
    const g0 = snap.generators.find((g) => g.island === 0)!, g1 = snap.generators.find((g) => g.island === 1)!;
    expect(g0.stored).toBeGreaterThan(g1.stored * 3);
    for (let i = 0; i < 30 * 100; i++) snap = m.tick(new Map());
    expect(snap.generators.find((g) => g.island === 0)!.stored).toBe(1500);

    // Player 2 raids island 0's generator.
    const before = snap.players[1].inv.cash;
    m.debugTeleport(2, add(m.map[0].generator, scale(forward(yaw), 1.5)));
    snap = m.tick(inputs(2, { interact: true }));
    expect(snap.players[1].inv.cash - before).toBeGreaterThanOrEqual(1500);
  });

  test('an enemy shop does not sell you an upgrade', async () => {
    const m = await Match.create(humans1v1);
    m.debugGive(1, { cash: 1000 });
    m.debugTeleport(1, add(m.map[1].shop, scale(forward(m.map[1].bunker.facingYaw), 1.5)));
    m.tick(new Map());
    const snap = m.tick(inputs(1, { shop: { buy: 'genUpgrade' } }));
    expect(snap.genLevels).toEqual([1, 1]);
  });
});

describe('gun lock', () => {
  test('price is 4x the gun', () => {
    expect(LOCK_PRICE_MULT).toBe(4);
    expect(lockPrice('pistol')).toBe(4 * WEAPONS.pistol.price);
    expect(lockPrice('rifle')).toBe(4 * WEAPONS.rifle.price);
  });

  test('requires owning the gun', () => {
    const p = player(5000);
    expect(buy(p, { buy: 'lock:pistol' }).ok).toBe(false);
    expect(p.locked).toEqual([]);
    expect(p.inv.cash).toBe(5000);
  });

  test('locks an owned gun once, charging 4x', () => {
    const p = player(1000);
    buy(p, { buy: 'smg' });
    const cash = p.inv.cash;
    expect(buy(p, { buy: 'lock:smg' })).toEqual({ ok: true });
    expect(p.locked).toEqual(['smg']);
    expect(p.inv.cash).toBe(cash - lockPrice('smg'));
    expect(buy(p, { buy: 'lock:smg' }).ok).toBe(false);
    expect(p.inv.cash).toBe(cash - lockPrice('smg'));
  });

  test('locking needs the cash', () => {
    const p = player(WEAPONS.pistol.price + lockPrice('pistol') - 1);
    buy(p, { buy: 'pistol' });
    expect(buy(p, { buy: 'lock:pistol' }).ok).toBe(false);
    expect(p.locked).toEqual([]);
  });

  test('grant gives each locked gun with a full mag + 1 spare, first slots, no duplicates', () => {
    const p = player(0);
    p.locked = ['rifle', 'pistol'];
    p.inv.weapons.pistol = { mag: 3, spare: 0 };
    p.hotbar[0] = 'wood'; p.inv.pieces.wood = 1;
    p.hotbar[1] = 'pistol';
    grantLockedGuns(p);
    expect(p.inv.weapons.pistol).toEqual({ mag: 3, spare: 0 }); // already held: untouched
    expect(p.inv.weapons.rifle).toEqual({ mag: WEAPONS.rifle.mag, spare: WEAPONS.rifle.mag });
    expect(p.hotbar.filter((k) => k === 'pistol')).toHaveLength(1);
    expect(p.hotbar.indexOf('rifle')).toBe(2);
  });

  test('grant skips a gun that has no free slot', () => {
    const p = player(0);
    p.locked = ['shotgun'];
    for (let i = 0; i < 9; i++) p.hotbar[i] = 'wood';
    p.inv.pieces.wood = 9;
    grantLockedGuns(p);
    expect(p.inv.weapons.shotgun).toBeUndefined();
  });

  test('in a match: lock a pistol, die, respawn with it in slot 1; lost on death as normal', async () => {
    const m = await Match.create(humans1v1);
    const yaw = m.map[0].bunker.facingYaw;
    m.debugGive(1, { cash: 1000 });
    m.debugTeleport(1, add(m.map[0].shop, scale(forward(yaw), 1.5)));
    m.tick(new Map());
    m.tick(inputs(1, { shop: { buy: 'pistol' } }));
    m.tick(inputs(1, { shop: { buy: 'smg' } }));
    let snap = m.tick(inputs(1, { shop: { buy: 'lock:smg' } }));
    expect(snap.players[0].locked).toEqual(['smg']);
    expect(snap.players[0].inv.cash).toBe(1050 - 50 - 150 - 600);

    m.debugKill(1);
    snap = m.tick(new Map());
    expect(snap.loot.some((b) => b.inv.weapons.smg)).toBe(true); // dropped like any gun
    for (let i = 0; i < 30 * 4; i++) snap = m.tick(new Map());
    const me = snap.players[0];
    expect(me.alive).toBe(true);
    expect(me.inv.weapons.smg).toEqual({ mag: WEAPONS.smg.mag, spare: WEAPONS.smg.mag });
    expect(me.inv.weapons.pistol).toBeUndefined();
    expect(me.hotbar[0]).toBe('smg');
    expect(me.locked).toEqual(['smg']);
  });

  test('an enemy shop does not sell a lock', async () => {
    const m = await Match.create(humans1v1);
    m.debugGive(1, { cash: 1000, weapons: { pistol: { mag: 12, spare: 0 } } });
    m.debugTeleport(1, add(m.map[1].shop, scale(forward(m.map[1].bunker.facingYaw), 1.5)));
    m.tick(new Map());
    const snap = m.tick(inputs(1, { shop: { buy: 'lock:pistol' } }));
    expect(snap.players[0].locked).toEqual([]);
  });
});

describe('bot shopping', () => {
  const armed = (cash: number) => {
    const p = player(cash);
    p.inv.weapons.rifle = { mag: 25, spare: 75 };
    p.inv.weapons.smg = { mag: 30, spare: 90 };
    p.equipped = 'rifle';
    return p;
  };
  const covered = { scaffolds: 0, kit: 0, charge: false };

  test('an investing bot upgrades its generator once essentials are covered', () => {
    const p = armed(400);
    expect(nextPurchase(p, { ...covered, genLevel: 1 }, 'medium', { ...PLAIN_STYLE, invest: true })).toBe('genUpgrade');
    expect(nextPurchase(p, { ...covered, genLevel: 1 }, 'medium', PLAIN_STYLE)).toBeNull(); // not rich enough
    expect(nextPurchase(p, { ...covered, genLevel: 4 }, 'medium', { ...PLAIN_STYLE, invest: true })).toBeNull();
    expect(nextPurchase(p, covered, 'medium', { ...PLAIN_STYLE, invest: true })).toBeNull(); // level unknown
  });

  test('a rich bot upgrades, then locks its favourite gun; the plan simulates both', () => {
    const p = armed(5000);
    const plan = shoppingPlan(p, { ...covered, genLevel: 3 }, 'medium');
    expect(plan.items).toEqual(['genUpgrade', 'lock:rifle']);
    expect(plan.spent).toBe(900 + lockPrice('rifle'));
    expect(plan.covered).toBe(true);
  });
});
