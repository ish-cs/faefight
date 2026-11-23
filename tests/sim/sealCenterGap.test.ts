import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { PIECES } from '../../src/sim/constants';
import { DECK_TRIES } from '../../src/sim/bots/bot';
import { lane, laneAt, landEdge, navNodes, nodeAt, type Lane, type NavNode } from '../../src/sim/bots/nav';
import { add, right, scale, v3, yawOf } from '../../src/sim/vec';

// Regression: the user's 1v1v1 of PRO bots (replay faefight-20261122-2001-fadd57, build c716a8c, bit-exact re-sim).
// No bot ever tried to seal. Every bot bridged to the center island first (1 deck vs 10 to a rival), and every
// center bridge stopped one deck short: on lane 0>3 the decks end 1.35 m from the shore, and a straight 4 m deck
// there runs into the barrier just inside the center island's edge ("blocked"), pushed further out it has no
// support. The bridge never finished, the center stayed the bridge target all match, no deck ever went toward a
// rival, and seal/attack (walkable route only) never scored. Two decks of that lane, exactly as they stood at 2:17.
const REPLAY_DECKS = [-16.893526817466693, -12.893526817466693].map((x) => ({ pos: v3(x, 2, 3), rotY: -Math.PI / 2 }));

const players = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, isBot: false }));

/** Walkable ground along the lane from `from`'s shore to `to`'s land (deck seams of a few cm allowed). */
function frontier(m: Match, nodes: NavNode[], l: Lane): { s: number; complete: boolean } {
  const ground = (s: number) => { const p = laneAt(l, s); return m.debugGroundAt(p.x, p.z) !== null; };
  for (let s = landEdge(nodes[l.from]) - 2; s <= l.length; s += 0.25) {
    if (!ground(s) && !ground(s + 0.06)) return { s: s - 0.25, complete: false };
    if (nodeAt(nodes, laneAt(l, s)) === l.to) return { s, complete: true };
  }
  throw new Error(`lane ${l.from}>${l.to} never reached node ${l.to}`);
}

/** Lay decks along a lane the way Bot.doBridge does (DECK_TRIES from the tip), standing at the tip. */
function layLane(m: Match, nodes: NavNode[], l: Lane, maxDecks = 30): { complete: boolean; decks: number; firstTry: boolean[] } {
  const rotY = yawOf(l.dir);
  const firstTry: boolean[] = [];
  for (let n = 0; n <= maxDecks; n++) {
    const f = frontier(m, nodes, l);
    if (f.complete) return { complete: true, decks: n, firstTry };
    const stand = laneAt(l, f.s - 1.1);
    const y = (m.debugGroundAt(stand.x, stand.z) ?? nodes[l.from].groundY);
    m.debugTeleport(1, v3(stand.x, y + 0.01, stand.z));
    let placed = false;
    for (const [i, [k, side]] of DECK_TRIES.entries()) {
      const p = add(laneAt(l, f.s + k), scale(right(rotY), side));
      const r = m.previewBuild(1, { kind: 'scaffold', pos: v3(p.x, y, p.z), rotY, free: true });
      if (!r.ok) continue;
      m.debugPlacePiece('scaffold', r.pos, rotY, 1);
      firstTry.push(i === 0);
      placed = true;
      break;
    }
    if (!placed) return { complete: false, decks: n, firstTry };
  }
  return { complete: false, decks: maxDecks, firstTry };
}

describe("the bridge to the center that never finished (replay fadd57)", () => {
  test('lane 0>3: the straight last deck is blocked; a sideways one closes the gap and the bridge reaches land', async () => {
    const m = await Match.create({ players: players(3), map: 'harbor', seed: 1 });
    const nodes = navNodes(m.def.islands, m.def.center);
    const C = nodes.length - 1;
    for (const d of REPLAY_DECKS) m.debugPlacePiece('scaffold', d.pos, d.rotY, 1);
    const l = lane(nodes, 0, C);
    const f = frontier(m, nodes, l);
    expect(f.complete).toBe(false);
    // The gap left is shorter than a deck: the straight deck butted on the tip doesn't fit.
    expect(l.length - landEdge(nodes[C]) - f.s).toBeLessThan(PIECES.scaffold.d / 2);
    const res = layLane(m, nodes, l);
    expect(res.complete).toBe(true);
    expect(res.decks).toBe(1);
    expect(res.firstTry).toEqual([false]);
  });

  test('a PRO bot left at the tip of that bridge finishes it and walks onto the center island', async () => {
    const m = await Match.create({ players: [{ name: 'Ash', isBot: true, difficulty: 'pro' }, ...players(2)], map: 'harbor', seed: 1 });
    m.tick(new Map());
    for (const d of REPLAY_DECKS) m.debugPlacePiece('scaffold', d.pos, d.rotY, 1);
    m.debugSetTime(137);
    m.debugGive(1, { pieces: { scaffold: 3 } });
    m.debugTeleport(1, v3(-13.5, 2.21, 3));
    const nodes = navNodes(m.def.islands, m.def.center);
    const C = nodes.length - 1;
    let onCenter = false;
    for (let i = 0; i < 30 * 40 && !onCenter; i++) {
      const s = m.tick(new Map());
      const p = s.players.find((q) => q.id === 1)!;
      if (p.alive && nodeAt(nodes, p.pos) === C) onCenter = true;
    }
    expect(frontier(m, nodes, lane(nodes, 0, C)).complete).toBe(true);
    expect(onCenter).toBe(true);
  }, 120_000);
});

describe('every bridge lane on the harbor map finishes on land', () => {
  // Each player island to the center and to its neighbours, both ways, 2..8 players: laid deck by deck from an
  // empty lane (as Bot.doBridge lays them), the last deck always reaches the far shore.
  for (let n = 2; n <= 8; n++) {
    test(`${n} players`, async () => {
      const m = await Match.create({ players: players(n), map: 'harbor', seed: 1 });
      const nodes = navNodes(m.def.islands, m.def.center);
      const C = nodes.length - 1;
      const lanes: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        lanes.push([i, C]);
        if (n > 1) lanes.push([i, (i + 1) % n], [(i + 1) % n, i]);
      }
      const failed: string[] = [];
      for (const [a, b] of lanes) {
        const f = await Match.create({ players: players(n), map: 'harbor', seed: 1 });
        const r = layLane(f, nodes, lane(nodes, a, b));
        if (!r.complete) failed.push(`${a}>${b} after ${r.decks} decks`);
        f.dispose();
      }
      m.dispose();
      expect(failed).toEqual([]);
    }, 300_000);
  }
});
