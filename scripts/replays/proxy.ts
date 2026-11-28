/// <reference types="node" />
/**
 * Human-proxy benchmark: "situations where a bot lost to a human" (mineScenarios) re-simulated with other bot params.
 * We can't play the user, so each mined moment is replayed exactly (recorded inputs, bots on PRE_STRENGTH_PARAMS: the
 * pre-2026-11-28 behaviour) up to its start, then forked and played on with:
 *   - the replay's bot seats handed to fresh bots of one tier (hard / pro) on the params under test ('before' =
 *     PRE_STRENGTH_PARAMS, 'after' = DEFAULT_BOT_PARAMS), keeping each seat's personality;
 *   - the human seat either a fixed human-style bot ('proxy': PRO, Sniper preset, PRE_STRENGTH_PARAMS, same for every
 *     variant), or the human's own recorded inputs ('ghost': open loop, so it overstates any change: a reference only).
 * The scenario's bot wins unless, within the window (start → decisive moment + slack), the human kills it, seals its
 * bunker or eliminates it. Bot-win share before vs after is the stand-in for "Hard beats the user".
 *
 *   npx tsx scripts/replays/proxy.ts <replay files/dirs>... [--out proxy.json] [--slack 30]
 *
 * Replays that don't re-run exactly on this code up to a scenario's start are reported and skipped.
 */
import fs from 'node:fs';
import { loadReplays, mineScenarios, type Scenario } from './extract';
import { Bot } from '../../src/sim/bots/bot';
import { DEFAULT_BOT_PARAMS, PRE_STRENGTH_PARAMS, type BotParams } from '../../src/sim/bots/params';
import { preset, type Personality } from '../../src/sim/bots/personality';
import { TICK_HZ } from '../../src/sim/constants';
import type { Match } from '../../src/sim/match';
import { ReplayRunner } from '../../src/sim/replay/runner';
import { mulberry32 } from '../../src/sim/rng';
import type { MoveCmd } from '../../src/sim/movement';
import type { Difficulty, PlayerInput } from '../../src/sim/types';

type Variant = 'before' | 'after';
type Mode = 'proxy' | 'ghost';
type Outcome = { botWon: boolean; how: string | null; botKilledHuman: boolean };
export type ScenarioResult = { replay: string; kind: Scenario['kind']; startTick: number; eventTick: number; bot: number; human: number; runs: Record<string, Outcome> };

const VARIANTS: Record<Variant, BotParams> = { before: PRE_STRENGTH_PARAMS, after: DEFAULT_BOT_PARAMS };
const TIERS: Difficulty[] = ['hard', 'pro'];
const MODES: Mode[] = ['proxy', 'ghost'];

type Internals = { bots: Map<number, { personality?: Personality }>; makeBot?: (id: number, d: Difficulty, rng: () => number) => unknown };

/** Fork the runner's match at the scenario start and hand the seats over as described above. */
function forkFor(runner: ReplayRunner, sc: Scenario, tier: Difficulty, P: BotParams, mode: Mode): Match {
  const m = runner.match.fork();
  const mi = m as unknown as Internals;
  const snap = runner.last;
  for (const p of snap?.players ?? []) {
    if (p.eliminated) continue;
    if (p.id === sc.human) {
      if (mode === 'ghost') continue;
      mi.makeBot = (id, _d, rng) => new Bot(id, 'pro', rng, preset('Sniper'), PRE_STRENGTH_PARAMS);
      m.setBot(p.id, 'pro');
    } else if (p.isBot) {
      const personality = mi.bots.get(p.id)?.personality;
      mi.makeBot = (id, _d, rng) => new Bot(id, tier, rng, personality, P);
      m.setBot(p.id, tier);
    }
  }
  return m;
}

function play(runner: ReplayRunner, m: Match, sc: Scenario, mode: Mode, slackTicks: number): Outcome {
  const end = Math.min(sc.eventTick - sc.startTick + slackTicks, mode === 'ghost' ? runner.length - runner.tick : Infinity);
  let botKilledHuman = false;
  try {
    for (let k = 0; k < end; k++) {
      const inputs = new Map<number, PlayerInput>();
      let moves: Map<number, MoveCmd[]> | undefined;
      if (mode === 'ghost') for (const e of runner.replay.ticks[runner.tick + k] ?? []) {
        if (e.id !== sc.human) continue;
        inputs.set(e.id, e.input);
        if (e.moves) (moves ??= new Map()).set(e.id, e.moves);
      }
      const snap = m.tick(inputs, moves);
      for (const e of snap.events) {
        const d = e.data;
        if (e.type === 'kill' && d.victim === sc.bot && d.killer === sc.human) return { botWon: false, how: 'killed', botKilledHuman };
        if (e.type === 'kill' && d.victim === sc.human && d.killer === sc.bot) botKilledHuman = true;
        if (e.type === 'sealed' && d.owner === sc.bot && d.by === sc.human) return { botWon: false, how: 'sealed', botKilledHuman };
        if (e.type === 'eliminated' && d.player === sc.bot) return { botWon: false, how: 'eliminated', botKilledHuman };
      }
      if (snap.winner === sc.human) return { botWon: false, how: 'won', botKilledHuman };
    }
    return { botWon: true, how: null, botKilledHuman };
  } finally {
    m.dispose();
  }
}

