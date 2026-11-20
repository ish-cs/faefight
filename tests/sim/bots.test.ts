import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { AIM, angleBetween, lookAt } from '../../src/sim/bots/aim';
import { lane, laneAt } from '../../src/sim/bots/nav';
import { plugSpot } from '../../src/sim/bots/plans';
import type { BotView, OtherStatus } from '../../src/sim/bots/view';
import type { Placement } from '../../src/sim/building';
import { BUILD, PIECES, TICK_HZ, WEAPONS } from '../../src/sim/constants';
import { eyePos } from '../../src/sim/combat';
import { buildMap } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import { isSealed } from '../../src/sim/seal';
import { snapPlacement, validatePlacement } from '../../src/sim/building';
import { newPlayer } from '../../src/sim/player';
import type { Difficulty, PieceKind, PieceState, PlayerInput, PlayerState, Vec3 } from '../../src/sim/types';
import { add, dist2D, forward, right, rotateY, scale, sub, v3, yawOf } from '../../src/sim/vec';

const map = buildMap(2);
const DT = 1 / TICK_HZ;

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

/** Land discs plus scaffold decks; null over water. */
function groundAt(pieces: PieceState[], x: number, z: number): number | null {
  let top: number | null = null;
  for (const p of pieces) {
    const s = PIECES[p.kind];
    const l = rotateY(v3(x - p.pos.x, 0, z - p.pos.z), -p.rotY);
    if (Math.abs(l.x) <= s.w / 2 && Math.abs(l.z) <= s.d / 2) top = Math.max(top ?? -Infinity, p.pos.y + s.h);
  }
  for (const isl of map) if (dist2D({ x, z }, isl.center) <= isl.radius) top = Math.max(top ?? -Infinity, isl.groundY);
  return top;
}

/** Simplified validatePlacement: reach, scaffold attaches level past its near end without overlapping decks, otherwise ground under the center. */
function canPlace(view: BotView, kind: PieceKind, pos: Vec3, rotY: number): Placement {
  if (dist2D(pos, view.self.pos) > BUILD.reach) return { ok: false, reason: 'too far' };
  if (kind === 'scaffold') {
    const s = PIECES.scaffold;
    const ends = [-1, 1].map((k) => add(pos, rotateY(v3(0, 0, k * (s.d / 2 + 0.2)), rotY)));
    const near = dist2D(ends[0], view.self.pos) <= dist2D(ends[1], view.self.pos) ? ends[0] : ends[1];
    const y = view.groundAt(near.x, near.z);
    if (y === null) return { ok: false, reason: 'scaffold needs a support at the near end' };
    for (const p of view.pieces) {
      if (p.kind !== 'scaffold') continue;
      const l = rotateY(v3(pos.x - p.pos.x, 0, pos.z - p.pos.z), -p.rotY);
      if (Math.abs(l.x) < s.w - 0.04 && Math.abs(l.z) < s.d - 0.04) return { ok: false, reason: 'blocked' };
    }
    const onDeck = view.pieces.some((p) => p.kind === 'scaffold' && Math.abs(p.pos.y + s.h - y) < 1e-6 &&
      Math.abs(rotateY(v3(near.x - p.pos.x, 0, near.z - p.pos.z), -p.rotY).z) <= s.d / 2);
    return { ok: true, pos: v3(pos.x, onDeck ? y - s.h : y, pos.z) };
  }
  const y = view.groundAt(pos.x, pos.z);
  return y === null ? { ok: false, reason: 'nothing to build on' } : { ok: true, pos: v3(pos.x, Math.max(y, pos.y), pos.z) };
}

const enemyStatus = (over: Partial<OtherStatus> = {}): OtherStatus =>
  ({ id: 1, island: 1, alive: true, eliminated: false, respawnAt: null, ...over });

function makeView(self: PlayerState, over: Partial<BotView> = {}): BotView {
  const view: BotView = {
    now: 100, self, enemies: [], others: [enemyStatus()], map, pieces: [],
    generators: [0, 0], sealed: [false, false], waterY: 0, suddenDeath: false,
    groundAt: (x, z) => groundAt(view.pieces, x, z),
    canPlace: (k, p, r) => canPlace(view, k, p, r),
    ...over,
  };
  return view;
}

/** Point on island i: `fwd` m toward the map center from the island center, `side` m to its right. */
function onIsland(i: number, fwd: number, side = 0): Vec3 {
  const isl = map[i];
  const p = add(add(isl.center, scale(forward(isl.bunker.facingYaw), fwd)), scale(right(isl.bunker.facingYaw), side));
  return v3(p.x, isl.groundY, p.z);
}

const worldMove = (inp: PlayerInput): Vec3 =>
  add(scale(right(inp.yaw), inp.moveX), scale(forward(inp.yaw), inp.moveZ));

