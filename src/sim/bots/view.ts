import type { IslandLayout } from '../map';
import type { Placement } from '../building';
import type { PieceKind, PieceState, PlayerState, Vec3 } from '../types';

/** Public status of every other player (what a human would know from the HUD). */
export type OtherStatus = {
  id: number; island: number; alive: boolean; eliminated: boolean; respawnAt: number | null;
  /** Kills so far (scoreboard). */
  kills: number;
};

/** A hit I took: the damage indicator says how much, the kill cam / direction says who. */
export type HurtEvent = { t: number; by: number | null; amount: number };
/** A shot whose tracer I could see (fired within sight range of me). */
export type ShotSeen = { t: number; by: number; from: Vec3; to: Vec3 };
/** Kill feed line. */
export type FeedLine = { t: number; killer: number | null; victim: number };

/**
 * Everything a bot may know when deciding its next input. Built by Match each tick.
 * `enemies` holds only enemies the bot can currently see (alive, line of sight from its eye).
 */
export type BotView = {
  now: number;
  self: PlayerState;
  enemies: PlayerState[];
  others: OtherStatus[];
  map: IslandLayout[];
  pieces: PieceState[];
  /** Uncollected cash sitting at each island's generator, indexed by island. */
  generators: number[];
  /** Generator level (1-4) of each island, indexed by island (public: shown on each generator). */
  genLevels?: number[];
  /** Whether each island's bunker is currently sealed, indexed by island. */
  sealed: boolean[];
  /** Hits against me in the last few seconds. */
  hurt: HurtEvent[];
  /** Tracers seen in the last few seconds (my own shots excluded). */
  shots: ShotSeen[];
  /** Kill feed, last ~30 s. */
  feed: FeedLine[];
  /** Positions of loot bags within sight range. */
  loot: Vec3[];
  waterY: number;
  suddenDeath: boolean;
  /** Top surface y under (x, z) (land, piece or scaffold), or null over open water. */
  groundAt(x: number, z: number): number | null;
  /** Would this build request succeed for this bot right now (snap applied by caller)? */
  canPlace(kind: PieceKind, pos: Vec3, rotY: number): Placement;
};
