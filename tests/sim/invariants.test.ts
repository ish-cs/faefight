import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { LIFECYCLE, PIECES } from '../../src/sim/constants';
import { DEFAULT_MAX_MATCH_SEC, floatingPieces, InvariantChecker, violationSignature, type Violation } from '../../src/sim/invariants';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { Physics } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import { unsupportedPieces } from '../../src/sim/support';
import type { PieceKind, PieceState, PlayerInput, Snapshot } from '../../src/sim/types';
import { NO_INPUT } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

const map = buildMap(2);
const isl = map[0];
const yaw = isl.bunker.facingYaw;
/** Ground point on island 0, `d` m in front of its centre and `side` m to the right. */
const spot = (d: number, side = 0, m: IslandLayout[] = map) => {
  const i = m[0], f = i.bunker.facingYaw;
  const p = add(add(i.center, scale(forward(f), d)), scale(right(f), side));
  return v3(p.x, i.groundY, p.z);
};

function snap(over: Partial<Snapshot> = {}): Snapshot {
  const players = map.map((m, i) => newPlayer(i + 1, `p${i + 1}`, true, i, spot(5, 0)));
  players[1].pos = v3(map[1].spawn.x, map[1].groundY, map[1].spawn.z);
  return {
    time: 1, tick: 30, players, pieces: [], loot: [], projectiles: [],
    generators: map.map((m) => ({ island: m.index, stored: 0 })), genLevels: map.map(() => 1),
    sealed: map.map(() => false), waterY: 0, suddenDeath: false, winner: null, events: [], ...over,
  };
}
const next = (s: Snapshot, ticks = 1): Snapshot => ({ ...s, tick: s.tick + ticks, time: s.time + ticks / 30 });
const kinds = (vs: Violation[]) => vs.map((v) => v.kind);
const piece = (id: number, kind: PieceKind, pos = spot(8, 3), rotY = yaw): PieceState => ({ id, kind, owner: 1, pos, rotY, hp: PIECES[kind].hp });
const walk: PlayerInput = { ...NO_INPUT, moveZ: -1 };

describe('violationSignature', () => {
  test('is stable across ids, ticks and numbers', () => {
    const a: Violation = { kind: 'negativeCount', sub: 'inv.grenades', tick: 5, time: 1, playerId: 1, detail: 'player 1 inv.grenades = -1' };
    const b: Violation = { ...a, tick: 900, playerId: 3, detail: 'player 3 inv.grenades = -7' };
    expect(violationSignature(a)).toBe('negativeCount:inv.grenades');
    expect(violationSignature(b)).toBe(violationSignature(a));
    expect(violationSignature({ kind: 'stuck', tick: 1, time: 0, detail: '' })).toBe('stuck');
  });
});

describe('clean snapshot', () => {
  test('a fresh hand-built snapshot has no violations', () => {
    const c = new InvariantChecker({ map });
    expect(c.observe(snap())).toEqual([]);
  });
});

describe('nonFinite', () => {
  test('flags NaN position / yaw once, not every tick', () => {
    const c = new InvariantChecker({ map });
    const s = snap();
    s.players[0].pos.x = NaN;
    s.players[0].yaw = Infinity;
    const v = c.observe(s);
    expect(kinds(v)).toEqual(['nonFinite', 'nonFinite']);
    expect(v.map(violationSignature).sort()).toEqual(['nonFinite:player.pos', 'nonFinite:player.yaw']);
    expect(c.observe(next(s))).toEqual([]);
  });
  test('flags projectile and piece NaNs; ignores the parked dead player', () => {
    const c = new InvariantChecker({ map });
    const s = snap({ projectiles: [{ id: 9, kind: 'rocket', pos: v3(0, 3, 0), vel: v3(NaN, 0, 0) }], pieces: [piece(5, 'wood')] });
    s.pieces[0].hp = NaN;
    expect(c.observe(s).map(violationSignature).sort()).toEqual(['nonFinite:piece.hp', 'nonFinite:projectile.vel']);
    const d = snap();
    d.players[0].alive = false;
    d.players[0].pos = v3(0, -1000, 0);
    expect(new InvariantChecker({ map }).observe(d)).toEqual([]);
  });
});