export async function runProxy(paths: string[], slackSec = 30, log: (s: string) => void = console.log): Promise<{ results: ScenarioResult[]; skipped: string[] }> {
  const replays = await loadReplays(paths);
  const results: ScenarioResult[] = [], skipped: string[] = [];
  for (const lr of replays) {
    const scs = mineScenarios([lr], { killLookback: 10, sealLookback: 25 }).sort((a, b) => a.startTick - b.startTick);
    if (!scs.length) continue;
    const short = lr.file.split('/').pop()!;
    const warn = console.warn;
    console.warn = () => {}; // the runner warns once on divergence; we report it ourselves
    const runner = await ReplayRunner.create(lr.replay, { checkpointEvery: 0, makeBot: (id, d, rng) => new Bot(id, d, rng, undefined, PRE_STRENGTH_PARAMS) });
    try {
      for (const sc of scs) {
        const at = sc.startTick - lr.replay.header.startTick;
        if (at < runner.tick) continue; // overlapping windows: keep the first
        runner.seek(at);
        if (runner.divergedAt !== null) { skipped.push(`${short}: diverged at tick ${runner.divergedAt}; ${scs.length - results.filter((r) => r.replay === short).length} scenarios skipped`); break; }
        const r: ScenarioResult = { replay: short, kind: sc.kind, startTick: sc.startTick, eventTick: sc.eventTick, bot: sc.bot, human: sc.human, runs: {} };
        for (const tier of TIERS) for (const v of Object.keys(VARIANTS) as Variant[]) for (const mode of MODES)
          r.runs[`${tier}/${v}/${mode}`] = play(runner, forkFor(runner, sc, tier, VARIANTS[v], mode), sc, mode, Math.round(slackSec * TICK_HZ));
        results.push(r);
        log(`${short} ${sc.kind} @${(sc.startTick / TICK_HZ).toFixed(0)}s bot ${sc.bot}: ${Object.entries(r.runs).map(([k, o]) => `${k}=${o.botWon ? 'W' : 'L'}`).join(' ')}`);
      }
    } finally {
      runner.dispose();
      console.warn = warn;
    }
  }
  return { results, skipped };
}

/** Bot-win share per tier/variant/mode with a 95% CI (normal approximation). */
export function summarizeProxy(results: ScenarioResult[]): Record<string, { won: number; n: number; share: number; ci95: number }> {
  const out: Record<string, { won: number; n: number; share: number; ci95: number }> = {};
  for (const r of results) for (const [k, o] of Object.entries(r.runs)) {
    const s = (out[k] ??= { won: 0, n: 0, share: 0, ci95: 0 });
    s.n++; if (o.botWon) s.won++;
  }
  for (const s of Object.values(out)) { s.share = s.won / s.n; s.ci95 = 1.96 * Math.sqrt(s.share * (1 - s.share) / s.n); }
  return out;
}

if (process.argv[1]?.endsWith('proxy.ts')) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const paths = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!paths.length) throw new Error('usage: npx tsx scripts/replays/proxy.ts <replays>... [--out proxy.json] [--slack 30]');
  const { results, skipped } = await runProxy(paths, Number(opt('slack') ?? 30));
  const sum = summarizeProxy(results);
  for (const s of skipped) console.log('skipped:', s);
  console.log('| tier/variant/mode | bot wins | share | 95% CI |\n|---|---|---|---|');
  for (const [k, s] of Object.entries(sum).sort()) console.log(`| ${k} | ${s.won}/${s.n} | ${(s.share * 100).toFixed(0)}% | ±${(s.ci95 * 100).toFixed(0)} |`);
  if (opt('out')) fs.writeFileSync(opt('out')!, JSON.stringify({ results, skipped, summary: sum }, null, 2));
}
