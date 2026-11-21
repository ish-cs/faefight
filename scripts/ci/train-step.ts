/// <reference types="node" />
/**
 * One step of the ES trainer (scripts/train-bots.ts) split for GitHub Actions (.github/workflows/bot-train.yml):
 * one workflow run = one generation, its games sharded over a job matrix, the state carried in an artifact.
 *
 *   tsx scripts/ci/train-step.ts play   --state <dir> --phase gen|eval --shard i --shards n --out shard.json
 *   tsx scripts/ci/train-step.ts update --state <dir> --results <dir> --out <dir>     (ES update after the gen games)
 *   tsx scripts/ci/train-step.ts eval   --state <dir> --results <dir> --out <dir>     (champion vs hand-tuned)
 *
 * <dir> holds state.json + log.jsonl (same format as the local trainer's .train/, so `--resume` works on it),
 * ci-config.json (the run's TrainConfig, fixed at generation 0) and trained-params.json (the champion).
 * The games of a generation are reproduced on every shard from the state alone: runGeneration/headToHead are
 * seeded, so each shard asks them for the match list, plays its slice, and the update job feeds the gathered
 * results back in. Uses the trainer's own code (scripts/train/*), so it follows the trainer as it changes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PARAMS, HAND_PARAMS, decode, encode, sanitize } from '../../src/sim/bots/params';
import { DEFAULT_ES, initEs, type EsState } from '../train/es';
import { headToHead, runGeneration, type TrainConfig } from '../train/generation';
import { runMatch, type MatchResult, type MatchSpec } from '../train/runMatch';

type Saved = { es: EsState; hall: number[][]; games: number; evals: { gen: number; share: number; ci95?: number; decisive?: number; games?: number; fitA: number; fitB: number }[] };
type CiConfig = { train: TrainConfig; evalEvery: number; evalGames: number; stopAtGen: number; fromTrained: boolean };

/** Hard cap on generations, whatever the inputs say (the chain can never run away). */
const MAX_GENERATIONS = 200;

const args = process.argv.slice(2);
const get = (n: string) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1]; };
const need = (n: string) => { const v = get(n); if (!v) throw new Error(`train-step: --${n} is required`); return v; };

function load(dir: string): { saved: Saved; cfg: CiConfig } {
  const sp = path.join(dir, 'state.json'), cp = path.join(dir, 'ci-config.json');
  if (fs.existsSync(sp)) {
    if (!fs.existsSync(cp)) throw new Error(`train-step: ${sp} has no ci-config.json next to it`);
    return { saved: JSON.parse(fs.readFileSync(sp, 'utf8')), cfg: JSON.parse(fs.readFileSync(cp, 'utf8')) };
  }
  throw new Error(`train-step: no state.json in ${dir} (run "init" first)`);
}

function save(dir: string, saved: Saved, cfg: CiConfig) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(saved));
  fs.writeFileSync(path.join(dir, 'ci-config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const out = { note: 'ES mean after self-play (GitHub Actions, scripts/ci/train-step.ts)', trainedAt: new Date().toISOString(), generations: saved.es.gen, games: saved.games, evals: saved.evals.slice(-12), params: sanitize(decode(saved.es.mean)) };
  fs.writeFileSync(path.join(dir, 'trained-params.json'), JSON.stringify(out, null, 2) + '\n');
}

const appendLog = (dir: string, line: object) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(line) + '\n');

/** Sentinel: thrown from a Runner to capture the match list without playing it. */
class Captured extends Error { constructor(readonly specs: MatchSpec[]) { super('captured'); } }
async function capture(f: (run: (s: MatchSpec[]) => Promise<MatchResult[]>) => Promise<unknown>): Promise<MatchSpec[]> {
  try { await f(async (s) => { throw new Captured(s); }); } catch (e) { if (e instanceof Captured) return e.specs; throw e; }
  throw new Error('train-step: the trainer finished without asking for any games');
}

const evalSeeds = (cfg: CiConfig) => Array.from({ length: Math.ceil(cfg.evalGames / 2) }, (_, i) => 900_000 + i);
const genSpecs = (s: Saved, c: CiConfig) => capture((run) => runGeneration(s.es, decode(s.es.mean), s.hall.map(decode), c.train, run));
const evalSpecs = (s: Saved, c: CiConfig) => capture((run) => headToHead(
  { kind: 'new', params: decode(s.es.mean), difficulty: 'pro' }, { kind: 'new', params: HAND_PARAMS, difficulty: 'pro' },
  evalSeeds(c), c.train.players, c.train.maxSec, run));

