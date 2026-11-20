import { describe, test } from 'vitest';
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
import { LIFECYCLE } from '../../src/sim/constants';
import { Bot } from '../../src/sim/bots/bot';
import { Match } from '../../src/sim/match';
import type { Difficulty, Snapshot } from '../../src/sim/types';

// Long-running measurements, off by default: MEASURE=1 npx vitest run tests/sim/proMeasure.test.ts
const LIMIT = 25 * 60 * 30;

type Result = {
  winner: number | null; minutes: number; kills: number; seals: number; elims: number; preSdElims: number;
  msPerTick: number; diffs: Difficulty[]; killsBy: Map<number, number>; insideIdle: number;
  /** Pieces placed per bot (scaffolds counted apart), and each bot's archetype. */
  built: Map<number, { pieces: number; scaffolds: number; archetype: string }>;
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
    for (const e of snap.events) {
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
  return { winner: snap.winner, minutes: snap.time / 60, kills, seals, elims, preSdElims, msPerTick: ms / snap.tick, diffs, killsBy, insideIdle: 0, built };
}

const fmt = (r: Result) =>
  `winner ${r.winner === null ? 'none' : `#${r.winner} (${r.diffs[r.winner - 1]})`} at ${r.minutes.toFixed(1)} min · kills ${r.kills} · seals ${r.seals} · elims ${r.elims} (${r.preSdElims} pre-SD) · ${r.msPerTick.toFixed(2)} ms/tick`;

describe.runIf(env.MEASURE)('measure', () => {
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
