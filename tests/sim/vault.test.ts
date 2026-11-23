import { describe, expect, test } from 'vitest';
import { LIFECYCLE, MEDKIT, PIECES, WEAPONS } from '../../src/sim/constants';
import { buy, vaultTransfer } from '../../src/sim/economy';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type PlayerInput, type Snapshot } from '../../src/sim/types';
import { bankAboveLoadout, funds, LOADOUT_MAX_KINDS, LOADOUT_MAX_PIECES, pay, restockFromVault, sanitizeLoadout, takeVaultCash } from '../../src/sim/vault';
import { sanitizeInput } from '../../src/net/sanitize';
import { add, forward, scale, v3 } from '../../src/sim/vec';
import { unarmed } from './unarmed';

const player = (cash = 0) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  return p;
};
const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);

describe('shop pays from the vault (D)', () => {
  test('carried cash first, then the vault', () => {
    const p = player(30);
    p.vault.cash = 100;
    expect(buy(p, { buy: 'pistol' }).ok).toBe(true); // $50
    expect(p.inv.cash).toBe(0);
    expect(p.vault.cash).toBe(80);
  });
  test('all carried when it covers the price', () => {
    const p = player(80);
    p.vault.cash = 100;
    buy(p, { buy: 'pistol' });
    expect([p.inv.cash, p.vault.cash]).toEqual([30, 100]);
  });
  test('short of carried + vault: rejected, nothing charged', () => {
    const p = player(20);
    p.vault.cash = 20;
    const r = buy(p, { buy: 'pistol' });
    expect(r.ok).toBe(false);
    expect([p.inv.cash, p.vault.cash]).toEqual([20, 20]);
  });
  test('pay / funds', () => {
    const p = player(5);
    p.vault.cash = 10;
    expect(funds(p)).toBe(15);
    pay(p, 12);
    expect([p.inv.cash, p.vault.cash]).toEqual([0, 3]);
    expect(() => pay(p, 4)).toThrow(/short/);
  });
  test('in a match the home shop charges the vault for what carried cash lacks', async () => {
    const m = await Match.create(humans1v1);
    unarmed(m);
    const isl = m.map[0];
    m.debugGive(1, { cash: 300 });
    m.debugTeleport(1, add(isl.vault, scale(forward(isl.bunker.facingYaw), 1)));
    m.tick(new Map());
    m.tick(inputs(1, { vault: { deposit: { cash: 300 } } }));
    m.debugTeleport(1, add(isl.shop, scale(forward(isl.bunker.facingYaw), 1.5)));
    for (let i = 0; i < 40; i++) m.tick(new Map()); // the vault's busy second
    const snap = m.tick(inputs(1, { shop: { buy: 'smg' } }));
    const me = snap.players[0];
    expect(me.inv.weapons.smg).toBeDefined();
    expect(me.inv.cash).toBe(0);
    expect(me.vault.cash).toBe(350 - WEAPONS.smg.price);
  });
});

describe('death costs what you carry (A)', () => {
  test('carried cash and items drop as a bag; the vault is untouched', async () => {
    const m = await Match.create(humans1v1);
    unarmed(m);
    const isl = m.map[0];
    m.debugGive(1, { cash: 400, pieces: { wood: 25 }, medkits: 2 });
    m.debugTeleport(1, add(isl.vault, scale(forward(isl.bunker.facingYaw), 1)));
    m.tick(new Map());
    m.tick(inputs(1, { vault: { deposit: { cash: 100, pieces: { wood: 10 } } } }));
    m.debugKill(1);
    const snap = m.tick(new Map());
    const bag = snap.loot.find((b) => b.inv.pieces.wood);
    expect(bag?.inv.cash).toBe(350);
    expect(bag?.inv.pieces.wood).toBe(15);
    expect(bag?.inv.medkits).toBe(2);
    expect(snap.players[0].vault.cash).toBe(100);
    expect(snap.players[0].vault.pieces.wood).toBe(10);
  });
});

