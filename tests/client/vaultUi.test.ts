import { afterEach, describe, expect, test, vi } from 'vitest';
import { emptyInventory } from '../../src/sim/economy';
import { bumpLoadout, cellCount, HoldTap, keepCashAction, loadoutKinds, moveAction, moveCount, vaultCells, VaultQueue, VAULT_PACE_MS } from '../../src/client/vaultUi';
import { LOADOUT_MAX_KINDS } from '../../src/sim/vault';

const m = (o: Partial<{ shift: boolean; one: boolean; exact: number; drag: boolean }> = {}) => ({ shift: false, one: false, exact: 0, drag: true, ...o });

describe('stack splitting', () => {
  test('drag: whole, Shift half (rounded up), Ctrl/Alt one; exact wins and is capped', () => {
    expect(moveCount('wood', 25, m())).toBe(25);
    expect(moveCount('wood', 25, m({ shift: true }))).toBe(13);
    expect(moveCount('wood', 1, m({ shift: true }))).toBe(1);
    expect(moveCount('wood', 25, m({ one: true }))).toBe(1);
    expect(moveCount('wood', 25, m({ exact: 10 }))).toBe(10);
    expect(moveCount('wood', 25, m({ exact: 40, shift: true }))).toBe(25);
    expect(moveCount('wood', 0, m())).toBe(0);
  });
  test('click: the whole stack (or the exact amount)', () => {
    expect(moveCount('medkit', 3, m({ drag: false }))).toBe(3);
    expect(moveCount('medkit', 3, m({ drag: false, exact: 2 }))).toBe(2);
  });
  test('guns and the hook always move whole', () => {
    expect(moveCount('smg', 1, m({ shift: true }))).toBe(1);
    expect(moveCount('grapple', 3, m({ one: true }))).toBe(3);
  });
  test('moveAction: deposit from the hotbar, withdraw from the vault', () => {
    const inv = emptyInventory();
    inv.pieces.wood = 25;
    inv.weapons.smg = { mag: 20, spare: 40 };
    expect(moveAction('wood', 10, 'carried', inv)).toEqual({ deposit: { pieces: { wood: 10 } } });
    expect(moveAction('smg', 1, 'stored', inv)).toEqual({ withdraw: { weapons: { smg: { mag: 20, spare: 40 } } } });
    expect(moveAction('medkit', 1, 'carried', inv)).toBeNull();
    expect(moveAction('wood', 0, 'carried', inv)).toBeNull();
  });
});

describe('grid and loadout helpers', () => {
  test('vault cells are auto-sorted: guns, pieces, gear, potions', () => {
    const v = emptyInventory();
    v.potions.healPotion = 1; v.medkits = 2; v.pieces.steel = 4; v.pieces.wood = 3; v.weapons.rifle = { mag: 5, spare: 10 };
    expect(vaultCells(v).map((c) => c.kind)).toEqual(['rifle', 'wood', 'steel', 'medkit', 'healPotion']);
    expect(cellCount('rifle', v)).toBe('5/10');
    expect(cellCount('wood', v)).toBe('×3');
  });
  test('loadout kinds: carried, stored or already listed', () => {
    const inv = emptyInventory(), v = emptyInventory();
    inv.pieces.wood = 1; v.medkits = 1;
    expect(loadoutKinds(inv, v, { items: { grenade: 2 }, keep: 0, buy: false })).toEqual(['wood', 'grenade', 'medkit']);
  });
  test('bumpLoadout clamps and caps the number of kinds', () => {
    let l = { items: {}, keep: 0, buy: false } as Parameters<typeof bumpLoadout>[0];
    l = bumpLoadout(l, 'wood', 5)!;
    expect(l.items).toEqual({ wood: 5 });
    expect(bumpLoadout(l, 'smg', 3)!.items.smg).toBe(1);
    expect(bumpLoadout(l, 'wood', -10)!.items).toEqual({});
    expect(bumpLoadout({ items: {}, keep: 0, buy: false }, 'wood', -1)).toBeNull();
    const full = { items: { wood: 1, metal: 1, steel: 1, medkit: 1 }, keep: 0, buy: false };
    expect(Object.keys(full.items).length).toBe(LOADOUT_MAX_KINDS);
    expect(bumpLoadout(full, 'grenade', 1)).toBeNull();
    expect(bumpLoadout(full, 'wood', 1)!.items.wood).toBe(2);
  });
  test('keep $X on me: deposit the excess or withdraw the shortfall', () => {
    expect(keepCashAction(300, 0, 100)).toEqual({ deposit: { cash: 200 } });
    expect(keepCashAction(20, 500, 100)).toEqual({ withdraw: { cash: 80 } });
    expect(keepCashAction(20, 30, 100)).toEqual({ withdraw: { cash: 30 } });
    expect(keepCashAction(100, 50, 100)).toBeNull();
  });
});

describe('queue and hold-E', () => {
  afterEach(() => vi.useRealTimers());
  test('vault moves go out one per pace, in order', () => {
    const q = new VaultQueue();
    q.add({ deposit: { cash: 1 } }); q.add({ deposit: { cash: 2 } });
    expect(q.take(0)).toEqual({ deposit: { cash: 1 } });
    expect(q.take(VAULT_PACE_MS - 1)).toBeNull();
    expect(q.take(VAULT_PACE_MS)).toEqual({ deposit: { cash: 2 } });
    expect(q.take(10_000)).toBeNull();
  });
  test('tap opens, hold banks (once, not also the tap)', () => {
    vi.useFakeTimers();
    const h = new HoldTap(450);
    const tap = vi.fn(), hold = vi.fn();
    h.start(hold); vi.advanceTimersByTime(100); h.release(tap);
    expect([tap.mock.calls.length, hold.mock.calls.length]).toEqual([1, 0]);
    h.start(hold); vi.advanceTimersByTime(500); h.release(tap);
    expect([tap.mock.calls.length, hold.mock.calls.length]).toEqual([1, 1]);
  });
});
