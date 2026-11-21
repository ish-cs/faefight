import { describe, expect, test } from 'vitest';
import { DOCK, PLAYER } from '../../src/sim/constants';
import { buildMapDef, MAP_TEMPLATES, type DockDef } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { lane, laneS, navNodes, LANE_OFFSET } from '../../src/sim/bots/nav';
import type { PlayerInput, Snapshot, Vec3 } from '../../src/sim/types';
import { dist2D, rotateY, sub, v3 } from '../../src/sim/vec';

async function match(n = 2, map: 'harbor' | 'yard' = 'harbor', seed = 1) {
  return Match.create({ players: Array.from({ length: n }, (_, i) => ({ name: `p${i + 1}`, isBot: false })), map, seed });
}
const tick = (m: Match, sec: number, inputs = new Map<number, PlayerInput>()) => {
  let s: Snapshot = m.tick(inputs);
  const all: Snapshot[] = [s];
  for (let i = 1; i < Math.round(sec * 30); i++) { s = m.tick(inputs); all.push(s); }
  return { last: s, events: all.flatMap((x) => x.events), all };
};
/** Top of a section's deck, at its middle. */
const top = (d: DockDef): Vec3 => v3(d.center.x, d.center.y + d.half.y, d.center.z);
const inside = (d: DockDef, p: Vec3, pad = 0) => {
  const l = rotateY(sub(p, d.center), -d.rotY);
  return Math.abs(l.x) <= d.half.x + pad && Math.abs(l.z) <= d.half.z + pad;
};
function place(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = (m as unknown as { s: { players: Map<number, { invulnUntil: number; spawnProtected?: boolean }> } }).s.players.get(id)!;
  p.invulnUntil = 0;
  p.spawnProtected = false;
}

describe('pier layout', () => {
  test('every player island has a pier along its bridge lane, ending clear of the far shore', () => {
    for (const t of MAP_TEMPLATES) for (let n = 2; n <= 8; n++) {
      const def = buildMapDef(n, t);
      const docks = def.docks ?? [];
      expect(new Set(docks.map((d) => d.id)).size).toBe(docks.length);
      const nodes = navNodes(def.islands, def.center);
      for (const isl of def.islands) {
        const mine = docks.filter((d) => d.island === isl.index);
        if (t === 'yard' && n === 3) continue; // center island too close: no room for a pier (checked below)
        expect(mine.length, `${t} ${n}p island ${isl.index}`).toBeGreaterThanOrEqual(DOCK.minLen / DOCK.chunk);
        const to = n === 2 ? 1 - isl.index : nodes.length - 1;
        const l = lane(nodes, isl.index, to);
        for (const d of mine) {
          // On the lane line (laneOff 0), deck top just above the island ground.
          const off = Math.abs((d.center.x - l.origin.x) * l.dir.z - (d.center.z - l.origin.z) * l.dir.x);
          expect(off).toBeLessThan(1e-6);
          expect(d.center.y + d.half.y).toBeCloseTo(isl.groundY + DOCK.lip, 6);
        }
        // Row 0 touches the island; the last row leaves minWater of open water.
        const tip = Math.max(...mine.map((d) => laneS(l, d.center) + DOCK.chunk / 2));
        const far = nodes[to];
        const shore = dist2D(isl.center, far.center) - Math.sqrt(far.radius ** 2 - LANE_OFFSET ** 2);
        expect(shore - tip).toBeGreaterThanOrEqual(DOCK.minWater - 1e-6);
        expect(Math.min(...mine.map((d) => laneS(l, d.center) - DOCK.chunk / 2))).toBeLessThan(Math.sqrt(isl.radius ** 2 - (LANE_OFFSET + DOCK.width / 2) ** 2));
      }
      // Never on top of another island, the center island, cover, hazards or props.
      for (const d of docks) {
        for (const o of def.islands) if (o.index !== d.island) expect(dist2D(o.center, d.center)).toBeGreaterThan(o.radius + 3);
        expect(dist2D(def.center.center, d.center)).toBeGreaterThan(def.center.radius + 3);
        for (const h of def.hazards) expect(inside(d, h.pos, 0.6), `hazard ${h.id} on dock ${d.id}`).toBe(false);
        for (const s of def.statics) expect(inside(d, s.center, Math.max(s.half.x, s.half.z))).toBe(false);
      }
    }
  });
});

