import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { v3 } from '../../src/sim/vec';
import type { Vec3 } from '../../src/sim/types';

/** Furthest (m) a PRO gets in 30 s from the edge of the center barrel's berth, its route to the gold running at it. */
async function walkFromBarrelEdge(rivalAt: Vec3 | null): Promise<number> {
  const m = await Match.create({
    players: [{ name: 'a', isBot: true, difficulty: 'pro' }, ...Array.from({ length: 7 }, (_, i) => ({ name: 'h' + i, isBot: false }))],
    map: 'harbor', seed: 24,
  });
  m.tick(new Map());
  const barrel = m.def.hazards.find((h) => h.kind === 'barrel' && Math.hypot(h.pos.x - 3.63, h.pos.z - 7.79) < 0.1);
  expect(barrel, 'the center barrel this test is built around').toBeTruthy();
  m.debugSetTime(5 * 60);
  (m as unknown as { center: { gold: number } }).center.gold = 1000;
  const start = v3(6.7, m.def.center.groundY + 0.05, 5.3);
  m.debugTeleport(1, start);
  if (rivalAt) { m.debugPlacePiece('scaffold', v3(rivalAt.x, 2, rivalAt.z), 0, 3); m.debugTeleport(2, v3(rivalAt.x, 2.6, rivalAt.z)); }
  let far = 0;
  for (let i = 0; i < 30 * 30; i++) {
    const s = m.tick(new Map());
    const p = s.players.find((x) => x.id === 1)!;
    far = Math.max(far, Math.hypot(p.pos.x - start.x, p.pos.z - start.z));
  }
  m.dispose();
  return far;
}

// bot-measure ffa8-mixed seed 24 (and seeds 5/18/60/... p5, ffa8-pro seed 5 p6): a bot on the center island walking
// to the gold station stood 4 min at the edge of a live barrel's fight berth (hazardAvoid): its route ran straight at
// the barrel, the "slide along the edge" step left nothing, and it never moved. The berth was on because a rival was in
// sight, but that rival stood on its own island 90 m away: no fight.
describe('a live barrel on my route', () => {
  test('nobody near: a bot at the edge of a center barrel walks on to the gold instead of freezing', async () => {
    expect(await walkFromBarrelEdge(null)).toBeGreaterThan(4);
  }, 120_000);

  // ffa4-pro seed 6 (154 s), seed 18 (78 s): the same edge with a rival close enough for the berth to hold (on a deck
  // off the island, 30 m away). Heading straight at the barrel, the bot goes round it instead of stopping.
  test('a rival 30 m off across the water: it goes round the berth instead of standing at its edge', async () => {
    expect(await walkFromBarrelEdge(v3(0, 0, 36))).toBeGreaterThan(4);
  }, 120_000);
});
