import { describe, expect, test } from 'vitest';
import { emptyInventory } from '../../src/sim/economy';
import {
  HOTBAR_SIZE, addKind, canAdd, countOf, emptyHotbar, equippedFor, heldKinds, removeIfEmpty, swapSlots,
  syncFromInventory, takeOut, validSlot,
} from '../../src/sim/hotbar';

describe('hotbar helpers', () => {
  test('emptyHotbar has nine empty slots', () => {
    expect(emptyHotbar()).toEqual(Array(HOTBAR_SIZE).fill(null));
    expect(HOTBAR_SIZE).toBe(9);
  });

  test('addKind fills the first empty slot and reuses an existing one', () => {
    const bar = emptyHotbar();
    bar[0] = 'pistol';
    expect(addKind(bar, 'wood')).toBe(1);
    expect(addKind(bar, 'wood')).toBe(1);
    bar[1] = null;
    bar[2] = 'smg';
    expect(addKind(bar, 'grenade')).toBe(1);
  });

  test('addKind and canAdd report a full hotbar', () => {
    const bar = emptyHotbar().map((_, i) => (['pistol', 'smg', 'shotgun', 'rifle', 'wood', 'metal', 'steel', 'ramp', 'grenade'] as const)[i]);
    expect(canAdd(bar, 'charge')).toBe(false);
    expect(addKind(bar, 'charge')).toBe(-1);
    expect(canAdd(bar, 'wood')).toBe(true);
    expect(addKind(bar, 'wood')).toBe(4);
  });

  test('countOf counts guns, pieces, grenades and charges', () => {
    const inv = emptyInventory();
    inv.weapons.rifle = { mag: 0, spare: 0 };
    inv.pieces.ramp = 3;
    inv.grenades = 2;
    expect(countOf(inv, 'rifle')).toBe(1);
    expect(countOf(inv, 'pistol')).toBe(0);
    expect(countOf(inv, 'ramp')).toBe(3);
    expect(countOf(inv, 'grenade')).toBe(2);
    expect(countOf(inv, 'charge')).toBe(0);
    inv.medkits = 3;
    expect(countOf(inv, 'medkit')).toBe(3);
    expect(heldKinds(inv)).toEqual(['rifle', 'ramp', 'grenade', 'medkit']);
  });

  test('removeIfEmpty clears slots for kinds no longer held', () => {
    const inv = emptyInventory();
    inv.pieces.wood = 1;
    const bar = emptyHotbar();
    bar[3] = 'wood';
    bar[5] = 'grenade';
    removeIfEmpty(bar, inv);
    expect(bar[3]).toBe('wood');
    expect(bar[5]).toBeNull();
  });

  test('syncFromInventory keeps order, adds missing kinds, dedupes, reports overflow', () => {
    const inv = emptyInventory();
    inv.weapons.pistol = { mag: 12, spare: 0 };
    inv.pieces.sandbags = 2;
    const bar = emptyHotbar();
    bar[4] = 'sandbags';
    bar[6] = 'sandbags';
    bar[7] = 'charge';
    expect(syncFromInventory(bar, inv)).toEqual([]);
    expect(bar).toEqual(['pistol', null, null, null, 'sandbags', null, null, null, null]);

    const full = emptyInventory();
    full.weapons = { pistol: { mag: 1, spare: 0 }, smg: { mag: 1, spare: 0 }, shotgun: { mag: 1, spare: 0 }, rifle: { mag: 1, spare: 0 } };
    full.pieces = { sandbags: 1, wood: 1, metal: 1, steel: 1, scaffold: 1, ramp: 1 };
    const bar2 = emptyHotbar();
    expect(syncFromInventory(bar2, full)).toEqual(['ramp']);
    expect(bar2.every((k) => k !== null)).toBe(true);
  });

  test('swapSlots swaps and rejects out-of-range indices', () => {
    const bar = emptyHotbar();
    bar[0] = 'pistol';
    expect(swapSlots(bar, 0, 8)).toBe(true);
    expect(bar[0]).toBeNull();
    expect(bar[8]).toBe('pistol');
    expect(swapSlots(bar, 8, 9)).toBe(false);
    expect(swapSlots(bar, -1, 0)).toBe(false);
    expect(swapSlots(bar, 0.5, 1)).toBe(false);
    expect(bar[8]).toBe('pistol');
  });

  test('validSlot', () => {
    expect([0, 8].every(validSlot)).toBe(true);
    expect([9, -1, 1.5, NaN, '2', null].some(validSlot)).toBe(false);
  });

  test('equippedFor: gun slot holds the gun, anything else is fists', () => {
    const bar = emptyHotbar();
    bar[1] = 'shotgun';
    bar[2] = 'wood';
    expect(equippedFor(bar, 1)).toBe('shotgun');
    expect(equippedFor(bar, 2)).toBe('fists');
    expect(equippedFor(bar, 0)).toBe('fists');
  });

  test('takeOut one / stack', () => {
    const inv = emptyInventory();
    inv.weapons.smg = { mag: 10, spare: 60 };
    inv.pieces.wood = 3;
    inv.grenades = 2;
    expect(takeOut(inv, 'smg', 'one')!.weapons.smg).toEqual({ mag: 10, spare: 60 });
    expect(inv.weapons.smg).toBeUndefined();
    expect(takeOut(inv, 'wood', 'one')!.pieces.wood).toBe(1);
    expect(inv.pieces.wood).toBe(2);
    expect(takeOut(inv, 'wood', 'stack')!.pieces.wood).toBe(2);
    expect(inv.pieces.wood).toBeUndefined();
    expect(takeOut(inv, 'grenade', 'stack')!.grenades).toBe(2);
    expect(inv.grenades).toBe(0);
    expect(takeOut(inv, 'charge', 'one')).toBeNull();
    inv.medkits = 2;
    expect(takeOut(inv, 'medkit', 'one')!.medkits).toBe(1);
    expect(inv.medkits).toBe(1);
    expect(takeOut(inv, 'medkit', 'stack')!.medkits).toBe(1);
    expect(inv.medkits).toBe(0);
  });
});
