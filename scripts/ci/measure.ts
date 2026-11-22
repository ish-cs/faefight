/// <reference types="node" />
/**
 * Headless bot measurement for CI (.github/workflows/bot-measure.yml). Node only: no browser, no GPU.
 * Imports nothing but src/sim, so it runs against any ref (the workflow copies this file into the checkout).
 *
 *   npx tsx scripts/ci/measure.ts run --tasks ffa8-pro:1,ffa8-pro:2 --out shard.json [--params path.json] [--workers N]
 *   npx tsx scripts/ci/measure.ts aggregate --in <dir of shard jsons> --json measure-summary.json --md summary.md
 *
 * Scenarios: 1v1-hard, 1v1-pro-vs-hard (PRO seat alternates by seed), ffa8-pro, ffa8-hard, ffa8-mixed.
 * Metrics follow scripts/train/runMatch.ts and tests/sim/shipChecks.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

type Difficulty = 'easy' | 'medium' | 'hard' | 'pro';
export const SCENARIOS = ['1v1-hard', '1v1-pro-vs-hard', 'ffa8-pro', 'ffa8-hard', 'ffa8-mixed'] as const;
type Scenario = (typeof SCENARIOS)[number];

const SD = 900; // LIFECYCLE.suddenDeathAt (checked against the sim at runtime)
const ATTACK_GOALS = new Set(['attack', 'seal', 'bridge', 'raid', 'fight']);
const IDLE_M = 8, THREAT_M = 30, SAMPLE_TICKS = 15, HOME_SIT_M = 6;

function seatsFor(scenario: Scenario, seed: number): { diffs: Difficulty[]; maxSec: number } {
  switch (scenario) {
    case '1v1-hard': return { diffs: ['hard', 'hard'], maxSec: 25 * 60 };
    // Same seat rule as tests/sim/botSeries.test.ts: PRO is seat 1 on odd seeds.
    case '1v1-pro-vs-hard': return { diffs: seed % 2 ? ['pro', 'hard'] : ['hard', 'pro'], maxSec: 25 * 60 };
    case 'ffa8-pro': return { diffs: Array(8).fill('pro'), maxSec: SD + 180 };
    case 'ffa8-hard': return { diffs: Array(8).fill('hard'), maxSec: SD + 180 };
    case 'ffa8-mixed': return { diffs: ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'], maxSec: SD + 180 };
  }
}

type SeatOut = {
  difficulty: Difficulty; kills: number; deaths: number; aliveSec: number; attackSec: number;
  idleHome: number; longestHomeIdle: number; hitDists: number[]; eliminatedAt: number | null;
  /** Heals (medkits, heal/shield potions): got (bought or picked up), used, used mid-fight (an enemy within 30 m or hurt
   * in the last 3 s), and deaths after at least 3 s at hp + shield ≤ 50 (a heal could have saved them). Optional: older shards. */
  healsGot?: number; healsUsed?: number; healsUsedFight?: number; lowHpDeaths?: number;
};
export type GameOut = {
  scenario: Scenario; seed: number; winner: number | null; winnerDifficulty: Difficulty | null;
  time: number; decisive: boolean; preSdElims: number; firstSeal: number | null; msPerTick: number; wallSec: number;
  seats: SeatOut[];
};

