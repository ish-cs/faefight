import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { lane, laneAt, landEdge, navNodes } from '../../src/sim/bots/nav';
import { v3, yawOf } from '../../src/sim/vec';

// botDrown mixed seed 2: a PRO marooned on the center past drive.strandedSec (holding it, farming the gold: no swim)
// picked up 3 decks from a loot bag and walked out to a bridge tip to lay them. Off the island the held stranded clock
// counted as "the ditch under way" and swam it home: a water death nobody caused. Walking out on a bridge isn't the
// ditch; it stays dry.
describe('marooned on the center, decks found', () => {
  test('a PRO walking out on a bridge off the center is not sent swimming home', async () => {
    const m = await Match.create({
      players: [{ name: 'a', isBot: true, difficulty: 'pro' }, ...Array.from({ length: 7 }, (_, i) => ({ name: 'h' + i, isBot: false }))],
      map: 'harbor', seed: 5,
    });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const C = m.def.islands.length;
    // Half bridges off the center toward every rival (whichever one the bot picks, it walks out to a tip).
    for (let i = 1; i < C; i++) {
      const l = lane(nodes, C, i), rotY = yawOf(l.dir), s0 = landEdge(nodes[C]) - 0.5 + 2;
      for (let s = s0; s < s0 + 12; s += 4) { const q = laneAt(l, s); m.debugPlacePiece('scaffold', v3(q.x, 2, q.z), rotY, 0); }
    }
    m.debugSetTime(5 * 60);
    m.debugTeleport(1, v3(-3, m.def.center.groundY + 0.05, -6));
    let alive = true, decksAt: number | null = null, diedAt = 0;
    for (let i = 0; i < 30 * 180 && alive; i++) {
      const t = i / 30;
      // Cut off past drive.strandedSec (90 s), then a few decks turn up (a loot bag's worth: not enough to get home).
      if (t >= 100 && decksAt === null) { m.debugGive(1, { pieces: { scaffold: 3 } }); decksAt = t; }
      const s = m.tick(new Map());
      alive = s.players.find((x) => x.id === 1)!.alive;
      if (!alive) diedAt = t;
    }
    m.dispose();
    expect(alive, `no swim into the water (died at ${diedAt.toFixed(1)} s, decks at ${decksAt})`).toBe(true);
  }, 180_000);
});
