import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { lane, laneAt } from '../../src/sim/bots/nav';
import { ARCHETYPES, preset, rollPersonality, type Archetype } from '../../src/sim/bots/personality';
import type { BotView, OtherStatus } from '../../src/sim/bots/view';
import { PIECES, TICK_HZ, WEAPONS } from '../../src/sim/constants';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PieceState, PlayerInput, PlayerState, Vec3 } from '../../src/sim/types';
import { add, dist2D, forward, right, rotateY, scale, v3, yawOf } from '../../src/sim/vec';

const map = buildMap(4);
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

/** A finished scaffold bridge laid along the lane from island a to b (built by `owner`). */
function bridge(a: number, b: number, owner: number): PieceState[] {
  const l = lane(map, a, b);
  const out: PieceState[] = [];
  for (let s = 18; s < l.length - 16; s += 3.8) {
    const p = laneAt(l, s);
    out.push({ id: 500 + a * 100 + b * 10 + out.length, kind: 'scaffold', owner, pos: v3(p.x, map[a].groundY - PIECES.scaffold.h, p.z), rotY: yawOf(l.dir), hp: 200 });
  }
  return out;
}

const status = (id: number, island: number, over: Partial<OtherStatus> = {}): OtherStatus =>
  ({ id, island, alive: true, eliminated: false, respawnAt: null, kills: 0, ...over });

function makeView(self: PlayerState, over: Partial<BotView> = {}): BotView {
  const view: BotView = {
    now: 100, self, enemies: [], others: [status(1, 1), status(2, 2), status(3, 3)], map, pieces: [],
    generators: [0, 0, 0, 0], sealed: [false, false, false, false], hurt: [], shots: [], feed: [], loot: [],
    waterY: 0, suddenDeath: false,
    groundAt: (x, z) => groundAt(view.pieces, x, z),
    canPlace: (_k, p) => (view.groundAt(p.x, p.z) === null ? { ok: false, reason: 'water' } : { ok: true, pos: p }),
    ...over,
  };
  return view;
}

function onIsland(i: number, fwd: number, side = 0): Vec3 {
  const isl = map[i];
  const p = add(add(isl.center, scale(forward(isl.bunker.facingYaw), fwd)), scale(right(isl.bunker.facingYaw), side));
  return v3(p.x, isl.groundY, p.z);
}

function armed(id: number, island: number, pos: Vec3): PlayerState {
  const p = newPlayer(id, `p${id}`, true, island, pos);
  p.inv.cash = 0;
  p.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: 36 };
  p.equipped = 'pistol';
  return p;
}

const worldMove = (inp: PlayerInput): Vec3 => add(scale(right(inp.yaw), inp.moveX), scale(forward(inp.yaw), inp.moveZ));

function step(view: BotView, inp: PlayerInput) {
  const me = view.self;
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

describe('personality', () => {
  test('random but seeded: same seed same personality, different bots differ', () => {
    expect(rollPersonality(mulberry32(42))).toEqual(rollPersonality(mulberry32(42)));
    const rng = mulberry32(7);
    const bots = Array.from({ length: 8 }, (_, i) => new Bot(i, 'medium', rng));
    const kinds = new Set(bots.map((b) => b.personality.archetype));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
    const sig = (b: Bot) => JSON.stringify(b.personality.traits);
    expect(new Set(bots.map(sig)).size).toBe(8);
    for (const b of bots) for (const v of Object.values(b.personality.traits)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    // Over many rolls every archetype shows up.
    const all = new Set(Array.from({ length: 200 }, (_, i) => rollPersonality(mulberry32(i)).archetype));
    expect([...all].sort()).toEqual([...ARCHETYPES].sort());
  });
});

describe('target choice (FFA)', () => {
  test('a Vulture goes after the rival who is respawning over a closer healthy one', () => {
    const self = armed(0, 0, onIsland(0, 0));
    const pieces = [...bridge(0, 1, 0), ...bridge(0, 2, 0)];
    const healthy = makeView(self, { pieces, others: [status(1, 1), status(2, 2), status(3, 3, { eliminated: true })] });
    const a = new Bot(0, 'hard', mulberry32(1), preset('Vulture'));
    a.think(healthy);
    expect(a.currentTarget).toBe(1); // nobody down: the nearer reachable rival

    const down = makeView(self, { pieces, others: [status(1, 1), status(2, 2, { alive: false, respawnAt: 102 }), status(3, 3, { eliminated: true })] });
    const b = new Bot(0, 'hard', mulberry32(1), preset('Vulture'));
    b.think(down);
    expect(dist2D(map[2].center, self.pos)).toBeGreaterThan(dist2D(map[1].center, self.pos));
    expect(b.currentTarget).toBe(2);
  });

  test('a bot just shot by X goes after X, even over the kill leader', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const self = armed(0, 0, onIsland(0, 0));
      const view = makeView(self, {
        others: [status(1, 1, { kills: 2 }), status(2, 2, { eliminated: true }), status(3, 3)],
        hurt: [{ t: 99.6, by: 3, amount: 20 }, { t: 99.8, by: 3, amount: 20 }],
      });
      const bot = new Bot(0, 'medium', mulberry32(seed), preset('Rusher'));
      bot.think(view);
      expect(bot.currentTarget, `seed ${seed}`).toBe(3);
    }
  });

  test('the target sticks instead of flip-flopping on noise', () => {
    const self = armed(0, 0, onIsland(0, 0));
    const view = makeView(self, { others: [status(1, 1), status(2, 2, { eliminated: true }), status(3, 3)] });
    const bot = new Bot(0, 'easy', mulberry32(9), preset('Turtle'));
    const seen = new Set<number | null>();
    for (let i = 0; i < 30 * TICK_HZ; i++) { bot.think(view); view.now += DT; seen.add(bot.currentTarget); }
    expect(seen.size).toBe(1);
  });
});

