import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { BUILD_SKILL, shields } from '../../src/sim/bots/build';
import { lookAt } from '../../src/sim/bots/aim';
import { preset, type Archetype } from '../../src/sim/bots/personality';
import { eyePos } from '../../src/sim/combat';
import { DT, PIECES, WEAPONS } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { NO_INPUT } from '../../src/sim/types';
import type { Difficulty, Inventory, PieceState, PlayerInput, Snapshot } from '../../src/sim/types';
import { add, right, scale, v3 } from '../../src/sim/vec';

/**
 * Combat building: material by situation, reinforcing a cracked wall, ramps for high ground chained forward,
 * healing behind cover, human-rate caps by skill. Bot seat 1 vs a scripted human seat 2.
 */
type Placed = { t: number; piece: PieceState };

async function setup(difficulty: Difficulty, opts: { island?: number; gap?: number; give: Partial<Inventory>; archetype?: Archetype; seed?: number; shield?: number }) {
  let bot: Bot | null = null;
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'human', isBot: false }], seed: opts.seed ?? 5 },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset(opts.archetype ?? 'Turtle'))) });
  const isl = m.map[opts.island ?? 0];
  const lat = right(isl.bunker.facingYaw);
  const half = (opts.gap ?? 16) / 2;
  const botAt = add(isl.center, scale(lat, -half)), humanAt = add(isl.center, scale(lat, half));
  m.debugTeleport(1, v3(botAt.x, isl.groundY + 0.05, botAt.z));
  m.debugTeleport(2, v3(humanAt.x, isl.groundY + 0.05, humanAt.z));
  m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 60 } }, ...opts.give });
  m.debugGive(2, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 200 } } });
  if (opts.shield) m.debugSetShield(1, opts.shield);
  bot!.debugBrain(); // spectate from the start (the probe records why each piece went down)
  const placed: Placed[] = [];
  let snap: Snapshot = m.tick(new Map());
  /** Human aims at the bot's chest and fires on the ticks `fire(i)` says; collects the bot's pieces. */
  const run = (ticks: number, fire: (i: number) => boolean, each?: (s: Snapshot, i: number) => void) => {
    for (let i = 0; i < ticks; i++) {
      const h = snap.players[1], b = snap.players[0];
      const aim = lookAt(eyePos(h), add(b.pos, v3(0, 1.2, 0)));
      const input: PlayerInput = { ...NO_INPUT, yaw: aim.yaw, pitch: aim.pitch, fire: fire(i), select: h.hotbar.indexOf('pistol'), reload: i % 90 === 89 };
      snap = m.tick(new Map([[2, input]]));
      for (const e of snap.events) if (e.type === 'placed' && e.data.by === 1) placed.push({ t: e.t, piece: snap.pieces.find((p) => p.id === e.data.piece)! });
      each?.(snap, i);
    }
    return snap;
  };
  return { m, bot: () => bot!, placed, run, snap: () => snap };
}

const WALLS = new Set(['wood', 'metal', 'steel', 'sandbags']);

describe('combat building: material by situation', () => {
  test('pro away from home throws the fast, cheap wall (wood) though it carries metal; at home the strongest (metal)', async () => {
    const away = await setup('pro', { island: 1, give: { pieces: { wood: 3, metal: 3 } } });
    const whys: string[] = [];
    away.run(4 * 30, (i) => i === 3 || i === 27, () => { const w = away.bot().debugBrain().build?.why; if (w && !whys.includes(w)) whys.push(w); });
    const a = away.placed.find((p) => WALLS.has(p.piece.kind));
    expect(a, 'away: a wall went up').toBeDefined();
    expect(a!.piece.kind).toBe('wood');
    expect(whys.some((w) => /^cover: wood .*fast/.test(w)), whys.join(' / ')).toBe(true);

    const home = await setup('pro', { island: 0, give: { pieces: { wood: 3, metal: 3 } } });
    home.run(4 * 30, (i) => i === 3 || i === 27);
    const h = home.placed.find((p) => WALLS.has(p.piece.kind));
    expect(h, 'home: a wall went up').toBeDefined();
    expect(h!.piece.kind).toBe('metal');
  }, 60_000);
});

