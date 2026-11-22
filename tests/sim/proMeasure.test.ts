import { describe, test } from 'vitest';
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
import { LIFECYCLE } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { Match } from '../../src/sim/match';
import { DEFAULT_SETTINGS } from '../../src/sim/settings';
import type { Difficulty, Snapshot } from '../../src/sim/types';

// Long-running measurements, off by default: MEASURE=1 npx vitest run tests/sim/proMeasure.test.ts
const LIMIT = 25 * 60 * 30;

type Result = {
  winner: number | null; minutes: number; kills: number; seals: number; elims: number; preSdElims: number;
  msPerTick: number; diffs: Difficulty[]; killsBy: Map<number, number>; insideIdle: number;
  /** Pieces placed per bot (scaffolds counted apart), and each bot's archetype. */
  built: Map<number, { pieces: number; scaffolds: number; archetype: string }>;
  /** Shooter→victim distance of every hit, first seal time (s), share of alive time spent on the home island, goal mix. */
  hitDists: number[]; firstSeal: number | null; homeShare: number; goals: Map<string, number>;
};

async function run(diffs: Difficulty[], seed: number): Promise<Result> {
  const bots = new Map<number, Bot>();
  const m = await Match.create({
    players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })),
    seed,
  }, { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  let snap: Snapshot = m.tick(new Map());
  let kills = 0, seals = 0, elims = 0, preSdElims = 0, ms = 0;
  const killsBy = new Map<number, number>();
  const built = new Map([...bots].map(([id, b]) => [id, { pieces: 0, scaffolds: 0, archetype: b.personality.archetype }]));
  const hitDists: number[] = [];
  let firstSeal: number | null = null, aliveTicks = 0, homeTicks = 0;
  const goals = new Map<string, number>();
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    const t0 = performance.now();
    snap = m.tick(new Map());
    ms += performance.now() - t0;
    if (env.TRACE && snap.tick % (30 * Number(env.TRACE)) === 0) {
      console.log(`t=${snap.time.toFixed(0)} ` + snap.players.map((p) => {
        const b = bots.get(p.id)!;
        const w = Object.keys(p.inv.weapons).join('+');
        const pcs = Object.entries(p.inv.pieces).map(([k, n]) => `${k[0]}${n}`).join('');
        return `#${p.id}${p.alive ? '' : p.eliminated ? 'X' : '†'} ${b.currentGoal}→${b.currentTarget} hp${Math.round(p.hp)} $${p.inv.cash}/${p.vault.cash} ${w} ${pcs} g${p.inv.grenades}c${p.inv.charges} (${p.pos.x.toFixed(0)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(0)})`;
      }).join(' | ') + ` sealed ${snap.sealed.map(Number).join('')}`);
    }
    for (const p of snap.players) {
      if (!p.alive) continue;
      aliveTicks++;
      const home = m.map[p.island];
      if (Math.hypot(p.pos.x - home.center.x, p.pos.z - home.center.z) < home.radius) homeTicks++;
      const g = bots.get(p.id)!.currentGoal;
      goals.set(g, (goals.get(g) ?? 0) + 1);
    }
    for (const e of snap.events) {
      if (e.type === 'hit' && e.data.by != null && e.data.by !== e.data.target) {
        const a = snap.players.find((p) => p.id === e.data.by), b = snap.players.find((p) => p.id === e.data.target);
        if (a && b) hitDists.push(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
      }
      if (e.type === 'sealed' && firstSeal === null && e.data.by != null) firstSeal = e.t;
      if (env.TRACE && ['kill', 'sealed', 'unsealed', 'eliminated', 'trapped', 'escaped'].includes(e.type)) console.log(`  ${e.t.toFixed(1)} ${e.type} ${JSON.stringify(e.data)}`);
      if (e.type === 'kill') {
        const k = e.data.killer as number | null;
        if (k != null && k !== e.data.victim) { kills++; killsBy.set(k, (killsBy.get(k) ?? 0) + 1); }
      }
      if (e.type === 'placed') { const b = built.get(e.data.by as number)!; if (e.data.kind === 'scaffold') b.scaffolds++; else b.pieces++; }
      if (e.type === 'sealed' && e.t < LIFECYCLE.suddenDeathAt) seals++;
      if (e.type === 'eliminated') { elims++; if (e.t < LIFECYCLE.suddenDeathAt) preSdElims++; }
    }
  }
  return { winner: snap.winner, minutes: snap.time / 60, kills, seals, elims, preSdElims, msPerTick: ms / snap.tick, diffs, killsBy, insideIdle: 0, built,
    hitDists, firstSeal, homeShare: homeTicks / Math.max(1, aliveTicks), goals };
}