/** Minimal kinematic stand-in for Match: walk on solid ground, apply build requests, advance time. */
function step(view: BotView, inp: PlayerInput, placed: PieceState[], onPlace?: (p: PieceState) => void) {
  const me = view.self;
  if (inp.build && me.busyUntil <= view.now && (me.inv.pieces[inp.build.kind] ?? 0) > 0) {
    const r = view.canPlace(inp.build.kind, inp.build.pos, inp.build.rotY);
    if (r.ok) {
      const piece: PieceState = { id: 100 + placed.length, kind: inp.build.kind, owner: me.id, pos: r.pos, rotY: inp.build.rotY, hp: PIECES[inp.build.kind].hp };
      placed.push(piece);
      view.pieces = [...view.pieces, piece];
      onPlace?.(piece);
      me.inv.pieces[inp.build.kind]! -= 1;
      me.busyUntil = view.now + PIECES[inp.build.kind].placeSec;
    }
  }
  const m = worldMove(inp);
  const l = Math.hypot(m.x, m.z);
  if (l > 1e-6) {
    const speed = (inp.sprint ? 7.5 : 5) * DT * Math.min(1, l) / l;
    const next = v3(me.pos.x + m.x * speed, me.pos.y, me.pos.z + m.z * speed);
    const g = view.groundAt(next.x, next.z);
    if (g !== null) me.pos = v3(next.x, g, next.z);
  }
  me.yaw = inp.yaw;
  me.pitch = inp.pitch;
  view.now += DT;
}

describe('Bot economy', () => {
  test('heads to its generator with ≥ 40 stored and interacts within 2.5 m', () => {
    const gen = map[0].generator;
    const self = newPlayer(0, 'bot', true, 0, add(gen, v3(8, 0, 3)));
    self.inv.cash = 0;
    const view = makeView(self, { generators: [60, 0] });
    const bot = new Bot(0, 'medium', mulberry32(1));
    const first = bot.think(view);
    const dir = worldMove(first);
    const want = sub(gen, self.pos);
    const cos = (dir.x * want.x + dir.z * want.z) / (Math.hypot(dir.x, dir.z) * Math.hypot(want.x, want.z));
    expect(cos).toBeGreaterThan(0.8);
    let interacted = false;
    let inp = first;
    for (let i = 0; i < 4 * TICK_HZ; i++) {
      step(view, inp, []);
      inp = bot.think(view);
      const d = dist2D(self.pos, gen);
      if (inp.interact) { expect(d).toBeLessThanOrEqual(2.5); interacted = true; }
    }
    expect(interacted).toBe(true);
  });

  test('buys a pistol at its own shop with $50+ and no gun', () => {
    const self = newPlayer(0, 'bot', true, 0, add(map[0].shop, v3(1.5, 0, 0)));
    self.inv.cash = 60;
    const inp = new Bot(0, 'hard', mulberry32(2)).think(makeView(self));
    expect(inp.shop).toEqual({ buy: 'pistol' });
  });
});

/** Bot holding a pistol facing a visible enemy `range` m ahead on its own island. */
function duel(difficulty: Difficulty, seed: number, offDeg = 0) {
  const self = newPlayer(0, 'bot', true, 0, onIsland(0, 0, 0));
  self.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: 36 };
  self.equipped = 'pistol';
  const enemy = newPlayer(1, 'foe', false, 1, onIsland(0, 12, 2));
  const exact = lookAt(eyePos(self), v3(enemy.pos.x, enemy.pos.y + 1.2, enemy.pos.z));
  self.yaw = exact.yaw + (offDeg * Math.PI) / 180;
  self.pitch = exact.pitch;
  const view = makeView(self, { enemies: [enemy] });
  return { self, enemy, view, bot: new Bot(0, difficulty, mulberry32(seed)) };
}

