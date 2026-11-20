import { describe, expect, test } from 'vitest';
import { buy, collect, emptyInventory, mergeInventory, tickGenerator, vaultTransfer } from '../../src/sim/economy';
import { newPlayer } from '../../src/sim/player';
import { v3 } from '../../src/sim/vec';

const player = (cash = 0) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  return p;
};

describe('generator', () => {
  test('accrues 5 per second and caps at 500', () => {
    expect(tickGenerator(0, 2, true)).toBeCloseTo(10);
    expect(tickGenerator(498, 10, true)).toBe(500);
  });
  test('stops when inactive', () => {
    expect(tickGenerator(100, 5, false)).toBe(100);
  });
  test('collect moves everything into carried cash', () => {
    const p = player(10);
    const gen = { stored: 75 };
    expect(collect(p, gen)).toBe(75);
    expect(p.inv.cash).toBe(85);
    expect(gen.stored).toBe(0);
  });
});

describe('shop', () => {
  test('buy pistol with exactly 50', () => {
    const p = player(50);
    expect(buy(p, { buy: 'pistol' })).toEqual({ ok: true });
    expect(p.inv.weapons.pistol).toEqual({ mag: 12, spare: 36 });
    expect(p.inv.cash).toBe(0);
  });
  test('cannot spend vault cash', () => {
    const p = player(0);
    p.vault.cash = 1000;
    const r = buy(p, { buy: 'pistol' });
    expect(r.ok).toBe(false);
    expect(p.inv.weapons.pistol).toBeUndefined();
    expect(p.vault.cash).toBe(1000);
  });
  test('buying a piece adds to the count', () => {
    const p = player(100);
    buy(p, { buy: 'sandbags' });
    buy(p, { buy: 'sandbags' });
    expect(p.inv.pieces.sandbags).toBe(2);
    expect(p.inv.cash).toBe(80);
  });
  test('ammo needs a gun equipped', () => {
    const p = player(100);
    expect(buy(p, { buy: 'ammo' }).ok).toBe(false);
    expect(p.inv.cash).toBe(100);
    buy(p, { buy: 'pistol' });
    p.equipped = 'pistol';
    expect(buy(p, { buy: 'ammo' }).ok).toBe(true);
    expect(p.inv.weapons.pistol!.spare).toBe(36 + 24);
  });
  test('cannot buy a gun twice', () => {
    const p = player(500);
    buy(p, { buy: 'rifle' });
    expect(buy(p, { buy: 'rifle' }).ok).toBe(false);
    expect(p.inv.cash).toBe(200);
  });
});

describe('vault', () => {
  test('deposit more than carried fails and changes nothing', () => {
    const p = player(30);
    expect(vaultTransfer(p, { deposit: { cash: 31 } }).ok).toBe(false);
    expect(p.inv.cash).toBe(30);
    expect(p.vault.cash).toBe(0);
  });
  test('deposit and withdraw cash and gear', () => {
    const p = player(200);
    buy(p, { buy: 'pistol' });
    buy(p, { buy: 'steel' });
    expect(vaultTransfer(p, { deposit: { cash: 0, weapons: { pistol: { mag: 0, spare: 0 } }, pieces: { steel: 1 } } }).ok).toBe(true);
    expect(p.inv.weapons.pistol).toBeUndefined();
    expect(p.vault.weapons.pistol).toEqual({ mag: 12, spare: 36 });
    expect(p.vault.pieces.steel).toBe(1);
    expect(p.inv.pieces.steel ?? 0).toBe(0);
    expect(vaultTransfer(p, { withdraw: { weapons: { pistol: { mag: 0, spare: 0 } }, pieces: { steel: 1 } } }).ok).toBe(true);
    expect(p.inv.weapons.pistol).toEqual({ mag: 12, spare: 36 });
    expect(p.inv.pieces.steel).toBe(1);
  });
  test('mergeInventory adds everything', () => {
    const a = emptyInventory();
    const b = emptyInventory();
    a.cash = 5; b.cash = 7; b.grenades = 2; b.pieces.wood = 3; b.weapons.smg = { mag: 30, spare: 90 };
    a.weapons.smg = { mag: 10, spare: 0 };
    mergeInventory(a, b);
    expect(a.cash).toBe(12);
    expect(a.grenades).toBe(2);
    expect(a.pieces.wood).toBe(3);
    expect(a.weapons.smg).toEqual({ mag: 10, spare: 120 });
  });
});