describe('negativeCount', () => {
  test('flags negative inventory, vault, gun ammo and generator counts', () => {
    const c = new InvariantChecker({ map });
    const s = snap();
    s.players[0].inv.grenades = -1;
    s.players[1].vault.cash = -5;
    s.players[1].inv.weapons.smg = { mag: -1, spare: 10 };
    s.players[1].hotbar[0] = 'smg';
    s.players[1].equipped = 'smg';
    s.generators[0].stored = -0.5;
    const sigs = c.observe(s).map(violationSignature).sort();
    expect(sigs).toEqual(['negativeCount:generator.stored', 'negativeCount:inv.grenades', 'negativeCount:inv.weapons.smg.mag', 'negativeCount:vault.cash']);
  });
  test('zero counts and a dead player with hp 0 are fine; alive hp < 0 is not', () => {
    const s = snap();
    s.players[0].inv.cash = 0;
    s.players[1].alive = false;
    s.players[1].hp = 0;
    expect(new InvariantChecker({ map }).observe(s)).toEqual([]);
    const t = snap();
    t.players[0].hp = -3;
    expect(new InvariantChecker({ map }).observe(t).map(violationSignature)).toEqual(['negativeCount:player.hp']);
  });
});

describe('belowMap', () => {
  test('flags a live player well under the water line', () => {
    const s = snap({ waterY: 0.4 });
    s.players[0].pos.y = -2;
    const v = new InvariantChecker({ map }).observe(s);
    expect(kinds(v)).toEqual(['belowMap']);
    expect(v[0].playerId).toBe(1);
  });
  test('ignores dead (parked) players and live players at/just above the water', () => {
    const s = snap({ waterY: 1 });
    s.players[0].alive = false;
    s.players[0].pos.y = -1000;
    s.players[1].pos.y = 1.01;
    expect(new InvariantChecker({ map }).observe(s)).toEqual([]);
  });
});

describe('stuck', () => {
  const run = (moveEach: (s: Snapshot, i: number) => void, seconds: number, inputs: Map<number, PlayerInput> | undefined, c = new InvariantChecker({ map })) => {
    let s = snap();
    const out: Violation[] = [];
    for (let i = 0; i < seconds * 30; i++) {
      s = next(s);
      s.players = structuredClone(s.players);
      moveEach(s, i);
      out.push(...c.observe(s, inputs));
    }
    return out;
  };
  test('flags a player pushing a move input for > 5 s without moving, once', () => {
    const v = run(() => {}, 7, new Map([[1, walk]]));
    expect(kinds(v)).toEqual(['stuck']);
    expect(v[0].playerId).toBe(1);
  });
  test('moving players, players without input, and short stalls are fine', () => {
    expect(run((s, i) => { s.players[0].pos.x += i * 0.01; }, 7, new Map([[1, walk]]))).toEqual([]);
    expect(run(() => {}, 7, undefined)).toEqual([]);
    expect(run(() => {}, 7, new Map([[1, NO_INPUT]]))).toEqual([]);
    expect(run(() => {}, 4, new Map([[1, walk]]))).toEqual([]);
  });
  test('body-blocked by another live player is not stuck', () => {
    expect(run((s) => { s.players[1].pos = { ...s.players[0].pos, x: s.players[0].pos.x + 0.7 }; }, 7, new Map([[1, walk]]))).toEqual([]);
  });
});

describe('hotbarDesync', () => {
  test('flags a slot whose item is gone from inv, and a mismatched hand', () => {
    const s = snap();
    s.players[0].hotbar[2] = 'grenade'; // inv.grenades = 0
    s.players[1].inv.weapons.pistol = { mag: 12, spare: 24 };
    s.players[1].hotbar[0] = 'pistol';
    s.players[1].selected = 0;
    s.players[1].equipped = 'fists';
    expect(new InvariantChecker({ map }).observe(s).map(violationSignature).sort()).toEqual(['hotbarDesync:emptySlot', 'hotbarDesync:equippedMismatch']);
  });
  test('flags a held item on no slot while a slot is free; allows overflow when the bar is full', () => {
    const s = snap();
    s.players[0].inv.medkits = 2;
    expect(new InvariantChecker({ map }).observe(s).map(violationSignature)).toEqual(['hotbarDesync:unslotted']);
    const full = snap();
    const p = full.players[0];
    const items = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container', 'grenade', 'charge'] as const;
    items.forEach((k, i) => { p.hotbar[i] = k; if (k === 'grenade') p.inv.grenades = 1; else if (k === 'charge') p.inv.charges = 1; else p.inv.pieces[k] = 1; });
    p.inv.medkits = 1; // overflow: no free slot
    expect(new InvariantChecker({ map }).observe(full)).toEqual([]);
  });
  test('a consistent gun in hand is fine', () => {
    const s = snap();
    s.players[0].inv.weapons.rifle = { mag: 25, spare: 50 };
    s.players[0].hotbar[3] = 'rifle';
    s.players[0].selected = 3;
    s.players[0].equipped = 'rifle';
    expect(new InvariantChecker({ map }).observe(s)).toEqual([]);
  });
});