describe('breaking piers', () => {
  test('a rocket on a section breaks it (and only chips the next one); bullets never do', async () => {
    const m = await match();
    const d = m.def.docks!.find((x) => x.island === 0 && x.row === 2)!;
    m.debugExplode('rocket', top(d), 2);
    const { last, events } = tick(m, 0.2);
    const broke = events.filter((e) => e.type === 'dockBroken');
    expect(broke.map((e) => e.data.id)).toEqual([d.id]);
    expect(broke[0].data.by).toBe(2);
    expect(last.docks).toEqual([d.id]);
    expect(last.dockHurt?.length).toBeGreaterThan(0);
    expect(last.dockHurt).not.toContain(d.id);
    // Open water where it was.
    expect(m.debugGroundAt(d.center.x, d.center.z)).toBeNull();
  });

  test('a grenade on the planks breaks a section, one in the air only chips it; a charge breaks one; the island core never breaks', async () => {
    const m = await match();
    const d = m.def.docks!.find((x) => x.island === 1 && x.row === 1)!;
    // A grenade two metres over the deck only chips it; one on the planks goes through.
    m.debugExplode('grenade', v3(d.center.x, d.center.y + d.half.y + 2, d.center.z));
    expect(tick(m, 0.2).last.docks ?? []).toEqual([]);
    m.debugExplode('grenade', top(d));
    expect(tick(m, 0.2).last.docks).toEqual([d.id]);
    const e = m.def.docks!.find((x) => x.island === 0 && x.row === 2)!;
    m.debugExplode('charge', top(e));
    expect(tick(m, 0.2).last.docks).toEqual([d.id, e.id]);
    const isl = m.def.islands[0];
    m.debugExplode('charge', v3(isl.center.x, isl.groundY + 0.1, isl.center.z));
    tick(m, 0.2);
    expect(m.debugGroundAt(isl.center.x, isl.center.z)).not.toBeNull();
  });

  test('a player standing on a broken section drops into the water', async () => {
    const m = await match();
    const d = m.def.docks!.find((x) => x.island === 0 && x.row === 2)!;
    place(m, 1, top(d));
    tick(m, 0.5);
    // Under the deck, out of the charge's player reach: the fall is what kills.
    m.debugExplode('charge', v3(d.center.x, d.center.y - 1, d.center.z), 2);
    const { events } = tick(m, 3);
    expect(events.some((e) => e.type === 'kill' && e.data.victim === 1 && e.data.inWater)).toBe(true);
  });

  test('pieces built on a broken section collapse', async () => {
    const m = await match();
    const d = m.def.docks!.find((x) => x.island === 0 && x.row === 1)!;
    const id = m.debugPlacePiece('wood', top(d), d.rotY, 1);
    expect(tick(m, 0.1).last.pieces.some((p) => p.id === id)).toBe(true);
    m.debugExplode('charge', v3(d.center.x, d.center.y - 0.5, d.center.z), 2);
    const { events } = tick(m, 0.2);
    expect(events.some((e) => e.type === 'destroyed' && e.data.piece === id)).toBe(true);
  });

  test('broken piers survive fork and a checkpoint round trip (same snapshots afterwards)', async () => {
    const { saveMatch, loadMatch } = await import('../../src/net/matchCheckpoint');
    const m = await match();
    const d = m.def.docks!.find((x) => x.island === 0 && x.row === 0)!;
    m.debugExplode('rocket', top(d), 2);
    tick(m, 0.2);
    const f = m.fork();
    const c = await loadMatch(saveMatch(m));
    for (const x of [m, f, c]) x.debugExplode('grenade', top(m.def.docks!.find((y) => y.island === 0 && y.row === 1)!), 2);
    const a = tick(m, 0.5).last, b = tick(f, 0.5).last, k = tick(c, 0.5).last;
    expect(b.docks).toEqual(a.docks);
    expect(k.docks).toEqual(a.docks);
    expect(b.dockHurt).toEqual(a.dockHurt);
    expect(k.dockHurt).toEqual(a.dockHurt);
    for (const x of [m, f, c]) expect(x.debugGroundAt(d.center.x, d.center.z)).toBeNull();
  });

  test('hand-made maps without piers still work', async () => {
    const m = await Match.create({ players: [{ name: 'p', isBot: false }], practice: true });
    expect(tick(m, 0.2).last.docks).toBeUndefined();
    expect(PLAYER.radius).toBeGreaterThan(0);
  });
});
