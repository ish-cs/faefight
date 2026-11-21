import { describe, expect, test } from 'vitest';
import { DT, LIFECYCLE, HEAL_POTION, PLAYER, POTIONS, SHIELD_MAX, SHIELD_POTIONS, SPEED_POTION } from '../../src/sim/constants';
import { applyPlayerDamage, type CombatCtx } from '../../src/sim/combat';
import { POTION_RESERVE, potionAction } from '../../src/sim/bots/plans';
import { buyAt, vaultTransfer } from '../../src/sim/economy';
import { countOf, takeOut } from '../../src/sim/hotbar';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { POTION_SHOP_ITEMS, shopFor, startDrink, tickPotions } from '../../src/sim/potions';
import { NO_INPUT, type PlayerInput, type PlayerState, type PotionKind } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

const player = (cash = 0) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  return p;
};
/** A player holding `n` of `kind` in a selected slot. */
const holding = (kind: PotionKind, n = 1) => {
  const p = player(POTIONS[kind].price * n);
  for (let i = 0; i < n; i++) expect(buyAt(p, 'potion', { buy: kind }).ok).toBe(true);
  p.selected = p.hotbar.indexOf(kind);
  return p;
};
/** Ticks `tickPotions` for `secs` starting at `from`; returns the end time. */
const run = (p: PlayerState, from: number, secs: number) => {
  let t = from;
  for (let i = 0; i < Math.round(secs / DT); i++) { t += DT; tickPotions(p, t, DT); }
  return t;
};

const ctxFor = (...ps: PlayerState[]): CombatCtx & { kills: number[] } => {
  const kills: number[] = [];
  return {
    kills,
    physics: null as never,
    players: new Map(ps.map((p) => [p.id, p])),
    pieces: new Map(),
    explosives: [],
    nextId: () => 1,
    onPieceDestroyed: () => {},
    onKill: (victim) => { kills.push(victim); },
  };
};

describe('shield absorbs damage before health', () => {
  test('constants', () => {
    expect(SHIELD_MAX).toBe(100);
    expect(newPlayer(1, 'p', false, 0, v3()).shield).toBe(0);
  });

  test('damage hits shield first', () => {
    const p = player();
    p.shield = 50;
    const ev = applyPlayerDamage(ctxFor(p), p, 30, 2, 1);
    expect(p.shield).toBe(20);
    expect(p.hp).toBe(100);
    expect(ev[0].data).toMatchObject({ target: 1, by: 2, amount: 30, shieldAmount: 30, broke: false });
  });

  test('overflow goes to health and a break is reported', () => {
    const p = player();
    p.shield = 20;
    const ev = applyPlayerDamage(ctxFor(p), p, 50, 2, 1);
    expect(p.shield).toBe(0);
    expect(p.hp).toBe(70);
    expect(ev[0].data).toMatchObject({ amount: 50, shieldAmount: 20, broke: true });
  });

  test('no shield: all to health, no break', () => {
    const p = player();
    const ev = applyPlayerDamage(ctxFor(p), p, 25, 2, 1);
    expect(p.hp).toBe(75);
    expect(ev[0].data).toMatchObject({ shieldAmount: 0, broke: false });
  });

  test('bypassShield (falls) skips the shield', () => {
    const p = player();
    p.shield = 50;
    applyPlayerDamage(ctxFor(p), p, 30, null, 1, { bypassShield: true });
    expect(p.shield).toBe(50);
    expect(p.hp).toBe(70);
  });

  test('a killing blow through the shield kills', () => {
    const p = player();
    p.shield = 30;
    const ctx = ctxFor(p);
    applyPlayerDamage(ctx, p, 200, 2, 1);
    expect(p.hp).toBe(0);
    expect(p.shield).toBe(0);
    expect(ctx.kills).toEqual([1]);
  });
});

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };
const inputs = (i: Partial<PlayerInput>) => new Map([[1, { ...NO_INPUT, ...i }]]);
const ticks = (m: Match, secs: number, i: Partial<PlayerInput> = {}) => {
  let s = m.tick(inputs(i));
  for (let k = 1; k < Math.round(secs * 30); k++) s = m.tick(inputs(i));
  return s;
};
const spot = (m: Match, d: number, side = 3) => {
  const isl = m.map[0], yaw = isl.bunker.facingYaw;
  const p = add(add(isl.center, scale(forward(yaw), d)), scale(right(yaw), side));
  return v3(p.x, isl.groundY, p.z);
};

