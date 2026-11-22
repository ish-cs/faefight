/**
 * Bot movement jitter probe (single game, local): plays one headless bot match and reports, per bot, how often the
 * walk direction flips back and forth (moveStats.ts) and which movement layer was driving at each flip.
 *
 *   npx tsx scripts/moveJitter.ts [seconds=240] [seed=1] [players=pro,hard] [episodes=10]
 *
 * Multi-seed series run on CI (scripts/ci/measure.ts reports the same numbers per scenario).
 */
import { Match } from '../src/sim/match';
import { Bot } from '../src/sim/bots/bot';
import { DT } from '../src/sim/constants';
import { moveStats, type MoveSample } from '../src/sim/bots/moveStats';
import type { Difficulty } from '../src/sim/types';

const secs = Number(process.argv[2] ?? 240);
const seed = Number(process.argv[3] ?? 1);
const diffs = (process.argv[4] ?? 'pro,hard').split(',') as Difficulty[];
const showEp = Number(process.argv[5] ?? 10);

const bots: Bot[] = [];
const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
  { makeBot: (id, d, rng) => (bots[id - 1] = new Bot(id, d, rng)) });
const tracks = diffs.map(() => [] as MoveSample[]);
const srcs = diffs.map(() => [] as string[]);
const goals = diffs.map(() => [] as string[]);
let snap = m.tick(new Map());
for (let i = 0; i < secs / DT && snap.winner === null; i++) {
  snap = m.tick(new Map());
  for (const p of snap.players) {
    const b = bots[p.id - 1], d = p.alive ? b.moveDir : null;
    tracks[p.id - 1].push({ alive: p.alive, wx: d?.x ?? 0, wz: d?.z ?? 0, vx: p.vel.x, vz: p.vel.z, x: p.pos.x, z: p.pos.z });
    srcs[p.id - 1].push(b.moveSrc);
    goals[p.id - 1].push((b as unknown as { goal: string }).goal);
  }
}
const n = snap.time;
console.log(`seed ${seed}, ${diffs.join(',')}, ${n.toFixed(0)} s`);
const total = new Map<string, number>();
for (let k = 0; k < diffs.length; k++) {
  const s = moveStats(tracks[k], DT);
  const perMin = (x: number) => (x / Math.max(1, s.aliveSec / 60)).toFixed(1);
  const by = new Map<string, number>();
  for (const i of s.wishFlips) by.set(srcs[k][i], (by.get(srcs[k][i]) ?? 0) + 1);
  for (const [k2, v] of by) total.set(k2, (total.get(k2) ?? 0) + v);
  console.log(`bot ${k + 1} ${diffs[k]}: wish flips/min ${perMin(s.wishFlips.length)}, vel flips/min ${perMin(s.velFlips.length)}, ` +
    `episodes ${s.episodes.length}, osc ${s.oscSec.toFixed(1)} s of ${s.aliveSec.toFixed(0)} alive; flips by src ${[...by].sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a}:${b}`).join(' ')}`);
  for (const e of s.episodes.slice(0, showEp)) {
    const p = tracks[k][e.i0];
    console.log(`   ep t=${(e.i0 * DT).toFixed(1)}-${(e.i1 * DT).toFixed(1)} at (${p.x.toFixed(1)},${p.z.toFixed(1)}) goal ${goals[k][e.i0]} flips ${e.flips.length}: ${e.flips.map((i) => srcs[k][i]).join(' ')}`);
  }
}
console.log('flips by source (all bots):', [...total].sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a}:${b}`).join(' '));
