import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { v3 } from '../../src/sim/vec';

// bot-measure ffa8-pro seed 5 p6 (178 s), ffa8-mixed seed 24 p5: a PRO on the center island with no decks, no cash and
// two hooks stood still ~3 min. Cut off from home, the hook couldn't reach home from any shore (harbor's center is
// 69 m from an island, hook reach 26 m), yet the hook doubled the wait before swimming home (2 × 90 s); and with a
// rival in sight 90 m off on their own island, the walk to the shore never started. It gets home well inside 45 s.
describe('cut off on the center with a hook that cannot reach home', () => {
  test('a broke PRO stranded on the center swims home instead of standing there for minutes', async () => {
    const m = await Match.create({
      players: [{ name: 'a', isBot: true, difficulty: 'pro' }, ...Array.from({ length: 7 }, (_, i) => ({ name: 'h' + i, isBot: false }))],
      map: 'harbor', seed: 5,
    });
    m.tick(new Map());
    m.debugSetTime(5 * 60);
    m.debugGive(1, { grapples: 2 });
    // Away from the center's barrels (their berth is a separate case: botBarrelEdge.test.ts).
    m.debugTeleport(1, v3(-3, m.def.center.groundY + 0.05, -6));
    const home = m.def.islands[0];
    let still = { x: -3, z: -6, t: 0 }, longest = 0, homeAt: number | null = null;
    // Nothing to farm here meanwhile (the others keep the center stations empty).
    const center = (m as unknown as { center: { gold: number; bags: number; steel: number } }).center;
    for (let i = 0; i < 30 * 120 && homeAt === null; i++) {
      center.gold = 0; center.bags = 0; center.steel = 0;
      const s = m.tick(new Map());
      const p = s.players.find((x) => x.id === 1)!;
      const t = i / 30;
      if (!p.alive || Math.hypot(p.pos.x - still.x, p.pos.z - still.z) > 1) still = { x: p.pos.x, z: p.pos.z, t };
      longest = Math.max(longest, t - still.t);
      if (p.alive && Math.hypot(p.pos.x - home.center.x, p.pos.z - home.center.z) < home.radius) homeAt = t;
    }
    m.dispose();
    expect(longest).toBeLessThan(45);
    expect(homeAt).not.toBeNull();
  }, 120_000);
});
