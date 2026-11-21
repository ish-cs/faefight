import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { AIM, Aim } from '../../src/sim/bots/aim';
import { Bot } from '../../src/sim/bots/bot';
import { BRAIN_KEYS, BRAIN_SPEC, HAND_BRAIN, HAND_PARAMS, PARAM_KEYS, PARAM_RANGES, decode, encode, withTraits } from '../../src/sim/bots/params';
import { fits, junkSlot, nextPurchase, plugSpot, shoppingPlan } from '../../src/sim/bots/plans';
import { PRESETS } from '../../src/sim/bots/personality';
import { Brain, fightOdds, type BrainInput } from '../../src/sim/bots/brain';
import type { BotView, OtherStatus } from '../../src/sim/bots/view';
import { aimDir } from '../../src/sim/combat';
import { TICK_HZ, WEAPONS } from '../../src/sim/constants';
import { buildMap } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import type { PlayerInput, PlayerState, Vec3 } from '../../src/sim/types';
import { NO_INPUT } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

const DT = 1 / TICK_HZ;
const map = buildMap(4);

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

const status = (id: number, island: number): OtherStatus => ({ id, island, alive: true, eliminated: false, respawnAt: null, kills: 0 });

function view(self: PlayerState, over: Partial<BotView> = {}): BotView {
  const v: BotView = {
    now: 100, self, enemies: [], others: [status(1, 1), status(2, 2), status(3, 3)], map, pieces: [],
    generators: [0, 0, 0, 0], sealed: [false, false, false, false], hurt: [], shots: [], feed: [], loot: [],
    waterY: 0, suddenDeath: false,
    groundAt: (x, z) => (map.some((i) => Math.hypot(x - i.center.x, z - i.center.z) <= i.radius) ? map[0].groundY : null),
    canPlace: () => ({ ok: false, reason: 'test' }),
    ...over,
  };
  return v;
}

const worldMove = (inp: PlayerInput): Vec3 => add(scale(right(inp.yaw), inp.moveX), scale(forward(inp.yaw), inp.moveZ));

describe('dodging', () => {
  /** Mean |sideways| movement relative to a shooter on island 1, and direction changes, over 3 s. */
  function run(underFire: boolean) {
    const me = newPlayer(0, 'me', true, 0, v3(map[0].center.x, map[0].groundY, map[0].center.z));
    me.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: 36 };
    me.equipped = 'pistol';
    const bot = new Bot(0, 'pro', mulberry32(3));
    const shooter = v3(map[1].center.x, map[1].groundY + 1.6, map[1].center.z);
    const v = view(me, { generators: [300, 0, 0, 0] });
    let lateral = 0, n = 0, flips = 0, lastSide = 0;
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      if (underFire) v.shots = [{ t: v.now, by: 1, from: shooter, to: add(me.pos, v3(0.5, 1.2, 0)) }];
      const inp = bot.think(v);
      const m = worldMove(inp);
      const l = Math.hypot(m.x, m.z);
      const to = v3(shooter.x - me.pos.x, 0, shooter.z - me.pos.z);
      const tl = Math.hypot(to.x, to.z);
      if (l > 1e-6) {
        const side = (m.x * -to.z + m.z * to.x) / (l * tl);
        lateral += Math.abs(side); n++;
        const s = Math.sign(Math.round(side * 3));
        if (s !== 0 && lastSide !== 0 && s !== lastSide) flips++;
        if (s !== 0) lastSide = s;
        me.pos = v3(me.pos.x + (m.x / l) * 5 * DT, me.pos.y, me.pos.z + (m.z / l) * 5 * DT);
      }
      me.yaw = inp.yaw; me.pitch = inp.pitch;
      v.now += DT;
    }
    return { lateral: n ? lateral / n : 0, flips, moving: n };
  }

  test('under fire, a bot strafes across the shooter line and changes direction (jukes)', () => {
    const calm = run(false), fire = run(true);
    console.log(`lateral calm ${calm.lateral.toFixed(2)} (${calm.flips} flips), under fire ${fire.lateral.toFixed(2)} (${fire.flips} flips)`);
    expect(fire.moving).toBeGreaterThan(60);
    expect(fire.lateral).toBeGreaterThan(calm.lateral + 0.2);
    expect(fire.flips).toBeGreaterThanOrEqual(3);
  });
});

