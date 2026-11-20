import { Match, type MatchOptions } from '../match';
import type { MoveCmd } from '../movement';
import type { PlayerInput, Snapshot } from '../types';
import { HASH_EVERY, type Replay, type ReplayOp } from './format';
import { stateHash } from './hash';

/** Do something recorded between ticks to a match (the inverse of Recorder.op). */
export function applyOp(m: Match, op: ReplayOp): void {
  switch (op.k) {
    case 'setBot': m.setBot(op.id, op.difficulty); break;
    case 'preview': m.previewBuild(op.id, op.req); break;
    case 'teleport': m.debugTeleport(op.id, op.pos); break;
    case 'hp': m.debugSetHp(op.id, op.hp); break;
    case 'shield': m.debugSetShield(op.id, op.shield); break;
    case 'potionShops': m.debugSetPotionShops(op.positions); break;
    case 'eliminate': m.debugEliminate(op.id); break;
    case 'kill': m.debugKill(op.id); break;
    case 'give': m.debugGive(op.id, op.inv); break;
    default: throw new Error(`applyOp: unknown op ${(op as { k: string }).k}`);
  }
}

export type RunnerOpts = {
  /** Bot factory (defaults to the game's bots; must match what recorded the replay to re-run it exactly). */
  makeBot?: MatchOptions['makeBot'];
  /** Keep a copy of the match every this many ticks for fast seeking (0 = never). Default 300 (10 s). */
  checkpointEvery?: number;
};

/**
 * Re-runs a replay: the recorded inputs and ops go into a fresh Match tick by tick. Seeking backwards
 * restarts from the nearest checkpoint (a Match.fork taken on the way) instead of from the start.
 * Recorded state hashes are checked as it goes: `divergedAt` is the first tick that didn't match
 * (different sim/bot code than the recording, or a determinism bug).
 */
export class ReplayRunner {
  /** Ticks run so far (0 = fresh match). */
  tick = 0;
  divergedAt: number | null = null;
  last: Snapshot | null = null;
  private opsAt = new Map<number, ReplayOp[]>();
  private checkpoints = new Map<number, Match>();
  private every: number;

  private constructor(readonly replay: Replay, public match: Match, opts: RunnerOpts) {
    this.every = opts.checkpointEvery ?? 300;
    for (const { tick, op } of replay.ops) {
      const list = this.opsAt.get(tick) ?? [];
      list.push(op);
      this.opsAt.set(tick, list);
    }
    if (this.every > 0) this.checkpoints.set(0, match.fork());
  }

  static async create(replay: Replay, opts: RunnerOpts = {}): Promise<ReplayRunner> {
    const m = await Match.create(replay.header.setup, opts.makeBot ? { makeBot: opts.makeBot } : undefined);
    return new ReplayRunner(replay, m, opts);
  }

  get length() { return this.replay.ticks.length; }
  get done() { return this.tick >= this.length; }

  /** Run the next recorded tick. Null at the end. */
  step(): Snapshot | null {
    if (this.done) return null;
    for (const op of this.opsAt.get(this.tick) ?? []) applyOp(this.match, op);
    const entries = this.replay.ticks[this.tick];
    const inputs = new Map<number, PlayerInput>();
    let moves: Map<number, MoveCmd[]> | undefined;
    for (const e of entries) {
      inputs.set(e.id, e.input);
      if (e.moves) (moves ??= new Map()).set(e.id, e.moves);
    }
    const snap = this.match.tick(inputs, moves);
    this.tick++;
    this.last = snap;
    if (snap.tick % HASH_EVERY === 0 && this.divergedAt === null) {
      const want = this.replay.hashes[snap.tick / HASH_EVERY - 1];
      if (want !== undefined && want !== stateHash(snap)) {
        this.divergedAt = snap.tick;
        console.warn(`[replay] diverged from the recording at tick ${snap.tick} (recorded on build ${this.replay.header.build})`);
      }
    }
    if (this.every > 0 && this.tick % this.every === 0 && !this.checkpoints.has(this.tick)) this.checkpoints.set(this.tick, this.match.fork());
    return snap;
  }

  /**
   * Go to tick `target` (clamped to the replay). Returns the snapshot after it (its events are that
   * tick's only), or null at tick 0. Same state as playing there from the start.
   */
  seek(target: number): Snapshot | null {
    target = Math.max(0, Math.min(this.length, Math.floor(target)));
    // Start at least one tick before the target, so there is a snapshot of it to show.
    let best = -1;
    for (const t of this.checkpoints.keys()) if ((t < target || t === 0) && t > best) best = t;
    if (target < this.tick || (target === this.tick && !this.last && target > 0) || best > this.tick) {
      if (best < 0) throw new Error('ReplayRunner.seek: no checkpoint to go back to (checkpointEvery = 0)');
      this.match.dispose();
      this.match = this.checkpoints.get(best)!.fork();
      this.tick = best;
      this.last = null;
    }
    while (this.tick < target) this.step();
    return this.last;
  }

  dispose() {
    this.match.dispose();
    for (const m of this.checkpoints.values()) m.dispose();
    this.checkpoints.clear();
  }
}