describe('Bot aim', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as Difficulty[]) {
    test(`${difficulty}: holds fire for the reaction delay, then fires within a tick`, () => {
      const { view, bot, self } = duel(difficulty, 3);
      const t0 = view.now;
      const firstAllowed = Math.ceil(AIM[difficulty].reactSec * TICK_HZ - 1e-6);
      let firstFire = -1;
      for (let k = 0; k <= firstAllowed + 3; k++) {
        view.now = t0 + k * DT;
        const inp = bot.think(view);
        self.yaw = inp.yaw;
        self.pitch = inp.pitch;
        if (k < firstAllowed) expect(inp.fire, `tick ${k}`).toBe(false);
        if (inp.fire && firstFire < 0) firstFire = k;
      }
      expect(firstFire).toBeGreaterThanOrEqual(firstAllowed);
      expect(firstFire).toBeLessThanOrEqual(firstAllowed + 1);
    });
  }

  test('hard aim error is smaller than easy over 200 samples', () => {
    const meanErr = (difficulty: Difficulty) => {
      let sum = 0;
      for (let i = 0; i < 200; i++) {
        const { view, bot, self, enemy } = duel(difficulty, 1000 + i, 15);
        const t0 = view.now;
        let inp = bot.think(view);
        for (let k = 1; k <= 20; k++) {
          self.yaw = inp.yaw; self.pitch = inp.pitch;
          view.now = t0 + k * DT;
          inp = bot.think(view);
        }
        sum += angleBetween(inp, lookAt(eyePos(self), v3(enemy.pos.x, enemy.pos.y + 1.2, enemy.pos.z)));
      }
      return sum / 200;
    };
    const easy = meanErr('easy'), hard = meanErr('hard');
    expect(hard).toBeLessThan(easy);
    expect(easy).toBeLessThan((10 * Math.PI) / 180);
  });
});

describe('Bot building', () => {
  test('at its island edge with scaffold, builds a bridge toward the enemy island', () => {
    const l = lane(map, 0, 1);
    const start = laneAt(l, 19.5);
    const self = newPlayer(0, 'bot', true, 0, v3(start.x, map[0].groundY, start.z));
    self.inv.cash = 0;
    self.inv.weapons.pistol = { mag: 12, spare: 36 };
    self.equipped = 'pistol';
    self.inv.pieces.scaffold = 4;
    self.yaw = yawOf(l.dir);
    const view = makeView(self);
    const bot = new Bot(0, 'medium', mulberry32(4));
    const placed: PieceState[] = [];
    let requests = 0, farthest = start.x;
    for (let i = 0; i < 12 * TICK_HZ; i++) {
      const inp = bot.think(view);
      if (inp.build && self.busyUntil <= view.now) {
        requests++;
        expect(inp.build.kind).toBe('scaffold');
        expect(view.canPlace(inp.build.kind, inp.build.pos, inp.build.rotY).ok).toBe(true);
      }
      step(view, inp, placed);
      farthest = Math.max(farthest, self.pos.x);
    }
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(placed.length).toBe(4);
    const along = placed.map((p) => (p.pos.x - start.x) * l.dir.x + (p.pos.z - start.z) * l.dir.z);
    for (let i = 1; i < along.length; i++) expect(along[i]).toBeGreaterThan(along[i - 1] + 2.5);
    expect(farthest).toBeGreaterThan(start.x + 6);
  });

  test('enemy respawning: plugs every doorway of the enemy bunker with steel', () => {
    const b = map[1].bunker;
    const front = b.doorways[0];
    const self = newPlayer(0, 'bot', true, 0, add(front.center, scale(forward(front.yaw), 6)));
    self.inv.cash = 0;
    self.inv.weapons.pistol = { mag: 12, spare: 36 };
    self.equipped = 'pistol';
    self.inv.pieces.steel = 3;
    const view = makeView(self, { others: [enemyStatus({ alive: false, respawnAt: 102.5 })] });
    const bot = new Bot(0, 'hard', mulberry32(5));
    const placed: PieceState[] = [];
    for (let i = 0; i < 20 * TICK_HZ && placed.length < 3; i++) step(view, bot.think(view), placed);
    expect(placed.map((p) => p.kind)).toEqual(['steel', 'steel', 'steel']);
    const doors = new Set<number>();
    for (const p of placed) {
      const i = b.doorways.findIndex((d) => dist2D(p.pos, plugSpot(d, 'steel', 0)) < 0.3);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(Math.abs(Math.sin(p.rotY - b.doorways[i].yaw))).toBeLessThan(1e-6);
      doors.add(i);
    }
    expect(doors.size).toBe(3);
    expect(isSealed(b, placed)).toBe(true);
  });

  test('real physics: bridge segments validate, stay walkable, and the bot walks out on them', async () => {
    const ph = await Physics.create(map);
    const l = lane(map, 0, 1);
    const start = laneAt(l, 19.5);
    const self = newPlayer(0, 'bot', true, 0, v3(start.x, map[0].groundY, start.z));
    self.inv.cash = 0;
    self.inv.weapons.pistol = { mag: 12, spare: 36 };
    self.equipped = 'pistol';
    self.inv.pieces.scaffold = 5;
    const view = makeView(self);
    view.groundAt = (x, z) => ph.isGroundAt(x, z);
    view.canPlace = (k, p, r) => {
      const s = snapPlacement(p, r, true);
      return validatePlacement(ph, k, s.pos, s.rotY, view.self.pos);
    };
    const bot = new Bot(0, 'hard', mulberry32(8));
    const placed: PieceState[] = [];
    let farthest = start.x;
    for (let i = 0; i < 15 * TICK_HZ && placed.length < 5; i++) {
      step(view, bot.think(view), placed, (p) => ph.addPiece(p));
      farthest = Math.max(farthest, self.pos.x);
    }
    expect(placed.length).toBe(5);
    const tip = laneAt(l, 19.5 + 5 * 3.2);
    expect(ph.isGroundAt(tip.x, tip.z)).not.toBeNull();
    expect(farthest).toBeGreaterThan(start.x + 10);
  });

  test('real physics: steel plugs validate in every doorway and seal the bunker', async () => {
    const ph = await Physics.create(map);
    const b = map[1].bunker;
    const front = b.doorways[0];
    const self = newPlayer(0, 'bot', true, 0, add(front.center, scale(forward(front.yaw), 6)));
    self.inv.pieces.steel = 3;
    self.inv.weapons.pistol = { mag: 12, spare: 36 };
    self.equipped = 'pistol';
    self.inv.cash = 0;
    const view = makeView(self, { others: [enemyStatus({ alive: false, respawnAt: 102.5 })] });
    view.groundAt = (x, z) => ph.isGroundAt(x, z);
    view.canPlace = (k, p, r) => validatePlacement(ph, k, p, r, view.self.pos);
    const bot = new Bot(0, 'medium', mulberry32(9));
    const placed: PieceState[] = [];
    for (let i = 0; i < 25 * TICK_HZ && placed.length < 3; i++) step(view, bot.think(view), placed, (p) => ph.addPiece(p));
    expect(placed.length).toBe(3);
    expect(isSealed(b, placed)).toBe(true);
  });
});

