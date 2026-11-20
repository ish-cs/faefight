import { describe, expect, test } from 'vitest';
import { chipState } from '../../src/client/chipState';

describe('bunker chip state', () => {
  test('eliminated owner shows OUT, even if the bunker reads open or sealed', () => {
    expect(chipState(false, true)).toBe('OUT');
    expect(chipState(true, true)).toBe('OUT');
  });
  test('alive owner shows SEALED or OPEN', () => {
    expect(chipState(true, false)).toBe('SEALED');
    expect(chipState(false, false)).toBe('OPEN');
  });
});