describe('shield in a match', () => {
  test('a fall bypasses the shield', async () => {
    const m = await Match.create(humans);
    const p = spot(m, 8);
    m.debugSetShield(1, 100);
    m.debugTeleport(1, v3(p.x, p.y + 6, p.z));
    const s = ticks(m, 2);
    expect(s.players[0].shield).toBe(100);
    expect(s.players[0].hp).toBeLessThan(100);
  });

  test('a grenade blast hits the shield first', async () => {
    const m = await Match.create(humans);
    const p = spot(m, 8);
    m.debugTeleport(1, p);
    m.debugSetShield(1, 100);
    m.debugGive(1, { grenades: 1 });
    // Throw straight down: it lands at our feet and blows up after the fuse.
    let s = m.tick(inputs({ select: 0, throwGrenade: true, pitch: -1.4 }));
    s = ticks(m, 3);
    expect(s.players[0].shield).toBeLessThan(100);
    expect(s.players[0].hp).toBe(100);
  });

  test('water kills straight through a full shield; death resets the shield to 0 and respawn keeps it 0', async () => {
    const m = await Match.create(humans);
    m.debugSetShield(1, 100);
    m.debugTeleport(1, v3(0, -2, 0));
    let s = m.tick(new Map());
    expect(s.players[0].alive).toBe(false);
    expect(s.players[0].shield).toBe(0);
    s = ticks(m, LIFECYCLE.respawnSec + 1);
    expect(s.players[0].alive).toBe(true);
    expect(s.players[0].shield).toBe(0);
  });

  test('shield does not regenerate', async () => {
    const m = await Match.create(humans);
    m.debugSetShield(1, 40);
    m.debugDamagePlayer(1, 10);
    const s = ticks(m, 12);
    expect(s.players[0].shield).toBe(30);
  });

  test('debug damage goes through the shield too', async () => {
    const m = await Match.create(humans);
    m.debugSetShield(1, 10);
    m.debugDamagePlayer(1, 25);
    const s = m.tick(new Map());
    expect(s.players[0].shield).toBe(0);
    expect(s.players[0].hp).toBe(85);
  });
});

