import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { lane, laneAt, landEdge, navNodes } from '../../src/sim/bots/nav';
import { v3, yawOf } from '../../src/sim/vec';

// ffa8-mixed seed 3 (PRO discipline ship 2edcb7de): a PRO's half-laid bridge to the center ended 1.3 m short of a
// crossing bridge (decks across its lane) with a wood wall standing on that crossing bridge's near edge. Nav's frontier
// walks gaps up to STEP_GAP, so it counted the crossing decks as this lane's bridge. doBridge sent the bot to the
// end of the crossing deck: it pressed into the wall at the edge of the gap, slid off and drowned, 6 times, once per
// respawn (storm prep keeps 'bridge' on). Here the same layout pins it at the gap's edge against the wall until the
// storm (a freeze where the physics doesn't slide it off). Either way it must not walk out to the edge.
describe('a bridge whose frontier runs past a gap onto a crossing bridge with a wall across it', () => {
  test('a PRO bridging to the center in storm prep neither drops into the gap nor stands pinned at its edge', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const C = m.def.islands.length;
    const l = lane(nodes, 0, C);
    const rotY = yawOf(l.dir);
    const s0 = landEdge(nodes[0]) - 0.5 + 2, end = l.length - landEdge(nodes[C]);
    // About half the lane laid (decks 4 m long, centre to centre), then a 1.3 m gap.
    let last = s0;
    for (let s = s0; s < s0 + (end - s0) / 2; s += 4) { const c = laneAt(l, s); m.debugPlacePiece('scaffold', v3(c.x, 2, c.z), rotY, 1); last = s; }
    // The crossing deck (2 m along this lane, 4 m across it) and a wood wall across the lane on its near edge.
    const cross = laneAt(l, last + 2 + 1.3 + 1);
    m.debugPlacePiece('scaffold', v3(cross.x, 2, cross.z), rotY + Math.PI / 2, 2);
    const w = laneAt(l, last + 2 + 1.3 + 0.15);
    m.debugPlacePiece('wood', v3(w.x, 2.2, w.z), rotY, 2);
    m.debugTeleport(2, v3(m.def.islands[1].center.x, m.def.islands[1].groundY + 0.1, m.def.islands[1].center.z));
    m.debugGive(1, { cash: 0, pieces: { scaffold: 2 } });
    m.debugSetTime(13 * 60 + 40);
    const drowned: number[] = [];
    let edge = 0, edgeMax = 0;
    const q = laneAt(l, last + 2);
    for (let i = 0; i < 30 * 90; i++) {
      const s = m.tick(new Map());
      for (const e of s.events) if (e.type === 'kill' && e.data.victim === 1 && e.data.inWater) drowned.push(+s.time.toFixed(1));
      const p = s.players.find((x) => x.id === 1)!;
      edge = p.alive && Math.hypot(p.pos.x - q.x, p.pos.z - q.z) < 2 ? edge + 1 / 30 : 0;
      edgeMax = Math.max(edgeMax, edge);
    }
    m.dispose();
    expect(drowned).toEqual([]);
    expect(edgeMax).toBeLessThan(5); // without the check: pinned at the edge ~70 s, to the storm
  }, 180_000);
});
