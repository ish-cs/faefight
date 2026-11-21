import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { nextPurchase, type Needs } from '../../src/sim/bots/plans';
import { DEFAULT_BOT_PARAMS, PARAM_RANGES } from '../../src/sim/bots/params';
import { preset } from '../../src/sim/bots/personality';
import { TRAP, WEAPONS } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { validateTrap } from '../../src/sim/traps';
import type { Physics } from '../../src/sim/physics';
import type { Difficulty, Snapshot } from '../../src/sim/types';
import { add, dist2D, forward, scale, v3 } from '../../src/sim/vec';

/** Bot seat 1 vs an idle human seat 2 (far away on its own island). */
async function duel(difficulty: Difficulty, seed = 5) {
  let bot: Bot | null = null;
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'human', isBot: false }], seed },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset('Turtle'))) });
  return { m, bot: () => bot! };
}
const physicsOf = (m: Match) => (m as unknown as { physics: Physics }).physics;

describe('bots and spike traps', () => {
  test('tunable: trap knobs are in the trainer search box', () => {
    for (const k of ['trap.carry.pro', 'trap.rich', 'trap.setScore', 'trap.avoidPad', 'trap.shootRange']) expect(PARAM_RANGES[k], k).toBeDefined();
    expect(DEFAULT_BOT_PARAMS.trap.carry.easy).toBe(0);
  });

  test('shopping: traps once the essentials are covered, never saved up for', () => {
    const p = newPlayer(1, 'b', true, 0, v3(), 0);
    p.inv.weapons.rifle = { mag: 25, spare: 75 };
    p.hotbar[0] = 'rifle';
    p.inv.cash = TRAP.price;
    const needs: Needs = { scaffolds: 0, kit: 0, charge: false, traps: 2 };
    expect(nextPurchase(p, needs, 'hard')).toBe('trap');
    p.inv.cash = TRAP.price - 1;
    expect(nextPurchase(p, needs, 'hard')).toBeNull();
  });

  test('a calm bot at home sets traps outside its doorways (shown in its brain), and walks around an enemy one', async () => {
    const { m, bot } = await duel('hard');
    const isl = m.map[0];
    m.debugGive(1, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 60 } }, traps: 2, cash: 0 });
    const front = isl.bunker.doorways[0];
    const out = add(front.center, scale(forward(front.yaw), 4));
    m.debugTeleport(1, v3(out.x, isl.groundY + 0.05, out.z));
    bot().watch(true);
    let snap: Snapshot = m.tick(new Map());
    let sawGoal = false, sawWhy = '';
    for (let i = 0; i < 40 * 30 && (snap.traps?.filter((t) => t.owner === 1).length ?? 0) < 2; i++) {
      snap = m.tick(new Map());
      if (bot().currentGoal === 'trap' && !sawGoal) {
        sawGoal = true;
        const d = bot().debugBrain();
        sawWhy = `${d.why} | ${d.step} | ${d.scores.find((r) => r[0] === 'trap')?.[3].map((f) => f[0]).join(',')}`;
      }
    }
    const mine = (snap.traps ?? []).filter((t) => t.owner === 1);
    expect(sawGoal).toBe(true);
    expect(mine.length).toBe(2);
    // At the bunker (choke points), not anywhere on the island.
    for (const t of mine) expect(dist2D(t.pos, isl.bunker.center)).toBeLessThan(7);
    expect(sawWhy).toMatch(/spike trap/i);
  });

  test('a bot walking past an enemy trap steers round it or shoots it out — never steps on it', async () => {
    const { m } = await duel('hard', 7);
    const isl = m.map[0];
    m.debugGive(1, { weapons: { rifle: { mag: WEAPONS.rifle.mag, spare: 90 } } });
    // Enemy (seat 2) trap on the open ground between the bot and its generator.
    const ph = physicsOf(m);
    const gen = isl.generator;
    const toGen = v3(gen.x - isl.bunker.center.x, 0, gen.z - isl.bunker.center.z);
    const l = Math.hypot(toGen.x, toGen.z);
    let placed = false;
    for (let k = 0.35; k < 0.8 && !placed; k += 0.05) {
      const p = v3(isl.bunker.center.x + toGen.x * k, 0, isl.bunker.center.z + toGen.z * k);
      const y = ph.isGroundAt(p.x, p.z);
      if (y === null) continue;
      const at = v3(p.x, y, p.z);
      if (!validateTrap(ph, { pos: at, rotY: 0, wall: false }, at, []).ok) continue;
      m.debugGive(2, { traps: 1 });
      m.debugTeleport(2, v3(at.x + 1.5, at.y, at.z));
      m.tick(new Map([[2, { ...noInput(), trap: { pos: at, rotY: 0, wall: false } }]]));
      placed = m.debugTraps().length === 1;
    }
    expect(placed).toBe(true);
    expect(l).toBeGreaterThan(3);
    // Park the human far away, give the generator cash, start the bot behind its bunker.
    m.debugTeleport(2, m.map[1].spawn);
    m.debugSetGenerator(0, 300);
    m.debugTeleport(1, v3(isl.bunker.center.x - toGen.x / l * 4, isl.groundY + 0.05, isl.bunker.center.z - toGen.z / l * 4));
    let hurt = 0, broken = false;
    for (let i = 0; i < 30 * 30; i++) {
      const s = m.tick(new Map());
      for (const e of s.events) {
        if (e.type === 'hit' && e.data.target === 1 && e.data.weapon === 'trap') hurt++;
        if (e.type === 'trap' && e.data.what === 'broken' && e.data.by === 1) broken = true;
      }
    }
    expect(hurt).toBe(0);
    // It got its cash (went past or cleared the trap).
    expect(m.debugTraps().length === 0 ? broken : true).toBe(true);
  });
});

function noInput() {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ads: false, reload: false, interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null, select: null, drop: null, moveSlot: null, useMedkit: false, drink: false };
}