async function runOne(scenario: Scenario, seed: number, paramsPath: string | null): Promise<GameOut> {
  const { Match } = await import('../../src/sim/match');
  const { Bot } = await import('../../src/sim/bots/bot');
  const { LIFECYCLE, TICK_HZ } = await import('../../src/sim/constants');
  if (LIFECYCLE.suddenDeathAt !== SD) throw new Error(`measure: sudden death is at ${LIFECYCLE.suddenDeathAt}s, script assumes ${SD}s — update SD`);
  let params: unknown = undefined;
  if (paramsPath) {
    let mod: { sanitize: (p: Record<string, number>) => unknown };
    // Variable specifier: params.ts exists only on refs with the trainable bot (tsc must pass on refs without it).
    const paramsModule = '../../src/sim/bots/params';
    try { mod = await import(/* @vite-ignore */ paramsModule); } catch (e) {
      throw new Error(`measure: --params given but this ref has no src/sim/bots/params.ts (${(e as Error).message})`);
    }
    const j = JSON.parse(fs.readFileSync(paramsPath, 'utf8')) as { params?: Record<string, number> } & Record<string, number>;
    params = mod.sanitize(j.params ?? j);
  }
  const { diffs } = seatsFor(scenario, seed);
  // MEASURE_MAX_SEC: cut games short (smoke tests of this script only; real measurements never set it).
  const maxSec = Number(process.env.MEASURE_MAX_SEC) || seatsFor(scenario, seed).maxSec;
  const brains: { currentGoal?: string }[] = [];
  const BotCtor = Bot as unknown as new (...a: unknown[]) => { currentGoal?: string };
  const m = await Match.create(
    { players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
    { makeBot: (id, d, rng) => { const b = params ? new BotCtor(id, d, rng, undefined, params) : new BotCtor(id, d, rng); brains[id - 1] = b; return b as never; } },
  );
  const seats: SeatOut[] = diffs.map((d) => ({ difficulty: d, kills: 0, deaths: 0, aliveSec: 0, attackSec: 0, idleHome: 0, longestHomeIdle: 0, hitDists: [], eliminatedAt: null, healsGot: 0, healsUsed: 0, healsUsedFight: 0, lowHpDeaths: 0 }));
  type HealSeen = { alive: boolean; n: number; healAt: unknown; drinking: { kind: string } | null; lowSince: number | null; hurtAt: number };
  const healSeen: HealSeen[] = diffs.map(() => ({ alive: false, n: 0, healAt: null, drinking: null, lowSince: null, hurtAt: -99 }));
  type HealP = { id: number; alive: boolean; hp: number; shield: number; pos: { x: number; z: number }; healAt?: unknown; drinking?: { kind: string } | null; inv: { medkits: number; potions?: Record<string, number | undefined> } };
  const healN = (p: HealP) => p.inv.medkits + (p.inv.potions?.healPotion ?? 0) + (p.inv.potions?.shieldSmall ?? 0) + (p.inv.potions?.shieldBig ?? 0);
  const bunkers = m.map.map((isl) => isl.bunker.center);
  const homeStreak = new Map<number, number>();
  let preSdElims = 0, firstSeal: number | null = null;
  const maxTicks = Math.round(maxSec * TICK_HZ);
  const w0 = performance.now();
  let snap = m.tick(new Map());
  let ticks = 0;
  for (; ticks < maxTicks && snap.winner === null; ticks++) {
    snap = m.tick(new Map());
    if (ticks % SAMPLE_TICKS === 0) {
      const dt = SAMPLE_TICKS / TICK_HZ;
      for (const p of snap.players) {
        if (!p.alive || p.breakoutUntil !== null) continue;
        const s = seats[p.id - 1];
        s.aliveSec += dt;
        const goal = brains[p.id - 1]?.currentGoal;
        if (goal && ATTACK_GOALS.has(goal)) s.attackSec += dt;
        const b = bunkers[p.island];
        const nearBunker = snap.players.some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - b.x, o.pos.z - b.z) < THREAT_M);
        const armed = Object.keys(p.inv.weapons).length > 0 && p.inv.cash + p.vault.cash > 0;
        const sitting = armed && !nearBunker && !snap.sealed[p.island] && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= HOME_SIT_M;
        const st = sitting ? (homeStreak.get(p.id) ?? 0) + dt : 0;
        homeStreak.set(p.id, st);
        s.longestHomeIdle = Math.max(s.longestHomeIdle, st);
        const w = p.inv.weapons as Record<string, unknown>;
        const geared = !!(w.smg || w.rifle || w.shotgun) || p.inv.cash + p.vault.cash >= 150;
        if (geared && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= IDLE_M && !nearBunker && !snap.sealed[p.island]) s.idleHome += dt;
      }
    }
    // Heals: per tick (a drink or medkit starts and finishes within a sample interval).
    for (const p of snap.players as unknown as HealP[]) {
      const h = healSeen[p.id - 1], s = seats[p.id - 1];
      const n = healN(p), drinking = p.drinking ?? null, healAt = p.healAt ?? null;
      if (p.alive && h.alive) {
        const started = (healAt !== null && h.healAt === null) || (!!drinking && !h.drinking && drinking.kind !== 'speedPotion');
        if (started) {
          s.healsUsed!++;
          const foe = (snap.players as unknown as HealP[]).some((o) => o.id !== p.id && o.alive && Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) < THREAT_M);
          if (foe || snap.time - h.hurtAt < 3) s.healsUsedFight!++;
        }
        const got = n - h.n + (started ? 1 : 0);
        if (got > 0) s.healsGot! += got;
      }
      if (p.alive && p.hp + p.shield <= 50) h.lowSince ??= snap.time; else if (p.alive) h.lowSince = null;
      h.alive = p.alive; h.n = n; h.healAt = healAt; h.drinking = drinking;
    }
    for (const e of snap.events) {
      if (e.type === 'hit') {
        const by = e.data.by as number | null, target = e.data.target as number;
        if (by != null && by !== target && healSeen[target - 1]) healSeen[target - 1].hurtAt = e.t;
        const a = by != null ? snap.players[by - 1]?.pos : undefined, t = snap.players[target - 1]?.pos;
        if (by == null || by === target || !a || !t) continue;
        seats[by - 1].hitDists.push(Math.round(Math.hypot(a.x - t.x, a.z - t.z)));
      } else if (e.type === 'kill') {
        const v = e.data.victim as number, k = e.data.killer as number | null;
        seats[v - 1].deaths++;
        const ls = healSeen[v - 1].lowSince;
        if (ls !== null && e.t - ls >= 3) seats[v - 1].lowHpDeaths!++;
        healSeen[v - 1].lowSince = null;
        if (k != null && k !== v) seats[k - 1].kills++;
      } else if (e.type === 'sealed') {
        const by = e.data.by as number | null | undefined;
        if (firstSeal === null && by != null && by !== e.data.owner && e.t < SD) firstSeal = e.t;
      } else if (e.type === 'eliminated') {
        const id = e.data.player as number;
        if (seats[id - 1].eliminatedAt === null) {
          seats[id - 1].eliminatedAt = e.t;
          if (e.t < SD) preSdElims++;
        }
      }
    }
  }
  const msPerTick = (performance.now() - w0) / Math.max(1, ticks);
  // Rapier worlds live in WASM memory and are never garbage collected.
  (m as unknown as { physics?: { world?: { free?: () => void } } }).physics?.world?.free?.();
  const winner = snap.winner !== null && snap.winner > 0 ? snap.winner : null;
  return {
    scenario, seed, winner, winnerDifficulty: winner ? diffs[winner - 1] : null, time: snap.time,
    decisive: winner !== null && snap.time < SD, preSdElims, firstSeal, msPerTick, wallSec: (performance.now() - w0) / 1000, seats,
  };
}

