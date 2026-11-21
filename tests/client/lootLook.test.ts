import { describe, expect, test } from 'vitest';
import { lootItems, lootLabel } from '../../src/client/lootLook';
import { emptyInventory } from '../../src/sim/economy';
import type { Inventory } from '../../src/sim/types';

const inv = (p: Partial<Inventory>): Inventory => ({ ...emptyInventory(), ...p });

describe('loot look', () => {
  test('every item type maps to a model or icon and a label', () => {
    expect(lootItems(inv({ weapons: { rifle: { mag: 25, spare: 75 } } }))).toEqual([{ model: 'gun', kind: 'rifle', text: 'Rifle · 25/75' }]);
    for (const g of ['pistol', 'smg', 'shotgun', 'rocket'] as const)
      expect(lootItems(inv({ weapons: { [g]: { mag: 1, spare: 2 } } }))[0]).toMatchObject({ model: 'gun', kind: g, text: expect.stringMatching(/ · 1\/2$/) });
    expect(lootItems(inv({ pieces: { wood: 4 } }))).toEqual([{ model: 'piece', kind: 'wood', text: 'Wood ×4' }]);
    for (const k of ['sandbags', 'metal', 'steel', 'scaffold', 'ramp', 'container'] as const)
      expect(lootItems(inv({ pieces: { [k]: 1 } }))[0]).toMatchObject({ model: 'piece', kind: k });
    expect(lootItems(inv({ pieces: { steel: 1 } }))[0].text).toBe('Steel plate');
    expect(lootItems(inv({ cash: 120 }))).toEqual([{ model: 'icon', kind: 'cash', text: '$120' }]);
    expect(lootItems(inv({ grenades: 2 }))[0]).toEqual({ model: 'icon', kind: 'grenade', text: 'Grenade ×2' });
    expect(lootItems(inv({ charges: 1 }))[0]).toEqual({ model: 'icon', kind: 'charge', text: 'Breach charge' });
    expect(lootItems(inv({ medkits: 3 }))[0]).toEqual({ model: 'icon', kind: 'medkit', text: 'Medkit ×3' });
    for (const k of ['shieldSmall', 'shieldBig', 'healPotion', 'speedPotion'] as const)
      expect(lootItems(inv({ potions: { [k]: 2 } }))[0]).toMatchObject({ model: 'icon', kind: k, text: expect.stringMatching(/×2$/) });
    expect(lootItems(inv({ weapons: { fists: { mag: 0, spare: 0 } } }))).toEqual([]);
  });

  test('one item: its own label; a death drop: a bag with a list, guns first, capped', () => {
    expect(lootLabel(lootItems(inv({ pieces: { wood: 4 } })))).toEqual(['Wood ×4']);
    const death = lootItems(inv({ cash: 300, medkits: 1, grenades: 2, pieces: { wood: 2, metal: 1 }, weapons: { smg: { mag: 10, spare: 40 }, pistol: { mag: 12, spare: 12 } } }));
    expect(death[0].model).toBe('gun');
    expect(death[death.length - 1].text).toBe('$300');
    const label = lootLabel(death);
    expect(label[0]).toBe('Bag (7)');
    expect(label).toHaveLength(1 + 5 + 1);
    expect(label[label.length - 1]).toBe('+2 more');
    expect(lootLabel([])).toEqual([]);
  });
});