describe('potions', () => {
  test('prices and timings', () => {
    expect(POTIONS).toEqual({
      shieldSmall: { price: 50, useSec: 1 },
      shieldBig: { price: 100, useSec: 2 },
      healPotion: { price: 60, useSec: 1 },
      speedPotion: { price: 120, useSec: 1 },
    });
    expect(SHIELD_POTIONS).toEqual({ shieldSmall: { amount: 25, cap: 50 }, shieldBig: { amount: 50, cap: 100 } });
    expect(HEAL_POTION).toEqual({ amount: 40, overSec: 4 });
    expect(SPEED_POTION).toEqual({ mult: 1.3, sec: 15 });
  });

  test('small shield: consumed on start, +25 after 1 s, busy meanwhile', () => {
    const p = holding('shieldSmall', 2);
    expect(startDrink(p, 10).ok).toBe(true);
    expect(countOf(p.inv, 'shieldSmall')).toBe(1);
    expect(p.drinking).toEqual({ kind: 'shieldSmall', doneAt: 11 });
    expect(p.busyUntil).toBe(11);
    tickPotions(p, 10.9, DT);
    expect(p.shield).toBe(0);
    tickPotions(p, 11, DT);
    expect(p.shield).toBe(25);
    expect(p.drinking).toBeNull();
  });

  test('small potions only fill up to 50', () => {
    const p = holding('shieldSmall', 3);
    p.shield = 40;
    expect(startDrink(p, 0).ok).toBe(true);
    tickPotions(p, 1, DT);
    expect(p.shield).toBe(50);
    expect(startDrink(p, 2)).toEqual({ ok: false, reason: 'small shields only fill to 50' });
    expect(countOf(p.inv, 'shieldSmall')).toBe(2);
  });

  test('big potion: +50 after 2 s, capped at 100; useless at full shield', () => {
    const p = holding('shieldBig', 2);
    p.shield = 70;
    expect(startDrink(p, 0).ok).toBe(true);
    tickPotions(p, 1.99, DT);
    expect(p.shield).toBe(70);
    tickPotions(p, 2, DT);
    expect(p.shield).toBe(100);
    expect(startDrink(p, 3)).toEqual({ ok: false, reason: 'shield already full' });
    expect(countOf(p.inv, 'shieldBig')).toBe(1);
  });

  test('heal potion: +40 HP over 4 s after a 1 s drink, never above 100', () => {
    const p = holding('healPotion');
    p.hp = 30;
    expect(startDrink(p, 0).ok).toBe(true);
    let t = run(p, 0, 1);
    expect(p.hp).toBe(30);
    t = run(p, t, 2);
    expect(p.hp).toBeCloseTo(50, 0);
    t = run(p, t, 2.5);
    expect(p.hp).toBeCloseTo(70, 5);
    expect(p.healLeft).toBe(0);

    const q = holding('healPotion');
    q.hp = 90;
    startDrink(q, 0);
    run(q, 0, 6);
    expect(q.hp).toBe(PLAYER.hp);
  });

  test('heal potion: useless at full health or when pending heals already cover it', () => {
    const p = holding('healPotion', 2);
    expect(startDrink(p, 0)).toEqual({ ok: false, reason: 'already at full health' });
    p.hp = 70;
    expect(startDrink(p, 0).ok).toBe(true);
    // Drink finished, 40 HP of healing still pending: 70 + 40 >= 100, a second one would do nothing.
    run(p, 0, 1);
    expect(startDrink(p, 1.1)).toEqual({ ok: false, reason: 'already healing to full' });
  });

  test('heal over time is not cancelled by damage', () => {
    const p = holding('healPotion');
    p.hp = 20;
    startDrink(p, 0);
    let t = run(p, 0, 2);
    applyPlayerDamage(ctxFor(p), p, 10, 2, t);
    t = run(p, t, 4);
    expect(p.hp).toBeCloseTo(50, 5);
  });

  test('speed potion: 15 s buff after a 1 s drink; not while one is active', () => {
    const p = holding('speedPotion', 2);
    expect(startDrink(p, 0).ok).toBe(true);
    tickPotions(p, 1, DT);
    expect(p.speedUntil).toBe(16);
    expect(startDrink(p, 2)).toEqual({ ok: false, reason: 'speed boost already active' });
    expect(startDrink(p, 16).ok).toBe(true);
  });

  test('cannot drink while busy, dead, or without the potion selected', () => {
    const p = holding('shieldBig', 2);
    expect(startDrink(p, 0).ok).toBe(true);
    expect(startDrink(p, 1).ok).toBe(false);
    const q = holding('shieldSmall');
    q.selected = (q.selected + 1) % 9;
    expect(startDrink(q, 0)).toEqual({ ok: false, reason: 'select a potion first' });
    const r = holding('shieldSmall');
    r.alive = false;
    expect(startDrink(r, 0).ok).toBe(false);
  });

  test('potions are sold only at the potion seller; medkits only at home', () => {
    expect(POTION_SHOP_ITEMS).toEqual(['shieldSmall', 'shieldBig', 'healPotion', 'speedPotion']);
    expect(shopFor('shieldBig')).toBe('potion');
    expect(shopFor('medkit')).toBe('home');
    const p = player(1000);
    expect(buyAt(p, 'home', { buy: 'shieldSmall' })).toEqual({ ok: false, reason: 'Small shield potion is only sold at the potion seller' });
    expect(buyAt(p, 'potion', { buy: 'medkit' })).toEqual({ ok: false, reason: 'medkit is only sold at your home shop' });
    expect(buyAt(p, 'potion', { buy: 'shieldSmall' }).ok).toBe(true);
    expect(p.inv.cash).toBe(950);
    expect(p.hotbar[0]).toBe('shieldSmall');
  });

  test('drop one / stack, and vault in and out', () => {
    const p = holding('healPotion', 3);
    expect(takeOut(p.inv, 'healPotion', 'one')!.potions).toEqual({ healPotion: 1 });
    expect(countOf(p.inv, 'healPotion')).toBe(2);
    expect(vaultTransfer(p, { deposit: { potions: { healPotion: 2 } } }).ok).toBe(true);
    expect(countOf(p.inv, 'healPotion')).toBe(0);
    expect(p.hotbar).not.toContain('healPotion');
    expect(p.vault.potions.healPotion).toBe(2);
    expect(vaultTransfer(p, { deposit: { potions: { healPotion: 1 } } })).toEqual({ ok: false, reason: 'not enough healPotion' });
    expect(vaultTransfer(p, { withdraw: { potions: { healPotion: 1 } } }).ok).toBe(true);
    expect(p.hotbar).toContain('healPotion');
    expect(countOf(p.inv, 'healPotion')).toBe(1);
  });
});

