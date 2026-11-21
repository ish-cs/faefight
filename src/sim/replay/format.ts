import type { IslandLayout } from '../map';
import type { MatchSetup } from '../matchApi';
import type { MoveCmd } from '../movement';
import type { BuildRequest, Difficulty, Inventory, PieceKind, PlayerInput, Vec3 } from '../types';

/**
 * A recorded match: enough to re-run it exactly (setup + seed + what every human fed the sim each tick +
 * out-of-band operations), plus analytics that don't need a re-run (event log, per-second summaries).
 * Bots need nothing: they're seeded from the match rng and see only sim state.
 */
export const REPLAY_FORMAT = 2;
/** Formats this build decodes (1: no segments; read as segment 0 of its own match, starting at tick 0). */
export const READ_FORMATS: readonly number[] = [1, 2];
/** Ticks between state hashes and per-second summaries. */
export const HASH_EVERY = 30;

export type ReplayKind = 'solo' | 'host' | 'selfplay' | 'test';

export type ReplayHeader = {
  format: number;
  /** Unique id (also the storage key). */
  id: string;
  /**
   * The match this recording is part of. A host migration splits a match into segments, each recorded
   * (and uploaded) by the machine hosting it then; all share the matchId of segment 0 (= its id).
   */
  matchId: string;
  /** 0 = recorded from the start of the match; k > 0 = recorded by the k-th migration's new host. */
  segment: number;
  /**
   * Sim tick the recording starts after (0 = a fresh match from `setup`). > 0: the replay carries the
   * match checkpoint it starts from (Replay.checkpoint). Stitching: segment k supersedes the earlier
   * segments from its startTick on (the old host may have run a little past it before it left).
   */
  startTick: number;
  kind: ReplayKind;
  /** ms since epoch when recording started. */
  recordedAt: number;
  /** Code version that recorded it (replays only re-run exactly on the same sim + bot code). */
  build: string;
  /** Exactly what Match.create got, seed filled in (a later segment repeats segment 0's). */
  setup: MatchSetup & { seed: number };
  /** The recording machine's own player (0 = none, e.g. self-play). */
  localId: number;
  players: { id: number; name: string; isBot: boolean; difficulty?: Difficulty; island: number }[];
  /** The map as built for this match (islands, stations), for analytics without a re-run. */
  map: IslandLayout[];
  /** Opaque per-seat bot configuration (e.g. trained params) when not the default bot. */
  bots?: Record<number, unknown>;
  /** Free-form tags (trainer generation, etc.). */
  tags?: Record<string, unknown>;
};

export type ReplayFooter = {
  ticks: number;
  /** Sim time at the last recorded tick (s). */
  duration: number;
  winner: number | null;
  /** The recording stopped before a result (player left, tab closed, tick cap). */
  unfinished: boolean;
};

/** One human's input as Match.tick consumed it. moves: undefined = none passed (moves from `input`). */
export type TickInput = { id: number; input: PlayerInput; moves?: MoveCmd[] };

/** Things done to the match between ticks; replayed before tick `tick` (= ticks already run). */
export type ReplayOp =
  | { k: 'setBot'; id: number; difficulty: Difficulty }
  /** A botified seat handed back to its returning human (reconnect). */
  | { k: 'setHuman'; id: number }
  /** A build preview (it may sync the collision world, so it's part of the run). */
  | { k: 'preview'; id: number; req: BuildRequest }
  | { k: 'teleport'; id: number; pos: Vec3 }
  | { k: 'hp'; id: number; hp: number }
  | { k: 'shield'; id: number; shield: number }
  | { k: 'potionShops'; positions: Vec3[] }
  | { k: 'eliminate'; id: number }
  | { k: 'kill'; id: number }
  | { k: 'give'; id: number; inv: Partial<Inventory> }
  | { k: 'piece'; kind: PieceKind; pos: Vec3; rotY: number };

/**
 * Event log entry: [tick, type, data]. Types: kill, hit, sealed, unsealed, eliminated, win, suddenDeath, trapped,
 * escaped, placed, destroyed, explosion, bought, ads. `hit` carries `dist` (attacker→target, m) for engagement
 * ranges; `bought` is derived from inventory changes ({ by, item, cost }).
 */
