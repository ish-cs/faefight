import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { lane, laneAt, landEdge, navNodes, nodeAt } from '../../src/sim/bots/nav';
import { preset } from '../../src/sim/bots/personality';
import { Match } from '../../src/sim/match';
import type { Physics } from '../../src/sim/physics';
import type { Difficulty, MatchEvent, PlayerState, Vec3 } from '../../src/sim/types';
import { drownMatches } from './drownMatches';
import { v3, yawOf } from '../../src/sim/vec';

/**
 * Bots used to drown 10-13 times a match (medium) without anyone touching them: stuck-recovery hops sideways off
 * decks and island rims, and standing on a rim with nothing under the centre. The scripted cases below pin each of
 * those at the edge itself (zero allowed). Whole matches: tests/sim/drownMatches.ts (seeds 1–3 here, 4–6 in
 * botDrownB.test.ts, so the two halves run on separate workers).
 */
describe('bots stay out of the water', () => {
  test('8 mixed bots, seeds 1–3, whole matches: at most 1 unexplained water death before sudden death', async () => {
    await drownMatches([1, 2, 3]);
  }, 1_200_000);
});

/**
 * The three ways bots used to end up in the water, scripted at the edge itself (deterministic: these must never
 * drown, whatever the rest of the brain does). Bot seat 1 on island 0 vs an idle human seat 2.
 */