describe('brain: goals for a reason, steps, re-planning', () => {
  const rival = (id: number, over: Partial<BrainInput['rivals'][number]> = {}): BrainInput['rivals'][number] => ({
    id, reach: true, scaffolds: 0, dist: 60, respawning: false, sinceDeath: Infinity, sealed: false, seenHp: null,
    grudge: 0, busy: false, kills: 0, leaderKills: 0, onMyIsland: false, away: false,
    island: id, name: `P${id}`, openDoors: 3, generator: 0, guarded: true, protectedNow: false, ...over,
  });
  const input = (now: number, rivals: BrainInput['rivals'], over: Partial<BrainInput> = {}): BrainInput => ({
    now, suddenDeath: false, hp: 1, shield: 0, home: 0, on: 0, rivals, gun: true, upgraded: true, myWeapon: 'rifle',
    kit: 3, scaffolds: 0, bridgeNeed: 0, medkits: 0, carried: 0, banked: 100, insuranceDue: 0, bankable: 0, focus: null, nearVault: false, canClearHome: true, intruder: false, homeSealed: false,
    homePlugged: false, incomingBridge: false, killedBy: null, seller: false, wantShields: false, endgame: false,
    enemy: null, armedNear: 0, underFire: false, ...over,
  });
  const P = { ...HAND_BRAIN, turtleUntil: 60 };
  const stepLabel = (b: Brain) => b.goal!.steps[b.goal!.step]?.label ?? 'done';

  test('commits to a goal (hysteresis) despite noisy, near-equal options', () => {
    const b = new Brain(mulberry32(1));
    const kinds = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const g = b.update(input(300 + i * 0.3, [rival(1), rival(2, { dist: 61 }), rival(3, { dist: 62 })]), P, 0.1);
      kinds.add(`${g.kind}:${g.target}`);
    }
    expect(kinds.size).toBe(1);
  });

  test('box in a player: a missing precondition leads to the step that fixes it', () => {
    const at = (over: Partial<BrainInput>, r: Partial<BrainInput['rivals'][number]> = {}) => {
      const b = new Brain(mulberry32(2));
      b.update(input(300, [rival(1, { respawning: true, ...r })], over), P, 0);
      expect(b.goal!.kind).toBe('seal');
      return b;
    };
    const noKit = at({ kit: 0 });
    expect(noKit.stepAct).toBe('shop');
    expect(stepLabel(noKit)).toMatch(/seal kit/);
    expect(stepLabel(at({ kit: 3 }, { reach: false, scaffolds: 8 }))).toMatch(/scaffolds/);
    const bridge = at({ kit: 3, scaffolds: 8 }, { reach: false, scaffolds: 8 });
    expect(bridge.stepAct).toBe('bridge');
    expect(at({ kit: 3 }).stepAct).toBe('attack');
    const plug = at({ kit: 3, on: 1 });
    expect(plug.stepAct).toBe('seal');
    expect(plug.thought).toMatch(/^Goal: seal \(P1 is respawning, I have 3 plugs\) — step \d\/\d plug P1's doors$/);
  });

  test('a sealing opportunity makes it box the player in', () => {
    const b = new Brain(mulberry32(3));
    b.update(input(300, [rival(1, { dist: 40 }), rival(2, { dist: 90 })], { carried: 0 }), P, 0);
    // P2 goes down (respawn window) and I have a kit: box P2 in.
    b.notify('targetBusy', 301);
    const g = b.update(input(302, [rival(1, { dist: 40 }), rival(2, { dist: 90, respawning: true })], { endgame: true }), P, 0);
    expect(g.kind).toBe('seal');
    expect(g.target).toBe(2);
  });

  test('low HP in a losing fight: it flees (break sight → home → heal), not fights', () => {
    const b = new Brain(mulberry32(4));
    const g = b.update(input(300, [rival(1)], {
      hp: 0.3, on: 1, myWeapon: 'pistol', upgraded: false, enemy: { id: 1, dist: 15, hp: 100, weapon: 'rifle' }, underFire: true,
    }), P, 0);
    expect(g.kind).toBe('retreat');
    expect(b.stepAct).toBe('disengage');
    expect(g.reason).toMatch(/HP|lose/);
    // Out of sight, away from home: fall back home.
    const g2 = b.update(input(301, [rival(1)], { hp: 0.3, on: 1, upgraded: false, myWeapon: 'pistol' }), P, 0);
    expect(['retreat', 'heal']).toContain(g2.kind);
    expect(b.stepAct).toBe('heal');
  });

  test('a fight it can win is not fled; outnumbered changes its mind', () => {
    const fight = { id: 1, dist: 15, hp: 40, weapon: 'pistol' as const };
    const even = input(300, [rival(1)], { enemy: fight, armedNear: 1 });
    expect(fightOdds(even)).toBeGreaterThan(0.6);
    const b = new Brain(mulberry32(5));
    expect(b.update(even, P, 0).kind).not.toBe('retreat');
    const swarmed = input(301, [rival(1)], { hp: 0.5, enemy: { ...fight, hp: 100, weapon: 'smg' }, armedNear: 3, myWeapon: 'pistol' });
    expect(fightOdds(swarmed)).toBeLessThan(P.fleeOdds);
    expect(b.update(swarmed, P, 0).kind).toBe('retreat');
  });

  test('no gun → upgrade (collect then buy); hurt and alone → heal; carrying a lot → bank', () => {
    const b = new Brain(mulberry32(6));
    b.update(input(300, [], { gun: false, upgraded: false, carried: 10, banked: 0 }), P, 0);
    expect(b.goal!.kind).toBe('upgrade');
    expect(b.stepAct).toBe('collect');
    const h = new Brain(mulberry32(6));
    h.update(input(300, [], { hp: 0.2, medkits: 0, carried: 200 }), P, 0);
    expect(h.goal!.kind).toBe('heal');
    const k = new Brain(mulberry32(6));
    k.update(input(300, [rival(1, { reach: false, scaffolds: 20, dist: 200 })], { carried: 900, bankable: 800 }), P, 0);
    expect(k.goal!.kind).toBe('bank');
    expect(k.stepAct).toBe('bank');
  });

  test('re-plans on events: target sealed → finish; target gone; died → hunt the killer; bridge cut → back to bridging', () => {
    const b = new Brain(mulberry32(3));
    const g0 = b.update(input(300, [rival(1, { dist: 40 }), rival(2, { dist: 90 })]), P, 0);
    expect(g0.kind).toBe('seal');
    expect(g0.target).toBe(1);
    const g1 = b.update(input(301, [rival(1, { dist: 40, sealed: true, openDoors: 0 }), rival(2, { dist: 90 })]), P, 0);
    expect(b.history.map((h) => h.event)).toContain('targetSealed');
    expect(g1.kind).toBe('finish');
    const g2 = b.update(input(302, [rival(2, { dist: 90 })]), P, 0);
    expect(b.history.map((h) => h.event)).toContain('targetGone');
    expect(g2.target).toBe(2);
    b.notify('died', 303);
    const g3 = b.update(input(306, [rival(2, { dist: 90 }), rival(3, { dist: 70, grudge: 60 })], { killedBy: { id: 3, ago: 3 } }), { ...P, planRevenge: 2 }, 0);
    expect(g3.kind).toBe('hunt');
    expect(g3.target).toBe(3);
    const c = new Brain(mulberry32(4));
    c.update(input(300, [rival(1)]), P, 0);
    expect(c.stepAct).toBe('attack');
    c.update(input(301, [rival(1, { reach: false, scaffolds: 6 })], { scaffolds: 6 }), P, 0);
    expect(c.history.map((h) => h.event)).toContain('bridgeCut');
    expect(c.stepAct).toBe('bridge');
  });

  test('a live bot exposes goal, reason and step for the debug overlay', async () => {
    const bots: Bot[] = [];
    const m = await Match.create({ players: Array.from({ length: 4 }, () => ({ name: '', isBot: true, difficulty: 'pro' as const })), seed: 5 },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.push(b); return b; } });
    for (let i = 0; i < 30 * 30; i++) m.tick(new Map());
    for (const b of bots) {
      expect(b.debug.goal).not.toBeNull();
      expect(b.debug.reason).not.toBe('');
      expect(b.debug.thought).toMatch(/^Goal: \w+ \(.+\) — (step \d+\/\d+ .+|done)$/);
    }
  }, 60_000);
});

