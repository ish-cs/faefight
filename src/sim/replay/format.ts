import type { IslandLayout } from '../map';
import type { MatchSetup } from '../matchApi';
import type { MoveCmd } from '../movement';
import type { BuildRequest, Difficulty, Inventory, PlayerInput, Vec3 } from '../types';

/**
 * A recorded match: enough to re-run it exactly (setup + seed + what every human fed the sim each tick +
 * out-of-band operations), plus analytics that don't need a re-run (event log, per-second summaries).
 * Bots need nothing: they're seeded from the match rng and see only sim state.
 */
export const REPLAY_FORMAT = 1;
/** Ticks between state hashes and per-second summaries. */
export const HASH_EVERY = 30;

export type ReplayKind = 'solo' | 'host' | 'selfplay' | 'test';

export type ReplayHeader = {
  format: number;
  /** Unique id (also the storage key). */
  id: string;
  kind: ReplayKind;
  /** ms since epoch when recording started. */
  recordedAt: number;
  /** Code version that recorded it (replays only re-run exactly on the same sim + bot code). */
  build: string;
  /** Exactly what Match.create got, seed filled in. */
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
  /** A build preview (it may sync the collision world, so it's part of the run). */
  | { k: 'preview'; id: number; req: BuildRequest }
  | { k: 'teleport'; id: number; pos: Vec3 }
  | { k: 'hp'; id: number; hp: number }
  | { k: 'shield'; id: number; shield: number }
  | { k: 'potionShops'; positions: Vec3[] }
  | { k: 'eliminate'; id: number }
  | { k: 'kill'; id: number }
  | { k: 'give'; id: number; inv: Partial<Inventory> };

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
  /** ticks[i] = inputs for tick i + 1 (only humans; empty for all-bot ticks). */
  ticks: TickInput[][];
  ops: { tick: number; op: ReplayOp }[];
  /** stateHash of the snapshot after tick (k + 1) * HASH_EVERY. */
  hashes: number[];
  events: LogEvent[];
  seconds: SecondSummary[];
};

/** List row for the Replays screen (stored next to the bytes so listing never decodes a replay). */
export type ReplayMeta = {
  id: string;
  recordedAt: number;
  kind: ReplayKind;
  players: { id: number; name: string; isBot: boolean }[];
  localId: number;
  mapName: string;
  winner: number | null;
  duration: number;
  unfinished: boolean;
  size: number;
};

export function metaOf(r: Replay, size: number): ReplayMeta {
  const setup = r.header.setup as { map?: unknown };
  const mapName = typeof setup.map === 'string' ? setup.map : `${r.header.players.length} islands`;
  return {
    id: r.header.id,
    recordedAt: r.header.recordedAt,
    kind: r.header.kind,
    players: r.header.players.map(({ id, name, isBot }) => ({ id, name, isBot })),
    localId: r.header.localId,
    mapName,
    winner: r.footer.winner,
    duration: r.footer.duration,
    unfinished: r.footer.unfinished,
    size,
  };
}
