/** Where a hotbar drag ended up: what releasing it does. */
export type DragOutcome =
  | { kind: 'none' }
  | { kind: 'select'; slot: number }
  | { kind: 'move'; from: number; to: number }
  | { kind: 'drop'; slot: number; amount: 'one' | 'stack' };

/**
 * Release of a slot dragged from `from`:
 * - on a slot: the same slot selects it, another swaps the two (reorder);
 * - on the bar but between slots: cancel;
 * - out over the game view: drop the item on the ground (whole stack; Shift = one) through the
 *   sim's drop action, exactly like the drop key;
 * - over any other UI (shop, chat, …): cancel. An empty slot has nothing to drop.
 */
export function dragOutcome(from: number, at: { slot: number | null; onBar: boolean; overGame: boolean }, shift: boolean, fromEmpty: boolean): DragOutcome {
  if (at.slot !== null) return at.slot === from ? { kind: 'select', slot: from } : { kind: 'move', from, to: at.slot };
  if (at.onBar || !at.overGame || fromEmpty) return { kind: 'none' };
  return { kind: 'drop', slot: from, amount: shift ? 'one' : 'stack' };
}
