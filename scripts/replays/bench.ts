/// <reference types="node" />
/**
 * Human-proxy benchmarks on the user's replays (local only: the replays are private). Both rebuild recorded moments
 * with reconstruct.ts, so they work on replays from any build.
 *
 *   agree      Live macro agreement (spec §4.1 metric 3): at each usable user window, a bot takes the user's seat
 *              for 5 s; its macro (macros.ts rules on what it did) is compared with what the user did. Seats:
 *              userproxy (tree fit WITHOUT that replay: leave-one-replay-out), hard, pro. Others: recorded tiers.
 *   scenarios  Mined-scenario reversal (spec §7.1): every usable "a bot lost to the user" moment (mineScenarios) is
 *              rebuilt at its start with the bots on one tier (hard / pro) and the user's seat on UserProxy; the bot
 *              wins unless, before the decisive moment + slack, UserProxy kills it, seals its bunker or it is out.
 *
 *   npx tsx scripts/replays/bench.ts agree|scenarios [<replays>...] [--every N] [--slack 30] [--model path] [--out f.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bot } from '../../src/sim/bots/bot';
import { goalBiasFor, isUserProxyModel, proxyPersonality, type UserProxyModel } from '../../src/sim/bots/userProxy';
import { TICK_HZ } from '../../src/sim/constants';
import type { MatchOptions } from '../../src/sim/match';
import type { LogEvent, Replay, SecondSummary } from '../../src/sim/replay/format';
import type { Difficulty, Snapshot } from '../../src/sim/types';
import { loadReplays, mineScenarios, type LoadedReplay } from './extract';
import { labelAll, labelReplay, userReplayFiles, WINDOW_SEC, type Moment } from './macros';
import { fidelity, reconstruct } from './reconstruct';
import { buildModel, LOCAL_DIR } from './userproxy';

type Factory = NonNullable<MatchOptions['makeBot']>;

export function makeProxy(model: UserProxyModel): (id: number, rng: () => number) => Bot {
  return (id, rng) => {
    const b = new Bot(id, model.difficulty, rng, proxyPersonality(model));
    b.goalBias = goalBiasFor(model) as Bot['goalBias'];
    return b;
  };
}

export function loadModel(file = path.join(LOCAL_DIR, 'userproxy.json')): UserProxyModel {
  const raw = process.env.USERPROXY_MODEL ?? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  if (!raw) throw new Error(`no UserProxy model: run scripts/replays/userproxy.ts (writes ${file}) or set USERPROXY_MODEL`);
  const m = JSON.parse(raw);
  if (!isUserProxyModel(m)) throw new Error('UserProxy model is malformed');
  return m;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const row = (p: Snapshot['players'][number]) => [p.id, r1(p.pos.x), r1(p.pos.y), r1(p.pos.z), Math.round(p.hp), Math.round(p.shield), p.alive ? 1 : 0,
  p.inv.cash, p.kills, p.deaths, p.equipped, p.ads ? 1 : 0, p.eliminated ? 1 : 0];
const summary = (s: Snapshot, tick: number): SecondSummary => ({ t: Math.round(tick / TICK_HZ), tick, p: s.players.map(row), pieces: s.pieces.length, sealed: s.sealed.map((x) => (x ? 1 : 0)), waterY: 0 });

/** Run `m` for WINDOW_SEC and label `seat`'s macro with the same rules as the recordings (a mini replay: 5 copies of the start, then the run). */
function labelLive(r: Replay, match: import('../../src/sim/match').Match, start: SecondSummary, first: Snapshot, seat: number): Moment | null {
  const seconds: SecondSummary[] = [];
  for (let k = 0; k < WINDOW_SEC; k++) seconds.push({ ...start, t: k, tick: k * TICK_HZ });
  const base = WINDOW_SEC * TICK_HZ;
  seconds.push(summary(first, base));
  const events: LogEvent[] = [];
  const log = (s: Snapshot, tick: number) => {
    for (const e of s.events) {
      const d: Record<string, unknown> = { ...e.data };
      if (e.type === 'placed') { const pc = s.pieces.find((x) => x.id === d.piece); if (pc) { d.pos = { ...pc.pos }; d.rotY = pc.rotY; } }
      events.push([tick, e.type, d]);
    }
  };
  // first's events are the rebuild's own (seals re-detected from the placed pieces): not something the seat did.
  for (let i = 1; i <= WINDOW_SEC * TICK_HZ; i++) {
    const s = match.tick(new Map());
    log(s, base + i);
    if (i % TICK_HZ === 0) seconds.push(summary(s, base + i));
  }
  seconds.push({ ...seconds[seconds.length - 1], t: seconds.length, tick: seconds.length * TICK_HZ }); // labelReplay wants one more second
  const mini: Replay = { ...r, seconds, events, ticks: [], ops: [], hashes: [] };
  return labelReplay('live', mini).find((m) => m.player === seat && m.tick === base) ?? null;
}

