/**
 * Gaze probe: how players point their view (src/sim/bots/gazeStats.ts has the definitions).
 *
 *   npx tsx scripts/gazeStats.ts human <replay files/dirs...>     the humans in recorded matches (stays local: prints aggregates only)
 *   npx tsx scripts/gazeStats.ts bots [seconds=300] [seeds=1,2] [players=pro,hard,medium,easy,pro,hard,medium,easy]
 *
 * Humans: view and walk input per tick from the recording, positions from the per-second summaries (interpolated),
 * hits from the event log. Bots: headless matches, the same quantities per tick.
 */
import { Match } from '../src/sim/match';
import { Bot } from '../src/sim/bots/bot';
import { DT } from '../src/sim/constants';
import { gazeStats, type GazeSample, type GazeStats } from '../src/sim/bots/gazeStats';
import { yawOf } from '../src/sim/vec';
import type { Difficulty, PlayerInput } from '../src/sim/types';
import { loadReplays } from './replays/extract';

const moveRel = (i: PlayerInput) => (Math.hypot(i.moveX, i.moveZ) > 0.1 ? Math.atan2(i.moveX, i.moveZ) : null);
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
export function row(name: string, s: GazeStats): string {
  return `| ${name} | ${f(s.aliveSec / 60, 0)} | ${f(s.aligned * 100, 0)}% | ${f(s.alignedCalm * 100, 0)}% | ${f(s.scansPerMin, 1)} | ${f(s.onFoeCalm * 100, 0)}% | ${f(s.onFoeEngaged * 100, 0)}% | ${f(s.trackCalmSec)} | ${f(s.trackEngagedSec)} | ${f(s.stareWalk * 100, 0)}% | ${s.reactions} | ${f(s.reactMedianSec)} | ${f(s.reactWithin1s * 100, 0)}% | ${f(s.yawP50, 0)}/${f(s.yawP90, 0)}/${f(s.yawP99, 0)} | ${f(s.still * 100, 0)}% |`;
}
export const HEAD = '| who | alive min | walk∥view | calm walk∥view | glances/min | on-foe calm | on-foe engaged | calm look s | engaged look s | stare-walk calm | hits | face attacker s (med) | ≤1 s | yaw °/s p50/p90/p99 | still |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

async function humans(paths: string[]) {
  const tracks: GazeSample[][] = [];
  for (const { replay: r } of await loadReplays(paths)) {
    const human = r.header.players.filter((p) => !p.isBot).map((p) => p.id);
    // A seat handed to a bot (/spectate, disconnect) stops being the human from then on.
    const botFrom = new Map<number, number>();
    for (const { tick, op } of r.ops) if (op.k === 'setBot' && !botFrom.has(op.id)) botFrom.set(op.id, tick);
    const secs = r.seconds;
    // Position of player `id` at sim tick `tk`, interpolated between per-second summaries.
    const posAt = (id: number, tk: number) => {
      let lo = 0, hi = secs.length - 1;
      if (hi < 0 || tk < secs[0].tick || tk > secs[hi].tick) return null;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (secs[m].tick <= tk) lo = m; else hi = m; }
      const a = secs[lo].p.find((p) => p[0] === id), b = secs[hi].p.find((p) => p[0] === id);
      if (!a || !b || !a[6] || !b[6]) return null;
      const u = secs[hi].tick === secs[lo].tick ? 0 : (tk - secs[lo].tick) / (secs[hi].tick - secs[lo].tick);
      return { x: +a[1] + (+b[1] - +a[1]) * u, z: +a[3] + (+b[3] - +a[3]) * u };
    };
    const hits = new Map<number, Map<number, number>>(); // tick -> target -> by
    for (const [tk, type, d] of r.events) {
      if (type !== 'hit' || typeof d.by !== 'number') continue;
      if (!hits.has(tk)) hits.set(tk, new Map());
      hits.get(tk)!.set(d.target as number, d.by);
    }
    for (const id of human) {
      const tr: GazeSample[] = [];
      r.ticks.forEach((inputs, i) => {
        const tk = r.header.startTick + i + 1;
        if (tk >= (botFrom.get(id) ?? Infinity)) return;
        const inp = inputs.find((x) => x.id === id)?.input;
        const me = posAt(id, tk);
        if (!inp || !me) { tr.push({ alive: false, yaw: 0, moveRel: null, fire: false, foes: [], hitBy: null }); return; }
        const foes = r.header.players.filter((p) => p.id !== id).flatMap((p) => {
          const q = posAt(p.id, tk);
          return q ? [{ id: p.id, yaw: yawOf({ x: q.x - me.x, z: q.z - me.z }), dist: Math.hypot(q.x - me.x, q.z - me.z) }] : [];
        });
        tr.push({ alive: true, yaw: inp.yaw, moveRel: moveRel(inp), fire: inp.fire, foes, hitBy: hits.get(tk)?.get(id) ?? null });
      });
      tracks.push(tr);
    }
  }
  console.log(HEAD);
  console.log(row(`human (${tracks.length} matches)`, gazeStats(tracks, DT)));
}

async function bots(secs: number, seeds: number[], diffs: Difficulty[]) {
  const byTier = new Map<Difficulty, GazeSample[][]>();
  for (const seed of seeds) {
    const out = new Map<number, PlayerInput>();
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed }, {
      makeBot: (id, d, rng) => {
        const b = new Bot(id, d, rng);
        return { think: (v) => { const i = b.think(v); out.set(id, i); return i; }, get currentTarget() { return b.currentTarget; } };
      },
    });
    const tracks = new Map<number, GazeSample[]>(diffs.map((_, i) => [i + 1, []]));
    let snap = m.tick(new Map());
    for (let i = 0; i < secs / DT && snap.winner === null; i++) {
      out.clear();
      snap = m.tick(new Map());
      const hit = new Map<number, number>();
      for (const e of snap.events) if (e.type === 'hit' && typeof e.data.by === 'number') hit.set(e.data.target as number, e.data.by);
      for (const p of snap.players) {
        const inp = out.get(p.id);
        const alive = p.alive && !!inp;
        const foes = alive ? snap.players.filter((q) => q.id !== p.id && q.alive).map((q) => ({
          id: q.id, yaw: yawOf({ x: q.pos.x - p.pos.x, z: q.pos.z - p.pos.z }), dist: Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z),
        })) : [];
        tracks.get(p.id)!.push({ alive, yaw: p.yaw, moveRel: inp ? moveRel(inp) : null, fire: !!inp?.fire, foes, hitBy: hit.get(p.id) ?? null });
      }
    }
    m.dispose();
    for (const [id, tr] of tracks) {
      const d = diffs[id - 1];
      if (!byTier.has(d)) byTier.set(d, []);
      byTier.get(d)!.push(tr);
    }
  }
  console.log(HEAD);
  for (const d of ['pro', 'hard', 'medium', 'easy'] as Difficulty[]) if (byTier.has(d)) console.log(row(`bot ${d}`, gazeStats(byTier.get(d)!, DT)));
  console.log(row('bot all', gazeStats([...byTier.values()].flat(), DT)));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'human') await humans(rest);
else if (mode === 'bots') await bots(Number(rest[0] ?? 300), (rest[1] ?? '1,2').split(',').map(Number), (rest[2] ?? 'pro,hard,medium,easy,pro,hard,medium,easy').split(',') as Difficulty[]);
else { console.error('usage: gazeStats.ts human <files...> | bots [seconds] [seeds] [players]'); process.exit(2); }