// ---------- aggregation ----------

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
/** Half-width of the 95% CI of a mean of per-game scores (normal approximation, as scripts/train/generation.ts). */
export function ci95(xs: number[]): number {
  if (xs.length < 2) return 1;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return 1.96 * Math.sqrt(v / xs.length);
}

type Check = { name: string; pass: boolean; value: string };
export type ScenarioSummary = {
  scenario: Scenario; games: number; seeds: number[]; decisive: number; noWinner: number;
  winsByDifficulty: Record<string, number>; medianPreSdElims: number | null; medianEngagementM: number | null;
  attackPct: number; homePct: number; medianFirstSealSec: number | null; gamesWithSeal: number;
  longestHomeSitSec: number; avgMinutes: number; msPerTick: number; maxWallSec: number;
  proVsHard: { share: number; ci95: number; games: number } | null;
  /** Per game (all seats): heals got, used, used mid-fight, deaths after ≥ 3 s at ≤ 50 hp + shield. Null: shards without heal data. */
  heals: { got: number; used: number; usedFight: number; lowHpDeaths: number; deaths: number } | null;
  shipCheck: { pass: boolean | null; checks: Check[] };
};

export function summarize(scenario: Scenario, games: GameOut[]): ScenarioSummary {
  const seats = games.flatMap((g) => g.seats);
  const alive = seats.reduce((a, s) => a + s.aliveSec, 0) || 1;
  const wins: Record<string, number> = {};
  for (const g of games) if (g.winnerDifficulty) wins[g.winnerDifficulty] = (wins[g.winnerDifficulty] ?? 0) + 1;
  const seals = games.filter((g) => g.firstSeal !== null).map((g) => g.firstSeal!);
  let proVsHard: ScenarioSummary['proVsHard'] = null;
  if (scenario === '1v1-pro-vs-hard') {
    const scores: number[] = games.map((g) => (g.winner === null ? 0.5 : g.winnerDifficulty === 'pro' ? 1 : 0));
    proVsHard = { share: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length), ci95: ci95(scores), games: scores.length };
  }
  const s: ScenarioSummary = {
    scenario, games: games.length, seeds: games.map((g) => g.seed).sort((a, b) => a - b),
    decisive: games.filter((g) => g.decisive).length, noWinner: games.filter((g) => g.winner === null).length,
    winsByDifficulty: wins,
    medianPreSdElims: median(games.map((g) => g.preSdElims)),
    medianEngagementM: median(seats.flatMap((x) => x.hitDists)),
    attackPct: (100 * seats.reduce((a, x) => a + x.attackSec, 0)) / alive,
    homePct: (100 * seats.reduce((a, x) => a + x.idleHome, 0)) / alive,
    medianFirstSealSec: median(seals), gamesWithSeal: seals.length,
    longestHomeSitSec: Math.max(0, ...seats.map((x) => x.longestHomeIdle)),
    avgMinutes: games.reduce((a, g) => a + g.time, 0) / Math.max(1, games.length) / 60,
    msPerTick: games.reduce((a, g) => a + g.msPerTick, 0) / Math.max(1, games.length),
    maxWallSec: Math.max(0, ...games.map((g) => g.wallSec)),
    proVsHard,
    heals: seats.every((x) => x.healsUsed !== undefined) ? {
      got: seats.reduce((a, x) => a + x.healsGot!, 0) / Math.max(1, games.length),
      used: seats.reduce((a, x) => a + x.healsUsed!, 0) / Math.max(1, games.length),
      usedFight: seats.reduce((a, x) => a + x.healsUsedFight!, 0) / Math.max(1, games.length),
      lowHpDeaths: seats.reduce((a, x) => a + x.lowHpDeaths!, 0) / Math.max(1, games.length),
      deaths: seats.reduce((a, x) => a + x.deaths, 0) / Math.max(1, games.length),
    } : null,
    shipCheck: { pass: null, checks: [] },
  };
  // Gates from tests/sim/shipChecks.test.ts (8-bot FFA) and tests/sim/botSeries.test.ts (PRO beats hard ≥ 70%).
  // The shipChecks comparisons against the hand-tuned params need a second series and are not run here.
  const checks: Check[] = [];
  if (scenario.startsWith('ffa8')) {
    checks.push({ name: 'decisive before sudden death ≥ 60%', pass: s.decisive >= 0.6 * s.games, value: `${s.decisive}/${s.games}` });
    checks.push({ name: 'median engagement < 25 m', pass: s.medianEngagementM !== null && s.medianEngagementM < 25, value: `${s.medianEngagementM ?? '-'} m` });
    checks.push({ name: 'nobody sits at home geared > 60 s', pass: s.longestHomeSitSec <= 60, value: `${s.longestHomeSitSec.toFixed(0)} s` });
  } else if (scenario === '1v1-pro-vs-hard' && proVsHard) {
    checks.push({ name: 'PRO beats hard ≥ 70%', pass: proVsHard.share >= 0.7, value: `${(100 * proVsHard.share).toFixed(0)}%` });
  }
  s.shipCheck = { pass: checks.length ? checks.every((c) => c.pass) : null, checks };
  return s;
}