describe('params', () => {
  test('ranges are sane, hand defaults inside them, encode/decode round-trips', () => {
    for (const k of BRAIN_KEYS) {
      const [lo, hi, def] = BRAIN_SPEC[k];
      expect(lo).toBeLessThan(hi);
      expect(def).toBeGreaterThanOrEqual(lo);
      expect(def).toBeLessThanOrEqual(hi);
      expect(PARAM_RANGES[`brain.${k}`]).toEqual([lo, hi]);
    }
    // The trainer searches brain weights and the drive/build params together.
    expect(PARAM_KEYS.some((k) => k.startsWith('drive.'))).toBe(true);
    expect(PARAM_KEYS.some((k) => k.startsWith('buildTuning.'))).toBe(true);
    const back = decode(encode(HAND_PARAMS));
    for (const k of PARAM_KEYS) expect(back[k]).toBeCloseTo(HAND_PARAMS[k], 9);
  });

  test('personalities are offsets on the params (a Rusher is more aggressive than a Turtle)', () => {
    const rusher = withTraits(HAND_BRAIN, PRESETS.Rusher), turtle = withTraits(HAND_BRAIN, PRESETS.Turtle);
    expect(rusher.biasAttack).toBeGreaterThan(turtle.biasAttack);
    expect(turtle.planTurtle).toBeGreaterThan(rusher.planTurtle);
    expect(turtle.lowHp).toBeGreaterThan(rusher.lowHp);
  });
});

