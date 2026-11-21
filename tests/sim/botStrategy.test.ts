import { describe, expect, test } from 'vitest';
import { Bot, throwAngles } from '../../src/sim/bots/bot';
import { angleBetween, lookAt } from '../../src/sim/bots/aim';
import { insideBunker, lane, laneAt } from '../../src/sim/bots/nav';
import { plugSpot } from '../../src/sim/bots/plans';
import { aimDir, eyePos } from '../../src/sim/combat';
import { buy, vaultTransfer } from '../../src/sim/economy';
import { syncFromInventory } from '../../src/sim/hotbar';
import { ARCHETYPES, preset, rollPersonality, type Archetype } from '../../src/sim/bots/personality';
import type { BotView, OtherStatus } from '../../src/sim/bots/view';
import { ECONOMY, GRENADE, LIFECYCLE, PIECES, SEAL, TICK_HZ, WEAPONS } from '../../src/sim/constants';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PieceKind, PieceState, PlayerInput, PlayerState, Vec3 } from '../../src/sim/types';
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

  test('respawn window: a rival dies near me → I push their bunker before they are back (seal with a kit), not right after my own respawn', () => {
    // Standing on rival 1's island (bridged), 20 m from their bunker, a full metal kit in hand; another rival is the current target.
    const pieces = [...bridge(0, 1, 0)];
    const near = add(map[1].bunker.center, scale(forward(map[1].bunker.facingYaw), 20));
    const kit = () => { const p = armed(0, 0, v3(near.x, map[1].groundY, near.z)); p.inv.pieces.metal = 3; syncFromInventory(p.hotbar, p.inv); return p; };
    const alive = (now: number) => makeView(kit(), { now, pieces, others: [status(1, 1), status(2, 2), status(3, 3, { eliminated: true })] });
    const died = (now: number, self = kit()) => makeView(self, {
      now, pieces, others: [status(1, 1, { alive: false, respawnAt: now + LIFECYCLE.respawnSec }), status(2, 2), status(3, 3, { eliminated: true })],
      feed: [{ t: now - 0.1, killer: 0, victim: 1 }],
    });
    const bot = new Bot(0, 'pro', mulberry32(4), preset('Rusher'));
    bot.think(alive(100));
    const v = died(100.2);
    bot.think(v);
    expect(bot.respawnWindow?.id).toBe(1);
    expect(bot.respawnWindow!.left).toBeGreaterThan(LIFECYCLE.respawnSec - 0.5);
    expect(bot.currentTarget).toBe(1);
    const goals = new Set<string>();
    for (let i = 0; i < TICK_HZ; i++) { v.now += DT; bot.think(v); goals.add(bot.currentGoal); }
    expect(goals.has('seal')).toBe(true);
    expect(bot.debugBrain().window?.[0]).toBe(1);

    // Same kill, but I only just respawned myself (deaths ticked up a moment ago): no push yet.
    const fresh = new Bot(0, 'pro', mulberry32(4), preset('Rusher'));
    const me = kit(); me.deaths = 1;
    fresh.think(makeView(me, { now: 100, pieces, others: [status(1, 1), status(2, 2), status(3, 3, { eliminated: true })] }));
    fresh.think(died(100.2, me));
    expect(fresh.respawnWindow).toBeNull();

    // Too far to make it before they're back: no window.
    const far = new Bot(0, 'pro', mulberry32(4), preset('Rusher'));
    const home = armed(0, 0, onIsland(0, 0)); home.inv.pieces.metal = 3; syncFromInventory(home.hotbar, home.inv);
    far.think(makeView(home, { now: 100, pieces, others: [status(1, 1), status(2, 2), status(3, 3, { eliminated: true })] }));
    far.think(died(100.2, home));
    expect(dist2D(home.pos, map[1].bunker.center) / 7.5).toBeGreaterThan(LIFECYCLE.respawnSec + 2);
    expect(far.respawnWindow).toBeNull();
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

/** step() plus what a Match would do with shop, vault, charge and grenade inputs. */
function richStep(view: BotView, inp: PlayerInput, log: { charges: Vec3[]; nades: PlayerInput[] }) {
  const me = view.self;
  const isl = map[me.island];
  const near = (p: Vec3) => dist2D(me.pos, p) <= ECONOMY.interactRadius;
  if (me.busyUntil <= view.now) {
    if (inp.vault && near(isl.vault) && vaultTransfer(me, inp.vault).ok) me.busyUntil = view.now + ECONOMY.vaultSec;
    if (inp.shop && near(isl.shop)) buy(me, inp.shop);
    if (inp.placeCharge && me.inv.charges > 0) { me.inv.charges--; log.charges.push({ ...me.pos }); }
    if (inp.throwGrenade && me.inv.grenades > 0) { me.inv.grenades--; log.nades.push(inp); }
  }
  step(view, inp);
}

/** Pieces plugging doorways of island i's bunker (all of them unless `only` is given). */
function plugs(i: number, kind: PieceKind, only?: number): PieceState[] {
  return map[i].bunker.doorways.filter((_, k) => only === undefined || k === only)
    .map((d, k) => ({ id: 900 + i * 10 + k, kind, owner: 3, pos: plugSpot(d, kind, 0), rotY: d.yaw, hp: PIECES[kind].hp }));
}

describe('game sense', () => {
  test('own bunker steel-sealed while out, cash banked: withdraws, buys a charge and blasts a plug from outside', () => {
    const self = armed(0, 0, add(map[0].shop, v3(2, 0, 0)));
    self.vault.cash = 600;
    const pieces = plugs(0, 'steel');
    const view = makeView(self, { pieces, sealed: [true, false, false, false] });
    const bot = new Bot(0, 'hard', mulberry32(4), preset('Turtle'));
    const log = { charges: [] as Vec3[], nades: [] as PlayerInput[] };
    let bought = false;
    for (let i = 0; i < 40 * TICK_HZ && !log.charges.length; i++) {
      const inp = bot.think(view);
      if (inp.shop?.buy === 'charge') bought = true;
      richStep(view, inp, log);
    }
    expect(bought).toBe(true);
    expect(log.charges.length).toBe(1);
    const at = log.charges[0];
    // Right in front of a steel plug, from outside the bunker.
    expect(Math.min(...pieces.map((p) => dist2D(p.pos, at)))).toBeLessThan(2.2);
    expect(insideBunker(map[0].bunker, at)).toBe(false);
  });

  test('one of my doorways gets plugged: clears it before heading out to bridge', () => {
    const self = armed(0, 0, onIsland(0, 0));
    self.inv.pieces = { scaffold: 12, wood: 3 };
    const plug = plugs(0, 'wood', 1);
    const view = makeView(self, { pieces: plug });
    const bot = new Bot(0, 'hard', mulberry32(6), preset('Rusher'));
    const center = v3(plug[0].pos.x, plug[0].pos.y + 1, plug[0].pos.z);
    let firedAtPlug = false;
    const goals = new Set<string>();
    for (let i = 0; i < 8 * TICK_HZ && !firedAtPlug; i++) {
      const inp = bot.think(view);
      goals.add(bot.currentGoal);
      if (inp.fire && angleBetween(inp, lookAt(eyePos(self), center)) < 0.08) firedAtPlug = true;
      step(view, inp);
    }
    expect(goals.has('bridge')).toBe(false);
    expect(firedAtPlug).toBe(true);
  });

  test('a plug in my doorway still gets shot with an enemy in sight far across the water', () => {
    // Bots used to swing their gun onto the far enemy (and hold fire past its damage floor) for minutes.
    const self = armed(0, 0, onIsland(0, 0));
    self.inv.pieces = { scaffold: 12, wood: 3 };
    const plug = plugs(0, 'wood', 1);
    const far = armed(2, 2, onIsland(2, 0));
    expect(dist2D(far.pos, self.pos)).toBeGreaterThan(30);
    const view = makeView(self, { pieces: plug, enemies: [far] });
    const bot = new Bot(0, 'hard', mulberry32(6), preset('Turtle'));
    const center = v3(plug[0].pos.x, plug[0].pos.y + 1, plug[0].pos.z);
    let firedAtPlug = false;
    for (let i = 0; i < 10 * TICK_HZ && !firedAtPlug; i++) {
      const inp = bot.think(view);
      if (inp.fire && angleBetween(inp, lookAt(eyePos(self), center)) < 0.08) firedAtPlug = true;
      step(view, inp);
    }
    expect(firedAtPlug).toBe(true);
  });

  test('does not idle inside its own bunker: with nothing to do there, walks out', () => {
    for (const difficulty of ['medium', 'hard', 'pro'] as const) {
      const self = armed(0, 0, v3(map[0].bunker.center.x, map[0].groundY, map[0].bunker.center.z));
      const view = makeView(self);
      const bot = new Bot(0, difficulty, mulberry32(8), preset('Turtle'));
      for (let i = 0; i < 4 * TICK_HZ; i++) step(view, bot.think(view));
      expect(dist2D(self.pos, map[0].bunker.center), difficulty).toBeGreaterThan(SEAL.exitRadius);
    }
  });

  test('escape countdown running inside my bunker with one doorway open: gets out in time', () => {
    const self = armed(0, 0, v3(map[0].bunker.center.x, map[0].groundY, map[0].bunker.center.z));
    self.breakoutUntil = 110;
    const view = makeView(self, { pieces: [...plugs(0, 'steel', 0), ...plugs(0, 'metal', 1)], sealed: [true, false, false, false] });
    const bot = new Bot(0, 'hard', mulberry32(9));
    let t = 0;
    for (; t < 10 * TICK_HZ && dist2D(self.pos, map[0].bunker.center) <= SEAL.exitRadius; t++) step(view, bot.think(view));
    expect(t / TICK_HZ).toBeLessThan(5);
  });

  test('a rival who ducks behind cover gets a grenade thrown after them', () => {
    const self = armed(0, 0, onIsland(0, 0));
    self.inv.grenades = 2;
    const enemy = armed(3, 3, onIsland(0, 12, 3));
    const wall: PieceState = { id: 77, kind: 'wood', owner: 3, pos: onIsland(0, 10.5, 2.6), rotY: yawOf(v3(enemy.pos.x - self.pos.x, 0, enemy.pos.z - self.pos.z)), hp: 250 };
    const view = makeView(self, { enemies: [enemy], pieces: [wall] });
    const bot = new Bot(0, 'pro', mulberry32(10));
    const log = { charges: [] as Vec3[], nades: [] as PlayerInput[] };
    richStep(view, bot.think(view), log);
    view.enemies = []; // behind the wall now
    for (let i = 0; i < 2 * TICK_HZ && !log.nades.length; i++) richStep(view, bot.think(view), log);
    expect(log.nades.length).toBe(1);
    const toEnemy = lookAt(eyePos(self), enemy.pos);
    expect(Math.abs(Math.atan2(Math.sin(log.nades[0].yaw - toEnemy.yaw), Math.cos(log.nades[0].yaw - toEnemy.yaw)))).toBeLessThan(0.15);
    const a = throwAngles(eyePos(self), enemy.pos, false)!;
    expect(Math.abs(log.nades[0].pitch - a.pitch)).toBeLessThan(0.1);
  });

  test('throwAngles lands the grenade where it was aimed (same physics as the sim)', () => {
    const eye = v3(0, 3.6, 0);
    for (const [to, low] of [[v3(0, 2.3, -12), false], [v3(8, 2.3, 0), true], [v3(-15, 2.3, 10), false]] as [Vec3, boolean][]) {
      const a = throwAngles(eye, to, low)!;
      expect(a).not.toBeNull();
      const dir = aimDir(a.yaw, a.pitch);
      let pos = eye, vel = add(scale(dir, GRENADE.throwSpeed), v3(0, 3, 0));
      while (pos.y > to.y) { vel = v3(vel.x, vel.y - 9.81 * DT, vel.z); pos = add(pos, scale(vel, DT)); }
      expect(dist2D(pos, to)).toBeLessThan(1.2);
    }
  });

  test('hurt with a medkit on the hotbar and nobody in sight: uses it', () => {
    const self = armed(0, 0, onIsland(0, 0));
    self.hp = 40;
    self.inv.medkits = 1;
    syncFromInventory(self.hotbar, self.inv);
    const view = makeView(self);
    const bot = new Bot(0, 'pro', mulberry32(11));
    let used: PlayerInput | null = null;
    for (let i = 0; i < TICK_HZ && !used; i++) { const inp = bot.think(view); if (inp.useMedkit) used = inp; step(view, inp); }
    expect(used).not.toBeNull();
    expect(self.hotbar[used!.select!]).toBe('medkit');
  });
});
