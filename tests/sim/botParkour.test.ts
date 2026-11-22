import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { islandAt } from '../../src/sim/bots/nav';
import { jumpReach, makeable, climbTakeoff, JUMP_APEX } from '../../src/sim/bots/parkour';
import { withParams } from '../../src/sim/bots/params';
import { preset, type Archetype } from '../../src/sim/bots/personality';
import { PIECES, PLAYER, WEAPONS } from '../../src/sim/constants';
import { overDock } from '../../src/sim/docks';
import { Match } from '../../src/sim/match';
import type { Difficulty, MatchEvent, PlayerInput, Snapshot, Vec3 } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

async function duel(difficulty: Difficulty, archetype: Archetype, seed: number, over: Record<string, number> = {}) {
  let bot: Bot | null = null;
  const P = withParams(over);
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'human', isBot: false }], seed },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset(archetype), P)) });
  return { m, bot: () => bot! };
}
function place(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = (m as unknown as { s: { players: Map<number, { invulnUntil: number; spawnProtected?: boolean }> } }).s.players.get(id)!;
  p.invulnUntil = 0;
  p.spawnProtected = false;
}
const tick = (m: Match) => m.tick(new Map<number, PlayerInput>());
const waterDeaths = (ev: MatchEvent[], id: number) => ev.filter((e) => e.type === 'kill' && e.data.victim === id && e.data.inWater).length;

describe('jump physics the bots plan with', () => {
  test('matches the movement model (measured in the sim: sprint jump ~7.3 m, walking ~4.8 m, ~1.1 m up)', () => {
    expect(jumpReach(PLAYER.sprint, 0)).toBeGreaterThan(6.8);
    expect(jumpReach(PLAYER.sprint, 0)).toBeLessThan(7.4);
    expect(jumpReach(PLAYER.walk, 0)).toBeGreaterThan(4.5);
    expect(jumpReach(PLAYER.walk, 0)).toBeLessThan(4.9);
    expect(JUMP_APEX).toBeCloseTo(1.08, 1);
    expect(jumpReach(PLAYER.walk, 1.2)).toBe(0);
    // PRO's widest gap with its slop is makeable sprinting, not walking; nothing superhuman (6 m) at all.
    expect(makeable(4.2, 0, 0.08, PLAYER.sprint, 1.2)).toBe(true);
    expect(makeable(4.2, 0, 0.08, PLAYER.walk, 1.2)).toBe(false);
    expect(makeable(6, 0, 0, PLAYER.sprint, 1.2)).toBe(false);
    expect(climbTakeoff(1.0, PLAYER.walk)).not.toBeNull();
    expect(climbTakeoff(1.5, PLAYER.walk)).toBeNull();
  });
});

