/// <reference types="node" />
/**
 * Parallel head-to-head series between two bot configurations.
 *
 *   npx tsx scripts/compare-bots.ts --a new:hard --b legacy:hard [--players 2] [--seeds 20] [--max-sec 1500]
 *
 * A side is `new:<difficulty>` (current bot, trained default params), `hand:<difficulty>` (current bot,
 * hand-tuned params) or `legacy:<difficulty>` (frozen pre-training bot). Each seed is played twice with seats
 * mirrored. Prints per-game lines and a summary (win share, decisive games, ms/tick).
 */
import os from 'node:os';
import { DEFAULT_PARAMS, HAND_PARAMS } from '../src/sim/bots/params';
import type { Difficulty } from '../src/sim/types';
import { headToHead } from './train/generation';
import { Pool } from './train/pool';
import type { SeatSpec } from './train/runMatch';

const args = process.argv.slice(2);
const get = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1]; };
function side(s: string): SeatSpec {
  const [kind, d] = s.split(':');
  const difficulty = d as Difficulty;
  if (!['easy', 'medium', 'hard', 'pro'].includes(difficulty)) throw new Error(`bad difficulty in ${s}`);
  if (kind === 'legacy') return { kind: 'legacy', difficulty };
  if (kind === 'new') return { kind: 'new', params: DEFAULT_PARAMS, difficulty };
  if (kind === 'hand') return { kind: 'new', params: HAND_PARAMS, difficulty };
  throw new Error(`bad side ${s} (new|hand|legacy:difficulty)`);
}
const a = get('a', 'new:hard'), b = get('b', 'legacy:hard');
const players = Number(get('players', '2'));
const nSeeds = Number(get('seeds', '10'));
const first = Number(get('first-seed', '1'));
const maxSec = Number(get('max-sec', String(25 * 60)));
const pool = new Pool(Number(get('workers', String(Math.min(4, Math.max(1, os.cpus().length - 2))))));
const t0 = Date.now();
try {
  const seeds = Array.from({ length: nSeeds }, (_, i) => first + i);
  const h = await headToHead(side(a), side(b), seeds, players, maxSec, pool.run);
  h.results.forEach((r, k) => {
    const flip = k % 2;
    const winSide = r.winner === null ? 'draw' : ((r.winner - 1 + flip) % 2 === 0 ? a : b);
    console.log(`seed ${r.seed}${flip ? ' (mirrored)' : ''}: ${winSide} at ${(r.time / 60).toFixed(1)} min · kills ${r.seats.reduce((n, s) => n + s.kills, 0)} · seals ${r.seats.reduce((n, s) => n + s.seals, 0)} · ${r.msPerTick.toFixed(2)} ms/tick`);
  });
  const decisive = h.results.filter((r) => r.decisive).length;
  const ms = h.results.reduce((n, r) => n + r.msPerTick, 0) / h.results.length;
  console.log(`${a} vs ${b} (${players} players, ${h.results.length} games): ${a} win share ${(100 * h.share).toFixed(0)}% ± ${(100 * h.ci95).toFixed(0)} (95% CI) · fitness ${h.fitA.toFixed(3)} vs ${h.fitB.toFixed(3)} · decisive before sudden death ${decisive}/${h.results.length} · ${ms.toFixed(2)} ms/tick · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} finally {
  await pool.close();
}