describe('no cheating: bots only see BotView', () => {
  test('bot modules import nothing that holds match state', () => {
    const dir = path.resolve(__dirname, '../../src/sim/bots');
    const allowed = new Set(['../constants', '../combat', '../map', '../types', '../vec', '../economy', '../hotbar', '../potions', '../building', '../seal', '../fire']);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) {
        const spec = m[1];
        if (spec.startsWith('./')) continue;
        expect(allowed.has(spec), `${f} imports ${spec}`).toBe(true);
      }
      // combat is only used for pure geometry (eye position, aim direction), never to act on the world.
      const combat = src.match(/import \{([^}]*)\} from '\.\.\/combat'/);
      if (combat) for (const name of combat[1].split(',').map((x) => x.trim()).filter(Boolean)) expect(['eyePos', 'aimDir']).toContain(name);
      // fire: only the pure helpers (is a piece flammable, steer around visible fire zones), never the burn step.
      const fire = src.match(/import \{([^}]*)\} from '\.\.\/fire'/);
      if (fire) for (const name of fire[1].split(',').map((x) => x.trim()).filter(Boolean)) expect(['isFlammable', 'steerFromFire']).toContain(name);
    }
  });

  test('a bot reads only BotView fields, and only enemies it can see', async () => {
    // Exactly the fields declared on BotView (view.ts), so new public fields are allowed and anything else is not.
    const viewSrc = fs.readFileSync(path.resolve(__dirname, '../../src/sim/bots/view.ts'), 'utf8');
    const block = viewSrc.slice(viewSrc.indexOf('export type BotView = {'), viewSrc.indexOf('\n};', viewSrc.indexOf('export type BotView = {')));
    const keys = new Set([...block.matchAll(/^ {2}([a-zA-Z]+)\??[:(]/gm)].map((m) => m[1]));
    expect(keys.has('enemies') && keys.has('self')).toBe(true);
    const touched = new Set<string>();
    const m = await Match.create({ players: Array.from({ length: 4 }, () => ({ name: '', isBot: true, difficulty: 'pro' as const })), seed: 9 }, {
      makeBot: (id, d, rng) => {
        const b = new Bot(id, d, rng);
        return {
          think: (v: BotView) => b.think(new Proxy(v, {
            get(t, k, r) {
              if (typeof k === 'string') { touched.add(k); if (!keys.has(k)) throw new Error(`bot read view.${k}, which is not in BotView`); }
              return Reflect.get(t, k, r);
            },
          })),
        };
      },
    });
    for (let i = 0; i < 30 * 60; i++) m.tick(new Map());
    expect(touched.has('enemies')).toBe(true);
  }, 120_000);
});

