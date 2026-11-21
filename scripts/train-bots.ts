/// <reference types="node" />
/**
 * Self-play training for the bots' strategy/tactics weights (FlatParams).
 *
 *   npx tsx scripts/train-bots.ts [--minutes 60] [--workers N] [--lambda 14] [--games 5] [--max-sec 1080]
 *                                 [--seed 1] [--duels 2] [--duel-weight 1.5] [--eval-every 5] [--eval-games 28] [--resume] [--dir .train]
 *
 * Many headless 8-bot FFAs in parallel (worker_threads, one sim per worker), all bots at PRO skill.
 * Optimizer: separable evolution strategy (scripts/train/es.ts). Each generation seats the candidates against a
 * mixed field (current champion = the ES mean, earlier champions, the frozen pre-training bot) so it can't
 * overfit one opponent. Every few generations the champion plays 4-v-4 against the hand-tuned params on fixed
 * seeds (the fitness curve). Logs go to <dir>/log.jsonl; the champion is checkpointed to
 * src/sim/bots/trained-params.json (the bots' default params).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PARAMS, HAND_PARAMS, PARAM_KEYS, decode, encode, sanitize, type FlatParams } from '../src/sim/bots/params';
import { DEFAULT_ES, initEs, type EsState } from './train/es';
import { headToHead, runGeneration, type TrainConfig } from './train/generation';
import { loadHumanTarget, loadRecorder } from './train/hooks';
import { Pool } from './train/pool';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number, got ${args[i + 1]}`);
  return v;
};
const flag = (name: string) => args.includes(`--${name}`);
const str = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };

const minutes = opt('minutes', 60);
// Default 4 workers: the machine is shared; pass --workers to use more.
const workers = opt('workers', Math.min(4, Math.max(1, os.cpus().length - 2)));
const evalEvery = opt('eval-every', 5);
// Enough games for a useful confidence interval (±~0.1 at 100 games).
const evalGames = opt('eval-games', 100);
const dir = str('dir', '.train');
const cfg: TrainConfig = {
  es: { ...DEFAULT_ES, lambda: opt('lambda', DEFAULT_ES.lambda) },
  games: opt('games', 5),
  candSeats: opt('cand-seats', 5),
  players: opt('players', 8),
  maxSec: opt('max-sec', 18 * 60),
  seed: opt('seed', 1),
  // ~70% of games are 8-player FFAs (14 per generation), ~30% duels.
  duels: opt('duels', 6),
  duelWeight: opt('duel-weight', 1.5),
};
const TRAINED = path.resolve('src/sim/bots/trained-params.json');

fs.mkdirSync(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
const logPath = path.join(dir, 'log.jsonl');

type Saved = { es: EsState; hall: number[][]; games: number; evals: { gen: number; share: number; ci95?: number; decisive?: number; games?: number; fitA: number; fitB: number }[] };
let saved: Saved;
if (flag('resume') && fs.existsSync(statePath)) {
  saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Saved;
  console.log(`resuming at generation ${saved.es.gen} (${saved.games} games so far)`);
} else {
  // --from-trained: warm start from the current champion (trained-params.json; params it lacks get hand values).
  const start = flag('from-trained') ? DEFAULT_PARAMS : HAND_PARAMS;
  saved = { es: initEs(encode(start), cfg.es), hall: [], games: 0, evals: [] };
  if (flag('from-trained')) console.log('warm start from src/sim/bots/trained-params.json');
  fs.writeFileSync(logPath, '');
}

function writeChampion(p: FlatParams, note: string) {
  const out = { note, trainedAt: new Date().toISOString(), generations: saved.es.gen, games: saved.games, evals: saved.evals.slice(-12), params: p };
  fs.writeFileSync(TRAINED, JSON.stringify(out, null, 2) + '\n');
}

// Optional data hooks (scripts/train/hooks.ts): human statistics as an imitation term, champion replays.
const humanFile = str('human-stats', '');
if (humanFile) cfg.imitation = { weight: opt('imitation-weight', 0.1), target: loadHumanTarget(humanFile) };
const replayDir = str('replays', '');
const recorder = replayDir ? await loadRecorder() : null;
if (replayDir && !recorder) throw new Error('--replays: scripts/replays (recordHeadlessMatch) is not in this checkout yet');

const pool = new Pool(workers);
const t0 = Date.now();
const deadline = t0 + minutes * 60_000;
console.log(`training: ${workers} workers, λ=${cfg.es.lambda}, ${cfg.games} games/candidate, ${PARAM_KEYS.length} params, until ${new Date(deadline).toLocaleTimeString()}`);

try {
  // Generation time from the first one, so the loop stops before the deadline rather than after.
  let genMs = 0;
  while (Date.now() + genMs < deadline) {
    const g0 = Date.now();
    const champion = decode(saved.es.mean);
    const hall = saved.hall.map(decode);
    const { next, stats } = await runGeneration(saved.es, champion, hall, cfg, pool.run);
    saved.games += stats.games;
    // Hall of fame: an earlier champion every few generations (kept small, most recent).
    if (saved.es.gen % 3 === 0) saved.hall = [...saved.hall, saved.es.mean].slice(-8);
    saved.es = next;
    genMs = Date.now() - g0;
    const line = { ...stats, totalGames: saved.games, wallMin: (Date.now() - t0) / 60_000, genSec: genMs / 1000 };
    fs.appendFileSync(logPath, JSON.stringify({ type: 'gen', ...line }) + '\n');
    console.log(`gen ${stats.gen}: fit mean ${stats.meanFit.toFixed(3)} best ${stats.bestFit.toFixed(3)} · field ${Object.entries(stats.field).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' ')} · duels vs old ${stats.duelWinRate === null ? '-' : `${(100 * stats.duelWinRate).toFixed(0)}%`} · decisive ${(100 * stats.decisive).toFixed(0)}% · ${stats.avgMinutes.toFixed(1)} min · σ ${stats.sigma.toFixed(3)} · ${(genMs / 1000).toFixed(0)} s`);

    if (saved.es.gen % evalEvery === 0) {
      const champ = decode(saved.es.mean);
      const seeds = Array.from({ length: Math.ceil(evalGames / 2) }, (_, i) => 900_000 + i);
      const h = await headToHead({ kind: 'new', params: champ, difficulty: 'pro' }, { kind: 'new', params: HAND_PARAMS, difficulty: 'pro' }, seeds, cfg.players, cfg.maxSec, pool.run);
      saved.games += h.results.length;
      const ev = { gen: saved.es.gen, share: h.share, ci95: h.ci95, decisive: h.decisive, games: h.results.length, fitA: h.fitA, fitB: h.fitB };
      saved.evals.push(ev);
      fs.appendFileSync(logPath, JSON.stringify({ type: 'eval', ...ev, wallMin: (Date.now() - t0) / 60_000 }) + '\n');
      console.log(`  eval gen ${ev.gen}: champion vs hand-tuned 4v4, ${h.results.length} games → champion win share ${(100 * h.share).toFixed(0)}% ± ${(100 * h.ci95).toFixed(0)} (95% CI) · decisive before sudden death ${h.decisive}/${h.results.length} · fitness ${h.fitA.toFixed(3)} vs ${h.fitB.toFixed(3)}`);
      writeChampion(champ, 'ES mean after self-play (scripts/train-bots.ts)');
      if (recorder) {
        // An 8-PRO match with the champion just written as the default params, saved as a replay.
        const file = path.join(replayDir, `gen${saved.es.gen}.json`);
        const rep = await recorder({ players: Array.from({ length: cfg.players }, () => ({ name: '', isBot: true, difficulty: 'pro' })), seed: 900_000 + saved.es.gen }, 900_000 + saved.es.gen, cfg.maxSec * 30);
        fs.mkdirSync(replayDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(rep));
        console.log(`  replay → ${file}`);
      }
    }
    fs.writeFileSync(statePath, JSON.stringify(saved));
  }
  writeChampion(sanitize(decode(saved.es.mean)), 'ES mean after self-play (scripts/train-bots.ts)');
  console.log(`done: ${saved.es.gen} generations, ${saved.games} games, ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
} finally {
  await pool.close();
}
