import { describe, expect, test } from 'vitest';
import { MEDKIT, POTIONS } from '../../src/sim/constants';
import { buyAt } from '../../src/sim/economy';
import { Bot } from '../../src/sim/bots/bot';
import { dropForHeal, healPlan, healStock, hpHealsHeld, type HealSituation } from '../../src/sim/bots/heal';
import { HEAL } from '../../src/sim/bots/params';
import { nextPurchase, type Needs } from '../../src/sim/bots/plans';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import type { PlayerState, PotionKind } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

const player = (cash = 0) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  return p;
};
const give = (p: PlayerState, kind: PotionKind | 'medkit', n = 1) => {
  for (let i = 0; i < n; i++) {
    p.inv.cash += kind === 'medkit' ? MEDKIT.price : POTIONS[kind].price;
    expect(buyAt(p, kind === 'medkit' ? 'home' : 'potion', { buy: kind }).ok).toBe(true);
  }
  return p;
};
const sit = (me: PlayerState, over: Partial<HealSituation> = {}): HealSituation => ({
  me, now: 100, diff: 'pro', foe: null, hurtAgo: 99, burst: 0, hidingFor: null, coverFirst: true, useReload: true, ...over,
});
const foe = (dist: number, eff = 100, reloadLeft = 0) => ({ dist, eff, reloadLeft });

describe('bot healing decisions (heal.ts)', () => {
  test('between fights: patch up below safeHp with the medkit; full hp does nothing', () => {
    const p = give(player(), 'medkit');
    p.hp = 50;
    expect(healPlan(sit(p), HEAL)).toMatchObject({ act: 'use', item: 'medkit', slot: p.hotbar.indexOf('medkit') });
    p.hp = 100;
    expect(healPlan(sit(p), HEAL)).toBeNull();
  });

  test('mid-fight, low, enemy close and in sight: break line of sight first, then heal in the open if hiding drags on', () => {
    const p = give(give(player(), 'medkit'), 'healPotion');
    p.hp = 40;
    const s = sit(p, { foe: foe(12), hurtAgo: 0.2 });
    expect(healPlan(s, HEAL)).toMatchObject({ act: 'hide' });
    // Out of their sight (or behind cover) a moment later: heal right away, quickest first.
    expect(healPlan({ ...s, foe: null }, HEAL)).toMatchObject({ act: 'use', item: 'healPotion' });
    expect(healPlan({ ...s, sheltered: true }, HEAL)).toMatchObject({ act: 'use', item: 'healPotion' });
    expect(healPlan({ ...s, hidingFor: HEAL.hideSec + 0.1 }, HEAL)).toMatchObject({ act: 'use', item: 'healPotion' });
  });

  test('mid-fight: heal while the enemy reloads, with an item that finishes before they do', () => {
    const p = give(player(), 'medkit');
    p.hp = 40;
    // Medkit takes 2 s: a 1 s reload is too short, a 2.5 s one is a window.
    expect(healPlan(sit(p, { foe: foe(12, 100, 1), hurtAgo: 0.2, coverFirst: true }), HEAL)).toMatchObject({ act: 'hide' });
    expect(healPlan(sit(p, { foe: foe(12, 100, 2.5), hurtAgo: 0.2 }), HEAL)).toMatchObject({ act: 'use', item: 'medkit', why: expect.stringMatching(/reload/) });
  });

  test('mid-fight: press a nearly dead enemy instead of healing; healthy enough does nothing', () => {
    const p = give(player(), 'medkit');
    p.hp = 45;
    expect(healPlan(sit(p, { foe: foe(10, 20), hurtAgo: 0.2 }), HEAL)).toMatchObject({ act: 'wait', why: expect.stringMatching(/press/) });
    p.hp = 90;
    expect(healPlan(sit(p, { foe: foe(10), hurtAgo: 0.2 }), HEAL)).toBeNull();
  });

  test('a burst of damage triggers a heal a little above fightHp', () => {
    const p = give(player(), 'healPotion');
    p.hp = HEAL.fightHp.pro + 10;
    expect(healPlan(sit(p, { hurtAgo: 0.3 }), HEAL)).toBeNull();
    expect(healPlan(sit(p, { hurtAgo: 0.3, burst: HEAL.burst + 5 }), HEAL)).toMatchObject({ act: 'use', item: 'healPotion' });
  });

  test('heal stock grows with cash', () => {
    expect(healStock(HEAL.stockAt.pro - 1, 'pro', HEAL)).toBe(0);
    expect(healStock(HEAL.stockAt.pro, 'pro', HEAL)).toBe(HEAL.stock.pro);
    expect(healStock(1e6, 'pro', HEAL)).toBe(HEAL.stockMax);
  });

  test('shopping: heals come right after the seal kit, before building pieces', () => {
    const p = player(400);
    p.inv.weapons.smg = { mag: 30, spare: 60 };
    p.inv.weapons.rifle = { mag: 25, spare: 50 };
    p.inv.pieces.metal = 3;
    p.hotbar.splice(0, 3, 'smg', 'rifle', 'metal');
    p.equipped = 'smg';
    const needs: Needs = { scaffolds: 0, kit: 3, charge: false, medkits: 2, build: { wood: 2 } };
    expect(nextPurchase(p, needs, 'pro')).toBe('medkit');
    expect(nextPurchase(p, { ...needs, medkits: 0 }, 'pro')).toBe('wood');
  });

  test('a full hotbar drops its least-wanted item (a spare pistol before a ramp), never guns that matter or the kit', () => {
    const p = player();
    p.inv.weapons.pistol = { mag: 12, spare: 24 };
    p.inv.weapons.smg = { mag: 30, spare: 60 };
    Object.assign(p.inv.pieces, { metal: 3, scaffold: 2, ramp: 1, sandbags: 2, wood: 2 });
    p.inv.grenades = 1; p.inv.charges = 1;
    p.hotbar.splice(0, 9, 'pistol', 'smg', 'metal', 'scaffold', 'ramp', 'sandbags', 'wood', 'grenade', 'charge');
    expect(dropForHeal(p, HEAL, new Set())).toBe(0);
    expect(dropForHeal(p, HEAL, new Set(['pistol']))).toBe(4); // ramp next
    p.hotbar[8] = null;
    expect(dropForHeal(p, HEAL, new Set())).toBeNull(); // a free slot: nothing to drop
  });
});