describe('potions in a match', () => {
  test('buy at the potion seller, drink with select + click; drop; death drops the rest and clears buffs', async () => {
    const m = await Match.create(humans);
    const at = spot(m, 6, -3);
    m.debugTeleport(1, at);
    m.debugSetPotionShops([v3(at.x + 1, at.y, at.z)]);
    m.debugGive(1, { cash: 1000 });
    // The home shop is far: only the potion seller can sell this.
    let s = m.tick(inputs({ shop: { buy: 'shieldBig' } }));
    expect(s.players[0].inv.potions.shieldBig).toBe(1);
    expect(s.potionShops).toEqual([{ id: 0, pos: v3(at.x + 1, at.y, at.z) }]);
    s = m.tick(inputs({ shop: { buy: 'medkit' } }));
    expect(s.players[0].inv.medkits).toBe(0);
    s = m.tick(inputs({ shop: { buy: 'speedPotion' } }));
    s = m.tick(inputs({ shop: { buy: 'speedPotion' } }));
    const slot = s.players[0].hotbar.indexOf('shieldBig');
    s = m.tick(inputs({ select: slot, drink: true }));
    expect(s.players[0].drinking?.kind).toBe('shieldBig');
    expect(s.players[0].inv.potions.shieldBig ?? 0).toBe(0);
    s = ticks(m, 2.1, { select: slot });
    expect(s.players[0].shield).toBe(50);

    const speedSlot = s.players[0].hotbar.indexOf('speedPotion');
    s = m.tick(inputs({ select: speedSlot, drop: 'one' }));
    expect(s.players[0].inv.potions.speedPotion).toBe(1);
    expect(s.loot.some((b) => b.inv.potions.speedPotion === 1)).toBe(true);
    s = m.tick(inputs({ select: speedSlot, drink: true }));
    s = ticks(m, 1.1, { select: speedSlot });
    expect(s.players[0].speedUntil).toBeGreaterThan(s.time);

    m.debugKill(1);
    s = m.tick(new Map());
    const me = s.players[0];
    expect(me.shield).toBe(0);
    expect(me.speedUntil).toBe(0);
    expect(me.drinking).toBeNull();
    expect(me.healLeft).toBe(0);
  });

  test('death drops carried potions as loot that someone else can pick up', async () => {
    const m = await Match.create(humans);
    const at = spot(m, 6, -3);
    m.debugTeleport(1, at);
    m.debugGive(1, { potions: { shieldSmall: 2, healPotion: 1 } });
    let s = m.tick(new Map());
    expect(s.players[0].hotbar.slice(0, 2)).toEqual(['shieldSmall', 'healPotion']);
    m.debugKill(1);
    s = m.tick(new Map());
    const bag = s.loot.find((b) => b.inv.potions.shieldSmall === 2);
    expect(bag).toBeDefined();
    m.debugTeleport(2, bag!.pos);
    s = m.tick(new Map());
    expect(s.players[1].inv.potions).toEqual({ shieldSmall: 2, healPotion: 1 });
    expect(s.players[1].hotbar).toContain('shieldSmall');
  });

  test('speed potion makes you move 30% faster for 15 s', async () => {
    const dist = async (speed: boolean) => {
      const m = await Match.create(humans);
      const at = spot(m, 0, -10);
      m.debugTeleport(1, at);
      const yaw = m.map[0].bunker.facingYaw;
      if (speed) {
        m.debugGive(1, { potions: { speedPotion: 1 } });
        m.tick(inputs({ yaw, select: 0, drink: true }));
        ticks(m, 1.1, { yaw });
      } else ticks(m, 1.15, { yaw });
      const from = m.tick(inputs({ yaw })).players[0].pos;
      const s = ticks(m, 1, { yaw, moveZ: 1 });
      return Math.hypot(s.players[0].pos.x - from.x, s.players[0].pos.z - from.z);
    };
    const plain = await dist(false), fast = await dist(true);
    expect(plain).toBeGreaterThan(4);
    expect(fast / plain).toBeCloseTo(SPEED_POTION.mult, 1);
  });

  test('a drink click with nothing useful to drink does nothing', async () => {
    const m = await Match.create(humans);
    m.debugGive(1, { potions: { healPotion: 1 } });
    const s = m.tick(inputs({ select: 0, drink: true }));
    expect(s.players[0].drinking).toBeNull();
    expect(s.players[0].inv.potions.healPotion).toBe(1);
  });
});