describe('sealContradiction', () => {
  test('flags eliminated-but-alive and a winner with rivals left', () => {
    const s = snap({ winner: 1 });
    s.players[1].eliminated = true; // and still alive
    s.players[0].eliminated = false;
    const t = snap({ winner: 1 });
    expect(new InvariantChecker({ map }).observe(s).map(violationSignature)).toEqual(['sealContradiction:eliminatedAlive']);
    expect(new InvariantChecker({ map }).observe(t).map(violationSignature)).toEqual(['sealContradiction:winnerWithRivals']);
  });
  test('a winner with every rival eliminated, or a draw with nobody left, is fine', () => {
    const s = snap({ winner: 1 });
    Object.assign(s.players[1], { alive: false, eliminated: true });
    expect(new InvariantChecker({ map }).observe(s)).toEqual([]);
    const d = snap({ winner: -1 });
    for (const p of d.players) Object.assign(p, { alive: false, eliminated: true });
    expect(new InvariantChecker({ map }).observe(d)).toEqual([]);
  });
  test('flags a missing winner only after the grace period', () => {
    const c = new InvariantChecker({ map });
    const s = snap();
    Object.assign(s.players[1], { alive: false, eliminated: true });
    expect(c.observe(s)).toEqual([]);
    expect(c.observe(next(s))).toEqual([]);
    expect(c.observe(next(s, 2)).map(violationSignature)).toEqual(['sealContradiction:noWinner']);
  });
  test('sealed flags must match the flood fill (and sudden death seals all)', () => {
    const c = new InvariantChecker({ map });
    const s = snap({ sealed: [true, false] });
    expect(c.observe(s)).toEqual([]); // grace
    expect(c.observe(next(s, 2)).map(violationSignature)).toEqual(['sealContradiction:sealedMismatch']);
    const sd = snap({ suddenDeath: true, sealed: [true, true] });
    const c2 = new InvariantChecker({ map });
    expect([...c2.observe(sd), ...c2.observe(next(sd, 2))]).toEqual([]);
  });
  test('a bunker walled in with real pieces reads as sealed', async () => {
    // Steel walls across all three doorways: the sim's flood fill says sealed, so sealed=true is consistent.
    const pieces = isl.bunker.doorways.map((d, i) => piece(100 + i, 'steel', add(d.center, scale(forward(d.yaw), 0.4)), d.yaw));
    const c = new InvariantChecker({ map });
    const s = snap({ pieces, sealed: [true, false] });
    expect([...c.observe(s), ...c.observe(next(s, 2))]).toEqual([]);
  });
});

describe('floatingPiece', () => {
  test('flags a piece in mid-air that survived a collapse pass, after the grace period, once', () => {
    const c = new InvariantChecker({ map });
    const air = piece(7, 'wood', { ...spot(8, 3), y: isl.groundY + 6 });
    const s = snap({ pieces: [air], events: [{ t: 1, type: 'destroyed', data: { piece: 3 } }] });
    expect(c.observe(s)).toEqual([]);
    const later = { ...next(s, 3), events: [] };
    const v = c.observe(later);
    expect(v.map(violationSignature)).toEqual(['floatingPiece:wood']);
    expect(v[0].pieceId).toBe(7);
    expect(c.observe({ ...next(later, 5), events: [{ t: 2, type: 'destroyed', data: {} }] })).toEqual([]);
    expect(c.observe(next(later, 8))).toEqual([]);
  });
  test('grounded pieces, stacked pieces and pieces placed after the collapse pass are fine', () => {
    const c = new InvariantChecker({ map });
    const base = piece(1, 'sandbags', spot(8, 3));
    const onTop = piece(2, 'sandbags', { ...spot(8, 3), y: isl.groundY + 1 });
    const s = snap({ pieces: [base, onTop], events: [{ t: 1, type: 'destroyed', data: {} }] });
    c.observe(s);
    const placedLater = piece(9, 'wood', { ...spot(8, 3), y: isl.groundY + 6 });
    expect(c.observe({ ...next(s, 3), pieces: [base, onTop, placedLater], events: [] })).toEqual([]);
  });
  test('no destruction, no check (unsupported pieces only collapse after something breaks)', () => {
    const c = new InvariantChecker({ map });
    const s = snap({ pieces: [piece(7, 'wood', { ...spot(8, 3), y: isl.groundY + 6 })] });
    for (let i = 0; i < 40; i++) expect(c.observe(next(s, i))).toEqual([]);
  });
  test('analytic support is never stricter than the sim (floatingPieces ⊆ unsupportedPieces)', async () => {
    const ph = await Physics.create(map);
    const g = isl.groundY;
    const roofY = g + 2.8;
    const ps: PieceState[] = [
      piece(1, 'sandbags', spot(8, 3)),
      piece(2, 'wood', { ...spot(8, 3), y: g + 1 }), // on the sandbags
      piece(3, 'ramp', spot(10, -4)),
      piece(4, 'scaffold', { ...spot(10, -4), y: g + 1.5 }), // touching the ramp top
      piece(5, 'metal', { ...spot(12, 6), y: g + 4 }), // floating
      piece(6, 'sandbags', { x: isl.bunker.center.x, y: roofY, z: isl.bunker.center.z }), // on the bunker roof
      piece(7, 'container', spot(isl.radius - 1, 0)), // hangs over the island edge
      piece(8, 'scaffold', { ...spot(isl.radius + 2.5, 0), y: g - 0.2 }), // just past the edge, below ground level
      piece(9, 'wood', { ...spot(12, 6), y: g + 2.5 }), // floating, below piece 5 (touches it): both unsupported
      piece(10, 'steel', { ...spot(-6, 6), y: g + 0.1 }), // slightly hovering (within the probe band)
    ];
    for (const p of ps) ph.addPiece(p);
    const sim = new Set(unsupportedPieces(ph, new Map(ps.map((p) => [p.id, p]))));
    const mine = floatingPieces(map, ps);
    for (const id of mine) expect(sim.has(id)).toBe(true);
    expect(mine.sort((a, b) => a - b)).toEqual([5, 8, 9]);
  });
});