const pct = (x: number) => `${x.toFixed(0)}%`;
const secs = (x: number | null) => (x === null ? '-' : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`);

export function markdown(sums: ScenarioSummary[], meta: Record<string, string>): string {
  const overall = sums.map((s) => s.shipCheck.pass).filter((p) => p !== null);
  const lines = [
    `## Bot measurement ${overall.length ? (overall.every(Boolean) ? '✅ ship checks pass' : '❌ ship checks fail') : ''}`,
    '',
    Object.entries(meta).map(([k, v]) => `**${k}** ${v}`).join(' · '),
    '',
    '| scenario | games | decisive < 15:00 | median elims < 15:00 | median engagement | attack | home | median first seal | PRO vs hard (95% CI) | avg length | ship check |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...sums.map((s) => `| ${s.scenario} | ${s.games} | ${s.decisive}/${s.games} | ${s.medianPreSdElims ?? '-'} | ${s.medianEngagementM ?? '-'} m | ${pct(s.attackPct)} | ${pct(s.homePct)} | ${secs(s.medianFirstSealSec)} (${s.gamesWithSeal}/${s.games} games) | ${s.proVsHard ? `${(100 * s.proVsHard.share).toFixed(0)}% ± ${(100 * s.proVsHard.ci95).toFixed(0)}` : '-'} | ${s.avgMinutes.toFixed(1)} min | ${s.shipCheck.pass === null ? 'n/a' : s.shipCheck.pass ? '✅ pass' : '❌ fail'} |`),
    '',
    '### Ship-check details',
    ...sums.flatMap((s) => s.shipCheck.checks.map((c) => `- ${s.scenario}: ${c.pass ? '✅' : '❌'} ${c.name} (${c.value})`)),
    '',
    '### Heals per game (all seats)',
    '| scenario | heals got | heals used | used mid-fight | low-hp deaths (≥3 s at ≤50) | deaths |',
    '|---|---|---|---|---|---|',
    ...sums.map((s) => s.heals ? `| ${s.scenario} | ${s.heals.got.toFixed(1)} | ${s.heals.used.toFixed(1)} | ${s.heals.usedFight.toFixed(1)} | ${s.heals.lowHpDeaths.toFixed(1)} | ${s.heals.deaths.toFixed(1)} |` : `| ${s.scenario} | - | - | - | - | - |`),
    '',
    '### Wins by skill',
    ...sums.map((s) => `- ${s.scenario}: ${Object.entries(s.winsByDifficulty).map(([d, n]) => `${d} ${n}`).join(', ') || 'none'}; no winner ${s.noWinner} · ${s.msPerTick.toFixed(2)} ms/tick · slowest game ${s.maxWallSec.toFixed(0)} s wall`),
  ];
  return lines.join('\n') + '\n';
}

