import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { lane, laneAt, landEdge, navNodes } from '../../src/sim/bots/nav';
import { v3, yawOf } from '../../src/sim/vec';
import type { Vec3 } from '../../src/sim/types';

// bot-measure ffa8-mixed seed 3 (713 s): a PRO at the tip of its unfinished bridge from island 2 toward island 7 stood
// there 12 min. The lane from island 5 to island 0 crosses that bridge a few metres from its tip, and nav read the bot
// as standing on that lane (no decks: it ends at home, island 0), so every step home went off the deck's side and the
// edge guard stopped it. Standing on a deck, only a lane that deck runs along is mine.
describe('two lanes crossing near a bridge tip', () => {
  test('the bot at the tip walks off from the island its decks hang off', async () => {
    const m = await Match.create({
      players: [{ name: 'a', isBot: true, difficulty: 'pro' }, ...Array.from({ length: 7 }, (_, i) => ({ name: 'h' + i, isBot: false }))],
      map: 'harbor', seed: 3,
    });
    m.tick(new Map());
    const nodes = navNodes(m.def.islands, m.def.center);
    const l = lane(nodes, 2, 7), rotY = yawOf(l.dir), cross = lane(nodes, 5, 0);
    const off = (p: Vec3) => Math.abs((p.x - cross.origin.x) * cross.dir.z - (p.z - cross.origin.z) * cross.dir.x);
    // Where the two lanes cross (that game's bot stood right there, at the far end of its tip deck).
    const den = l.dir.x * cross.dir.z - l.dir.z * cross.dir.x;
    const k = ((cross.origin.x - l.origin.x) * cross.dir.z - (cross.origin.z - l.origin.z) * cross.dir.x) / den;
    const x = v3(l.origin.x + l.dir.x * k, 2.22, l.origin.z + l.dir.z * k);
    expect(Math.hypot(x.x + 53.8, x.z - 17.6)).toBeLessThan(0.5);
    // Where it stood, 0.35 m off its own lane's centreline and 0.17 m off the other's.
    const at = v3(-53.5, 2.22, 17.7);
    expect(off(at)).toBeLessThan(0.3);
    // Decks out from island 2, the last one under that spot (its far end).
    const sAt = (at.x - l.origin.x) * l.dir.x + (at.z - l.origin.z) * l.dir.z;
    for (let s = landEdge(nodes[2]) - 0.5 + 2; s - 2 < sAt; s += 4) { const c = laneAt(l, s); m.debugPlacePiece('scaffold', v3(c.x, 2, c.z), rotY, 1); }
    m.debugTeleport(1, at);
    m.tick(new Map());
    const nav = (m.botBrain(1) as unknown as { nav: { startNodes(p: Vec3): number[] } }).nav;
    expect(nav.startNodes(at)).toEqual([2]);
    m.dispose();
  }, 60_000);
});