describe('restock loadout (C)', () => {
  test('sanitize: clamps counts, caps kinds, rejects junk', () => {
    expect(sanitizeLoadout({ items: { wood: 80.7, medkit: 3, smg: 5 }, keep: -3, buy: 'yes' }))
      .toEqual({ items: { smg: 1, wood: LOADOUT_MAX_PIECES, medkit: 3 }, keep: 0, buy: false });
    expect(sanitizeLoadout({ items: { nope: 1 }, keep: 0, buy: false })).toBeNull();
    expect(sanitizeLoadout({ items: { wood: NaN }, keep: 0 })).toBeNull();
    expect(sanitizeLoadout(null)).toBeNull();
    const many = { wood: 1, metal: 1, steel: 1, medkit: 1, grenade: 1 };
    expect(Object.keys(many).length).toBeGreaterThan(LOADOUT_MAX_KINDS);
    expect(sanitizeLoadout({ items: many, keep: 0, buy: false })).toBeNull();
    // Zero counts don't count against the cap.
    expect(sanitizeLoadout({ items: { ...many, grenade: 0 }, keep: 0, buy: false })?.items).toEqual({ wood: 1, metal: 1, steel: 1, medkit: 1 });
  });

  test('the wire sanitizer passes a loadout-only vault action', () => {
    const i = sanitizeInput({ ...NO_INPUT, vault: { loadout: { items: { medkit: 2 }, keep: 50, buy: true } } });
    expect(i?.vault).toEqual({ loadout: { items: { medkit: 2 }, keep: 50, buy: true } });
    expect(sanitizeInput({ ...NO_INPUT, vault: { loadout: { items: { bogus: 2 } } } })?.vault).toBeNull();
  });

  test('withdraws up to the loadout from the vault, then keeps $ on you', () => {
    const p = player(0);
    p.vault = { ...p.vault, cash: 500, pieces: { wood: 25 }, medkits: 5 };
    p.loadout = { items: { wood: 10, medkit: 2 }, keep: 100, buy: false };
    const r = restockFromVault(p);
    expect(r).toEqual({ moved: 12, bought: 0, spent: 0, cash: 100 });
    expect(p.inv.pieces.wood).toBe(10);
    expect(p.inv.medkits).toBe(2);
    expect(p.inv.cash).toBe(100);
    expect(p.vault.pieces.wood).toBe(15);
    expect(p.vault.medkits).toBe(3);
    expect(p.vault.cash).toBe(400);
    expect(p.hotbar.filter(Boolean)).toEqual(['wood', 'medkit']);
  });

  test('tops up only what is missing; a gun comes out whole with its ammo', () => {
    const p = player(0);
    p.inv.pieces.wood = 4;
    p.hotbar[0] = 'wood';
    p.vault.pieces.wood = 20;
    p.vault.weapons.smg = { mag: 20, spare: 40 };
    p.loadout = { items: { wood: 10, smg: 1 }, keep: 0, buy: false };
    expect(restockFromVault(p)?.moved).toBe(7);
    expect(p.inv.pieces.wood).toBe(10);
    expect(p.inv.weapons.smg).toEqual({ mag: 20, spare: 40 });
    expect(p.vault.weapons.smg).toBeUndefined();
  });

  test('buy toggle: what the vault lacks is bought with vault cash', () => {
    const p = player(0);
    p.vault.cash = 1000;
    p.vault.medkits = 1;
    p.loadout = { items: { medkit: 3, wood: 5 }, keep: 0, buy: true };
    const r = restockFromVault(p)!;
    expect(p.inv.medkits).toBe(3);
    expect(p.inv.pieces.wood).toBe(5);
    expect(r.moved).toBe(1);
    expect(r.bought).toBe(2 + 5);
    expect(r.spent).toBe(2 * MEDKIT.price + 5 * PIECES.wood.price);
    expect(p.vault.cash).toBe(1000 - r.spent);
  });

  test('buy toggle off: nothing is bought; running out of vault cash stops buying', () => {
    const p = player(0);
    p.vault.cash = MEDKIT.price + 1;
    p.loadout = { items: { medkit: 3 }, keep: 0, buy: false };
    expect(restockFromVault(p)).toEqual({ moved: 0, bought: 0, spent: 0, cash: 0 });
    p.loadout.buy = true;
    expect(restockFromVault(p)?.bought).toBe(1);
    expect(p.vault.cash).toBe(1);
  });

  test('no loadout: nothing happens', () => {
    const p = player(0);
    p.vault.medkits = 3;
    expect(restockFromVault(p)).toBeNull();
    expect(p.inv.medkits).toBe(0);
  });

  test('in a match: set the loadout from anywhere, die, respawn restocked from the vault', async () => {
    const m = await Match.create(humans1v1);
    unarmed(m);
    const isl = m.map[0];
    m.debugGive(1, { cash: 500, pieces: { wood: 30 }, medkits: 4 });
    m.debugTeleport(1, add(isl.vault, scale(forward(isl.bunker.facingYaw), 1)));
    m.tick(new Map());
    m.tick(inputs(1, { vault: { deposit: { cash: 500, pieces: { wood: 30 }, medkits: 4 } } }));
    // Far from the vault: the loadout is still accepted, a deposit is not.
    m.debugTeleport(1, add(isl.vault, v3(15, 0, 15)));
    m.tick(new Map());
    let snap = m.tick(inputs(1, { vault: { loadout: { items: { wood: 10, medkit: 2 }, keep: 60, buy: false }, deposit: { cash: 1 } } }));
    expect(snap.players[0].loadout).toEqual({ items: { wood: 10, medkit: 2 }, keep: 60, buy: false });
    m.debugKill(1);
    let restock: Snapshot['events'][number] | undefined;
    for (let i = 0; i < 30 * (LIFECYCLE.respawnSec + 1); i++) {
      snap = m.tick(new Map());
      restock ??= snap.events.find((e) => e.type === 'restock');
    }
    const me = snap.players[0];
    expect(me.alive).toBe(true);
    expect(me.inv.pieces.wood).toBe(10);
    expect(me.inv.medkits).toBe(2);
    expect(me.inv.cash).toBe(60);
    expect(me.vault.cash).toBe(500 - 60); // the start $50 stayed carried and dropped
    expect(restock?.data).toMatchObject({ player: 1, moved: 12, cash: 60 });
  });
});

