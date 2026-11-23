import { describe, expect, test } from 'vitest';
import { PIECES } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type PieceState, type PlayerInput, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, forward, right, rotateY, scale, v3 } from '../../src/sim/vec';

// A scaffold deck is solid the tick it is placed: walk onto it from any side, jump onto it, stand on it, and walk a
// two-deck bridge off the shore, without ever dropping below its top.

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };
const S = PIECES.scaffold;
const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;
const tick = (m: Match, i: Partial<PlayerInput>) => m.tick(new Map([[1, { ...NO_INPUT, ...i }]]));

/** Place as player 1 standing at `stand`; returns the new piece. */
function place(m: Match, stand: Vec3, at: Vec3, rotY: number): PieceState {
  m.debugTeleport(1, stand);
  m.debugGive(1, { pieces: { scaffold: 1 } });
  for (let i = 0; i < 10; i++) m.tick(new Map()); // the last placement's busy time
  const s = tick(m, { yaw: rotY, build: { kind: 'scaffold', pos: at, rotY, free: true } });
  const ev = s.events.find((e) => e.type === 'placed');
  if (!ev) throw new Error(`scaffold not placed: ${JSON.stringify(m.previewBuild(1, { kind: 'scaffold', pos: at, rotY, free: true }))}`);
  return s.pieces.find((p) => p.id === ev.data.piece)!;
}

/** Feet over the deck's footprint (inset `inset`)? */
const over = (d: PieceState, p: Vec3, inset = 0.05) => {
  const l = rotateY(v3(p.x - d.pos.x, 0, p.z - d.pos.z), -d.rotY);
  return Math.abs(l.x) < S.w / 2 - inset && Math.abs(l.z) < S.d / 2 - inset;
};

/** Run `ticks` with `input(t)`, tracking the lowest feet y while over any deck (after `settle` ticks on it). */
function walk(m: Match, decks: PieceState[], ticks: number, input: (t: number) => Partial<PlayerInput>) {
  let s = m.tick(new Map()), low = Infinity, onFor = 0;
  for (let t = 0; t < ticks; t++) {
    s = tick(m, input(t));
    const p = me(s).pos;
    const d = decks.find((d) => over(d, p, 0.4));
    if (d) { onFor++; if (onFor > 6) low = Math.min(low, p.y - (d.pos.y + S.h)); } else onFor = 0;
  }
  return { s, low, onFor };
}

describe('scaffold decks hold the player', () => {
  test('walking onto a fresh deck from each of its four sides, then standing 3 s', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw + Math.PI / 2;
    const c = add(isl.center, scale(forward(yaw), 9)), C = v3(c.x, isl.groundY, c.z);
    const deck = place(m, add(C, scale(forward(yaw), -4.5)), C, yaw);
    expect(deck.pos.y).toBeCloseTo(isl.groundY, 2);
    // From each side: start 1.2 m past that edge, face the centre, walk until over the middle.
    for (const [lx, lz] of [[0, S.d / 2 + 1.2], [0, -(S.d / 2 + 1.2)], [S.w / 2 + 1.2, 0], [-(S.w / 2 + 1.2), 0]]) {
      const from = add(C, rotateY(v3(lx, 0, lz), deck.rotY));
      m.debugTeleport(1, from);
      const face = Math.atan2(from.x - C.x, from.z - C.z); // forward(face) points at the centre
      const dist = Math.hypot(lx, lz);
      const r = walk(m, [deck], 100, (t) => ({ yaw: face, moveZ: t < Math.ceil(dist / 0.16) ? 1 : 0 }));
      expect(r.onFor, `came from ${lx},${lz}`).toBeGreaterThan(60); // ended up on it and stayed
      expect(r.low, `came from ${lx},${lz}`).toBeGreaterThan(-0.05);
      expect(me(r.s).pos.y - (deck.pos.y + S.h)).toBeGreaterThan(-0.05);
    }
  });

  test('jumping onto a fresh deck, and standing on it 5 s', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw + Math.PI / 2;
    const c = add(isl.center, scale(forward(yaw), 9)), C = v3(c.x, isl.groundY, c.z);
    const deck = place(m, add(C, scale(forward(yaw), -4.5)), C, yaw);
    m.debugTeleport(1, add(C, scale(forward(yaw), -4)));
    const r = walk(m, [deck], 170, (t) => ({ yaw, moveZ: t < 16 ? 1 : 0, jump: t === 5 })); // running jump at the near end
    expect(r.onFor).toBeGreaterThan(140);
    expect(r.low).toBeGreaterThan(-0.05);
  });

  test('a two-deck bridge off the shore: walk out to the far deck and stand there 5 s', async () => {
    const m = await Match.create(humans);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw + Math.PI / 2, f = forward(yaw), r = right(yaw);
    const lane = (d: number, y = isl.groundY) => { const p = add(add(isl.center, scale(f, d)), scale(r, 3)); return v3(p.x, y, p.z); };
    const a = place(m, lane(isl.radius - 2), lane(isl.radius + S.d / 2 - 0.35), yaw);
    const b = place(m, lane(isl.radius + 1, isl.groundY + S.h), add(a.pos, add(scale(f, S.d), v3(0, S.h, 0))), yaw);
    expect(b.pos.y).toBeCloseTo(a.pos.y, 4); // level with the first
    m.debugTeleport(1, lane(isl.radius - 2));
    const w = walk(m, [a, b], 200, (t) => ({ yaw, moveZ: t < 38 ? 1 : 0 }));
    expect(over(b, me(w.s).pos, 0.3)).toBe(true);
    expect(w.low).toBeGreaterThan(-0.05);
    expect(me(w.s).pos.y - (b.pos.y + S.h)).toBeGreaterThan(-0.05);
    expect(me(w.s).alive).toBe(true);
  });
});
