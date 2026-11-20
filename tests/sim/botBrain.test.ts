import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { AIM, Aim } from '../../src/sim/bots/aim';
import { Bot } from '../../src/sim/bots/bot';
import { HAND_PARAMS, PARAM_KEYS, PARAM_SPEC, decode, encode, withTraits } from '../../src/sim/bots/params';
import { PRESETS } from '../../src/sim/bots/personality';
import { Strategist, type PlanInput } from '../../src/sim/bots/strategy';
import type { RivalFacts } from '../../src/sim/bots/mind';
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

describe('plan layer', () => {
  const fact = (id: number, over: Partial<PlanInput['rivals'][number]> = {}): PlanInput['rivals'][number] => ({
    id, reach: true, scaffolds: 0, dist: 60, respawning: false, sinceDeath: Infinity, sealed: false, seenHp: null,
    grudge: 0, busy: false, kills: 0, leaderKills: 0, onMyIsland: false, away: false,
    island: id, openDoors: 3, generator: 0, guarded: true, ...over,
  });
  const input = (now: number, rivals: PlanInput['rivals'], over: Partial<PlanInput> = {}): PlanInput => ({
    now, suddenDeath: false, hp: 1, home: 0, on: 0, rivals, gun: true, upgraded: true, kit: 3, carried: 0, banked: 100,
    insuranceDue: 0, intruder: false, homeSealed: false, homePlugged: false, incomingBridge: false, killedBy: null,
    seller: false, wantShields: false, endgame: false, ...over,
  });
  const P = { ...HAND_PARAMS, turtleUntil: 60 };

  test('commits to a plan (hysteresis) despite noisy, near-equal options', () => {
    const s = new Strategist(mulberry32(1));
    const kinds = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const p = s.update(input(300 + i * 0.3, [fact(1), fact(2, { dist: 61 }), fact(3, { dist: 62 })]), P, 0.1);
      kinds.add(`${p.kind}:${p.target}`);
    }
    expect(kinds.size).toBe(1);
    expect(s.plan!.motive.length).toBeGreaterThan(5);
  });

  test('decomposes into steps: gear up without a kit, bridge when unreachable, act when there', () => {
    const s = new Strategist(mulberry32(2));
    expect(s.update(input(300, [fact(1, { respawning: true })], { kit: 0 }), P, 0).step).toBe('gearUp');
    const s2 = new Strategist(mulberry32(2));
    expect(s2.update(input(300, [fact(1, { reach: false, scaffolds: 8 })]), P, 0).step).toBe('bridge');
    const s3 = new Strategist(mulberry32(2));
    expect(s3.update(input(300, [fact(1)]), P, 0).step).toBe('approach');
    const s4 = new Strategist(mulberry32(2));
    expect(s4.update(input(300, [fact(1)], { on: 1 }), P, 0).step).toBe('act');
  });

  test('re-plans on events: target sealed → eliminate; target gone; died → revenge on the killer', () => {
    const s = new Strategist(mulberry32(3));
    const p0 = s.update(input(300, [fact(1, { dist: 40 }), fact(2, { dist: 90 })]), P, 0);
    expect(p0.kind).toBe('seal');
    expect(p0.target).toBe(1);
    // Target got sealed (by me or anyone): one kill eliminates them now.
    const p1 = s.update(input(301, [fact(1, { dist: 40, sealed: true, openDoors: 0 }), fact(2, { dist: 90 })]), P, 0);
    expect(s.history.map((h) => h.event)).toContain('targetSealed');
    expect(p1.kind).toBe('eliminate');
    // Target eliminated: plan moves on at once (no hysteresis).
    const p2 = s.update(input(302, [fact(2, { dist: 90 })]), P, 0);
    expect(s.history.map((h) => h.event)).toContain('targetGone');
    expect(p2.target).toBe(2);
    // I die to #3: revenge becomes an option and the death forces a re-plan.
    s.notify('died', 303);
    const p3 = s.update(input(306, [fact(2, { dist: 90 }), fact(3, { dist: 70, grudge: 60 })], { killedBy: { id: 3, ago: 3 } }), { ...P, planRevenge: 2 }, 0);
    expect(p3.kind).toBe('revenge');
    expect(p3.target).toBe(3);
  });

  test('bridge cut while approaching triggers a re-plan', () => {
    const s = new Strategist(mulberry32(4));
    s.update(input(300, [fact(1)]), P, 0);
    expect(s.plan!.step).toBe('approach');
    s.update(input(301, [fact(1, { reach: false, scaffolds: 6 })]), P, 0);
    expect(s.history.map((h) => h.event)).toContain('bridgeCut');
    expect(s.plan!.step).toBe('bridge');
  });

  test('a live bot exposes its plan for the debug overlay', async () => {
    const bots: Bot[] = [];
    const m = await Match.create({ players: Array.from({ length: 4 }, () => ({ name: '', isBot: true, difficulty: 'pro' as const })), seed: 5 },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.push(b); return b; } });
    for (let i = 0; i < 30 * 30; i++) m.tick(new Map());
    for (const b of bots) {
      expect(b.debug.plan).not.toBeNull();
      expect(b.debug.motive).not.toBe('');
      expect(['gearUp', 'bank', 'bridge', 'approach', 'act', 'retreat']).toContain(b.debug.step);
    }
  }, 60_000);
});

describe('params', () => {
  test('ranges are sane, hand defaults inside them, encode/decode round-trips', () => {
    for (const k of PARAM_KEYS) {
      const [lo, hi, def] = PARAM_SPEC[k];
      expect(lo).toBeLessThan(hi);
      expect(def).toBeGreaterThanOrEqual(lo);
      expect(def).toBeLessThanOrEqual(hi);
    }
    const back = decode(encode(HAND_PARAMS));
    for (const k of PARAM_KEYS) expect(back[k]).toBeCloseTo(HAND_PARAMS[k], 9);
  });

  test('personalities are offsets on the params (a Rusher is more aggressive than a Turtle)', () => {
    const rusher = withTraits(HAND_PARAMS, PRESETS.Rusher), turtle = withTraits(HAND_PARAMS, PRESETS.Turtle);
    expect(rusher.biasAttack).toBeGreaterThan(turtle.biasAttack);
    expect(turtle.planTurtle).toBeGreaterThan(rusher.planTurtle);
    expect(turtle.lowHp).toBeGreaterThan(rusher.lowHp);
  });
});

describe('no cheating: bots only see BotView', () => {
  test('bot modules import nothing that holds match state', () => {
    const dir = path.resolve(__dirname, '../../src/sim/bots');
    const allowed = new Set(['../constants', '../combat', '../map', '../types', '../vec', '../economy', '../hotbar', '../potions', '../building']);
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
    }
  });

  test('a bot reads only BotView fields, and only enemies it can see', async () => {
    const keys = new Set(['now', 'self', 'enemies', 'others', 'map', 'pieces', 'generators', 'genLevels', 'sealed', 'hurt', 'shots', 'feed', 'loot', 'waterY', 'suddenDeath', 'potionShops', 'groundAt', 'canPlace']);
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
