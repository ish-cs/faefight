import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { GRAPPLE } from '../../src/sim/constants';
import { lane, laneAt, landEdge, navNodes, nodeAt } from '../../src/sim/bots/nav';
import { buildMapDef, grappleRange } from '../../src/sim/map';
import { v3, yawOf } from '../../src/sim/vec';

// A hook gets a bot over to a rival it can't walk to: with a seal kit and a hook, and its bridge laid to within hook
// reach (the hook reaches 26 m, the islands are 36 m apart: a few decks first), a PRO bot walks out to the tip, hooks
// across and plugs the rival's doors. Before, seal and attack needed a finished bridge and never scored here.
describe('hooking over to seal', () => {
  test('a PRO bot at a part-built bridge hooks across and seals', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const l = lane(nodes, 0, 1);
    const rotY = yawOf(l.dir);
    // Four decks out from my shore.
    for (let i = 0; i < 4; i++) { const c = laneAt(l, landEdge(nodes[0]) - 0.5 + 2 + 4 * i); m.debugPlacePiece('scaffold', v3(c.x, 2, c.z), rotY, 1); }
    const tip = landEdge(nodes[0]) - 0.5 + 16;
    const left = l.length - landEdge(nodes[1]) - tip;
    expect(left).toBeGreaterThan(GRAPPLE.range - 10); // no hooking straight from the shore
    expect(left + 2.5).toBeLessThan(GRAPPLE.range - 1); // but from the tip
    // The rival is out at the center island (their doors are open, nobody home).
    m.debugTeleport(2, v3(m.def.center.center.x, m.def.center.groundY + 0.1, m.def.center.center.z));
    m.debugGive(1, { grapples: 3, pieces: { wood: 3, scaffold: 0 } });
    m.debugSetTime(240);
    let crossed = false, sealedBy1 = 0;
    for (let i = 0; i < 30 * 60 && sealedBy1 === 0; i++) {
      const s = m.tick(new Map());
      const p = s.players.find((q) => q.id === 1)!;
      if (p.alive && nodeAt(nodes, p.pos) === 1) crossed = true;
      for (const e of s.events) if (e.type === 'placed' && e.data.by === 1 && e.data.kind === 'wood' && nodeAt(nodes, s.pieces.find((x) => x.id === e.data.piece)?.pos ?? v3(999, 0, 999)) === 1) sealedBy1++;
    }
    expect(crossed).toBe(true);
    expect(sealedBy1).toBeGreaterThan(0);
  }, 120_000);
});

describe('grapple reach per map', () => {
  test('a few decks short of the narrowest island gap: harbor 26 m (36 m gaps), container yard 18 m (26 m gaps)', () => {
    for (let n = 2; n <= 8; n++) {
      const h = buildMapDef(n, 'harbor', 1), y = buildMapDef(n, 'yard', 1);
      expect(grappleRange(h.islands), `harbor ${n}`).toBe(GRAPPLE.range);
      expect(grappleRange(y.islands), `yard ${n}`).toBeCloseTo(18, 0);
      for (const d of [h, y]) {
        const isl = d.islands;
        let gap = Infinity;
        for (let i = 0; i < isl.length; i++) for (let j = i + 1; j < isl.length; j++)
          gap = Math.min(gap, Math.hypot(isl[i].center.x - isl[j].center.x, isl[i].center.z - isl[j].center.z) - isl[i].radius - isl[j].radius);
        expect(gap - grappleRange(isl)).toBeGreaterThanOrEqual(GRAPPLE.gapMargin - 1e-9);
      }
    }
  });

  test('the match uses it: the hook reaches as far as the map allows and no further', async () => {
    for (const map of ['harbor', 'yard'] as const) {
      const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], map, seed: 1 });
      expect(m.hookRange).toBeCloseTo(grappleRange(m.def.islands), 6);
      m.dispose();
    }
  });
});
