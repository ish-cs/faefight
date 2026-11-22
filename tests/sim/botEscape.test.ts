import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { plugSpot } from '../../src/sim/bots/plans';
const TRACE = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TRACE;
import { MAP, SEAL, WEAPONS } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { Difficulty, PieceKind, Snapshot } from '../../src/sim/types';
import { add, dist2D, forward, scale, v3 } from '../../src/sim/vec';

/**
 * Real physics: a bot alone in its bunker with pieces in or across the doorways (the 10 s escape countdown runs
 * whenever it's sealed in). Player 2 is an idle human far away.
 */
type Setup = (m: Match) => void;

async function escapeRun(difficulty: Difficulty, setup: Setup, seconds = 10, withCharge = false) {
  let bot: Bot | null = null;
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'idle', isBot: false }], seed: 5 },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng)) });
  const b = m.map[0].bunker;
  m.debugTeleport(1, v3(b.center.x, b.center.y + 0.05, b.center.z));
  m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, charges: withCharge ? 1 : 0 });
  setup(m);
  let snap: Snapshot = m.tick(new Map());
  let fired = 0, out = -1, trapped = false;
  for (let i = 0; i < seconds * 30 && out < 0; i++) {
    snap = m.tick(new Map());
    const p = snap.players[0];
    if (p.breakoutUntil !== null) trapped = true;
    if (TRACE && i % 10 === 0) console.log(snap.time.toFixed(2), bot!.currentGoal, p.pos.x.toFixed(2), p.pos.z.toFixed(2), 'yaw', p.yaw.toFixed(2), p.breakoutUntil, snap.pieces.map((x) => `${x.kind}${x.hp}`).join(' '));
    if (!p.alive) break;
    if (snap.events.some((e) => e.type === 'shot' && e.data.by === 1) || snap.events.some((e) => e.type === 'pieceHit' && e.data.by === 1)) fired++;
    if (dist2D(p.pos, b.center) > SEAL.exitRadius) out = snap.time;
  }
  const p = snap.players[0];
  return { out, alive: p.alive && !p.eliminated, fired, trapped, pos: p.pos };
}

const plug = (m: Match, door: number, kind: PieceKind) => {
  const d = m.map[0].bunker.doorways[door];
  m.debugPlacePiece(kind, plugSpot(d, kind, 0), d.yaw);
};

const SCENARIOS: Record<string, Setup> = {
  'one wood plug in each of the 3 doorways': (m) => { for (const d of [0, 1, 2]) plug(m, d, 'wood'); },
  'a wall inside the bunker in front of the only open doorway': (m) => {
    plug(m, 1, 'steel'); plug(m, 2, 'steel');
    const d = m.map[0].bunker.doorways[0];
    // Parallel to the front wall, 1.1 m inside it, covering the doorway: walk around either end.
    const p = add(d.center, scale(forward(d.yaw), -1.1));
    m.debugPlacePiece('wood', v3(p.x, MAP.groundY, p.z), d.yaw);
  },
  'a container across a doorway (the others plugged with wood)': (m) => {
    plug(m, 0, 'container'); plug(m, 1, 'wood'); plug(m, 2, 'wood');
  },
  // Not a seal (a sandbag is below SEAL.blockHeight), but nobody gets over it either: standing on it puts the head
  // above the lintel. A pistol can't touch metal, so the sandbag has to be shot out (ffa8-pro seed 17: 81 s sit).
  'metal in two doorways and a lone sandbag in the third (pistol only)': (m) => {
    plug(m, 0, 'metal'); plug(m, 2, 'metal'); plug(m, 1, 'sandbags');
  },
};

describe('escaping my own bunker (real physics)', () => {
  for (const [name, setup] of Object.entries(SCENARIOS)) {
    for (const difficulty of ['hard', 'pro'] as Difficulty[]) {
      test(`${difficulty}: ${name} → out within 10 s`, async () => {
        const r = await escapeRun(difficulty, setup);
        expect(r.alive).toBe(true);
        expect(r.out).toBeGreaterThan(0);
      }, 60_000);
    }
    test(`easy: ${name} → at least tries`, async () => {
      const r = await escapeRun('easy', setup);
      expect(r.out > 0 || r.fired > 0).toBe(true);
    }, 60_000);
  }

  test('steel in every doorway with a charge carried: blasts one from a safe spot and walks out alive', async () => {
    const r = await escapeRun('pro', (m) => { for (const d of [0, 1, 2]) plug(m, d, 'steel'); }, 10, true);
    expect(r.trapped).toBe(true);
    expect(r.alive).toBe(true);
    expect(r.out).toBeGreaterThan(0);
  }, 60_000);
});
