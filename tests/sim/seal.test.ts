import { beforeAll, describe, expect, test } from 'vitest';
import { isSealed } from '../../src/sim/seal';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { PIECES } from '../../src/sim/constants';
import { forward, v3 } from '../../src/sim/vec';
import type { PieceKind, PieceState } from '../../src/sim/types';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const bunker = () => map[0].bunker;
let nextId = 1;

/** A piece sitting just outside doorway `i`, spanning it. */
function plug(i: number, kind: PieceKind, level = 0): PieceState {
  const d = bunker().doorways[i];
  const out = forward(d.yaw);
  const off = PIECES[kind].d / 2 + 0.05;
  return {
    id: nextId++, kind, owner: 1, rotY: d.yaw, hp: PIECES[kind].hp,
    pos: v3(d.center.x + out.x * (0.15 + off), d.center.y + level, d.center.z + out.z * (0.15 + off)),
  };
}

describe('isSealed', () => {
  test('open bunker is not sealed', () => {
    expect(isSealed(bunker(), [])).toBe(false);
  });
  test('steel in all three doorways seals', () => {
    expect(isSealed(bunker(), [plug(0, 'steel'), plug(1, 'steel'), plug(2, 'steel')])).toBe(true);
  });
  test('steel in two of three does not seal', () => {
    expect(isSealed(bunker(), [plug(0, 'steel'), plug(1, 'steel')])).toBe(false);
  });
  test('low pieces do not seal, stacked do', () => {
    const low = [0, 1, 2].map((i) => plug(i, 'sandbags'));
    expect(isSealed(bunker(), low)).toBe(false);
    const stacked = [...low, ...[0, 1, 2].map((i) => plug(i, 'sandbags', PIECES.sandbags.h))];
    expect(isSealed(bunker(), stacked)).toBe(true);
  });
  test('container blocking a doorway counts', () => {
    expect(isSealed(bunker(), [plug(0, 'container'), plug(1, 'steel'), plug(2, 'metal')])).toBe(true);
  });
  test('removing one plate unseals', () => {
    const all = [plug(0, 'steel'), plug(1, 'steel'), plug(2, 'steel')];
    expect(isSealed(bunker(), all.slice(1))).toBe(false);
  });
  test('ramps and scaffold never block', () => {
    expect(isSealed(bunker(), [plug(0, 'ramp'), plug(1, 'scaffold'), plug(2, 'steel')])).toBe(false);
  });
});