describe('bot healing in a match', () => {
  test('a PRO with cash and a full hotbar at home ends up holding a heal', async () => {
    const m = await Match.create({ players: [{ name: 'you', isBot: false }, { name: 'b', isBot: true, difficulty: 'pro' }], seed: 5 });
    m.debugSetTime(300);
    m.debugGive(2, {
      cash: 900,
      weapons: { pistol: { mag: 12, spare: 24 }, smg: { mag: 30, spare: 90 }, rifle: { mag: 25, spare: 75 } },
      pieces: { metal: 4, scaffold: 6, ramp: 1, sandbags: 2, wood: 3 }, grenades: 1, traps: 1,
    });
    let s = m.tick(new Map());
    expect(s.players[1].hotbar.includes(null)).toBe(false);
    let held = false;
    for (let i = 0; i < 30 * 40 && !held; i++) {
      s = m.tick(new Map());
      held = hpHealsHeld(s.players[1]) > 0;
    }
    expect(held).toBe(true);
  }, 60_000);

  test('a hurt PRO with a medkit and nobody around uses it', async () => {
    const m = await Match.create({ players: [{ name: 'you', isBot: false }, { name: 'b', isBot: true, difficulty: 'pro' }], seed: 5 });
    m.debugGive(2, { medkits: 1, weapons: { smg: { mag: 30, spare: 90 } } });
    m.debugSetHp(2, 30);
    let used = false;
    for (let i = 0; i < 30 * 5 && !used; i++) used = m.tick(new Map()).players[1].healAt !== null;
    expect(used).toBe(true);
  }, 30_000);

  test('mid-fight: a low PRO shot at by someone it can see heals within a few seconds (hides or uses a window)', async () => {
    const bots: Bot[] = [];
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: true, difficulty: 'pro' }], seed: 7 },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.push(b); return b; } });
    const isl = m.map[0];
    m.debugGive(1, { potions: { healPotion: 2 }, medkits: 1, weapons: { smg: { mag: 30, spare: 90 } } });
    m.debugGive(2, { weapons: { smg: { mag: 30, spare: 90 } } });
    m.debugTeleport(1, v3(isl.spawn.x, isl.groundY, isl.spawn.z));
    m.debugTeleport(2, v3(isl.spawn.x + 25, isl.groundY, isl.spawn.z));
    m.debugSetHp(1, 50);
    let healed = false;
    for (let i = 0; i < 30 * 6 && !healed; i++) {
      const s = m.tick(new Map());
      const p = s.players[0];
      if (!p.alive) break;
      healed = p.healAt !== null || p.drinking?.kind === 'healPotion';
    }
    expect(healed).toBe(true);
  }, 30_000);
});