/** Results from all shards, back in spec order; fails loudly if any game is missing or doesn't match. */
function gather(dir: string, specs: MatchSpec[], phase: string, gen: number): MatchResult[] {
  const out: (MatchResult | undefined)[] = new Array(specs.length);
  const walk = (d: string): string[] => fs.readdirSync(d).flatMap((f) => { const p = path.join(d, f); return fs.statSync(p).isDirectory() ? walk(p) : f.endsWith('.json') ? [p] : []; });
  for (const f of walk(dir)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { phase: string; gen: number; games: { index: number; result: MatchResult }[] };
    if (j.phase !== phase || j.gen !== gen) throw new Error(`train-step: ${f} is ${j.phase} gen ${j.gen}, expected ${phase} gen ${gen}`);
    for (const g of j.games) {
      if (g.result.seed !== specs[g.index]?.seed) throw new Error(`train-step: ${f} game ${g.index} has seed ${g.result.seed}, expected ${specs[g.index]?.seed}`);
      out[g.index] = g.result;
    }
  }
  const missing = out.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) throw new Error(`train-step: ${missing.length}/${specs.length} ${phase} games missing (indices ${missing.slice(0, 10).join(',')}) — a shard failed`);
  return out as MatchResult[];
}

/** Play games in child processes (the trainer's worker_threads pool needs a loader setup tsx may not give workers). */
async function playAll(specs: { index: number; spec: MatchSpec }[], workers: number) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'train-'));
  const queue = [...specs];
  const out: { index: number; result: MatchResult }[] = [];
  await Promise.all(Array.from({ length: Math.min(workers, specs.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const sf = path.join(tmp, `${job.index}.spec.json`), rf = path.join(tmp, `${job.index}.json`);
      fs.writeFileSync(sf, JSON.stringify(job.spec));
      const t0 = Date.now();
      const code = await new Promise<number | null>((resolve, reject) => {
        const c = spawn(process.execPath, [...process.execArgv, process.argv[1], 'match', '--spec', sf, '--out', rf], { stdio: ['ignore', 'inherit', 'inherit'] });
        c.on('error', reject);
        c.on('exit', resolve);
      });
      if (code !== 0) throw new Error(`train-step: game ${job.index} (seed ${job.spec.seed}) exited with code ${code}`);
      const result = JSON.parse(fs.readFileSync(rf, 'utf8')) as MatchResult;
      console.log(`game ${job.index}: seed ${result.seed}, ${job.spec.seats.length} seats, winner ${result.winner ?? 'none'} at ${(result.time / 60).toFixed(1)} min · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      out.push({ index: job.index, result });
    }
  }));
  return out;
}

const cmd = args[0];
if (cmd === 'init') {
  // New run: generation 0 from hand-tuned params (or the current champion with --from-trained).
  const over = JSON.parse(get('config') || '{}') as Record<string, unknown>;
  const known = ['lambda', 'games', 'candSeats', 'players', 'maxSec', 'seed', 'duels', 'duelWeight', 'evalEvery', 'evalGames'];
  for (const k of Object.keys(over)) if (!known.includes(k)) throw new Error(`train-step: unknown config key "${k}" (known: ${known.join(', ')})`);
  const num = (k: string, d: number) => { const v = over[k] ?? d; if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`train-step: config.${k} must be a number`); return v; };
  const gens = Number(need('generations'));
  if (!Number.isInteger(gens) || gens < 1 || gens > MAX_GENERATIONS) throw new Error(`train-step: generations must be 1..${MAX_GENERATIONS}, got ${gens}`);
  // Defaults = scripts/train-bots.ts.
  const train: TrainConfig = {
    es: { ...DEFAULT_ES, lambda: num('lambda', DEFAULT_ES.lambda) }, games: num('games', 5), candSeats: num('candSeats', 5),
    players: num('players', 8), maxSec: num('maxSec', 18 * 60), seed: num('seed', 1), duels: num('duels', 6), duelWeight: num('duelWeight', 1.5),
  };
  const fromTrained = get('from-trained') === 'true';
  const cfg: CiConfig = { train, evalEvery: num('evalEvery', 5), evalGames: num('evalGames', 100), stopAtGen: gens, fromTrained };
  const saved: Saved = { es: initEs(encode(fromTrained ? DEFAULT_PARAMS : HAND_PARAMS), train.es), hall: [], games: 0, evals: [] };
  const dir = need('out');
  save(dir, saved, cfg);
  fs.writeFileSync(path.join(dir, 'log.jsonl'), '');
  const specs = await genSpecs(saved, cfg);
  console.log(`init: ${gens} generations, λ=${train.es.lambda}, ${specs.length} games/generation, eval every ${cfg.evalEvery} (${cfg.evalGames} games)`);
} else if (cmd === 'match') {
  const spec = JSON.parse(fs.readFileSync(need('spec'), 'utf8')) as MatchSpec;
  fs.writeFileSync(need('out'), JSON.stringify(await runMatch(spec)));
} else if (cmd === 'play') {
  const { saved, cfg } = load(need('state'));
  const phase = need('phase'), shard = Number(need('shard')), shards = Number(need('shards'));
  if (!(shard >= 1 && shard <= shards)) throw new Error(`train-step: shard ${shard} of ${shards}`);
  const specs = phase === 'gen' ? await genSpecs(saved, cfg) : phase === 'eval' ? await evalSpecs(saved, cfg) : null;
  if (!specs) throw new Error(`train-step: --phase must be gen or eval, got ${phase}`);
  const mine = specs.map((spec, index) => ({ index, spec })).filter(({ index }) => index % shards === shard - 1);
  console.log(`${phase}, generation ${saved.es.gen}: shard ${shard}/${shards} plays ${mine.length} of ${specs.length} games on ${os.availableParallelism()} cores`);
  const games = await playAll(mine, Number(get('workers') ?? os.availableParallelism()));
  fs.writeFileSync(need('out'), JSON.stringify({ phase, gen: saved.es.gen, games }));
} else if (cmd === 'update') {
  const dir = need('state'), outDir = need('out');
  const { saved, cfg } = load(dir);
  const specs = await genSpecs(saved, cfg);
  const results = gather(need('results'), specs, 'gen', saved.es.gen);
  const t0 = Date.now();
  const { next, stats } = await runGeneration(saved.es, decode(saved.es.mean), saved.hall.map(decode), cfg.train, async (s) => {
    if (s.length !== results.length || s.some((x, i) => x.seed !== results[i].seed)) throw new Error('train-step: generation replay asked for different games than were played');
    return results;
  });
  saved.games += stats.games;
  if (saved.es.gen % 3 === 0) saved.hall = [...saved.hall, saved.es.mean].slice(-8); // as scripts/train-bots.ts
  saved.es = next;
  fs.mkdirSync(outDir, { recursive: true });
  if (outDir !== dir) fs.copyFileSync(path.join(dir, 'log.jsonl'), path.join(outDir, 'log.jsonl'));
  appendLog(outDir, { type: 'gen', ...stats, totalGames: saved.games, ci: { run: process.env.GITHUB_RUN_ID ?? null }, genSec: (Date.now() - t0) / 1000 });
  save(outDir, saved, cfg);
  const evalDue = saved.es.gen % cfg.evalEvery === 0 || saved.es.gen >= cfg.stopAtGen;
  const done = saved.es.gen >= Math.min(cfg.stopAtGen, MAX_GENERATIONS);
  const line = `gen ${stats.gen}: fit mean ${stats.meanFit.toFixed(3)} best ${stats.bestFit.toFixed(3)} · field ${Object.entries(stats.field).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' ')} · duels vs old ${stats.duelWinRate === null ? '-' : `${(100 * stats.duelWinRate).toFixed(0)}%`} · decisive ${(100 * stats.decisive).toFixed(0)}% · ${stats.avgMinutes.toFixed(1)} min · σ ${stats.sigma.toFixed(3)}`;
  console.log(line);
  fs.writeFileSync(path.join(outDir, 'summary.md'), `### Generation ${stats.gen} (of ${cfg.stopAtGen})\n\n${line}\n\n${stats.games} games · ${saved.games} total\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `gen=${saved.es.gen}\neval_due=${evalDue}\ndone=${done}\n`);
} else if (cmd === 'eval') {
  const dir = need('state'), outDir = need('out');
  const { saved, cfg } = load(dir);
  const specs = await evalSpecs(saved, cfg);
  const results = gather(need('results'), specs, 'eval', saved.es.gen);
  const h = await headToHead({ kind: 'new', params: decode(saved.es.mean), difficulty: 'pro' }, { kind: 'new', params: HAND_PARAMS, difficulty: 'pro' },
    evalSeeds(cfg), cfg.train.players, cfg.train.maxSec, async () => results);
  saved.games += h.results.length;
  const ev = { gen: saved.es.gen, share: h.share, ci95: h.ci95, decisive: h.decisive, games: h.results.length, fitA: h.fitA, fitB: h.fitB };
  saved.evals.push(ev);
  fs.mkdirSync(outDir, { recursive: true });
  if (outDir !== dir) fs.copyFileSync(path.join(dir, 'log.jsonl'), path.join(outDir, 'log.jsonl'));
  appendLog(outDir, { type: 'eval', ...ev, ci: { run: process.env.GITHUB_RUN_ID ?? null } });
  save(outDir, saved, cfg);
  const line = `eval gen ${ev.gen}: champion vs hand-tuned ${cfg.train.players / 2}v${cfg.train.players / 2}, ${h.results.length} games → champion win share **${(100 * h.share).toFixed(0)}% ± ${(100 * h.ci95).toFixed(0)}** (95% CI) · decisive before sudden death ${h.decisive}/${h.results.length} · fitness ${h.fitA.toFixed(3)} vs ${h.fitB.toFixed(3)}`;
  console.log(line);
  fs.appendFileSync(path.join(outDir, 'summary.md'), `\n${line}\n`);
} else {
  throw new Error(`train-step: unknown command "${cmd}" (init | play | update | eval | match)`);
}