const fmt = (r: Result) =>
  `winner ${r.winner === null ? 'none' : `#${r.winner} (${r.diffs[r.winner - 1]})`} at ${r.minutes.toFixed(1)} min · kills ${r.kills} · seals ${r.seals} · elims ${r.elims} (${r.preSdElims} pre-SD) · ${r.msPerTick.toFixed(2)} ms/tick`;

const median = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** Aggression summary over seeds: games decided before sudden death, engagement distance, first seal, time at home. */
async function aggression(label: string, diffs: Difficulty[], seeds: number[]) {
  const rs: Result[] = [];
  for (const seed of seeds) rs.push(await run(diffs, seed));
  const preSd = rs.filter((r) => r.winner !== null && r.minutes * 60 < LIFECYCLE.suddenDeathAt).length;
  const dists = rs.flatMap((r) => r.hitDists);
  const seals = rs.map((r) => r.firstSeal).filter((x): x is number => x !== null);
  const goals = new Map<string, number>();
  for (const r of rs) for (const [g, n] of r.goals) goals.set(g, (goals.get(g) ?? 0) + n);
  const total = [...goals.values()].reduce((a, b) => a + b, 0);
  console.log([
    `${label} (${seeds.length} seeds): decided before sudden death ${preSd}/${rs.length} · median length ${median(rs.map((r) => r.minutes)).toFixed(1)} min · pre-SD eliminations median ${median(rs.map((r) => r.preSdElims))} · seals median ${median(rs.map((r) => r.seals))}`,
    `  median hit distance ${median(dists).toFixed(1)} m (${(100 * dists.filter((d) => d > 30).length / Math.max(1, dists.length)).toFixed(0)}% past 30 m) · first seal median ${seals.length ? median(seals).toFixed(0) : '-'} s (${seals.length}/${rs.length} games) · time at home ${(100 * median(rs.map((r) => r.homeShare))).toFixed(0)}% · ${median(rs.map((r) => r.msPerTick)).toFixed(2)} ms/tick`,
    `  goals: ${[...goals].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${(100 * n / total).toFixed(0)}%`).join(' ')}`,
  ].join('\n'));
}

/**
 * One game as a JSON line (for seed series split over several processes, see MEASURE=series):
 * MEASURE=series MIX=pro|hard|mixed|medium SEEDS=1,2 OUT=file.jsonl npx vitest run tests/sim/proMeasure.test.ts
 */
async function seriesGame(diffs: Difficulty[], seed: number, teamMode = 0) {
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed,
    ...(teamMode ? { settings: { ...DEFAULT_SETTINGS, teamMode } } : {}) },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  let snap: Snapshot = m.tick(new Map());
  const hitDists: number[] = [];
  const lastHurt = new Map<number, number>();
  const drown = { total: 0, unexplained: 0, byDiff: {} as Record<string, number>, spots: [] as string[] };
  let preSdElims = 0, firstSeal: number | null = null, aliveTicks = 0, homeTicks = 0, kills = 0, seals = 0;
  const goals: Record<string, number> = {};
  const elimAt: { id: number; diff: string; t: number }[] = [];
  // Teams: island -> owning team; push = >=2 alive teammates on one enemy team's island at once (episodes and seconds);
  // goal episodes (entries into a goal) per bot; friendly hits (shooter and target on one team).
  const islandTeam = new Map(snap.players.filter((p) => p.team !== undefined).map((p) => [p.island, p.team!]));
  const team = { pushes: 0, pushSec: 0, friendlyHits: 0, episodes: {} as Record<string, number>, sealsOnPush: 0 };
  const pushing = new Set<string>();
  const lastGoal = new Map<number, string>();
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    if (teamMode) {
      const on = new Map<string, number>();
      for (const p of snap.players) {
        if (!p.alive || p.team === undefined) continue;
        const g = bots.get(p.id)!.currentGoal;
        if (lastGoal.get(p.id) !== g) { team.episodes[g] = (team.episodes[g] ?? 0) + 1; lastGoal.set(p.id, g); }
        const isl = m.map.findIndex((l) => Math.hypot(p.pos.x - l.center.x, p.pos.z - l.center.z) < l.radius + 2);
        const owner = islandTeam.get(isl);
        if (owner === undefined || owner === p.team) continue;
        const k = `${p.team}@${isl}`;
        on.set(k, (on.get(k) ?? 0) + 1);
      }
      const now = new Set([...on].filter(([, n]) => n >= 2).map(([k]) => k));
      for (const k of now) if (!pushing.has(k)) team.pushes++;
      if (now.size) team.pushSec += 1 / 30;
      pushing.clear();
      for (const k of now) pushing.add(k);
    }
    for (const p of snap.players) {
      if (!p.alive) continue;
      aliveTicks++;
      const home = m.map[p.island];
      if (Math.hypot(p.pos.x - home.center.x, p.pos.z - home.center.z) < home.radius) homeTicks++;
      const g = bots.get(p.id)!.currentGoal;
      goals[g] = (goals[g] ?? 0) + 1;
    }
    for (const e of snap.events) {
      if (e.type === 'hit' && e.data.by != null && e.data.by !== e.data.target) {
        const a = snap.players.find((p) => p.id === e.data.by), b = snap.players.find((p) => p.id === e.data.target);
        if (a && b) hitDists.push(Math.round(10 * Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)) / 10);
      }
      if (e.type === 'hit') lastHurt.set(e.data.target as number, e.t);
      if (teamMode && e.type === 'hit' && e.data.by != null && e.data.by !== e.data.target) {
        const a = snap.players.find((p) => p.id === e.data.by), b = snap.players.find((p) => p.id === e.data.target);
        if (a && b && a.team !== undefined && a.team === b.team) team.friendlyHits++;
      }
      if (teamMode && e.type === 'sealed' && e.data.by != null && [...pushing].some((k) => k.endsWith(`@${e.data.island}`))) team.sealsOnPush++;
      if (e.type === 'sealed' && e.data.by != null) { firstSeal ??= e.t; if (e.t < LIFECYCLE.suddenDeathAt) seals++; }
      if (e.type === 'kill') {
        const k = e.data.killer as number | null, v = e.data.victim as number;
        if (k != null && k !== v) kills++;
        if (e.data.inWater && k == null && !e.data.cause) {
          drown.total++;
          const d = diffs[v - 1];
          drown.byDiff[d] = (drown.byDiff[d] ?? 0) + 1;
          if (e.t - (lastHurt.get(v) ?? -Infinity) > 4) {
            drown.unexplained++;
            const b = bots.get(v)!;
            if (drown.spots.length < 6) drown.spots.push(`${d}#${v}@${e.t.toFixed(0)}s ${b.currentGoal}`);
          }
        }
      }
      if (e.type === 'eliminated') {
        const id = e.data.player as number;
        elimAt.push({ id, diff: diffs[id - 1], t: e.t });
        if (e.t < LIFECYCLE.suddenDeathAt) preSdElims++;
      }
    }
  }
  return {
    seed, winner: snap.winner, winnerDiff: snap.winner ? diffs[snap.winner - 1] ?? null : null, t: snap.time,
    preSd: snap.winner !== null && snap.time < LIFECYCLE.suddenDeathAt, preSdElims, kills, seals, firstSeal,
    homeShare: homeTicks / Math.max(1, aliveTicks), goals, aliveTicks, hitDists, drown, elimAt,
    ...(teamMode ? { teamMode, team: { ...team, pushSec: Math.round(team.pushSec) } } : {}),
  };
}

