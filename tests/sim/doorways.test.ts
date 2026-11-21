import { beforeAll, describe, expect, test } from 'vitest';
import { DoorwayTracker, doorwaysBlocked, isSealed } from '../../src/sim/seal';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { PIECES } from '../../src/sim/constants';
import { forward, v3 } from '../../src/sim/vec';
import type { PieceKind, PieceState, Snapshot } from '../../src/sim/types';
import { Match } from '../../src/sim/match';
import { SnapshotEncoder } from '../../src/net/snapshotCodec';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
let nextId = 1;

/** A piece sitting just outside doorway `i` of island `isl`'s bunker, spanning it. */
function plug(i: number, kind: PieceKind = 'steel', level = 0, isl = 0): PieceState {
  const d = map[isl].bunker.doorways[i];
  const out = forward(d.yaw);
  const off = PIECES[kind].d / 2 + 0.05;
  return {
    id: nextId++, kind, owner: 2, rotY: d.yaw, hp: PIECES[kind].hp,
    pos: v3(d.center.x + out.x * (0.15 + off), d.center.y + level, d.center.z + out.z * (0.15 + off)),
  };
}
const count = (pieces: PieceState[]) => doorwaysBlocked(map[0].bunker, pieces).filter(Boolean).length;

describe('doorwaysBlocked', () => {
  test('counts up as walls go on each doorway and back down as they come off', () => {
    const walls = [plug(0), plug(1), plug(2)];
    expect(count([])).toBe(0);
    expect(doorwaysBlocked(map[0].bunker, walls.slice(0, 1))).toEqual([true, false, false]);
    expect(count(walls.slice(0, 2))).toBe(2);
    expect(count(walls)).toBe(3);
    expect(isSealed(map[0].bunker, walls)).toBe(true);
    expect(count(walls.slice(1))).toBe(2);
    expect(doorwaysBlocked(map[0].bunker, [walls[2]])).toEqual([false, false, true]);
  });
  test('walkable or low pieces do not block a doorway; a stacked pair does', () => {
    expect(count([plug(0, 'ramp'), plug(1, 'scaffold'), plug(2, 'sandbags')])).toBe(0);
    expect(count([plug(2, 'sandbags'), plug(2, 'sandbags', PIECES.sandbags.h)])).toBe(1);
  });
  test('all three blocked agrees with isSealed across combinations', () => {
    const kinds: PieceKind[] = ['steel', 'sandbags', 'container', 'ramp'];
    for (const a of kinds) for (const b of kinds) for (const c of kinds) {
      const ps = [plug(0, a), plug(1, b), plug(2, c)];
      expect(count(ps) === 3).toBe(isSealed(map[0].bunker, ps));
    }
  });
});

describe('DoorwayTracker', () => {
  test('recomputes a bunker only when blocking pieces near it change', () => {
    const t = new DoorwayTracker(map.map((i) => i.bunker));
    const pieces: PieceState[] = [];
    expect(t.update(pieces)).toEqual([0, 0]);
    expect(t.recomputes).toBe(0); // nothing nearby yet: no flood fill at all

    pieces.push(plug(0));
    expect(t.update(pieces)).toEqual([1, 0]);
    expect(t.recomputes).toBe(1); // only bunker 0

    expect(t.update(pieces)).toEqual([1, 0]);
    expect(t.recomputes).toBe(1); // nothing changed: cached

    pieces.push(plug(1, 'steel', 0, 1)); // on the other island
    expect(t.update(pieces)).toEqual([1, 1]);
    expect(t.recomputes).toBe(2); // only bunker 1

    // A piece far from every bunker, and a walkable ramp next to one: neither triggers a recompute.
    pieces.push({ id: nextId++, kind: 'steel', owner: 2, rotY: 0, hp: 1, pos: v3(map[0].center.x, map[0].groundY, map[0].center.z) });
    pieces.push(plug(2, 'ramp'));
    t.update(pieces);
    expect(t.recomputes).toBe(2);

    pieces.push(plug(1), plug(2));
    expect(t.update(pieces)[0]).toBe(3);
    pieces.splice(0, 1); // first wall destroyed
    expect(t.update(pieces)[0]).toBe(2);
    expect(t.recomputes).toBe(4);
  });
});

describe('Match: doorsBlocked', () => {
  test('the owner sees their own count, wired only to them; sealed reads 3; removal counts back down', async () => {
    const m = await Match.create({ players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] });
    const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;
    expect(me(m.tick(new Map())).doorsBlocked).toBe(0);
    const ids = [0, 1].map((d) => m.debugPlugDoor(0, d, 2));
    let s = m.tick(new Map());

    expect(me(s).doorsBlocked).toBe(2);
    expect(s.players.find((p) => p.id === 2)!.doorsBlocked).toBe(0);
    const enc = new SnapshotEncoder();
    enc.push(s);
    expect(enc.take(1).players.find((p) => p.id === 1)!.doorsBlocked).toBe(2);
    expect(enc.take(2).players.find((p) => p.id === 1)!.doorsBlocked).toBeUndefined(); // never sent to others
    ids.push(m.debugPlugDoor(0, 2, 2));
    s = m.tick(new Map());
    expect(s.sealed[0]).toBe(true);
    expect(me(s).doorsBlocked).toBe(3);
    m.debugRemovePiece(ids[0]);
    s = m.tick(new Map());
    expect(s.sealed[0]).toBe(false);
    expect(me(s).doorsBlocked).toBe(2);
  });
});
