import { describe, expect, test } from 'vitest';
import { CLIENT_REACH } from '../../src/client/buildAim';
import { Match } from '../../src/sim/match';
import type { MoveCmd } from '../../src/sim/movement';
import { NO_INPUT, type BuildRequest, type PieceKind, type Vec3 } from '../../src/sim/types';
import { dist2D } from '../../src/sim/vec';
import cases from './fixtures/userReachReplay.json';

// Regression: the user's match (replay faefight-20261122-1530-3780b2, build 7d6d6fa, bit-exact re-sim). Sprinting
// toward the water, their scaffolds (and later steel doorway plugs) were refused as "too far": the client checked
// reach (CLIENT_REACH) from its predicted feet, but the host checked BUILD.reach from where it had the player when the
// request arrived, a few commands behind (5.2-5.5 m from the spot). Nothing was placed; they sprinted onto open
// water (3 of their 4 deaths). The fixture holds, per refused request: the host's player position the tick before,
// the request, the movement commands that followed, and the pieces nearby.
//
// Here the host starts from that position with those commands queued (one simulated per tick, as recorded); the
// client is ahead by the commands it has already stepped, and places once its predicted feet are within
// CLIENT_REACH of the spot. Old protocol: refused. With BuildRequest.seq: placed, exactly where the client showed it.

type Case = { tick: number; pos: Vec3; build: BuildRequest; yaw: number; cmds: MoveCmd[];
  pieces: { kind: PieceKind; owner: number; pos: Vec3; rotY: number }[] };

async function setup(c: Case) {
  const m = await Match.create({ players: Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, isBot: false })), map: 'harbor', seed: 1 });
  for (const p of c.pieces) m.debugPlacePiece(p.kind, p.pos, p.rotY, p.owner);
  m.debugTeleport(1, c.pos);
  m.debugGive(1, { pieces: { [c.build.kind]: 1 } });
  // The ack before this tick (commands are numbered from there on).
  const cmds = c.cmds.map((x, i) => ({ ...x, seq: i + 1 }));
  m.tick(new Map([[1, { ...NO_INPUT, yaw: c.yaw }]]), new Map([[1, []]]));
  return { m, cmds };
}

/** The client: one command ahead per step; the seq after which its predicted feet are within CLIENT_REACH (0 = now). */
function clientSeq(m: Match, cmds: MoveCmd[], req: BuildRequest): { seq: number; feet: Vec3 } | null {
  const f = m.fork();
  for (let k = 0; k <= cmds.length; k++) {
    const feet = f.tick(new Map([[1, { ...NO_INPUT, yaw: cmds[0].yaw }]]), new Map([[1, []]])).players.find((p) => p.id === 1)!.pos;
    if (dist2D(feet, req.pos) <= CLIENT_REACH && f.previewBuild(1, req).ok) return { seq: k, feet };
    if (k < cmds.length) f.tick(new Map([[1, { ...NO_INPUT, yaw: cmds[k].yaw }]]), new Map([[1, [cmds[k]]]]));
  }
  return null;
}

/** Host: the request arrives now; the queued commands are simulated one per tick. Returns the placed piece. */
function host(m: Match, cmds: MoveCmd[], build: BuildRequest) {
  for (let k = 0; k < cmds.length; k++) {
    const s = m.tick(new Map([[1, { ...NO_INPUT, yaw: cmds[k].yaw, build: k === 0 ? build : null }]]), new Map([[1, [cmds[k]]]]));
    const ev = s.events.find((e) => e.type === 'placed' && e.data.by === 1);
    if (ev) return s.pieces.find((p) => p.id === ev.data.piece)!;
  }
  return null;
}

// The first refused request of each episode, and one continuation. The other refused ticks of the episodes were
// retries or continuations made from a path that no longer exists once the first piece is placed (3895, 19582: the
// player walked through where the deck now stands; 22320: a retry of the plug at 22132's spot), so they can't be
// replayed on their own; they're in the fixture for reference.
const PAIRS: [number, number?][] = [[3872], [5308, 5324], [19557], [22132]];

describe("the user's refused-as-too-far placements (replay 3780b2)", () => {
  for (const [a, b] of PAIRS) {
    test(`tick${b ? `s ${a} and ${b}` : ` ${a}`}: refused by the old protocol, placed where the client showed them with seq`, async () => {
      const run = [a, b].filter((t) => t !== undefined).map((t) => (cases as Case[]).find((c) => c.tick === t)!);
      let first: { kind: PieceKind; pos: Vec3; rotY: number } | null = null;
      for (const c of run) {
        expect(dist2D(c.pos, c.build.pos)).toBeGreaterThan(4.9); // the host was this far behind
        const extra = first ? [{ ...first, owner: 1 }] : [];
        const cur = await setup({ ...c, pieces: [...c.pieces, ...extra] });
        const cl = clientSeq(cur.m, cur.cmds, c.build);
        expect(cl, `tick ${c.tick}: the client got within reach on these commands`).not.toBeNull();
        // Old protocol: refused (the host checks from where it is when the request arrives).
        const old = await setup({ ...c, pieces: [...c.pieces, ...extra] });
        expect(host(old.m, old.cmds, c.build), `tick ${c.tick}: old protocol`).toBeNull();
        // With seq: placed after that command, from the client's position.
        const placed = host(cur.m, cur.cmds, { ...c.build, seq: cl!.seq });
        expect(placed, `tick ${c.tick}: with seq`).not.toBeNull();
        first = placed && { kind: placed.kind, pos: placed.pos, rotY: placed.rotY };
      }
    }, 300_000);
  }
});
