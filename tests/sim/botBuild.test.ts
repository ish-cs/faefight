import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { BUILD_SKILL, BUILD_TUNING, fortPlan, ghost, ownBunkerSafe, shields } from '../../src/sim/bots/build';
import { lookAt } from '../../src/sim/bots/aim';
import { islandAt, lane, laneAt, laneS, type Lane } from '../../src/sim/bots/nav';
import { preset, type Archetype } from '../../src/sim/bots/personality';
import { eyePos } from '../../src/sim/combat';
import { PIECES, PLAYER, WEAPONS } from '../../src/sim/constants';
import { buildMap } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { isSealed } from '../../src/sim/seal';
import { NO_INPUT } from '../../src/sim/types';
import type { Difficulty, PieceKind, PieceState, PlayerInput, Snapshot } from '../../src/sim/types';
import { add, dist2D, forward, right, scale, v3 } from '../../src/sim/vec';

const laneOffset = (l: Lane, p: { x: number; z: number }) => Math.abs((p.x - l.origin.x) * l.dir.z - (p.z - l.origin.z) * l.dir.x);
const WALL_KINDS: PieceKind[] =['sandbags', 'wood', 'metal', 'steel'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bot seat 1 (with this archetype) vs an idle human seat 2. */
async function duel(difficulty: Difficulty, archetype: Archetype, seed = 5) {
  let bot: Bot | null = null;
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'human', isBot: false }], seed },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset(archetype))) });
  return { m, bot: () => bot! };
}

describe('combat building (real physics)', () => {
  /** Bot standing in the open on its island; a human 16 m away shoots it twice with a pistol. */
  async function underFire(difficulty: Difficulty, archetype: Archetype = 'Economist', seed = 5) {
    const { m } = await duel(difficulty, archetype, seed);
    const isl = m.map[0];
    const lat = right(isl.bunker.facingYaw);
    const botAt = add(isl.center, scale(lat, -8)), humanAt = add(isl.center, scale(lat, 8));
    m.debugTeleport(1, v3(botAt.x, isl.groundY + 0.05, botAt.z));
    m.debugTeleport(2, v3(humanAt.x, isl.groundY + 0.05, humanAt.z));
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { wood: 4, sandbags: 2 } });
    m.debugGive(2, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } } });
    let snap: Snapshot = m.tick(new Map());
    let firstHit = -1, built: { t: number; piece: PieceState } | null = null;
    for (let i = 0; i < 6 * 30 && !built; i++) {
      const h = snap.players[1], b = snap.players[0];
      const aim = lookAt(eyePos(h), add(b.pos, v3(0, 1.2, 0)));
      const fire = i === 3 || i === 27;
      const input: PlayerInput = { ...NO_INPUT, yaw: aim.yaw, pitch: aim.pitch, fire, select: h.hotbar.indexOf('pistol') };
      snap = m.tick(new Map([[2, input]]));
      for (const e of snap.events) {
        if (e.type === 'hit' && e.data.target === 1 && firstHit < 0) firstHit = e.t;
        if (e.type === 'placed' && e.data.by === 1) {
          const piece = snap.pieces.find((p) => p.id === e.data.piece)!;
          built = { t: e.t, piece };
        }
      }
    }
    return { firstHit, built, snap, m };
  }

  for (const difficulty of ['hard', 'pro'] as Difficulty[]) {
    test(`${difficulty}: shot at in the open → a wall between it and the shooter within 2 s`, async () => {
      const r = await underFire(difficulty);
      expect(r.firstHit).toBeGreaterThan(0);
      expect(r.built).not.toBeNull();
      expect(r.built!.t - r.firstHit).toBeLessThan(2);
      expect(WALL_KINDS).toContain(r.built!.piece.kind);
      const h = r.snap.players[1], b = r.snap.players[0];
      expect(shields(r.built!.piece, eyePos(h), add(b.pos, v3(0, 1.2, 0))) || dist2D(r.built!.piece.pos, b.pos) < 2).toBe(true);
    }, 60_000);
  }

  test('pro: after the wall goes up it hides behind it and peeks out to shoot back', async () => {
    const r = await underFire('pro');
    expect(r.built).not.toBeNull();
    // The human keeps watching (no more shots); the bot should alternate between hidden and out shooting.
    const { m } = r;
    let snap = r.snap, hidden = 0, out = 0, shots = 0;
    for (let i = 0; i < 6 * 30; i++) {
      const h = snap.players[1], b = snap.players[0];
      const aim = lookAt(eyePos(h), add(b.pos, v3(0, 1.2, 0)));
      snap = m.tick(new Map([[2, { ...NO_INPUT, yaw: aim.yaw, pitch: aim.pitch, select: h.hotbar.indexOf('pistol') }]]));
      const me = snap.players[0];
      const safe = snap.pieces.some((p) => p.owner === 1 && shields(p, eyePos(snap.players[1]), add(me.pos, v3(0, 1.2, 0))));
      if (safe) hidden++; else out++;
      shots += snap.events.filter((e) => e.type === 'shot' && e.data.by === 1).length;
    }
    console.log(`peeking: ${hidden} ticks hidden, ${out} out, ${shots} shots`);
    expect(hidden).toBeGreaterThan(30);
    expect(out).toBeGreaterThan(10);
    expect(shots).toBeGreaterThan(0);
  }, 60_000);
});

