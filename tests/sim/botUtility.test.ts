import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { nextPurchase, type Needs } from '../../src/sim/bots/plans';
import { DEFAULT_BOT_PARAMS, PARAM_RANGES } from '../../src/sim/bots/params';
import { preset } from '../../src/sim/bots/personality';
import { planUtility, utilAngles, type UtilSituation } from '../../src/sim/bots/utilityPlan';
import { FLASH, PLAYER, SMOKE, WEAPONS } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import type { Physics } from '../../src/sim/physics';
import { NO_INPUT, type Difficulty, type MatchEvent, type PlayerState, type Snapshot, type Vec3 } from '../../src/sim/types';
import { v3, yawOf } from '../../src/sim/vec';
import type { BotView } from '../../src/sim/bots/view';

const physicsOf = (m: Match) => (m as unknown as { physics: Physics }).physics;
const playerOf = (m: Match, id: number) => (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(id)!;

/** Bot seat 1 vs an idle human seat 2. */
async function duel(difficulty: Difficulty, seed = 5) {
  let bot: Bot | null = null;
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'human', isBot: false }], seed },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset('Rusher'))) });
  return { m, bot: () => bot! };
}
/** Two open floor spots `gap` m apart on island `i` with a clear eye line between. */
function openPair(m: Match, gap: number, i = 0): [Vec3, Vec3] {
  const isl = m.def.islands[i];
  const ph = physicsOf(m);
  for (let r = 2; r < isl.radius - 2; r += 0.5) for (let a = 0; a < 6.28; a += 0.2) {
    const x = isl.center.x + Math.cos(a) * r, z = isl.center.z + Math.sin(a) * r;
    const y = ph.isGroundAt(x, z), y2 = ph.isGroundAt(x + gap, z);
    if (y === null || y2 === null || Math.abs(y - y2) > 0.05) continue;
    if (ph.raycastStatic(v3(x, y + PLAYER.eyeHeight, z), v3(1, 0, 0), gap, true)) continue;
    return [v3(x, y, z), v3(x + gap, y2, z)];
  }
  throw new Error('no open pair');
}
function stand(m: Match, id: number, pos: Vec3, faceTo: Vec3) {
  m.debugTeleport(id, pos);
  const p = playerOf(m, id);
  p.invulnUntil = 0;
  p.spawnProtected = false;
  p.yaw = yawOf({ x: faceTo.x - pos.x, z: faceTo.z - pos.z });
}
const thrown = (evs: MatchEvent[], type: 'smoke' | 'flash', by: number) => evs.filter((e) => e.type === type && e.data.by === by);