describe('bots move like players: parkour', () => {
  /** Island 0's pier with section `row` blown out; the bot heads out over it toward the next island. */
  async function pierGap(difficulty: Difficulty, rows: number[], over: Record<string, number> = {}, seed = 9) {
    const { m, bot } = await duel(difficulty, 'Turtle', seed, over);
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { scaffold: 14, wood: 5 } });
    const holes = rows.map((r) => m.def.docks!.find((d) => d.island === 0 && d.row === r)!);
    for (const h of holes) m.debugExplode('charge', v3(h.center.x, h.center.y - 1, h.center.z));
    let snap: Snapshot = tick(m);
    const events: MatchEvent[] = [];
    let crossed = false, patched = false;
    for (let i = 0; i < 150 * 30 && !crossed; i++) {
      snap = tick(m);
      events.push(...snap.events);
      patched ||= snap.pieces.some((p) => p.owner === 1 && p.kind === 'scaffold' && holes.some((h) => overDock(h, p.pos, PIECES.scaffold.d / 2 - 0.5)));
      const me = snap.players[0].pos;
      crossed = islandAt(m.map, me) === 1 || Math.hypot(me.x, me.z) < 12;
    }
    const st = bot().parkourStats;
    if (env.PARKOUR_DEBUG) console.log(difficulty, rows, JSON.stringify(st), { crossed, patched, t: snap.time });
    return { crossed, patched, st, drowned: waterDeaths(events, 1), m, bot: bot() };
  }

  test('gap jump: PRO jumps a blown-out pier section instead of decking over it, and crosses', async () => {
    const r = await pierGap('pro', [1]);
    expect(r.crossed).toBe(true);
    expect(r.st.jumps).toBeGreaterThan(0);
    expect(r.st.decksSaved).toBeGreaterThan(0);
    expect(r.patched).toBe(false);
    expect(r.st.fails).toBe(0);
    expect(r.drowned).toBe(0);
  }, 150_000);

  test('a gap wider than its skill allows: medium decks over two missing sections (4 m) instead', async () => {
    const r = await pierGap('medium', [1, 2], { 'parkour.medium.use': 1 });
    expect(r.crossed).toBe(true);
    expect(r.patched).toBe(true);
    expect(r.st.fails).toBe(0);
    expect(r.drowned).toBe(0);
  }, 150_000);

  test('jumping off (gapMax 0): the old behaviour, decks over the gap', async () => {
    const r = await pierGap('hard', [1], { 'parkour.hard.gapMax': 0 });
    expect(r.crossed).toBe(true);
    expect(r.patched).toBe(true);
    expect(r.st.jumps).toBe(0);
  }, 150_000);

  test('the brain inspector says it is jumping', async () => {
    const { m, bot } = await duel('pro', 'Turtle', 9);
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { scaffold: 14 } });
    const h = m.def.docks!.find((d) => d.island === 0 && d.row === 1)!;
    m.debugExplode('charge', v3(h.center.x, h.center.y - 1, h.center.z));
    bot().watch(true);
    let move = '';
    for (let i = 0; i < 120 * 30 && !/Jump/.test(move); i++) { tick(m); move = bot().debugBrain().move ?? ''; }
    expect(move).toMatch(/Jump/);
  }, 150_000);

  test('climb: in a fight on its island, PRO hops up onto sandbags for high ground', async () => {
    const { m, bot } = await duel('pro', 'Rusher', 4);
    const home = m.map[0];
    const fwd = forward(home.bunker.facingYaw), side = right(home.bunker.facingYaw);
    const me = add(home.center, add(scale(fwd, 8), scale(side, 6)));
    place(m, 1, v3(me.x, home.groundY + 0.05, me.z));
    place(m, 2, (() => { const p = add(home.center, add(scale(fwd, 8), scale(side, -10))); return v3(p.x, home.groundY + 0.05, p.z); })());
    const bags = add(me, scale(side, -2.5));
    m.debugPlacePiece('sandbags', v3(bags.x, home.groundY, bags.z), home.bunker.facingYaw);
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 60 } } });
    m.debugSetHp(2, 100);
    let high = false;
    for (let i = 0; i < 25 * 30 && !high; i++) {
      const s = tick(m);
      m.debugSetHp(2, 100); m.debugSetHp(1, 100);
      // Up on the bags (not mid-hop): standing still at their height.
      high = bot().parkourStats.climbs > 0 && s.players[0].pos.y > home.groundY + 0.8 && Math.abs(s.players[0].vel.y) < 0.05;
    }
    if (env.PARKOUR_DEBUG) console.log('climb', JSON.stringify(bot().parkourStats));
    expect(high).toBe(true);
    expect(bot().parkourStats.fails).toBe(0);
  }, 120_000);

  test('ramp-rush: PRO on the enemy pier, enemy on their island ahead, lays ramps forward and up', async () => {
    const { m, bot } = await duel('pro', 'Rusher', 6);
    const rival = m.map[1];
    const pier = m.def.docks!.filter((d) => d.island === 1).sort((a, b) => b.row - a.row)[0];
    place(m, 1, v3(pier.center.x, pier.center.y + pier.half.y + 0.05, pier.center.z));
    const tgt = add(rival.center, add(scale(forward(rival.bunker.facingYaw), rival.radius - 5), scale(right(rival.bunker.facingYaw), 3)));
    place(m, 2, v3(tgt.x, rival.groundY + 0.05, tgt.z));
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 60 } }, pieces: { ramp: 3, scaffold: 2 } });
    let ramps = 0;
    for (let i = 0; i < 20 * 30 && ramps < 2; i++) {
      const s = tick(m);
      m.debugSetHp(2, 100); m.debugSetHp(1, 100);
      ramps = s.pieces.filter((p) => p.owner === 1 && p.kind === 'ramp').length;
    }
    const st = bot().parkourStats;
    if (env.PARKOUR_DEBUG) console.log('rush', JSON.stringify(st));
    expect(st.rushes).toBeGreaterThan(0);
    expect(ramps).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