describe('human aim (perception, all skills)', () => {
  /** Share of ticks the crosshair is within a body (0.4 m) of the target's chest. */
  function hitRate(diff: 'pro' | 'hard', range: number, strafe: boolean): number {
    const aim = new Aim(AIM[diff], mulberry32(11));
    const eye = v3(0, 1.6, 0);
    let cur = { yaw: 0, pitch: 0 };
    let hits = 0, n = 0, side = 1, flipAt = 0, x = 0;
    for (let i = 0; i < 6 * TICK_HZ; i++) {
      const now = i * DT;
      if (strafe && now >= flipAt) { side = -side; flipAt = now + 0.3 + ((i * 7919) % 5) * 0.06; }
      if (strafe) x += side * 5 * DT;
      const target = v3(x, 1.2, -range);
      const r = aim.track(now, DT, eye, target, 1, cur);
      cur = r;
      if (now < 1) continue;
      const d = aimDir(r.yaw, r.pitch);
      const to = v3(target.x - eye.x, target.y - eye.y, target.z - eye.z);
      const along = to.x * d.x + to.y * d.y + to.z * d.z;
      const miss = Math.hypot(to.x - d.x * along, to.y - d.y * along, to.z - d.z * along);
      n++;
      if (miss < 0.4) hits++;
    }
    return hits / n;
  }

  for (const diff of ['pro', 'hard'] as const) {
    test(`${diff}: a strafing target at 40 m is hit much less often than a still one at 15 m`, () => {
      const still = hitRate(diff, 15, false), far = hitRate(diff, 40, true);
      console.log(`${diff}: still 15 m ${(100 * still).toFixed(0)}% · strafing 40 m ${(100 * far).toFixed(0)}%`);
      expect(still).toBeGreaterThan(0.8);
      expect(far).toBeLessThan(still - 0.25);
    });
  }
  test('PRO is still the better shot', () => {
    expect(hitRate('pro', 40, true)).toBeGreaterThan(hitRate('hard', 40, true));
  });
});