export type LogEvent = [tick: number, type: string, data: Record<string, unknown>];

/**
 * Per-second state, players as tuples: [id, x, y, z, hp, shield, alive(0/1), cash, kills, deaths, equipped,
 * ads(0/1), eliminated(0/1)]. Positions rounded to 0.1 m.
 */
export type SecondSummary = { t: number; tick: number; p: (number | string)[][]; pieces: number; sealed: number[]; waterY: number };

export type Replay = {
  header: ReplayHeader;
  footer: ReplayFooter;
  /** ticks[i] = inputs for tick startTick + i + 1 (only humans; empty for all-bot ticks). */
  ticks: TickInput[][];
  /** `tick` = ticks of this recording already run (0 = before its first tick). */
  ops: { tick: number; op: ReplayOp }[];
  /** stateHash of the k-th snapshot whose tick is a multiple of HASH_EVERY (after startTick). */
  hashes: number[];
  events: LogEvent[];
  seconds: SecondSummary[];
  /** Raw match checkpoint (net/matchCheckpoint.ts saveMatch) the recording starts from; null when startTick = 0. */
  checkpoint: Uint8Array | null;
};

/** What the next host needs to continue a recording after a host migration (travels in the checkpoint's SessionMeta). */
export type RecordingLink = { matchId: string; segment: number; setup: MatchSetup & { seed: number } };

/** Is `v` a well-formed RecordingLink (it comes off the network)? */
export function isRecordingLink(v: unknown): v is RecordingLink {
  const l = v as RecordingLink | null;
  return !!l && typeof l === 'object' && typeof l.matchId === 'string' && /^[0-9a-z_-]{1,64}$/i.test(l.matchId)
    && Number.isInteger(l.segment) && l.segment >= 0 && l.segment < 1000
    && !!l.setup && typeof l.setup === 'object' && Array.isArray(l.setup.players) && typeof l.setup.seed === 'number';
}

const CHATTY = /chat/i;

/**
 * Drop anything chat-like (event types, header tags) from a recording before it is encoded: recordings
 * are uploaded and must never carry chat text. The recorder's event list never includes chat; this is
 * the guard that keeps it that way.
 */
export function withoutChat<T extends { header: ReplayHeader; events: LogEvent[] }>(r: T): T {
  const events = r.events.some(([, type]) => CHATTY.test(type)) ? r.events.filter(([, type]) => !CHATTY.test(type)) : r.events;
  const tags = r.header.tags;
  const cleanTags = tags && Object.keys(tags).some((k) => CHATTY.test(k)) ? Object.fromEntries(Object.entries(tags).filter(([k]) => !CHATTY.test(k))) : tags;
  if (events === r.events && cleanTags === tags) return r;
  return { ...r, events, header: { ...r.header, tags: cleanTags } };
}

/** List row for the Replays screen (stored next to the bytes so listing never decodes a replay). */
export type ReplayMeta = {
  id: string;
  recordedAt: number;
  kind: ReplayKind;
  /** Header matchId / segment (absent on rows stored before segments existed). */
  matchId?: string;
  segment?: number;
  players: { id: number; name: string; isBot: boolean }[];
  localId: number;
  mapName: string;
  winner: number | null;
  duration: number;
  unfinished: boolean;
  size: number;
};

export function metaOf(r: Pick<Replay, 'header' | 'footer'>, size: number): ReplayMeta {
  const setup = r.header.setup as { map?: unknown };
  const mapName = typeof setup.map === 'string' ? setup.map : `${r.header.players.length} islands`;
  return {
    id: r.header.id,
    recordedAt: r.header.recordedAt,
    kind: r.header.kind,
    matchId: r.header.matchId,
    segment: r.header.segment,
    players: r.header.players.map(({ id, name, isBot }) => ({ id, name, isBot })),
    localId: r.header.localId,
    mapName,
    winner: r.footer.winner,
    duration: r.footer.duration,
    unfinished: r.footer.unfinished,
    size,
  };
}
