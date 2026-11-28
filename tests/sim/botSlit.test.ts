import { describe, expect, test } from 'vitest';
import { LIFECYCLE, MAP, PIECES, PLAYER } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { insideBunker } from '../../src/sim/bots/nav';
import { DEFAULT_BOT_PARAMS, type BotParams } from '../../src/sim/bots/params';
import { chestOf, slitLines } from '../../src/sim/bots/slit';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type Difficulty, type Snapshot } from '../../src/sim/types';
import { add, forward, rotateY, scale, v3, yawOf } from '../../src/sim/vec';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe('firing slits: shooting into a bunker', () => {
  test('from every stand slitLines gives, a pistol shot at the chest of a target inside goes through the slit and hits', async () => {
    const m = await Match.create({ players: [{ name: 'in', isBot: false }, { name: 'out', isBot: false }] });
    const b = m.map[0].bunker;
    const local = (x: number, z: number) => { const p = add(b.center, rotateY(v3(x, 0, z), b.facingYaw)); return v3(p.x, b.center.y, p.z); };
    let tried = 0;
    for (const [x, z] of [[0, 0], [-1, -1], [1.2, 0.5], [0.6, -1.4], [-1.4, 1.2]]) {
      const t = local(x, z);
      const lines = slitLines(b, t, 0.8);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines.slice(0, 3)) {
        m.debugTeleport(1, t);
        m.debugSetHp(1, 100);
        m.debugTeleport(2, l.stand);
        m.debugGive(2, { weapons: { pistol: { mag: 12, spare: 0 } } });
        let s: Snapshot = m.tick(new Map());
        for (let i = 0; i < 15; i++) s = m.tick(new Map());
        const eye = add(s.players.find((p) => p.id === 2)!.pos, v3(0, PLAYER.eyeHeight, 0));
        const chest = chestOf(s.players.find((p) => p.id === 1)!.pos);
        const d = v3(chest.x - eye.x, chest.y - eye.y, chest.z - eye.z);
        // Aimed single shots (ADS, spread recovered between them): the pistol's cone is still random, so a few tries.
        const input = { ...NO_INPUT, yaw: yawOf(d), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)), ads: true, slot: 'pistol' as const };
        let hit = false;
        for (let i = 0; i < 80 && !hit; i++) {
          s = m.tick(new Map([[2, { ...input, fire: i % 10 === 9 }]]));
          hit = s.events.some((e) => e.type === 'hit' && e.data.target === 1 && e.data.by === 2);
        }
        expect(hit, `target (${x},${z}) slit ${l.slit}`).toBe(true);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(8);
    m.dispose();
  });
});

/**
 * A bot sieging a rival who respawned trapped in their sealed bunker (all-metal plugs: the respawn pistol can't get
 * out in time). PRO / Hard take a line through a firing slit and kill them before the breakout clock does; Easy
 * waits at the door. User replay 8e57e4: a Hard sealed the user three times and only hit them after they broke out.
 */
async function siege(d: Difficulty, seed: number, params?: BotParams) {
  const m = await Match.create({ players: [{ name: 'sieger', isBot: true, difficulty: d }, { name: 'trapped', isBot: true, difficulty: 'medium' }], seed },
    { makeBot: (id, diff, rng) => new Bot(id, diff, rng, undefined, id === 1 ? params : undefined) });
  for (let i = 0; i < 30; i++) m.tick(new Map());
  const isl = m.map[1], b = isl.bunker;
  m.debugKill(2, 1);
  for (const dw of b.doorways) {
    const out = forward(dw.yaw), off = MAP.bunker.wall / 2 + PIECES.metal.d / 2 + 0.05;
    m.debugPlacePiece('metal', v3(dw.center.x + out.x * off, dw.center.y - 0.01, dw.center.z + out.z * off), dw.yaw, 1);
  }
  // Camping a different doorway each seed, 5-7 m out.
  const front = b.doorways[seed % b.doorways.length];
  m.debugTeleport(1, add(front.center, scale(forward(front.yaw), 5 + (seed % 3))));
  m.debugGive(1, { weapons: { rifle: { mag: 30, spare: 90 } } });
  let snap: Snapshot = m.tick(new Map());
  const p = (id: number) => snap.players.find((q) => q.id === id)!;
  for (let i = 0; i < 30 * (LIFECYCLE.respawnSec + 1) && !p(2).alive; i++) snap = m.tick(new Map());
  expect(p(2).breakoutUntil).not.toBeNull();
  const brain = () => m.botBrain(1) as unknown as { slitNote: { t: number; text: string } | null };
  let slitKill = false, usedSlit = false, sieger = 0;
  const end = snap.time + LIFECYCLE.breakoutSec + 0.5;
  while (snap.time < end && !p(2).eliminated) {
    snap = m.tick(new Map());
    if (brain().slitNote?.text.includes('window slit')) usedSlit = true;
    for (const e of snap.events) {
      if (e.type === 'hit' && e.data.target === 2 && e.data.by === 1) sieger++;
      if (e.type === 'kill' && e.data.victim === 2 && e.data.killer === 1 && insideBunker(b, p(2).pos)) slitKill = true;
    }
    if (ENV.SLIT_TRACE && snap.tick % 10 === 0) {
      const s = p(1), v = p(2);
      console.log(d, seed, snap.time.toFixed(1), (m.botBrain(1) as unknown as { currentGoal: string }).currentGoal,
        s.pos.x.toFixed(2), s.pos.z.toFixed(2), '|', v.pos.x.toFixed(2), v.pos.z.toFixed(2), v.alive, brain().slitNote?.text ?? '');
    }
  }
  m.dispose();
  return { slitKill, usedSlit, sieger };
}

describe('bots shoot a trapped rival through the firing slits', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6];
  test('PRO: kills the trapped rival through a slit before the breakout clock in most seeds', async () => {
    const rs = [];
    for (const s of SEEDS) rs.push(await siege('pro', s));
    if (ENV.SLIT_TRACE) console.log(rs);
    expect(rs.filter((r) => r.usedSlit).length).toBe(SEEDS.length);
    expect(rs.filter((r) => r.slitKill).length).toBeGreaterThanOrEqual(4);
  }, 120_000);
  test('Hard: the same', async () => {
    const rs = [];
    for (const s of SEEDS) rs.push(await siege('hard', s));
    expect(rs.filter((r) => r.slitKill).length).toBeGreaterThanOrEqual(4);
  }, 120_000);
  test('control: a PRO with drive.slitShoot 0 camps the door and kills nobody inside (the slit play is what does it)', async () => {
    const params: BotParams = { ...DEFAULT_BOT_PARAMS, drive: { ...DEFAULT_BOT_PARAMS.drive, slitShoot: { easy: 0, medium: 0, hard: 0, pro: 0 } } };
    const rs = [];
    for (const s of SEEDS.slice(0, 3)) rs.push(await siege('pro', s, params));
    expect(rs.filter((r) => r.usedSlit || r.slitKill)).toEqual([]);
  }, 60_000);
  test('Easy: never takes a slit line (waits at the door)', async () => {
    const rs = [];
    for (const s of SEEDS.slice(0, 3)) rs.push(await siege('easy', s));
    expect(rs.filter((r) => r.usedSlit)).toEqual([]);
  }, 60_000);
});
