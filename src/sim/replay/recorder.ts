import type { Match } from '../match';
import type { MatchSetup } from '../matchApi';
import type { MoveCmd } from '../movement';
import { NO_INPUT, type PlayerInput, type PlayerState, type Snapshot } from '../types';
import { encodeReplay, TickWriter } from './codec';
import { HASH_EVERY, REPLAY_FORMAT, withoutChat, type LogEvent, type RecordingLink, type ReplayHeader, type ReplayKind, type ReplayOp, type SecondSummary, type TickInput } from './format';
import { stateHash } from './hash';

export type RecorderOpts = {
  setup: MatchSetup;
  kind: ReplayKind;
  /** This machine's player (0 = none). */
  localId: number;
  build?: string;
  id?: string;
  recordedAt?: number;
  bots?: Record<number, unknown>;
  tags?: Record<string, unknown>;
  /** A later segment of a migrated match (see ReplayHeader.matchId); default: a new match, segment 0. */
  matchId?: string;
  segment?: number;
};

/** Sim events kept in the replay's event log (the per-shot/per-piece-hit chatter is left out). */
const LOGGED = new Set(['kill', 'hit', 'sealed', 'unsealed', 'eliminated', 'win', 'suddenDeath', 'trapped', 'escaped', 'placed', 'destroyed', 'explosion']);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