describe('bots: smoke grenades and flashbangs', () => {
  test('tunable: utility knobs are in the trainer search box', () => {
    for (const k of ['util.carrySmoke.pro', 'util.carryFlash.hard', 'util.buyAt.medium', 'util.smokeRetreat.pro', 'util.smokeCross.hard',
      'util.flashPush.pro', 'util.avoidSmoke.hard', 'util.blindBack.pro', 'util.retreatM', 'util.flashMin', 'util.flashMax', 'util.gapSec'])
      expect(PARAM_RANGES[k], k).toBeDefined();
    expect(DEFAULT_BOT_PARAMS.util.carryFlash.easy).toBe(0);
  });

  test('shopping: smoke, then flash, once the essentials are covered (never saved up for)', () => {
    const p = newPlayer(1, 'b', true, 0, v3(), 0);
    p.inv.weapons.rifle = { mag: 25, spare: 75 };
    p.hotbar[0] = 'rifle';
    p.inv.cash = SMOKE.price;
    const needs: Needs = { scaffolds: 0, kit: 0, charge: false, smokes: 1, flashes: 1 };
    expect(nextPurchase(p, needs, 'hard')).toBe('smoke');
    p.inv.smokes = 1;
    p.inv.cash = FLASH.price;
    expect(nextPurchase(p, needs, 'hard')).toBe('flash');
    p.inv.cash = FLASH.price - 1;
    expect(nextPurchase(p, needs, 'hard')).toBeNull();
  });

  test('plan: smoke a retreat between me and them; flash a rival who just ducked out; never while blinded', () => {
    const me = newPlayer(1, 'b', true, 0, v3(0, 0, 0), 0);
    me.inv.smokes = 1; me.inv.flashes = 1;
    const foe = newPlayer(2, 'e', false, 1, v3(10, 0, 0), 0);
    const view = { now: 100, self: me, enemies: [foe], map: [], others: [] } as unknown as BotView;
    const base: UtilSituation = {
      view, me, difficulty: 'pro', P: DEFAULT_BOT_PARAMS.util, goal: 'disengage', enemy: foe, enemyDist: 10,
      target: { id: 2, pos: foe.pos, t: 100 }, rivalBunker: null, retreating: true, lastAt: -Infinity, lastHurtAt: 99.5,
    };
    const r = planUtility(base)!;
    expect(r.kind).toBe('smoke');
    expect(r.at.x).toBeGreaterThan(0); // toward them
    expect(r.at.x).toBeLessThan(10);
    me.inv.smokes = 0;
    const f = planUtility({ ...base, P: { ...base.P, flashPush: { ...base.P.flashPush, pro: 1 } }, goal: 'fight', retreating: false, enemy: null, target: { id: 2, pos: foe.pos, t: 99 } })!;
    expect(f.kind).toBe('flash');
    expect(f.at).toEqual(foe.pos);
    me.inv.smokes = 1;
    expect(planUtility({ ...base, view: { ...view, blind: true } })).toBeNull();
    expect(planUtility({ ...base, lastAt: 99 })).toBeNull(); // gap between throws
    expect(utilAngles(v3(0, 1.6, 0), v3(10, 0, 0), 'flash')).not.toBeNull();
  });

  test('a PRO bot in a fight flashes its rival before pushing (shown in its brain)', async () => {
    const { m, bot } = await duel('pro', 3);
    const [a, b] = openPair(m, 11);
    m.debugGive(1, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 90 } }, flashes: 1 });
    stand(m, 1, a, b);
    stand(m, 2, b, a);
    m.debugGive(2, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 90 } } });
    bot().watch(true);
    const evs: MatchEvent[] = [];
    let note = '';
    for (let i = 0; i < 8 * 30 && !thrown(evs, 'flash', 1).length; i++) {
      const s = m.tick(new Map());
      evs.push(...s.events);
      const u = bot().debugBrain().util;
      if (u && /flash/.test(u)) note = u;
      playerOf(m, 2).hp = 100; // keep the duel going
    }
    expect(thrown(evs, 'flash', 1).length).toBe(1);
    expect(note).toMatch(/flash/);
    // The thrower is never blinded by it.
    expect(playerOf(m, 1).blind).toBeUndefined();
  });

  test('a hurt bot backing off smokes its retreat', async () => {
    const { m, bot } = await duel('pro', 4);
    const [a, b] = openPair(m, 9);
    m.debugGive(1, { weapons: { pistol: { mag: 12, spare: 0 } }, smokes: 1, medkits: 2 });
    m.debugGive(2, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 90 } } });
    stand(m, 1, a, b);
    stand(m, 2, b, a);
    m.debugSetHp(1, 20);
    playerOf(m, 1).shield = 0;
    const evs: MatchEvent[] = [];
    const goals = new Set<string>();
    for (let i = 0; i < 8 * 30 && !thrown(evs, 'smoke', 1).length; i++) {
      // The human shoots at the bot now and then (hurts, never kills).
      const me = playerOf(m, 2), it = playerOf(m, 1);
      const yaw = yawOf({ x: it.pos.x - me.pos.x, z: it.pos.z - me.pos.z });
      const s = m.tick(new Map([[2, { ...NO_INPUT, yaw, pitch: -0.05, fire: false }]]));
      if (it.alive && it.hp < 5) it.hp = 20;
      evs.push(...s.events);
      goals.add(bot().currentGoal);
    }
    expect(thrown(evs, 'smoke', 1).length, `goals: ${[...goals].join(',')}`).toBe(1);
  });

  test('a blinded bot stops shooting and backs off or holds', async () => {
    const { m, bot } = await duel('hard', 6);
    const [a, b] = openPair(m, 10);
    m.debugGive(1, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 90 } } });
    stand(m, 1, a, b);
    stand(m, 2, b, a);
    for (let i = 0; i < 30; i++) m.tick(new Map());
    // Flash right in its face (thrown by the human).
    const me = playerOf(m, 1);
    m.debugExplode('flash', v3(me.pos.x + 2, me.pos.y + 1.4, me.pos.z), 2);
    m.tick(new Map());
    expect(playerOf(m, 1).blind!.k).toBeGreaterThan(0.5);
    const shots: MatchEvent[] = [];
    let blindSrc = false;
    for (let i = 0; i < 2 * 30; i++) {
      const s = m.tick(new Map());
      shots.push(...s.events.filter((e) => e.type === 'shot' && e.data.by === 1));
      if (bot().moveSrc === 'utility') blindSrc = true;
    }
    expect(blindSrc).toBe(true);
    expect(shots.length).toBeLessThan(3); // at most a stray round at where they were
  });
});

/** 4-bot mixed games: every bot type that carries them throws smokes and flashes in real games. */
describe('bots use smoke and flash in real games', () => {
  test('smoke in ≥ 3 of 4 games and flash in ≥ 2 of 4 (games ≤ 12 min, 4 bots)', async () => {
    let smokeGames = 0, flashGames = 0;
    const lines: string[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const m = await Match.create({ players: (['pro', 'hard', 'medium', 'pro'] as Difficulty[]).map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
      let snap: Snapshot = m.tick(new Map());
      let smokes = 0, flashes = 0;
      const why = new Set<string>();
      for (let i = 0; i < 12 * 60 * 30 && snap.winner === null; i++) {
        snap = m.tick(new Map());
        for (const e of snap.events) { if (e.type === 'smoke') smokes++; if (e.type === 'flash') flashes++; }
      }
      m.dispose();
      if (smokes) smokeGames++;
      if (flashes) flashGames++;
      lines.push(`seed ${seed} (${(snap.time / 60).toFixed(1)} min): ${smokes} smokes, ${flashes} flashes ${[...why].join('; ')}`);
    }
    console.log(lines.join('\n'));
    expect(smokeGames).toBeGreaterThanOrEqual(3);
    expect(flashGames).toBeGreaterThanOrEqual(2);
  }, 900_000);
});