describe('never seals its own bunker', () => {
  test('ownBunkerSafe (property): whenever it says yes, a 1.3 m way out remains', () => {
    const map = buildMap(4);
    const b = map[0].bunker;
    const rng = mulberry32(42);
    const kinds: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'container'];
    let yes = 0, no = 0;
    for (let trial = 0; trial < 300; trial++) {
      const pieces: PieceState[] = [];
      const n = Math.floor(rng() * 5);
      const rand = (id: number): PieceState => {
        const a = rng() * 2 * Math.PI, r = 2.2 + rng() * 5;
        const kind = kinds[Math.floor(rng() * kinds.length)];
        return { id, kind, owner: 9, pos: v3(b.center.x + Math.cos(a) * r, b.center.y, b.center.z + Math.sin(a) * r), rotY: rng() * Math.PI, hp: PIECES[kind].hp };
      };
      for (let i = 0; i < n; i++) pieces.push(rand(i));
      if (isSealed(b, pieces, 0.3)) continue;
      const cand = rand(99);
      const ok = ownBunkerSafe(b, pieces, ghost(cand.kind, cand.pos, cand.rotY, 0));
      if (ok) { yes++; expect(isSealed(b, [...pieces, cand])).toBe(false); expect(isSealed(b, [...pieces, cand], 0.3)).toBe(false); }
      else no++;
    }
    expect(yes).toBeGreaterThan(20);
    expect(no).toBeGreaterThan(20);
  });

  test('shot at right next to its own doorway: never walls itself in', async () => {
    for (const seed of [1, 2, 3]) {
      const { m } = await duel('pro', 'Turtle', seed);
      const b = m.map[0].bunker;
      const d = b.doorways[0];
      const at = add(d.center, scale(forward(d.yaw), 1.6));
      m.debugTeleport(1, v3(at.x, d.center.y + 0.05, at.z));
      const far = add(d.center, scale(forward(d.yaw), 14));
      m.debugTeleport(2, v3(far.x, d.center.y + 0.05, far.z));
      m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { wood: 5, sandbags: 4 } });
      m.debugGive(2, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } } });
      let snap = m.tick(new Map());
      for (let i = 0; i < 8 * 30; i++) {
        const h = snap.players[1], me = snap.players[0];
        const aim = lookAt(eyePos(h), add(me.pos, v3(0, 1.2, 0)));
        snap = m.tick(new Map([[2, { ...NO_INPUT, yaw: aim.yaw, pitch: aim.pitch, fire: i % 40 === 3, select: h.hotbar.indexOf('pistol') }]]));
        const mine = snap.pieces.filter((p) => p.owner === 1);
        expect(isSealed(b, mine)).toBe(false);
        expect(snap.sealed[0]).toBe(false);
      }
    }
  }, 300_000);

  test('4 builder bots over 5 minutes, several seeds: no bot ever seals itself in', async () => {
    let placedNear = 0;
    for (const seed of [1, 2, 3, 4]) {
      const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy'];
      const types: Archetype[] = ['Turtle', 'Turtle', 'Economist', 'Turtle'];
      const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
        { makeBot: (id, d, rng) => new Bot(id, d, rng, preset(types[id - 1])) });
      for (let id = 1; id <= 4; id++) m.debugGive(id, { cash: 400 });
      let snap = m.tick(new Map());
      for (let i = 0; i < 5 * 60 * 30 && snap.winner === null; i++) {
        snap = m.tick(new Map());
        for (const e of snap.events) {
          if (e.type === 'sealed') expect(e.data.by === e.data.owner && e.data.by !== null).toBe(false);
          if (e.type !== 'placed') continue;
          const by = e.data.by as number;
          const own = m.map[snap.players.find((p) => p.id === by)!.island].bunker;
          const piece = snap.pieces.find((p) => p.id === e.data.piece);
          if (!piece || dist2D(piece.pos, own.center) > BUILD_TUNING.ownBunkerCheck) continue;
          placedNear++;
          expect(isSealed(own, snap.pieces)).toBe(false);
        }
      }
    }
    console.log(`pieces placed within ${BUILD_TUNING.ownBunkerCheck} m of the placer's own bunker: ${placedNear}`);
  }, 600_000);
});