export async function agree(reps: LoadedReplay[], every = 1, log = console.log) {
  const user = labelAll(reps, { humansOnly: true });
  const seats = ['userproxy', 'hard', 'pro'] as const;
  const res: Record<string, { hit: number; n: number }> = Object.fromEntries(seats.map((s) => [s, { hit: 0, n: 0 }]));
  const conf: Record<string, Record<string, number>> = Object.fromEntries(seats.map((s) => [s, {}]));
  let usable = 0, skipped = 0;
  for (const { file, replay: r } of reps) {
    const mine = user.filter((m) => m.replay === path.basename(file));
    if (!mine.length) continue;
    const model = buildModel(user.filter((m) => m.replay !== path.basename(file)), { depth: 3, leaf: 8, bias: loadModelBias(), difficulty: loadModelDifficulty() });
    const proxy = makeProxy(model);
    for (let i = 0; i < mine.length; i += every) {
      const w = mine[i];
      for (const s of seats) {
        const tier = (p: Replay['header']['players'][number]) => (p.difficulty ?? 'hard') as Difficulty;
        const make: Factory = (id, d, rng) => (id === w.player ? (s === 'userproxy' ? proxy(id, rng) : new Bot(id, s, rng)) : new Bot(id, d, rng));
        const rb = await reconstruct(r, w.tick, make, tier);
        try {
          const first = rb.match.tick(new Map());
          if (!fidelity(first, rb.second).usable) { if (s === 'userproxy') skipped++; break; }
          if (s === 'userproxy') usable++;
          const got = labelLive(r, rb.match, rb.second, first, w.player);
          if (!got) continue;
          res[s].n++;
          if (got.y === w.y) res[s].hit++;
          const key = `${w.macro}>${got.macro}`;
          conf[s][key] = (conf[s][key] ?? 0) + 1;
        } finally { rb.match.dispose(); }
      }
    }
    log(`${path.basename(file)}: ${seats.map((s) => `${s} ${res[s].hit}/${res[s].n}`).join(' · ')}`);
  }
  return { usable, skipped, res, conf };
}

// The CV model in `agree` takes bias/difficulty from the saved model when present (else the fit defaults).
function savedModel(): UserProxyModel | null { try { return loadModel(); } catch { return null; } }
const loadModelBias = () => savedModel()?.bias ?? 0.4;
const loadModelDifficulty = () => savedModel()?.difficulty ?? 'hard';

export type ScenarioRun = { replay: string; kind: string; startTick: number; eventTick: number; bot: number; human: number; tier: Difficulty; botWon: boolean; how: string | null };