describe.runIf(env.MEASURE)('measure', () => {
  test.runIf(env.MEASURE === 'series')('series', async () => {
    const mixes: Record<string, Difficulty[]> = {
      pro: Array(8).fill('pro'), hard: Array(8).fill('hard'), medium: Array(8).fill('medium'),
      mixed: ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'],
      hard1v1: ['hard', 'hard'],
    };
    // Team lobbies: MIX=duos|trios|quads (2v2v2v2 / 3v3 / 4v4), TDIFF difficulty (default hard).
    const teamMixes: Record<string, [number, number]> = { duos: [1, 8], trios: [2, 6], quads: [3, 8] };
    const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { appendFileSync(p: string, d: string): void };
    for (const mix of (env.MIX ?? 'pro').split(',')) {
      for (const seed of (env.SEEDS ?? '1').split(',').map(Number)) {
        let diffs = mixes[mix];
        // 1v1 ladders: A vs B, seats alternate with the seed.
        if (!diffs && mix.includes('v')) { const [a, b] = mix.split('v') as Difficulty[]; diffs = seed % 2 ? [a, b] : [b, a]; }
        const tm = teamMixes[mix];
        if (tm) diffs = Array(tm[1]).fill((env.TDIFF ?? 'hard') as Difficulty);
        if (!diffs) throw new Error(`unknown MIX ${mix}`);
        const r = await seriesGame(diffs, seed, tm?.[0] ?? 0);
        fs.appendFileSync(env.OUT ?? 'series.jsonl', JSON.stringify({ mix, diffs, ...r }) + '\n');
      }
    }
  }, 7_200_000);

  test.runIf(env.MEASURE?.includes('aggr'))('aggression', async () => {
    const seeds = (env.SEEDS ?? Array.from({ length: 20 }, (_, i) => i + 1).join(',')).split(',').map(Number);
    if (!env.MIX || env.MIX === 'pro') await aggression('8 PRO FFA', Array(8).fill('pro'), seeds);
    if (!env.MIX || env.MIX === 'hard') await aggression('Hard 1v1', ['hard', 'hard'], seeds);
  }, 7_200_000);
  const seeds = (env.SEEDS ?? '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
  const a = (env.A ?? 'pro') as Difficulty, b = (env.B ?? 'hard') as Difficulty;
  test.runIf(env.MEASURE?.includes('1v1'))(`1v1 ${a} vs ${b}`, async () => {
    let winsA = 0, winsB = 0, none = 0;
    for (const seed of seeds) {
      // Alternate seats so island/seat bias cancels.
      const diffs: Difficulty[] = seed % 2 ? [a, b] : [b, a];
      const r = await run(diffs, seed);
      if (r.winner === null) none++; else if (r.winner === (seed % 2 ? 1 : 2)) winsA++; else winsB++;
      console.log(`seed ${seed} [${diffs.join(' v ')}]: ${fmt(r)}`);
    }
    console.log(`${a} ${winsA} – ${b} ${winsB} (no winner ${none})`);
  }, 3_600_000);
  test.runIf(env.MEASURE?.includes('ffa'))('8-bot FFA', async () => {
    const mixes: Record<string, Difficulty[]> = {
      pro: Array(8).fill('pro'),
      mixed: ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'],
    };
    for (const [name, diffs] of Object.entries(mixes)) {
      if (env.MIX && env.MIX !== name) continue;
      for (const seed of seeds) {
        const r = await run(diffs, seed);
        const top = [...r.killsBy.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id, k]) => `#${id}(${diffs[id - 1]}) ${k}`).join(', ');
        console.log(`FFA ${name} seed ${seed}: ${fmt(r)} · top killers ${top}`);
        console.log('  built (pieces/scaffolds): ' + [...r.built].map(([id, b]) => `#${id} ${diffs[id - 1]} ${b.archetype} ${b.pieces}/${b.scaffolds}`).join(' · '));
      }
    }
  }, 3_600_000);
});