describe('fortifying home (real physics)', () => {
  test('a Turtle fortifies home within the first minutes without ever sealing its own bunker', async () => {
    const { m } = await duel('hard', 'Turtle', 7);
    let snap = m.tick(new Map());
    let firstFort = -1;
    const home = m.map[0];
    const fortAt = (s: Snapshot) => s.pieces.filter((p) => p.owner === 1 && islandAt(m.map, p.pos) === 0 && dist2D(p.pos, home.bunker.center) > 6);
    for (let i = 0; i < 5 * 60 * 30 && snap.winner === null; i++) {
      snap = m.tick(new Map());
      expect(snap.sealed[0]).toBe(false);
      if (firstFort < 0 && fortAt(snap).length) firstFort = snap.time;
    }
    const forts = fortAt(snap);
    console.log(`turtle: first fortification at ${firstFort.toFixed(0)} s, ${forts.length} pieces at home: ${forts.map((p) => p.kind).join(' ')}`);
    expect(firstFort).toBeGreaterThan(0);
    expect(firstFort).toBeLessThan(180);
    expect(forts.length).toBeGreaterThanOrEqual(4);
    expect(isSealed(home.bunker, snap.pieces)).toBe(false);
  }, 120_000);

  test('a shot-out fortification piece is rebuilt when things are calm', async () => {
    const { m } = await duel('pro', 'Turtle', 3);
    m.debugGive(1, { cash: 600 });
    let snap = m.tick(new Map());
    const home = m.map[0];
    const mine = (s: Snapshot) => s.pieces.filter((p) => p.owner === 1 && p.kind === 'sandbags' && islandAt(m.map, p.pos) === 0);
    for (let i = 0; i < 3 * 60 * 30 && mine(snap).length < 3; i++) snap = m.tick(new Map());
    const victim = mine(snap)[0];
    expect(victim).toBeDefined();
    m.debugDamagePiece(victim.id, 10_000);
    snap = m.tick(new Map());
    expect(snap.pieces.some((p) => p.id === victim.id)).toBe(false);
    let back = -1;
    const t0 = snap.time;
    for (let i = 0; i < 90 * 30 && back < 0; i++) {
      snap = m.tick(new Map());
      if (snap.pieces.some((p) => p.kind === 'sandbags' && p.id !== victim.id && dist2D(p.pos, victim.pos) < 0.8 && Math.abs(p.pos.y - victim.pos.y) < 0.5)) back = snap.time - t0;
    }
    console.log(`fortification piece rebuilt after ${back.toFixed(1)} s`);
    expect(back).toBeGreaterThan(0);
    expect(isSealed(home.bunker, snap.pieces)).toBe(false);
  }, 120_000);

  test('the plan never comes near the bunker and has firing positions, econ cover and (for builders) a tower', () => {
    const map = buildMap(8);
    for (const isl of map) {
      const plan = fortPlan(map, isl.index, preset('Turtle').traits);
      expect(plan.some((s) => s.tag === 'post')).toBe(true);
      expect(plan.some((s) => s.tag === 'econ')).toBe(true);
      expect(plan.some((s) => s.tag === 'tower')).toBe(true);
      for (const s of plan) {
        expect(dist2D(s.pos, isl.bunker.center)).toBeGreaterThan(BUILD_TUNING.ownBunkerCheck);
        expect(dist2D(s.pos, isl.center)).toBeLessThan(isl.radius - 1);
      }
    }
  });
});