// ---------- CLI / worker plumbing ----------

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const get = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
  const need = (name: string) => { const v = get(name); if (!v) throw new Error(`measure: --${name} is required`); return v; };
  const cmd = args[0];
  if (cmd === 'run') {
    const tasks = need('tasks').split(',').filter(Boolean).map((t) => {
      const [sc, seed] = t.split(':');
      if (!(SCENARIOS as readonly string[]).includes(sc) || !Number.isInteger(Number(seed))) throw new Error(`measure: bad task "${t}" (want <scenario>:<seed>)`);
      return { scenario: sc as Scenario, seed: Number(seed) };
    });
    const params = get('params') ? path.resolve(get('params')!) : null;
    if (params && !fs.existsSync(params)) throw new Error(`measure: params file ${params} not found`);
    const nWorkers = Math.max(1, Math.min(tasks.length, Number(get('workers') ?? os.availableParallelism())));
    console.log(`measure: ${tasks.length} games on ${nWorkers} workers${params ? ` with params ${params}` : ''}`);
    const out: GameOut[] = [];
    const queue = [...tasks];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
    // One child process per game (same node + tsx loader flags), N at a time: a fresh WASM heap per game.
    await Promise.all(Array.from({ length: nWorkers }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const file = path.join(tmp, `${t.scenario}-${t.seed}.json`);
        const argv = [...process.execArgv, process.argv[1], 'one', '--task', `${t.scenario}:${t.seed}`, '--out', file, ...(params ? ['--params', params] : [])];
        const code = await new Promise<number | null>((resolve, reject) => {
          const c = spawn(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
          c.on('error', reject);
          c.on('exit', resolve);
        });
        if (code !== 0) throw new Error(`measure: ${t.scenario} seed ${t.seed} exited with code ${code}`);
        const r = JSON.parse(fs.readFileSync(file, 'utf8')) as GameOut;
        console.log(`${r.scenario} seed ${r.seed}: winner ${r.winner ?? 'none'}${r.winnerDifficulty ? ` (${r.winnerDifficulty})` : ''} at ${(r.time / 60).toFixed(1)} min · decisive ${r.decisive} · elims<15:00 ${r.preSdElims} · first seal ${secs(r.firstSeal)} · ${r.msPerTick.toFixed(2)} ms/tick · ${r.wallSec.toFixed(0)} s`);
        out.push(r);
      }
    }));
    fs.writeFileSync(need('out'), JSON.stringify({ games: out }));
  } else if (cmd === 'one') {
    const [sc, seed] = need('task').split(':');
    fs.writeFileSync(need('out'), JSON.stringify(await runOne(sc as Scenario, Number(seed), get('params'))));
  } else if (cmd === 'aggregate') {
    const dir = need('in');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json')) files.push(p); } };
    walk(dir);
    if (!files.length) throw new Error(`measure: no shard results under ${dir}`);
    const games = files.flatMap((f) => (JSON.parse(fs.readFileSync(f, 'utf8')) as { games: GameOut[] }).games);
    const expected = Number(get('expect') ?? games.length);
    if (games.length !== expected) throw new Error(`measure: expected ${expected} games, got ${games.length} (a shard failed?)`);
    const byScenario = SCENARIOS.map((sc) => games.filter((g) => g.scenario === sc)).filter((g) => g.length);
    const sums = byScenario.map((g) => summarize(g[0].scenario, g));
    const meta: Record<string, string> = {};
    for (const k of ['ref', 'sha', 'scenario', 'seeds', 'params', 'label', 'run']) if (get(k)) meta[k] = get(k)!;
    const md = markdown(sums, meta);
    const ship = sums.map((s) => s.shipCheck.pass).filter((p) => p !== null);
    fs.writeFileSync(need('json'), JSON.stringify({ meta, shipCheckPass: ship.length ? ship.every(Boolean) : null, scenarios: sums }, null, 2) + '\n');
    fs.writeFileSync(need('md'), md);
    console.log(md);
  } else {
    throw new Error(`measure: unknown command "${cmd}" (run | aggregate)`);
  }
}