describe('quick-bank and spoils', () => {
  test('bankAboveLoadout: cash above keep and stack excess; guns stay', () => {
    const p = player(260);
    p.inv.pieces.wood = 25;
    p.inv.medkits = 1;
    p.inv.weapons.pistol = { mag: 12, spare: 12 };
    p.loadout = { items: { wood: 10, medkit: 2 }, keep: 60, buy: false };
    const dep = bankAboveLoadout(p)!;
    expect(dep).toEqual({ cash: 200, pieces: { wood: 15 } });
    expect(vaultTransfer(p, { deposit: dep }).ok).toBe(true);
    expect(p.inv.pieces.wood).toBe(10);
    expect(p.inv.cash).toBe(60);
    expect(bankAboveLoadout(p)).toBeNull();
  });
  test('no loadout: banks every stack and all cash', () => {
    const p = player(10);
    p.inv.pieces.wood = 3;
    p.hotbar[0] = 'wood';
    expect(bankAboveLoadout(p)).toEqual({ cash: 10, pieces: { wood: 3 } });
  });
  test('takeVaultCash takes whole dollars up to max', () => {
    const p = player(0);
    p.vault.cash = 120.6;
    expect(takeVaultCash(p, 50)).toBe(50);
    expect(takeVaultCash(p)).toBe(70);
    expect(p.vault.cash).toBeCloseTo(0.6);
    expect(takeVaultCash(p)).toBe(0);
  });
});

describe('stack splitting (vault moves of part of a stack)', () => {
  test('move 10 of 25 walls in and 4 back out', () => {
    const p = player(0);
    p.inv.pieces.wood = 25;
    p.hotbar[3] = 'wood';
    expect(vaultTransfer(p, { deposit: { pieces: { wood: 10 } } }).ok).toBe(true);
    expect([p.inv.pieces.wood, p.vault.pieces.wood]).toEqual([15, 10]);
    expect(p.hotbar[3]).toBe('wood');
    expect(vaultTransfer(p, { withdraw: { pieces: { wood: 4 } } }).ok).toBe(true);
    expect([p.inv.pieces.wood, p.vault.pieces.wood]).toEqual([19, 6]);
  });
});