describe('bridge craft (real physics)', () => {
  test('a builder bridging a long gap puts side walls on the deck and the bridge still gets finished', async () => {
    const { m } = await duel('hard', 'Turtle', 9);
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { scaffold: 12, wood: 5 } });
    let snap = m.tick(new Map());
    let walls: PieceState[] = [];
    let crossed = false;
    for (let i = 0; i < 120 * 30 && !crossed; i++) {
      snap = m.tick(new Map());
      walls = snap.pieces.filter((p) => p.owner === 1 && p.kind === 'wood' && islandAt(m.map, p.pos) < 0);
      // Across: on the rival's island, or on the center island (map origin) when that was the shorter bridge.
      const me = snap.players[0].pos;
      crossed = islandAt(m.map, me) === 1 || Math.hypot(me.x, me.z) < 12;
    }
    const decks = snap.pieces.filter((p) => p.owner === 1 && p.kind === 'scaffold');
    console.log(`bridge: ${decks.length} decks, ${walls.length} side walls, crossed ${crossed}`);
    expect(walls.length).toBeGreaterThanOrEqual(1);
    // The walls stand on the deck (scaffold top), not in the water.
    for (const w of walls) expect(decks.some((d) => Math.abs(d.pos.y + PIECES.scaffold.h - w.pos.y) < 0.1 && dist2D(d.pos, w.pos) < 2.5)).toBe(true);
    expect(crossed).toBe(true);
  }, 120_000);
});

describe('bridge craft: alternate route', () => {
  test('main bridge shot out while under fire → a hard bot lays a new one on the other lane', async () => {
    const { m } = await duel('hard', 'Turtle', 3); // a seed where it bridges to the rival first (with traps + piers + gameplay props: seeds 3-6, 8 do; 1, 2 and 9 go elsewhere first)
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { scaffold: 16, wood: 3 } });
    const main = lane(m.map, 0, 1), mirror = lane(m.map, 1, 0);
    let snap = m.tick(new Map());
    const decksOn = (l: typeof main) => snap.pieces.filter((p) => p.owner === 1 && p.kind === 'scaffold' && laneOffset(l, p.pos) < 0.5);
    for (let i = 0; i < 60 * 30 && decksOn(main).length < 4; i++) snap = m.tick(new Map());
    expect(decksOn(main).length).toBe(4);
    // Back on land (say it went to restock), someone shoots its first deck out (everything past it falls).
    const shore = laneAt(main, 15);
    m.debugTeleport(1, v3(shore.x, m.map[0].groundY + 0.05, shore.z));
    const first = decksOn(main).sort((a, b) => laneS(main, a.pos) - laneS(main, b.pos))[0];
    m.debugDamagePiece(first.id, 10_000);
    for (let i = 0; i < 40 * 30 && decksOn(mirror).length < 2; i++) snap = m.tick(new Map());
    console.log(`after the cut: ${decksOn(main).length} decks on the main lane, ${decksOn(mirror).length} on the mirror lane`);
    expect(decksOn(mirror).length).toBeGreaterThanOrEqual(2);
    // The new bridge is finished and walked.
    let crossed = false;
    for (let i = 0; i < 90 * 30 && !crossed; i++) { snap = m.tick(new Map()); crossed = islandAt(m.map, snap.players[0].pos) === 1; }
    console.log(`mirror lane: ${decksOn(mirror).length} decks, crossed ${crossed}`);
    expect(crossed).toBe(true);
  }, 120_000);
});

describe('skill shows in how much bots build', () => {
  // The match-level check (PRO and Hard out-build Easy in real games) is in botBuildSkill.test.ts.
  test('skill table is ordered: better players cover more often, sooner, cleaner', () => {
    const order: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
    for (let i = 1; i < order.length; i++) {
      const a = BUILD_SKILL[order[i - 1]], b = BUILD_SKILL[order[i]];
      expect(b.coverChance).toBeGreaterThan(a.coverChance);
      expect(b.coverDelay).toBeLessThan(a.coverDelay);
      expect(b.misplace).toBeLessThanOrEqual(a.misplace);
      expect(b.gap).toBeLessThan(a.gap);
    }
    expect(PLAYER.radius).toBeGreaterThan(0);
  });
});
