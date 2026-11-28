import { test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { aimStats, type AimSample } from '../../src/sim/bots/aimStats';
import { debugBrain } from '../../src/sim/bots/introspect';
import { ARCHETYPES, preset } from '../../src/sim/bots/personality';
import { DT, LIFECYCLE } from '../../src/sim/constants';
import type { HazardDef } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import type { Difficulty, PlayerInput, PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { dist2D, v3 } from '../../src/sim/vec';

// Measurement only (ci/seedstats-measure branch, never merged): per-seed raw numbers behind the seed-robust tests.
// TASKS="util:1,commit:2,..." ; prints one `SEEDSTAT {json}` line per task.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const out = (o: object) => console.log('SEEDSTAT ' + JSON.stringify(o));
const r2 = (x: number) => Math.round(x * 100) / 100;
const MIX: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];

async function util(seed: number) {
  const m = await Match.create({ players: (['pro', 'hard', 'medium', 'pro'] as Difficulty[]).map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  let snap: Snapshot = m.tick(new Map());
  const smokeT: number[] = [], flashT: number[] = [];
  for (let i = 0; i < 12 * 60 * 30 && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) { if (e.type === 'smoke') smokeT.push(r2(e.t)); if (e.type === 'flash') flashT.push(r2(e.t)); }
  }
  m.dispose();
  out({ task: 'util', seed, end: r2(snap.time), winner: snap.winner, smokeT, flashT });
}

async function commit(seed: number) {
  const diffs: Difficulty[] = ['pro', 'hard', 'pro', 'hard'];
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  const players = (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players;
  for (const id of bots.keys()) m.debugGive(id, { weapons: { rocket: { mag: 1, spare: 8 }, rifle: { mag: 25, spare: 100 } } });
  const prev = new Map<number, { eq: string; rl: number; mag: number }>();
  const c = { switches: 0, rocketSwitches: 0, starts: 0, done: 0, cancelled: 0, botSec: 0 };
  const at: Record<string, typeof c> = {};
  let whys = 0;
  m.tick(new Map());
  for (let i = 0; i < 3 * 60 * 30; i++) {
    if (i === 60 * 30 || i === 120 * 30) at[i / 30] = { ...c };
    const snap = m.tick(new Map());
    if (snap.winner !== null) break;
    for (const [id, p] of players) {
      if (!p.alive) { prev.delete(id); continue; }
      c.botSec += 1 / 30;
      const cur = { eq: p.equipped, rl: p.reloadUntil, mag: p.inv.weapons.rocket?.mag ?? 0 };
      const was = prev.get(id);
      if (was && was.eq !== cur.eq) {
        if (was.eq !== 'fists' && cur.eq !== 'fists') c.switches++;
        if (was.eq === 'rocket' || cur.eq === 'rocket') c.rocketSwitches++;
        if (was.eq === 'rocket' && was.rl > 0) c.cancelled++;
      }
      if (was && was.eq === 'rocket' && cur.eq === 'rocket') {
        if (was.rl === 0 && cur.rl > 0) c.starts++;
        if (was.mag === 0 && cur.mag === 1) c.done++;
      }
      prev.set(id, cur);
      if (i % 30 === 0 && debugBrain(bots.get(id)!).weapon) whys++;
    }
  }
  at['180'] = { ...c };
  m.dispose();
  out({ task: 'commit', seed, at, whys });
}

async function build(seed: number) {
  // Fixed archetypes, balanced across tiers: seats 1-4 (pro, hard, medium, easy) one archetype, seats 5-8 another.
  const A = ARCHETYPES[seed % ARCHETYPES.length], B = ARCHETYPES[(seed + 2) % ARCHETYPES.length];
  const m = await Match.create({ players: MIX.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
    { makeBot: (id, d, rng) => new Bot(id, d, rng, preset(id <= 4 ? A : B)) });
  let snap = m.tick(new Map());
  const placed: [number, number][] = [];
  for (let i = 0; i < 25 * 60 * 30 && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) if (e.type === 'placed' && e.data.kind !== 'scaffold') placed.push([Math.round(e.t), e.data.by as number]);
  }
  m.dispose();
  out({ task: 'build', seed, A, B, end: r2(snap.time), winner: snap.winner, placed });
}

async function drown(seed: number, kind: Difficulty | 'mixed') {
  const diffs = kind === 'mixed' ? MIX : Array<Difficulty>(8).fill(kind);
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  let snap: Snapshot = m.tick(new Map());
  const lastHurt = new Map<number, number>();
  const lastPos = new Map<number, { x: number; z: number }>();
  const lost: { t: number; x: number; z: number }[] = [];
  const unexplained: [number, number][] = [];
  let water = 0, aliveSec = 0;
  for (let i = 0; i < 30 * LIFECYCLE.suddenDeathAt && snap.winner === null; i++) {
    for (const p of snap.players) if (p.alive) { lastPos.set(p.id, { x: p.pos.x, z: p.pos.z }); aliveSec += 1 / 30; }
    snap = m.tick(new Map());
    for (const e of snap.events) {
      if (e.type === 'hit') lastHurt.set(e.data.target as number, e.t);
      if (e.type === 'destroyed') { const q = e.data.pos as { x: number; z: number }; lost.push({ t: e.t, x: q.x, z: q.z }); }
      if (e.type !== 'kill' || !e.data.inWater) continue;
      water++;
      if (e.data.killer != null || e.data.cause) continue;
      const v = e.data.victim as number, at = lastPos.get(v);
      const cut = !!at && lost.some((q) => e.t - q.t < 4 && Math.hypot(q.x - at.x, q.z - at.z) < 6);
      if (e.t - (lastHurt.get(v) ?? -Infinity) > 4 && !cut) unexplained.push([Math.round(e.t), v]);
    }
  }
  m.dispose();
  out({ task: 'drown', kind, seed, end: r2(snap.time), aliveSec: Math.round(aliveSec), water, unexplained });
}

async function aim(seed: number) {
  const m = await Match.create({ players: MIX.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  const tracks = new Map<number, AimSample[]>();
  let snap = m.tick(new Map());
  for (let i = 0; i < 150 / DT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const p of snap.players) {
      if (!tracks.has(p.id)) tracks.set(p.id, []);
      tracks.get(p.id)!.push({ yaw: p.yaw, pitch: p.pitch, alive: p.alive });
    }
  }
  m.dispose();
  const tiers: Record<string, unknown> = {};
  for (const d of ['easy', 'medium', 'hard', 'pro'] as Difficulty[])
    tiers[d] = aimStats([...tracks].filter(([id]) => MIX[id - 1] === d).map(([, t]) => t), DT);
  out({ task: 'aim', seed, tiers });
}

// hazards.test.ts helpers (copied).
const tick = (m: Match, sec: number, inputs = new Map<number, PlayerInput>()) => {
  let s: Snapshot = m.tick(inputs);
  const all: Snapshot[] = [s];
  for (let i = 1; i < Math.round(sec * 30); i++) { s = m.tick(inputs); all.push(s); }
  return { last: s, events: all.flatMap((x) => x.events), all };
};
function place(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = (m as unknown as { s: { players: Map<number, { invulnUntil: number; spawnProtected?: boolean }> } }).s.players.get(id)!;
  p.invulnUntil = 0;
  p.spawnProtected = false;
}
function beside(m: Match, h: HazardDef, d: number): Vec3 {
  const c = h.island >= 0 ? m.def.islands[h.island].center : m.def.center.center;
  const l = dist2D(c, h.pos) || 1;
  return v3(h.pos.x + ((c.x - h.pos.x) / l) * d, h.pos.y, h.pos.z + ((c.z - h.pos.z) / l) * d);
}
const firstOf = (m: Match, kind: HazardDef['kind'], island = 0) => m.def.hazards.find((h) => h.kind === kind && h.island === island)!;

async function barrelDuel(difficulty: 'easy' | 'pro', seed: number) {
  const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'Bot', isBot: true, difficulty }], seed });
  const b = firstOf(m, 'barrel', 0);
  const t = beside(m, b, 1);
  const side = v3(b.pos.x - (t.z - b.pos.z) * 1.3, b.pos.y, b.pos.z + (t.x - b.pos.x) * 1.3);
  place(m, 1, side);
  m.debugGive(2, { weapons: { rifle: { mag: 25, spare: 100 } } });
  place(m, 2, beside(m, b, 14));
  const bot = (m as unknown as { bots: Map<number, { barrelTarget: number | null }> }).bots.get(2)!;
  let aimed = false, aimedAt = Infinity, barrelBy: unknown = null;
  for (let i = 0; i < 30 * 12 && barrelBy === null; i++) {
    if (i % 30 === 0) place(m, 1, side);
    m.debugSetHp(1, 100);
    const s = m.tick(new Map());
    if (bot.barrelTarget === b.id && !aimed) { aimed = true; aimedAt = s.time; }
    for (const e of s.events) if (e.type === 'hazard' && e.data.what === 'fuse' && e.data.id === b.id) barrelBy = e.data.by;
  }
  return { aimed, aimedAt: Number.isFinite(aimedAt) ? r2(aimedAt) : null, barrelBy };
}