describe('human tactics', () => {
  test('carrying lots of cash with an enemy around: banks it in the vault first', () => {
    for (const archetype of ARCHETYPES as readonly Archetype[]) {
      const isl = map[0];
      const self = armed(0, 0, add(isl.vault, v3(3, 0, 2)));
      self.inv.cash = 400;
      self.inv.weapons.smg = { mag: 30, spare: 90 };
      self.inv.weapons.rifle = { mag: 25, spare: 75 };
      self.inv.weapons.shotgun = { mag: 6, spare: 18 };
      self.inv.pieces = { scaffold: 30, steel: 3, wood: 2 };
      self.equipped = 'rifle';
      const enemy = armed(3, 3, onIsland(0, 18, -10));
      const view = makeView(self, { enemies: [enemy], others: [status(1, 1), status(2, 2), status(3, 3)] });
      const bot = new Bot(0, 'medium', mulberry32(3), preset(archetype));
      let deposited = 0;
      const goals: string[] = [];
      for (let i = 0; i < 4 * TICK_HZ && !deposited; i++) {
        const inp = bot.think(view);
        goals.push(bot.currentGoal);
        if (inp.vault?.deposit?.cash) {
          expect(dist2D(self.pos, isl.vault)).toBeLessThanOrEqual(2.5);
          deposited = inp.vault.deposit.cash;
        }
        step(view, inp);
      }
      if (!deposited) console.log(archetype, [...new Set(goals)]);
      expect(deposited, archetype).toBeGreaterThanOrEqual(200);
    }
  });

  test('a low-HP bot disengages from a shooter; at full HP it fights', () => {
    const run = (hp: number) => {
      const self = armed(0, 0, onIsland(0, 0));
      self.hp = hp;
      const enemy = armed(3, 3, onIsland(0, 10, 0));
      enemy.inv.weapons.smg = { mag: 30, spare: 90 };
      enemy.equipped = 'smg';
      const view = makeView(self, { enemies: [enemy], hurt: [{ t: 99.9, by: 3, amount: 12 }] });
      const bot = new Bot(0, 'hard', mulberry32(5), preset('Sniper'));
      const d0 = dist2D(self.pos, enemy.pos);
      const goals = new Set<string>();
      for (let i = 0; i < 2 * TICK_HZ; i++) { step(view, bot.think(view)); goals.add(bot.currentGoal); }
      return { gained: dist2D(self.pos, enemy.pos) - d0, goals };
    };
    const low = run(20);
    expect(low.goals.has('disengage')).toBe(true);
    expect(low.gained).toBeGreaterThan(4);
    const full = run(100);
    expect(full.goals.has('disengage')).toBe(false);
    expect(full.goals.has('fight')).toBe(true);
  });

  test('a shop purchase that keeps failing is given up for a while instead of spammed', () => {
    const self = armed(0, 0, add(map[0].shop, v3(1, 0, 0)));
    self.inv.weapons = {};
    self.equipped = 'fists';
    self.inv.cash = 60;
    const view = makeView(self);
    const bot = new Bot(0, 'hard', mulberry32(2), preset('Rusher'));
    let tries = 0;
    for (let i = 0; i < 15 * TICK_HZ; i++) { if (bot.think(view).shop) tries++; view.now += DT; } // the buy never lands
    expect(tries).toBeGreaterThanOrEqual(1);
    expect(tries).toBeLessThanOrEqual(2);
  });
});
