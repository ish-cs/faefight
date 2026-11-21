import { describe, expect, test } from 'vitest';
import { dragOutcome } from '../../src/client/hotbarDrag';

const at = (slot: number | null, onBar: boolean, overGame: boolean) => ({ slot, onBar, overGame });

describe('hotbar drag outcome', () => {
  test('release on the same slot selects it; on another slot reorders', () => {
    expect(dragOutcome(2, at(2, true, false), false, false)).toEqual({ kind: 'select', slot: 2 });
    expect(dragOutcome(2, at(5, true, false), false, false)).toEqual({ kind: 'move', from: 2, to: 5 });
  });
  test('out over the game view drops the whole stack; Shift drops one', () => {
    expect(dragOutcome(1, at(null, false, true), false, false)).toEqual({ kind: 'drop', slot: 1, amount: 'stack' });
    expect(dragOutcome(1, at(null, false, true), true, false)).toEqual({ kind: 'drop', slot: 1, amount: 'one' });
  });
  test('back on the bar (between slots), over other UI, or from an empty slot: nothing', () => {
    expect(dragOutcome(1, at(null, true, false), false, false)).toEqual({ kind: 'none' });
    expect(dragOutcome(1, at(null, false, false), false, false)).toEqual({ kind: 'none' });
    expect(dragOutcome(1, at(null, false, true), false, true)).toEqual({ kind: 'none' });
  });
});
