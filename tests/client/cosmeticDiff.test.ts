import { describe, expect, test } from 'vitest';
import { brokenDiff } from '../../src/client/world/cosmeticDiff';

describe('brokenDiff (World.syncCosmetics)', () => {
  test('nothing broken, nothing hidden: no work', () => {
    expect(brokenDiff(new Set(), [])).toEqual({ hide: [], reset: false });
  });
  test('hides only ids not hidden yet', () => {
    expect(brokenDiff(new Set([3]), [3, 7, 9])).toEqual({ hide: [7, 9], reset: false });
  });
  test('unchanged list is a no-op (length fast path)', () => {
    expect(brokenDiff(new Set([3, 7]), [3, 7])).toEqual({ hide: [], reset: false });
  });
  test('a shorter list (new match) resets and re-hides the current ids', () => {
    expect(brokenDiff(new Set([3, 7, 9]), [4])).toEqual({ hide: [4], reset: true });
  });
  test('applying the diff converges on exactly the broken set', () => {
    const hidden = new Set<number>();
    for (const broken of [[1], [1, 5], [1, 5], [1, 5, 2], [8]]) {
      const { hide, reset } = brokenDiff(hidden, broken);
      if (reset) hidden.clear();
      for (const id of hide) hidden.add(id);
      expect([...hidden].sort()).toEqual([...broken].sort());
    }
  });
});
