import { Bot } from '../bots/bot';
import { Match, type MatchOptions } from '../match';
import type { MatchSetup } from '../matchApi';
import type { Difficulty, Snapshot } from '../types';
import type { Replay, ReplayFooter, ReplayHeader } from './format';
import { Recorder } from './recorder';
import { ReplayRunner } from './runner';

export type HeadlessOpts = {
  /** Bot factory (trainer params); record what it was in `bots` so the replay can be re-run. */
  makeBot?: MatchOptions['makeBot'];
  bots?: Record<number, unknown>;
  tags?: Record<string, unknown>;
  build?: string;
  /** Called with every snapshot (the trainer's own scoring). */
  onSnapshot?: (s: Snapshot) => void;
};

export type HeadlessResult = { bytes: Uint8Array; header: ReplayHeader; footer: ReplayFooter; last: Snapshot };

/**
 * Self-play/training: run one bot match headless (no rendering, no network) and record it as a replay.
 * Ends at a winner or after maxTicks. The match's native memory is freed.
 */
export async function recordHeadlessMatch(setup: MatchSetup, seed: number, maxTicks: number, opts: HeadlessOpts = {}): Promise<HeadlessResult> {
  const s = { ...setup, seed };
  const m = await Match.create(s, opts.makeBot ? { makeBot: opts.makeBot } : undefined);
  try {
    const rec = new Recorder(m, { setup: s, kind: 'selfplay', localId: 0, build: opts.build, bots: opts.bots, tags: opts.tags });
    let last = rec.tick(new Map());
    opts.onSnapshot?.(last);
    while (rec.tickCount < maxTicks && last.winner === null) {
      last = rec.tick(new Map());
      opts.onSnapshot?.(last);
    }
    const { bytes, header, footer } = await rec.finish();
    return { bytes, header, footer, last };
  } finally {
    m.dispose();
  }
}

/**
 * Scenario start for training: re-run `replay` up to `tick` (with the bots that recorded it), then hand
 * every seat that's still in the game to `makeBot` (the trainer's bots). Returns the live match; the
 * caller ticks it and must dispose() it.
 */
export async function matchFromReplay(replay: Replay, tick: number, makeBot: NonNullable<MatchOptions['makeBot']>,
  opts: { recordedBots?: MatchOptions['makeBot']; difficulty?: Difficulty } = {}): Promise<Match> {
  let factory: NonNullable<MatchOptions['makeBot']> | undefined = opts.recordedBots;
  const runner = await ReplayRunner.create(replay, {
    checkpointEvery: 0,
    // Until the hand-over, bots come from the recorded factory (the game's own bots if none given).
    makeBot: (id, d, rng) => (factory ? factory(id, d, rng) : makeDefault(id, d, rng)),
  });
  runner.seek(tick);
  factory = makeBot;
  const snap = runner.last;
  for (const p of snap?.players ?? []) {
    if (p.eliminated) continue;
    runner.match.setBot(p.id, opts.difficulty ?? replay.header.players.find((x) => x.id === p.id)?.difficulty ?? 'pro');
  }
  return runner.match;
}

const makeDefault: NonNullable<MatchOptions['makeBot']> = (id, d, rng) => new Bot(id, d, rng);
