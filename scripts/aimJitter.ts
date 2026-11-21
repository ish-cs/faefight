/**
 * Bot aim jitter probe: plays headless bot matches and measures how each bot's view (yaw/pitch) moves tick to tick.
 *
 *   npx tsx scripts/aimJitter.ts [seconds=180] [seeds=1,2] [players=pro,hard,medium,easy,pro,hard,medium,easy]
 *
 * Per tier (definitions in src/sim/bots/aimStats.ts): yaw reversals/s, fast flick-backs/s, jerks/s, p99 yaw
 * acceleration, p99 / max angular speed.
 */
import { Match } from '../src/sim/match';
import { DT } from '../src/sim/constants';
import { aimStats, type AimSample } from '../src/sim/bots/aimStats';
import type { Difficulty } from '../src/sim/types';

const secs = Number(process.argv[2] ?? 180);
const seeds = (process.argv[3] ?? '1,2').split(',').map(Number);
const diffs = (process.argv[4] ?? 'pro,hard,medium,easy,pro,hard,medium,easy').split(',') as Difficulty[];

const byTier = new Map<Difficulty, AimSample[][]>();
for (const seed of seeds) {
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  const tracks = new Map<number, AimSample[]>();
  let snap = m.tick(new Map());
  for (let i = 0; i < secs / DT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const p of snap.players) {
      let t = tracks.get(p.id);
      if (!t) tracks.set(p.id, (t = []));
      t.push({ yaw: p.yaw, pitch: p.pitch, alive: p.alive });
    }
  }
  for (const p of snap.players) {
    const d = diffs[p.id - 1];
    if (!byTier.has(d)) byTier.set(d, []);
    byTier.get(d)!.push(tracks.get(p.id) ?? []);
  }
}
const rows: string[] = ['| tier | reversals/s | flick-backs/s | jerks/s | p99 accel °/s² | p99 °/s | max °/s | alive s |', '|---|---|---|---|---|---|---|---|'];
for (const [d, tracks] of byTier) {
  const s = aimStats(tracks, DT);
  rows.push(`| ${d} | ${s.reversalsPerSec.toFixed(3)} | ${s.flickBacksPerSec.toFixed(3)} | ${s.spikesPerSec.toFixed(3)} | ${s.accelP99.toFixed(0)} | ${s.p99.toFixed(0)} | ${s.max.toFixed(0)} | ${s.aliveSec.toFixed(0)} |`);
}
console.log(rows.join('\n'));