describe('neverEnds', () => {
  test('flags a run that ends with no winner past the limit', () => {
    const c = new InvariantChecker({ map });
    expect(DEFAULT_MAX_MATCH_SEC).toBe(LIFECYCLE.suddenDeathAt + 600);
    expect(c.finish(snap({ time: DEFAULT_MAX_MATCH_SEC + 1 })).map(violationSignature)).toEqual(['neverEnds']);
    expect(c.violations.map((v) => v.kind)).toEqual(['neverEnds']);
  });
  test('a won match, or one stopped early, is fine', () => {
    expect(new InvariantChecker({ map }).finish(snap({ time: 5000, winner: 1 }))).toEqual([]);
    expect(new InvariantChecker({ map }).finish(snap({ time: 60 }))).toEqual([]);
    expect(new InvariantChecker({ map, maxMatchSec: 30 }).finish(snap({ time: 60 }))).toHaveLength(1);
  });
});

describe('maxPerKind', () => {
  test('caps stored violations per kind', () => {
    const c = new InvariantChecker({ map, maxPerKind: 2 });
    const s = snap();
    s.players[0].inv.grenades = -1;
    s.players[0].inv.charges = -1;
    s.players[0].inv.medkits = -1;
    c.observe(s);
    expect(c.violations).toHaveLength(2);
  });
});

/** A real bot-only match, inputs captured from the bots so the stuck check runs too. */
async function botRun(players: number, seed: number, ticks: number) {
  const inputs = new Map<number, PlayerInput>();
  const m = await Match.create(
    { players: Array.from({ length: players }, () => ({ name: '', isBot: true, difficulty: 'hard' as const })), seed },
    {
      makeBot: (id, difficulty, rng) => {
        const b = new Bot(id, difficulty, rng);
        return { think: (view) => { const i = b.think(view); inputs.set(id, i); return i; } };
      },
    },
  );
  const c = new InvariantChecker({ map: m.map });
  let s: Snapshot | null = null;
  for (let i = 0; i < ticks && s?.winner == null; i++) {
    inputs.clear();
    s = m.tick(new Map());
    c.observe(s, inputs);
  }
  c.finish(s!);
  return c.violations;
}

describe('integration: real bot-only matches', () => {
  test('a short 4-bot match produces no violations', async () => {
    expect(await botRun(4, 7, 900)).toEqual([]);
  }, 120_000);
  // Long soak used to calibrate thresholds; run with INVARIANT_SOAK=1.
  test.skipIf(!process.env.INVARIANT_SOAK)('soak: several longer matches', async () => {
    const all: Violation[] = [];
    for (const [n, seed] of [[2, 1], [4, 2], [6, 3], [8, 4], [3, 5]]) all.push(...(await botRun(n, seed, 30 * 60 * 8)));
    console.log(JSON.stringify(all, null, 1));
    expect(all).toEqual([]);
  }, 1_800_000);
});