describe('bots at the water\'s edge never drown (scripted)', () => {
  const playerOf = (m: Match, id: number) => (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(id)!;
  const drowned = (evs: MatchEvent[]) => evs.filter((e) => e.type === 'kill' && e.data.victim === 1 && e.data.inWater);
  async function setup(difficulty: Difficulty) {
    let bot: Bot | null = null;
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'h', isBot: false }], seed: 1 },
      { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset('Rusher'))) });
    m.debugSetTime(240);
    return { m, bot: () => bot! };
  }
  /** Last ground along the ray from island 0's centre at angle `a`. */
  function rim(m: Match, a: number) {
    const isl = m.def.islands[0], ph = (m as unknown as { physics: Physics }).physics;
    let r = 0;
    for (let x = 2; x < isl.radius + 3; x += 0.05) if (ph.isGroundAt(isl.center.x + Math.cos(a) * x, isl.center.z + Math.sin(a) * x) !== null) r = x;
    return { r, at: (rr: number) => v3(isl.center.x + Math.cos(a) * rr, isl.groundY + 0.05, isl.center.z + Math.sin(a) * rr), out: { x: Math.cos(a), z: Math.sin(a) } };
  }
  /** Runs `sec` s; returns the bot's water deaths, when its centre was first over solid ground and the move sources seen. */
  function run(m: Match, bot: () => Bot, sec: number) {
    const evs: MatchEvent[] = [], srcs = new Set<string>();
    let grounded = -1;
    for (let i = 0; i < sec * 30; i++) {
      playerOf(m, 2).hp = 100;
      const s = m.tick(new Map());
      evs.push(...s.events);
      srcs.add(bot().moveSrc);
      const p = s.players[0];
      if (grounded < 0 && p.alive && m.debugGroundAt(p.pos.x, p.pos.z) !== null) grounded = i / 30;
    }
    return { drowned: drowned(evs), grounded, srcs };
  }
  function place(m: Match, id: number, pos: Vec3, faceTo?: { x: number; z: number }) {
    m.debugTeleport(id, pos);
    const p = playerOf(m, id);
    p.invulnUntil = 0;
    p.spawnProtected = false;
    if (faceTo) p.yaw = yawOf(faceTo);
  }

  test('rim step-back: standing with its centre past the rim (a rival across the water), it steps back, never off', async () => {
    for (let k = 0; k < 6; k++) {
      const { m, bot } = await setup('hard');
      const i0 = m.def.islands[0], i1 = m.def.islands[1];
      const toward = Math.atan2(i1.center.z - i0.center.z, i1.center.x - i0.center.x);
      // Spots facing the rival's island (it wants to go that way) and round the rest of the rim.
      const a = k < 3 ? toward + (k - 1) * 0.12 : toward + (k - 2) * (Math.PI / 2);
      const e = rim(m, a);
      const back = Math.atan2(i0.center.z - i1.center.z, i0.center.x - i1.center.x);
      place(m, 2, v3(i1.center.x + Math.cos(back) * (i1.radius - 1.5), i1.groundY + 0.05, i1.center.z + Math.sin(back) * (i1.radius - 1.5)));
      m.debugGive(1, { weapons: { rifle: { mag: 25, spare: 100 } } });
      place(m, 1, e.at(e.r + 0.25), e.out);
      const r = run(m, bot, 20);
      m.dispose();
      expect(r.drowned, `spot ${k}`).toEqual([]);
      // Stepped back: its centre over solid ground again within 2 s.
      expect(r.grounded, `spot ${k}: centre over ground at ${r.grounded} s`).toBeGreaterThanOrEqual(0);
      expect(r.grounded, `spot ${k}: centre over ground at ${r.grounded} s`).toBeLessThan(2);
    }
  }, 120_000);

  test('stuck hop at the island edge: boxed in by walls with the water behind, the unstick hops never go in', async () => {
    for (let k = 0; k < 6; k++) {
      const { m, bot } = await setup('hard');
      const e = rim(m, (k / 6) * Math.PI * 2 + 0.2);
      // A pocket at the rim: a wall inland and one either side, the water behind.
      const c = e.at(e.r - 0.9), side = { x: -e.out.z, z: e.out.x }, y = m.def.islands[0].groundY, yaw = yawOf(e.out);
      m.debugPlacePiece('wood', v3(c.x - e.out.x * 1.3, y, c.z - e.out.z * 1.3), yaw, 2);
      for (const sg of [-1, 1]) m.debugPlacePiece('wood', v3(c.x + side.x * 1.3 * sg, y, c.z + side.z * 1.3 * sg), yaw + Math.PI / 2, 2);
      place(m, 1, c, e.out);
      const r = run(m, bot, 20);
      m.dispose();
      expect(r.drowned, `spot ${k}`).toEqual([]);
      expect([...r.srcs], `spot ${k}: never got stuck`).toContain('unstick');
    }
  }, 120_000);

  test('grapple to a ledge: from a part-built bridge it hooks onto the far island\'s edge and lands, never in the water', async () => {
    for (const to of [1, 2]) {
      const { m } = await setup('pro');
      m.tick(new Map());
      const nodes = navNodes(m.def.islands, m.def.center);
      const l = lane(nodes, 0, to);
      // Decks out from my shore to within hook reach of the far edge (botHookSeal.test.ts).
      for (let i = 0; i < 4; i++) { const p = laneAt(l, landEdge(nodes[0]) - 0.5 + 2 + 4 * i); m.debugPlacePiece('scaffold', v3(p.x, 2, p.z), yawOf(l.dir), 1); }
      const far = nodes[to];
      // The rival waits on the far side (an island: their bunker; the center: out in the open).
      place(m, 2, v3(far.center.x, (to === 2 ? m.def.center.groundY : m.def.islands[1].groundY) + 0.1, far.center.z));
      m.debugGive(1, { grapples: 3, pieces: { wood: 3, scaffold: 0 }, weapons: { rifle: { mag: 25, spare: 100 } } });
      const tip = laneAt(l, landEdge(nodes[0]) - 0.5 + 15);
      place(m, 1, v3(tip.x, 2.25, tip.z), l.dir);
      const evs: MatchEvent[] = [];
      let hooked = false, landedAt = -1;
      for (let i = 0; i < 60 * 30 && (landedAt < 0 || i < landedAt + 5 * 30); i++) {
        playerOf(m, 2).hp = 100;
        const s = m.tick(new Map());
        evs.push(...s.events);
        if (s.events.some((e) => e.type === 'grapple' && e.data.phase === 'fire' && e.data.by === 1)) hooked = true;
        const p = s.players[0];
        if (landedAt < 0 && hooked && p.alive && nodeAt(nodes, p.pos) === to && Math.abs(p.vel.y) < 0.05) landedAt = i;
      }
      m.dispose();
      expect(drowned(evs), `to node ${to}`).toEqual([]);
      expect(hooked, `to node ${to}: never hooked`).toBe(true);
      expect(landedAt, `to node ${to}: never landed across`).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);
});