describe('full hotbar', () => {
  function packed() {
    const p = newPlayer(0, 'me', true, 0, v3(map[0].shop.x, map[0].groundY, map[0].shop.z));
    p.inv.cash = 2000;
    p.inv.weapons = { pistol: { mag: 12, spare: 36 }, smg: { mag: 30, spare: 90 }, rifle: { mag: 25, spare: 75 } };
    p.inv.pieces = { wood: 3, metal: 2, steel: 1, ramp: 1 };
    p.inv.potions = { shieldSmall: 1, speedPotion: 1 };
    p.hotbar = ['pistol', 'smg', 'rifle', 'wood', 'metal', 'steel', 'ramp', 'shieldSmall', 'speedPotion'];
    p.equipped = 'rifle';
    return p;
  }

  test('optional stock (medkits, grenades) is not chosen when there is no room, and planning never loops on a failing buy', () => {
    const p = packed();
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    try {
      const needs = { scaffolds: 0, kit: 0, charge: false, grenades: 2, medkits: 2 };
      expect(nextPurchase(p, needs, 'pro')).not.toBe('medkit');
      expect(nextPurchase(p, needs, 'pro')).not.toBe('grenade');
      shoppingPlan(p, { ...needs, charge: true, scaffolds: 6 }, 'pro');
    } finally { console.warn = warn; }
    expect(warned).toBe(0);
  });

  test('an essential buy with a full hotbar drops junk first (a pistol once a better gun is owned)', () => {
    const p = packed();
    expect(fits(p, 'charge')).toBe(false);
    expect(p.hotbar[junkSlot(p, 'charge')]).toBe('pistol');
    const bot = new Bot(0, 'pro', mulberry32(9));
    const v = view(p, { pieces: [], sealed: [false, false, false, false] });
    // A steel plug in my own doorway: only a charge clears it.
    const door = map[0].bunker.doorways[0];
    v.pieces = [{ id: 900, kind: 'steel', owner: 1, pos: plugSpot(door, 'steel', 0), rotY: door.yaw, hp: 3000 }];
    let dropped: string | null = null;
    for (let i = 0; i < 4 * TICK_HZ && !dropped; i++) {
      const inp = bot.think(v);
      if (inp.select !== null && inp.select !== undefined) p.selected = inp.select;
      if (inp.drop) dropped = p.hotbar[p.selected];
      v.now += DT;
    }
    expect(dropped).toBe('pistol');
  });
});

describe('no hiding at home', () => {
  test('a PRO bot spends under 25% of a 5-minute 1v1 within 8 m of its own bunker without a reason to', async () => {
    for (const seed of [1, 2]) {
      const bots = new Map<number, Bot>();
      const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'pro' }, { name: '', isBot: true, difficulty: 'pro' }], seed },
        { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
      let snap = m.tick(new Map());
      const alive = new Map<number, number>(), near = new Map<number, number>(), acts = new Map<string, number>();
      for (let i = 0; i < 5 * 60 * TICK_HZ && snap.winner === null; i++) {
        snap = m.tick(new Map());
        for (const p of snap.players) {
          if (!p.alive) continue;
          alive.set(p.id, (alive.get(p.id) ?? 0) + 1);
          const b = m.map[p.island].bunker.center;
          const d = bots.get(p.id)!.debug;
          // A reason to be there: defending home, breaking out, or getting out of my own bunker.
          const reason = p.breakoutUntil !== null || d.action === 'defend' || d.goal === 'defend' || snap.sealed[p.island];
          if (!reason && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) < 8) { near.set(p.id, (near.get(p.id) ?? 0) + 1); acts.set(`${d.action}/${d.goal}`, (acts.get(`${d.action}/${d.goal}`) ?? 0) + 1); }
        }
      }
      for (const [id, n] of alive) {
        const share = (near.get(id) ?? 0) / n;
        console.log(`seed ${seed} #${id}: ${(100 * share).toFixed(0)}% of the time near own bunker`, JSON.stringify([...acts].sort((x, y) => y[1] - x[1]).slice(0, 5)));
        expect(share).toBeLessThan(0.25);
      }
    }
  }, 300_000);
});

describe('seal first', () => {
  test('a PRO bot eliminates a passive opponent in a 1v1 via a seal within ~5 minutes', async () => {
    for (const seed of [1, 2, 3]) {
      const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'pro' }, { name: 'Me', isBot: false }], seed });
      let snap = m.tick(new Map());
      let sealedAt: number | null = null;
      for (let i = 0; i < 5 * 60 * TICK_HZ && snap.winner === null; i++) {
        snap = m.tick(new Map([[2, { ...NO_INPUT }]]));
        for (const e of snap.events) if (e.type === 'sealed' && e.data.by === 1 && sealedAt === null) sealedAt = e.t;
      }
      console.log(`seed ${seed}: sealed at ${sealedAt?.toFixed(0)} s, winner ${snap.winner} at ${(snap.time / 60).toFixed(1)} min`);
      expect(sealedAt).not.toBeNull();
      expect(snap.winner).toBe(1);
    }
  }, 300_000);
});