export async function scenarios(reps: LoadedReplay[], model: UserProxyModel, slackSec = 30, log = console.log): Promise<{ runs: ScenarioRun[]; unusable: number }> {
  const runs: ScenarioRun[] = [];
  let unusable = 0;
  const proxy = makeProxy(model);
  for (const lr of reps) {
    for (const sc of mineScenarios([lr], { killLookback: 10, sealLookback: 25 })) {
      for (const tier of ['hard', 'pro'] as Difficulty[]) {
        const make: Factory = (id, _d, rng) => (id === sc.human ? proxy(id, rng) : new Bot(id, tier, rng));
        const rb = await reconstruct(lr.replay, sc.startTick, make, () => tier);
        try {
          let snap = rb.match.tick(new Map());
          if (!fidelity(snap, rb.second).usable) { if (tier === 'hard') unusable++; break; }
          const end = sc.eventTick - rb.second.tick + Math.round(slackSec * TICK_HZ);
          snap = rb.match.tick(new Map()); // the first tick's events are the rebuild's own (seals re-detected)
          let how: string | null = null;
          for (let k = 0; k < end && !how; k++) {
            for (const e of snap.events) {
              const d = e.data;
              if (e.type === 'kill' && d.victim === sc.bot && d.killer === sc.human) how = 'killed';
              else if (e.type === 'sealed' && d.owner === sc.bot && d.by === sc.human) how = 'sealed';
              else if (e.type === 'eliminated' && d.player === sc.bot) how = 'eliminated';
            }
            if (!how && snap.winner === sc.human) how = 'won';
            if (!how) snap = rb.match.tick(new Map());
          }
          runs.push({ replay: path.basename(lr.file), kind: sc.kind, startTick: sc.startTick, eventTick: sc.eventTick, bot: sc.bot, human: sc.human, tier, botWon: !how, how });
        } finally { rb.match.dispose(); }
      }
      const last = runs.slice(-2);
      if (last.length) log(`${path.basename(lr.file)} ${sc.kind} @${Math.round(sc.startTick / TICK_HZ)}s bot ${sc.bot}: ${last.map((x) => `${x.tier} ${x.botWon ? 'W' : `L(${x.how})`}`).join(' ')}`);
    }
  }
  return { runs, unusable };
}

/** Wilson score interval (95%). */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pc = (x: number) => `${(100 * x).toFixed(1)}%`;

async function main(argv: string[]) {
  const cmd = argv[0];
  const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const files = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const reps = await loadReplays(files.length ? files : userReplayFiles());
  let out: unknown;
  if (cmd === 'agree') {
    const r = await agree(reps, Number(opt('every', '1')));
    console.log(`usable windows ${r.usable} (skipped ${r.skipped})`);
    console.log('| seat in the user\'s place | top-1 macro agreement with the user | 95% CI | windows |\n|---|---|---|---|');
    for (const [s, v] of Object.entries(r.res)) { const [lo, hi] = wilson(v.hit, v.n); console.log(`| ${s} | ${pc(v.hit / Math.max(1, v.n))} | ${pc(lo)}–${pc(hi)} | ${v.n} |`); }
    for (const [s, c] of Object.entries(r.conf)) console.log(`${s} top confusions: ${Object.entries(c).filter(([k]) => k.split('>')[0] !== k.split('>')[1]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    out = r;
  } else if (cmd === 'scenarios') {
    const r = await scenarios(reps, loadModel(opt('model', path.join(LOCAL_DIR, 'userproxy.json'))), Number(opt('slack', '30')));
    console.log(`usable scenarios ${r.runs.length / 2} (unusable ${r.unusable})`);
    console.log('| bots | bot wins vs UserProxy (mined scenarios) | 95% CI (Wilson) | n |\n|---|---|---|---|');
    for (const tier of ['hard', 'pro']) { const xs = r.runs.filter((x) => x.tier === tier), k = xs.filter((x) => x.botWon).length; const [lo, hi] = wilson(k, xs.length); console.log(`| ${tier} | ${pc(k / Math.max(1, xs.length))} | ${pc(lo)}–${pc(hi)} | ${xs.length} |`); }
    out = r;
  } else throw new Error('usage: bench.ts agree|scenarios [<replays>...] [--every N] [--slack 30] [--model path] [--out f.json]');
  const o = opt('out', '');
  if (o) fs.writeFileSync(o, JSON.stringify(out, null, 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