describe('bots and potions', () => {
  test('potionAction: stock shields at the seller with spare cash; drink out of combat only when useful', () => {
    const p = player(POTION_RESERVE + 100);
    expect(potionAction(p, 0, false, true)).toEqual({ buy: 'shieldBig' });
    expect(potionAction(p, 0, false, false)).toBeNull();
    p.inv.cash = POTION_RESERVE + 60;
    expect(potionAction(p, 0, false, true)).toEqual({ buy: 'shieldSmall' });
    p.inv.cash = POTION_RESERVE;
    expect(potionAction(p, 0, false, true)).toBeNull();

    const q = holding('shieldSmall');
    expect(potionAction(q, 0, false, false)).toEqual({ drink: q.hotbar.indexOf('shieldSmall') });
    expect(potionAction(q, 0, true, false)).toBeNull();
    q.shield = 50;
    expect(potionAction(q, 0, false, false)).toBeNull();
  });

  test('a bot standing at the potion seller buys and drinks a shield', async () => {
    const m = await Match.create({ players: [{ name: 'you', isBot: false }, { name: 'Bot (easy)', isBot: true, difficulty: 'easy' }] });
    const isl = m.map[1];
    const at = v3(isl.spawn.x, isl.groundY, isl.spawn.z);
    m.debugSetPotionShops([at]);
    m.debugGive(2, { cash: 2000 });
    let best = 0;
    for (let i = 0; i < 90; i++) {
      m.debugTeleport(2, at);
      const s = m.tick(new Map());
      best = Math.max(best, s.players[1].shield + (s.players[1].drinking ? 1 : 0));
    }
    expect(best).toBeGreaterThan(0);
  });
});
