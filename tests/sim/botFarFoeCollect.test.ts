import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { WEAPONS } from '../../src/sim/constants';
import { v3 } from '../../src/sim/vec';

// bot-measure ffa8-hard seed 11 (NET 42 branch): a Hard bot back home on low hp (no heals, no cash) swung between
// 'disengage' (an enemy in sight ~80 m off across the water, pistol range 60) and walking to its generator ($400 in it)
// for 63 s, never collecting it (home-sit gate). Low hp alone backs a bot off only from someone who can reach it.
describe('low hp with a far-off enemy in sight', () => {
  test('a Hard bot on low hp does not back off from someone out of their gun range', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'hard' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const home = m.def.islands[0], far = m.def.islands[1];
    // b on the next island's near shore, in sight of my bunker, ~78 m off.
    const k = (far.radius - 2) / Math.hypot(home.center.x - far.center.x, home.center.z - far.center.z);
    m.debugTeleport(2, v3(far.center.x + (home.center.x - far.center.x) * k, far.groundY + 0.1, far.center.z + (home.center.z - far.center.z) * k));
    m.debugTeleport(1, v3(home.bunker.center.x, home.groundY + 0.1, home.bunker.center.z));
    m.debugGive(1, { cash: 0 });
    m.debugSetHp(1, 20);
    m.debugSetGenerator(0, 400);
    const range = WEAPONS.pistol.range;
    let bad = 0, seen = 0;
    for (let i = 0; i < 30 * 20; i++) {
      const s = m.tick(new Map());
      const a = s.players.find((x) => x.id === 1)!, b = s.players.find((x) => x.id === 2)!;
      const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
      const goal = (m.botBrain(1) as unknown as { currentGoal: string }).currentGoal;
      if (dist > range + 2) { seen++; if (goal === 'disengage') bad++; }
    }
    if (process.env.FF_TRACE) console.log('bad', bad, 'of', seen);
    m.dispose();
    expect(seen).toBeGreaterThan(30);
    expect(bad).toBe(0);
  }, 120_000);
  // ffa8-mixed x60 (NET 44): ignoring every foe out of their gun range at home (fists 20 m off on my own island, one
  // walking over a bridge) left low-hp bots shopping and bridging into deaths; pre-SD decisive fell 26 -> 15 of 60.
  test('a Hard bot on low hp still backs off from a foe who can walk over to it (out of their gun range for now)', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'hard' }, { name: 'b', isBot: false }], map: 'harbor', seed: 3 });
    m.tick(new Map());
    const home = m.def.islands[0];
    m.debugTeleport(1, v3(home.bunker.center.x, home.groundY + 0.1, home.bunker.center.z));
    // b on my island, 15 m from me, fists only (range 2).
    const dx = home.center.x - home.bunker.center.x, dz = home.center.z - home.bunker.center.z, d = Math.hypot(dx, dz) || 1;
    m.debugTeleport(2, v3(home.bunker.center.x + (dx / d) * 15, home.groundY + 0.1, home.bunker.center.z + (dz / d) * 15));
    const pb = (m as unknown as { mustPlayer(id: number): { equipped: string; inv: { weapons: object }; hotbar: unknown[] } }).mustPlayer(2);
    pb.inv.weapons = {}; pb.hotbar = pb.hotbar.map(() => null); pb.equipped = 'fists';
    m.debugGive(1, { cash: 0 });
    m.debugSetHp(1, 20);
    let off = 0;
    for (let i = 0; i < 30 * 5; i++) {
      const s = m.tick(new Map());
      if (s.players.find((x) => x.id === 2)!.equipped !== 'fists') throw new Error('b lost its fists-only setup');
      if ((m.botBrain(1) as unknown as { currentGoal: string }).currentGoal === 'disengage') off++;
    }
    m.dispose();
    expect(off).toBeGreaterThan(30);
  }, 120_000);
});