const randomId = () => {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/**
 * Records one match as it runs: every tick goes through `tick()` (which calls Match.tick with exactly the
 * inputs it records), anything else done to the match between ticks through `op()`. `finish()` encodes it.
 */
export class Recorder {
  private ticks = new TickWriter();
  private ops: { tick: number; op: ReplayOp }[] = [];
  private hashes: number[] = [];
  private events: LogEvent[] = [];
  private seconds: SecondSummary[] = [];
  private header: ReplayHeader;
  private last: Snapshot | null = null;
  /** A preview was recorded since the last tick (later ones can't change anything: see ReplayOp). */
  private previewed = false;
  private checkpoint: Uint8Array | null = null;

  /**
   * `match` must be fresh from Match.create(opts.setup), or use fromCheckpoint. Nothing may be done to
   * it before the recorder is made (ops after that go through op()).
   */
  constructor(private match: Match, opts: RecorderOpts) {
    const id = opts.id ?? randomId();
    this.header = {
      format: REPLAY_FORMAT,
      id,
      matchId: opts.matchId ?? id,
      segment: opts.segment ?? 0,
      startTick: match.tickCount,
      kind: opts.kind,
      recordedAt: opts.recordedAt ?? Date.now(),
      build: opts.build ?? 'dev',
      setup: { ...structuredClone(opts.setup), seed: opts.setup.seed ?? 1 },
      localId: opts.localId,
      players: [],
      map: structuredClone(match.map),
      ...(opts.bots ? { bots: opts.bots } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
    };
  }

  /**
   * Record a match restored from a checkpoint (host migration): `checkpoint` is the raw saveMatch bytes
   * `match` was just loaded from (net/matchCheckpoint.ts loadMatch), nothing done to it since. The replay
   * starts from those bytes; opts.setup is the original match's (segment 0's) setup.
   */
  static fromCheckpoint(match: Match, checkpoint: Uint8Array, opts: RecorderOpts): Recorder {
    if (!checkpoint.length) throw new Error('Recorder.fromCheckpoint: empty checkpoint');
    const r = new Recorder(match, opts);
    if (r.header.startTick === 0) throw new Error('Recorder.fromCheckpoint: the match has not ticked yet (record it from its setup instead)');
    r.checkpoint = checkpoint;
    return r;
  }

  get id() { return this.header.id; }
  /** What a host taking this match over needs to record the next segment of it. */
  get link(): RecordingLink { return { matchId: this.header.matchId, segment: this.header.segment, setup: this.header.setup }; }
  get tickCount() { return this.ticks.count; }
  /** Bytes of input data so far (uncompressed). */
  get inputBytes() { return this.ticks.size; }

  /** Run one tick of the match, recording exactly what it was given. */
  tick(inputs: Map<number, PlayerInput>, moves?: Map<number, MoveCmd[]>): Snapshot {
    const ids = new Set<number>(inputs.keys());
    if (moves) for (const id of moves.keys()) ids.add(id);
    const entries: TickInput[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const input = inputs.get(id);
      const m = moves?.get(id);
      // An id with moves but no input moves from NO_INPUT in the sim; an absent input replays the same way.
      entries.push(m ? { id, input: input ?? NO_INPUT, moves: m } : { id, input: input ?? NO_INPUT });
    }
    this.ticks.push(entries);
    this.previewed = false;
    const snap = this.match.tick(inputs, moves);
    this.observe(snap);
    return snap;
  }

  /** Something done to the match between ticks (after it was done). */
  op(op: ReplayOp) {
    if (op.k === 'preview') {
      if (this.previewed) return;
      this.previewed = true;
    }
    this.ops.push({ tick: this.ticks.count, op: structuredClone(op) });
  }

  private observe(snap: Snapshot) {
    if (!this.header.players.length)
      this.header.players = snap.players.map((p) => {
        const seat = this.header.setup.players[p.id - 1];
        return { id: p.id, name: p.name, isBot: p.isBot, ...(seat?.difficulty ? { difficulty: seat.difficulty } : {}), island: p.island };
      });
    const prev = this.last;
    this.last = snap;
    const byId = new Map(snap.players.map((p) => [p.id, p]));
    for (const e of snap.events) {
      if (!LOGGED.has(e.type)) continue;
      const d: Record<string, unknown> = { ...e.data };
      if (e.type === 'hit') {
        const a = typeof d.by === 'number' ? byId.get(d.by) : undefined, b = byId.get(d.target as number);
        if (a && b) d.dist = r2(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z));
        if (typeof d.amount === 'number') d.amount = r2(d.amount);
        if (typeof d.shieldAmount === 'number') d.shieldAmount = r2(d.shieldAmount);
      } else if (e.type === 'placed') {
        const pc = snap.pieces.find((x) => x.id === d.piece);
        if (pc) { d.pos = { x: r2(pc.pos.x), y: r2(pc.pos.y), z: r2(pc.pos.z) }; d.rotY = r2(pc.rotY); }
      }
      this.events.push([snap.tick, e.type, d]);
    }
    if (prev) for (const p of snap.players) {
      const q = prev.players.find((x) => x.id === p.id);
      const item = q && boughtItem(q, p, prev, snap);
      if (item) this.events.push([snap.tick, 'bought', { by: p.id, item, cost: q!.inv.cash - p.inv.cash }]);
    }
    if (snap.tick % HASH_EVERY === 0) {
      this.hashes.push(stateHash(snap));
      this.seconds.push(summarize(snap));
    }
  }

  /** The finished replay, encoded. `unfinished`: stopped before a result. */
  async finish(): Promise<{ bytes: Uint8Array; header: ReplayHeader; footer: { ticks: number; duration: number; winner: number | null; unfinished: boolean } }> {
    const last = this.last;
    const footer = {
      ticks: this.ticks.count,
      duration: last?.time ?? 0,
      winner: last?.winner ?? null,
      unfinished: last?.winner == null,
    };
    const { header, events } = withoutChat({ header: this.header, events: this.events });
    const bytes = await encodeReplay({ header, footer, ticks: this.ticks, ops: this.ops, hashes: this.hashes, events, seconds: this.seconds, checkpoint: this.checkpoint });
    return { bytes, header, footer };
  }
}

function summarize(s: Snapshot): SecondSummary {
  return {
    t: r2(s.time),
    tick: s.tick,
    p: s.players.map((p) => [p.id, r1(p.pos.x), r1(p.pos.y), r1(p.pos.z), Math.round(p.hp), Math.round(p.shield), p.alive ? 1 : 0,
      p.inv.cash, p.kills, p.deaths, p.equipped, p.ads ? 1 : 0, p.eliminated ? 1 : 0]),
    pieces: s.pieces.length,
    sealed: s.sealed.map((x) => (x ? 1 : 0)),
    waterY: r2(s.waterY),
  };
}

/** What a player bought this tick, read off the inventory change (cash down, something gained), else null. */
export function boughtItem(before: PlayerState, after: PlayerState, prevSnap: Snapshot, snap: Snapshot): string | null {
  if (!before.alive || !after.alive || after.inv.cash >= before.inv.cash) return null;
  if (after.vault.cash > before.vault.cash) return null; // a deposit
  const a = after.inv, b = before.inv;
  const newLock = after.locked.find((g) => !before.locked.includes(g));
  if (newLock) return `lock:${newLock}`;
  if ((snap.genLevels[after.island] ?? 1) > (prevSnap.genLevels[after.island] ?? 1)) return 'genUpgrade';
  for (const g of Object.keys(a.weapons) as (keyof typeof a.weapons)[]) if (!b.weapons[g]) return g;
  for (const k of Object.keys(a.pieces) as (keyof typeof a.pieces)[]) if ((a.pieces[k] ?? 0) > (b.pieces[k] ?? 0)) return k;
  for (const k of Object.keys(a.potions) as (keyof typeof a.potions)[]) if ((a.potions[k] ?? 0) > (b.potions[k] ?? 0)) return k;
  if (a.grenades > b.grenades) return 'grenade';
  if (a.charges > b.charges) return 'charge';
  if (a.medkits > b.medkits) return 'medkit';
  if (a.traps > b.traps) return 'trap';
  for (const g of Object.keys(a.weapons) as (keyof typeof a.weapons)[]) if ((a.weapons[g]?.spare ?? 0) > (b.weapons[g]?.spare ?? 0)) return 'ammo';
  return null;
}