async function haz(seed: number) {
  const { HAZARD } = await import('../../src/sim/constants');
  const pro = await barrelDuel('pro', seed), easy = await barrelDuel('easy', seed);
  const closest: Record<string, number> = {};
  for (const fusing of [false, true]) {
    const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'Bot', isBot: true, difficulty: 'hard' }], seed });
    const b = firstOf(m, 'barrel', 0);
    place(m, 2, beside(m, b, 0.8));
    if (fusing) { place(m, 1, m.def.islands[1].center); m.debugDamageHazard(b.id, HAZARD.barrel.hp, 1); }
    else { place(m, 1, beside(m, b, 16)); m.debugGive(2, { weapons: { pistol: { mag: 12, spare: 24 } } }); }
    tick(m, 1);
    const { all } = tick(m, fusing ? 0.4 : 1);
    closest[fusing ? 'fusing' : 'fight'] = r2(Math.min(...all.map((s) => dist2D(s.players[1].pos, b.pos))));
  }
  const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'Bot', isBot: true, difficulty: 'hard' }], seed });
  const c = firstOf(m, 'crate', 1);
  place(m, 1, m.def.islands[0].center);
  place(m, 2, beside(m, c, 4));
  m.debugGive(2, { weapons: { pistol: { mag: 12, spare: 24 } } });
  const { events } = tick(m, 10);
  const broke = events.some((e) => e.type === 'hazard' && e.data.what === 'break' && e.data.id === c.id && e.data.by === 2);
  out({ task: 'haz', seed, pro, easyAimed: easy.aimed, closest, broke, fusingMin: r2(HAZARD.barrel.radius * 0.5) });
}

test('seed stats', async () => {
  console.log('TASKS=' + env.TASKS);
  for (const t of (env.TASKS ?? '').split(',').filter(Boolean)) {
    const [task, s, kind] = t.split(':');
    const seed = Number(s);
    const t0 = Date.now();
    try {
      if (task === 'util') await util(seed);
      else if (task === 'commit') await commit(seed);
      else if (task === 'build') await build(seed);
      else if (task === 'drown') await drown(seed, (kind ?? 'mixed') as Difficulty | 'mixed');
      else if (task === 'aim') await aim(seed);
      else if (task === 'haz') await haz(seed);
      else throw new Error(`unknown task ${task}`);
    } catch (e) { out({ task, seed, kind, error: String(e) }); }
    out({ timing: t, sec: Math.round((Date.now() - t0) / 1000) });
  }
}, 6 * 3600_000);