describe('combat building: reinforcing and healing behind cover', () => {
  test('pro: its cover wall cracks under fire → a fresh metal wall beside it, then it hides behind that one', async () => {
    // At home (no rival doors to plug on this island to pull it away), metal walls carried.
    const r = await setup('pro', { island: 0, give: { pieces: { wood: 2, metal: 4 } } });
    // Shot at until the first wall is up (a shot a second keeps it in its cover episode).
    for (let k = 0; k < 90 && !r.placed.length; k++) r.run(1, (i) => k % 30 === 3 + i);
    const first = r.placed.find((p) => WALLS.has(p.piece.kind));
    expect(first, 'first cover wall').toBeDefined();
    // Crack it (as if it took a burst).
    (r.m as unknown as { s: { pieces: Map<number, PieceState> } }).s.pieces.get(first!.piece.id)!.hp = PIECES[first!.piece.kind].hp * 0.3;
    let hiddenBehindNew = 0;
    r.run(4 * 30, (i) => i % 30 === 3, (s) => {
      const fresh = s.pieces.find((p) => p.owner === 1 && p.id !== first!.piece.id && WALLS.has(p.kind));
      if (fresh && shields(fresh, eyePos(s.players[1]), add(s.players[0].pos, v3(0, 1.2, 0)))) hiddenBehindNew++;
    });
    const second = r.placed.find((p) => p.piece.id !== first!.piece.id && WALLS.has(p.piece.kind));
    expect(second, 'a reinforcement wall').toBeDefined();
    expect(second!.piece.kind).toBe('metal');
    expect(hiddenBehindNew).toBeGreaterThan(10);
    // Human hand speed: never two combat pieces closer than pieceSec.
    for (let i = 1; i < r.placed.length; i++) expect(r.placed[i].t - r.placed[i - 1].t).toBeGreaterThanOrEqual(BUILD_SKILL.pro.pieceSec - DT - 1e-9);
  }, 60_000);

  test('hurt pro behind its wall uses a medkit with the shooter still in sight', async () => {
    const r = await setup('pro', { island: 1, give: { pieces: { wood: 6 }, medkits: 1 } });
    r.run(3 * 30, (i) => i === 3 || i === 27);
    expect(r.placed.some((p) => WALLS.has(p.piece.kind)), 'cover went up').toBe(true);
    r.m.debugSetHp(1, 40);
    let healing = false;
    r.run(5 * 30, () => false, (s) => { if (s.players[0].healAt !== null) healing = true; });
    expect(healing).toBe(true);
  }, 60_000);
});

describe('combat building: ramps', () => {
  test('pro in a level mid-range fight throws a ramp toward the shooter and chains a second one forward and up', async () => {
    // Only ramps to build with (no walls): this is the high-ground play, not cover.
    const r = await setup('pro', { island: 1, gap: 22, give: { pieces: { ramp: 3 } }, seed: 7, shield: 100 });
    const whys: string[] = [];
    r.run(8 * 30, (i) => i % 60 === 3, () => { const w = r.bot().debugBrain().build?.why; if (w && !whys.includes(w)) whys.push(w); });
    const ramps = r.placed.filter((p) => p.piece.kind === 'ramp');
    expect(whys.some((w) => /ramp: chained/.test(w)), whys.join(' / ')).toBe(true);
    console.log(`ramps: ${ramps.map((p) => `${p.t.toFixed(1)}s y=${p.piece.pos.y.toFixed(2)}`).join(', ')}`);
    expect(ramps.length).toBeGreaterThanOrEqual(2);
    expect(ramps[1].piece.pos.y).toBeGreaterThan(ramps[0].piece.pos.y + 1);

  }, 60_000);

  test('easy never builds ramps in a fight', async () => {
    const r = await setup('easy', { island: 1, gap: 22, give: { pieces: { ramp: 3 } }, seed: 7, shield: 100 });
    r.run(8 * 30, (i) => i % 60 === 3);
    expect(r.placed.filter((p) => p.piece.kind === 'ramp')).toHaveLength(0);
  }, 60_000);
});

describe('combat building: skill scaling', () => {
  test('better players build faster (human caps), ramp, chain and reinforce more; easy rarely covers', () => {
    const order: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
    for (let i = 1; i < order.length; i++) {
      const a = BUILD_SKILL[order[i - 1]], b = BUILD_SKILL[order[i]];
      expect(b.pieceSec).toBeLessThan(a.pieceSec);
      expect(b.ramp).toBeGreaterThanOrEqual(a.ramp);
      expect(b.rampChain).toBeGreaterThanOrEqual(a.rampChain);
      expect(b.reinforce).toBeGreaterThanOrEqual(a.reinforce);
    }
    // No superhuman hands: even PRO needs ≥ 0.25 s per combat piece (≤ 4 a second).
    expect(BUILD_SKILL.pro.pieceSec).toBeGreaterThanOrEqual(0.25);
    expect(BUILD_SKILL.easy.ramp).toBe(0);
    expect(BUILD_SKILL.easy.coverChance).toBeLessThanOrEqual(0.15);
  });
});
