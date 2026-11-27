import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { lane, laneAt, landEdge, navNodes, nodeAt } from '../../src/sim/bots/nav';
import { v3, yawOf } from '../../src/sim/vec';

// bot-measure ffa4-pro seed 5: a PRO's finished bridge to the center started behind two of its own sandbags. The
// bridge counted as done (nothing left to lay) but not walkable from home (its end a sandbag high), so at 13:43,
// storm prep (never given up) on, it stood 76 s at home. Nav takes a bridge end up to HOP_UP as walkable and the
// bot hops a low piece in its way (it gets to the center; before: never).
describe('a finished bridge blocked at my end', () => {
  test('a PRO clears its own sandbags off the bridge start and walks to the center for the storm', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'pro' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const C = m.def.islands.length;
    const l = lane(nodes, 0, C);
    const rotY = yawOf(l.dir);
    const s0 = landEdge(nodes[0]) - 0.5 + 2, end = l.length - landEdge(nodes[C]) + 2;
    for (let s = s0; s < end; s += 4) { const c = laneAt(l, s); m.debugPlacePiece('scaffold', v3(c.x, 2, c.z), rotY, 1); }
    const q = laneAt(l, landEdge(nodes[0]) + 0.5);
    if (!process.env.NO_BAGS) for (const side of [-0.66, 0.66]) m.debugPlacePiece('sandbags', v3(q.x - l.dir.z * side, 2, q.z + l.dir.x * side), rotY + Math.PI / 2, 1);
    m.debugTeleport(2, v3(m.def.islands[1].center.x, m.def.islands[1].groundY + 0.1, m.def.islands[1].center.z));
    m.debugSetTime(13 * 60 + 40);
    let at: number | null = null;
    for (let i = 0; i < 30 * 60 && at === null; i++) {
      const s = m.tick(new Map());
      const p = s.players.find((x) => x.id === 1)!;
      if (p.alive && nodeAt(nodes, p.pos) === C) at = i / 30;
    }
    if (process.env.BE_TRACE) console.log('at', at, (m.botBrain(1) as unknown as { currentGoal: string }).currentGoal, JSON.stringify(m.tick(new Map()).players[0].pos));
    m.dispose();
    expect(at).not.toBeNull();
  }, 120_000);
});
