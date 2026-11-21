import { describe, expect, test } from 'vitest';
import { PIECES, WEAPONS, SEAL } from '../../src/sim/constants';
import type { PieceKind, WeaponKind } from '../../src/sim/types';

const pieceKinds: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
const guns: WeaponKind[] = ['pistol', 'smg', 'shotgun', 'rifle'];

describe('constants', () => {
  test('every piece has hp and price', () => {
    for (const k of pieceKinds) {
      expect(PIECES[k].hp).toBeGreaterThan(0);
      expect(PIECES[k].price).toBeGreaterThan(0);
    }
  });
  test('wall strength ordering', () => {
    expect(PIECES.steel.hp).toBeGreaterThan(PIECES.metal.hp);
    expect(PIECES.metal.hp).toBeGreaterThan(PIECES.wood.hp);
    expect(PIECES.wood.hp).toBeGreaterThan(PIECES.sandbags.hp);
  });
  test('placing is snappy: short busy times, heavier pieces a little longer', () => {
    expect(Object.fromEntries(pieceKinds.map((k) => [k, PIECES[k].placeSec]))).toEqual({
      sandbags: 0.15, wood: 0.2, metal: 0.25, steel: 0.4, scaffold: 0.15, ramp: 0.2, container: 1.0,
    });
  });
  test('every gun costs money', () => {
    for (const g of guns) expect(WEAPONS[g].price).toBeGreaterThan(0);
  });
  test('sandbags are below the seal block height', () => {
    expect(SEAL.blockHeight).toBe(1.3);
    expect(PIECES.sandbags.h).toBeLessThan(SEAL.blockHeight);
  });
});
