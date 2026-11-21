import type { GunKind, Inventory, PieceKind, PotionKind } from '../sim/types';

/**
 * What a loot bag on the ground looks like: each item as a 3D model (guns, building pieces) or a
 * billboard of its hotbar/shop icon (explosives, medkits, potions, cash), plus a floating label.
 */
export type LootModel =
  | { model: 'gun'; kind: GunKind }
  | { model: 'piece'; kind: PieceKind }
  | { model: 'icon'; kind: 'grenade' | 'charge' | 'medkit' | PotionKind | 'cash' };
export type LootItem = LootModel & { text: string };

const NAME: Record<string, string> = {
  pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket launcher',
  sandbags: 'Sandbags', wood: 'Wood', metal: 'Sheet metal', steel: 'Steel plate', scaffold: 'Scaffold', ramp: 'Ramp', container: 'Container',
  grenade: 'Grenade', charge: 'Breach charge', medkit: 'Medkit',
  shieldSmall: 'Small shield', shieldBig: 'Big shield', healPotion: 'Heal potion', speedPotion: 'Speed potion',
};
const count = (name: string, n: number) => (n > 1 ? `${name} ×${n}` : name);

/** Every item in the bag, most notable first (guns, then pieces, explosives, healing, cash). */
export function lootItems(inv: Inventory): LootItem[] {
  const out: LootItem[] = [];
  for (const [k, a] of Object.entries(inv.weapons) as [GunKind | 'fists', { mag: number; spare: number } | undefined][]) {
    if (!a || k === 'fists') continue;
    out.push({ model: 'gun', kind: k, text: `${NAME[k]} · ${a.mag}/${a.spare}` });
  }
  for (const [k, n] of Object.entries(inv.pieces) as [PieceKind, number | undefined][]) if (n && n > 0) out.push({ model: 'piece', kind: k, text: count(NAME[k], n) });
  if (inv.grenades > 0) out.push({ model: 'icon', kind: 'grenade', text: count(NAME.grenade, inv.grenades) });
  if (inv.charges > 0) out.push({ model: 'icon', kind: 'charge', text: count(NAME.charge, inv.charges) });
  if (inv.medkits > 0) out.push({ model: 'icon', kind: 'medkit', text: count(NAME.medkit, inv.medkits) });
  for (const [k, n] of Object.entries(inv.potions) as [PotionKind, number | undefined][]) if (n && n > 0) out.push({ model: 'icon', kind: k, text: count(NAME[k], n) });
  if (inv.cash > 0) out.push({ model: 'icon', kind: 'cash', text: `$${inv.cash}` });
  return out;
}

/** Label lines over a bag: one item's own line; several = "Bag" then a line per item (at most 5 + "…"). */
export function lootLabel(items: LootItem[]): string[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [items[0].text];
  const lines = items.slice(0, 5).map((i) => i.text);
  if (items.length > 5) lines.push(`+${items.length - 5} more`);
  return [`Bag (${items.length})`, ...lines];
}