describe('Bot navigation', () => {
  const safe = (view: BotView, inp: PlayerInput) => {
    const m = worldMove(inp);
    const l = Math.hypot(m.x, m.z);
    if (l < 1e-6) return true;
    const p = add(view.self.pos, scale(v3(m.x / l, 0, m.z / l), 0.8));
    return view.groundAt(p.x, p.z) !== null;
  };

  test('never walks toward open water when not bridging (enemy visible across the gap)', () => {
    const self = newPlayer(0, 'bot', true, 0, onIsland(0, 20, 0));
    self.inv.cash = 0;
    self.inv.weapons.pistol = { mag: 12, spare: 36 };
    self.equipped = 'pistol';
    const enemy = newPlayer(1, 'foe', false, 1, onIsland(1, 20, 0));
    const view = makeView(self, { enemies: [enemy] });
    const bot = new Bot(0, 'hard', mulberry32(6));
    for (let i = 0; i < 8 * TICK_HZ; i++) {
      const inp = bot.think(view);
      expect(safe(view, inp), `tick ${i} at ${JSON.stringify(self.pos)}`).toBe(true);
      step(view, inp, []);
    }
  });

  test('walks around a hole on the way to its generator', () => {
    const gen = map[0].generator;
    const self = newPlayer(0, 'bot', true, 0, add(gen, v3(8, 0, 0)));
    self.inv.cash = 0;
    const view = makeView(self, { generators: [200, 0] });
    const hole = add(gen, v3(4, 0, 0));
    view.groundAt = (x, z) => (Math.abs(x - hole.x) < 1 && Math.abs(z - hole.z) < 2 ? null : groundAt(view.pieces, x, z));
    const bot = new Bot(0, 'easy', mulberry32(7));
    for (let i = 0; i < 8 * TICK_HZ; i++) {
      const inp = bot.think(view);
      expect(safe(view, inp), `tick ${i}`).toBe(true);
      step(view, inp, []);
    }
    expect(dist2D(self.pos, gen)).toBeLessThan(2.5);
  });
});

describe('goal choice', () => {
  test('an enemy seen across the water does not stop the bot from bridging', () => {
    const l = lane(map, 0, 1);
    const start = laneAt(l, 19.5);
    const self = newPlayer(0, 'bot', true, 0, v3(start.x, map[0].groundY, start.z));
    self.inv.cash = 0;
    self.inv.weapons.pistol = { mag: 12, spare: 36 };
    self.equipped = 'pistol';
    self.inv.pieces.scaffold = 10;
    self.inv.pieces.metal = 3;
    const enemyAt = laneAt(l, l.length - 19.5);
    const enemy = newPlayer(1, 'rival', false, 1, v3(enemyAt.x, map[1].groundY, enemyAt.z));
    const view = makeView(self, { enemies: [enemy] });
    const bot = new Bot(0, 'hard', mulberry32(3));
    const goals = new Set<string>();
    for (let i = 0; i < 3 * TICK_HZ; i++) { bot.think(view); view.now += 1 / TICK_HZ; goals.add(bot.currentGoal); }
    expect(goals.has('fight')).toBe(false);
  });
});
