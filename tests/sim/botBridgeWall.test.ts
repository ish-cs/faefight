import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { lane, laneAt, landEdge, navNodes, nodeAt } from '../../src/sim/bots/nav';
import { v3, yawOf } from '../../src/sim/vec';

// bot-measure ffa4-pro seed 14 (NET 42 branch): a rival's wood wall stood across the start of a PRO's finished bridge
// to the center, on its home shore. The bridge counted as done (frontier complete) but not walkable from home (its end
// a wall high), so 'bridge' (storm prep) won and doBridge idled: the PRO stood at its generator from 12:22 to sudden
// death, which measure.ts counted as an "econ hold" (cash rising). It shoots the wall out and walks over instead.
describe('a finished bridge blocked at my end by a wall', () => {
  test("a PRO shoots a rival's wall off its bridge start and walks to the center for the storm", async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const C = m.def.islands.length;
    const l = lane(nodes, 0, C);
    const rotY = yawOf(l.dir);
    const s0 = landEdge(nodes[0]) - 0.5 + 2, end = l.length - landEdge(nodes[C]) + 2;
    for (let s = s0; s < end; s += 4) { const c = laneAt(l, s); m.debugPlacePiece('scaffold', v3(c.x, 2, c.z), rotY, 1); }
    const q = laneAt(l, landEdge(nodes[0]) + 0.5);
    if (!process.env.NO_WALL) m.debugPlacePiece('wood', v3(q.x, 2, q.z), rotY, 2);
    m.debugTeleport(2, v3(m.def.islands[1].center.x, m.def.islands[1].groundY + 0.1, m.def.islands[1].center.z));
    m.debugSetTime(13 * 60 + 40);
    let at: number | null = null;
    for (let i = 0; i < 30 * 60 && at === null; i++) {
      const s = m.tick(new Map());
      const p = s.players.find((x) => x.id === 1)!;
      if (p.alive && nodeAt(nodes, p.pos) === C) at = i / 30;
    }
    if (process.env.BW_TRACE) console.log('at', at, (m.botBrain(1) as unknown as { currentGoal: string }).currentGoal, JSON.stringify(m.tick(new Map()).players[0].pos));
    m.dispose();
    expect(at).not.toBeNull();
  }, 120_000);
});
