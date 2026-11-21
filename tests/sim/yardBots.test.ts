import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { navNodes, lane, laneAt, landEdge, WalkGrid } from '../../src/sim/bots/nav';
import { Match } from '../../src/sim/match';
import { MAP_TEMPLATES, buildMapDef, type MapTemplate } from '../../src/sim/map';
import type { Difficulty, PlayerInput, Snapshot, Vec3 } from '../../src/sim/types';
import { dist2D } from '../../src/sim/vec';

const LIMIT = 25 * 60 * 30;

describe('walk grid reachability (built-in cover never cuts anything off)', () => {
  test('from the bunker door: every station and every bridge start toward every other node; on the center: every landing to every station', () => {
    for (const t of MAP_TEMPLATES) for (const n of [2, 3, 5, 8]) {
      const def = buildMapDef(n, t);
      const nodes = navNodes(def.islands, def.center);
      const C = nodes.length - 1;
      const grids = nodes.map((nd) => new WalkGrid(nd, def.statics.filter((s) => (s.island < 0 ? C : s.island) === nd.index)));
      const reach = (g: WalkGrid, a: Vec3, b: Vec3, what: string) => {
        const p = g.path(a, b);
        if (!p) throw new Error(`${t} n=${n} node ${g.node.index}: no path to ${what}`);
        expect(p.at(-1)).toEqual(b);
      };
      for (const isl of def.islands) {
        const g = grids[isl.index];
        const door = isl.bunker.doorways[0].center;
        const out = { x: door.x + (door.x - isl.bunker.center.x) * 0.8, y: door.y, z: door.z + (door.z - isl.bunker.center.z) * 0.8 };
        for (const [k, p] of Object.entries({ generator: isl.generator, vault: isl.vault, shop: isl.shop })) reach(g, out, p, k);
        for (let j = 0; j < nodes.length; j++) {
          if (j === isl.index) continue;
          const l = lane(nodes, isl.index, j);
          const start = laneAt(l, landEdge(nodes[isl.index]) - 1.2);
          expect(g.isBlocked(start)).toBe(false);
          reach(g, out, start, `bridge start toward ${j}`);
        }
      }
      const cg = grids[C];
      for (let i = 0; i < def.islands.length; i++) {
        const l = lane(nodes, i, C);
        const landing = laneAt(l, l.length - landEdge(nodes[C]) + 1.2);
        for (const p of [def.center.goldGen, def.center.supplyGen, def.center.potionShop, def.center.shieldWell]) reach(cg, landing, p, `station from island ${i}`);
      }
    }
  });

  test('a path around a container stack goes around it, not through', () => {
    const def = buildMapDef(2, 'yard');
    const box = def.statics.find((s) => s.island === 0)!;
    const g = new WalkGrid(navNodes(def.islands, def.center)[0], def.statics.filter((s) => s.island === 0));
    // Points on either side of the box along its long axis' normal.
    const nx = Math.cos(box.rotY), nz = -Math.sin(box.rotY);
    const p = { x: box.center.x + nx * 3, y: 2, z: box.center.z + nz * 3 };
    const q = { x: box.center.x - nx * 3, y: 2, z: box.center.z - nz * 3 };
    expect(g.clear(p, q)).toBe(false);
    const path = g.path(p, q)!;
    expect(path.length).toBeGreaterThan(1);
    let from = p;
    for (const w of path) { expect(g.clear(from, w)).toBe(true); from = w; }
  });
});

/** Bot-vs-bot soak: winner, plus "stuck" = wanting to move for 20 s straight without getting 1.5 m anywhere. */
export async function soak(template: MapTemplate, n: number, seed: number) {
  const diffs: Difficulty[] = ['hard', 'medium', 'easy'];
  const track = new Map<number, { pos: Vec3; since: number; worst: number; at?: string }>();
  let now = 0;
  const m = await Match.create({
    players: Array.from({ length: n }, (_, i) => ({ name: `Bot (${diffs[i % 3]})`, isBot: true, difficulty: diffs[i % 3] })),
    seed, map: template,
  }, {
    makeBot: (id, d, rng) => {
      const b = new Bot(id, d, rng);
      return {
        think: (view) => {
          const out: PlayerInput = b.think(view);
          const me = view.self;
          const moving = me.alive && (Math.abs(out.moveX) + Math.abs(out.moveZ) > 0.1) && me.busyUntil <= view.now;
          const tr = track.get(id);
          if (!moving || !tr || dist2D(tr.pos, me.pos) > 1.5) track.set(id, { pos: { ...me.pos }, since: view.now, worst: tr?.worst ?? 0, at: tr?.at });
          else if (view.now - tr.since > tr.worst) { tr.worst = view.now - tr.since; tr.at = `bot ${id} ${b.currentGoal} at ${me.pos.x.toFixed(1)},${me.pos.y.toFixed(1)},${me.pos.z.toFixed(1)} t=${view.now.toFixed(0)}`; }
          return out;
        },
      };
    },
  });
  let snap: Snapshot = m.tick(new Map());
  let gold = 0, supply = 0, seals = 0;
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    now = snap.time;
    for (const e of snap.events) {
      if (e.type === 'centerCollect') { if (e.data.station === 'gold') gold++; else supply++; }
      if (e.type === 'sealed') seals++;
    }
  }
  const worst = Math.max(...[...track.values()].map((t) => t.worst));
  const worstAt = [...track.values()].sort((a, b) => b.worst - a.worst)[0]?.at;
  console.log(`${template} ${n} bots seed ${seed}: winner ${snap.winner} at ${(now / 60).toFixed(1)} min, seals ${seals}, center gold pickups ${gold}, supply pickups ${supply}, longest stuck ${worst.toFixed(1)} s (${worstAt})`);
  return { snap, worst, gold, supply, seals };
}

describe('bots on Container Yard', () => {
  test('1v1 bot match finishes with a winner and no stuck bots', async () => {
    const r = await soak('yard', 2, 5);
    expect(r.snap.winner).not.toBeNull();
    expect(r.worst).toBeLessThan(20);
  }, 600_000);

  test('4-bot match finishes, nobody gets stuck, and bots contest the center island', async () => {
    const r = await soak('yard', 4, 7);
    expect(r.snap.winner).not.toBeNull();
    expect(r.worst).toBeLessThan(20);
    expect(r.gold + r.supply).toBeGreaterThan(0);
  }, 600_000);
});

describe('bots and the center island', () => {
  test('a bot standing on the center island with gold waiting walks to the gold generator and collects', async () => {
    const m = await Match.create({ players: [{ name: 'Bot (hard)', isBot: true, difficulty: 'hard' }, { name: 'x', isBot: false }], seed: 2 });
    for (let i = 0; i < 30 * 40; i++) m.tick(new Map()); // let gold build up (bot may wander)
    const c = m.def.center;
    m.debugTeleport(1, { x: c.center.x + (c.supplyGen.x - c.center.x) * 1.4, y: c.groundY, z: c.center.z + (c.supplyGen.z - c.center.z) * 1.4 });
    let got = false;
    for (let i = 0; i < 30 * 20 && !got; i++) got = m.tick(new Map()).events.some((e) => e.type === 'centerCollect' && e.data.by === 1);
    expect(got).toBe(true);
  }, 120_000);
});
