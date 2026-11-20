import type { IslandLayout } from '../map';
import type { Placement } from '../building';
import type { PieceKind, PieceState, PlayerState, Vec3 } from '../types';

/** Public status of every other player (what a human would know from the HUD). */
export type OtherStatus = { id: number; island: number; alive: boolean; eliminated: boolean; respawnAt: number | null };

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
  /** Whether each island's bunker is currently sealed, indexed by island. */
  sealed: boolean[];
  waterY: number;
  suddenDeath: boolean;
  /** Top surface y under (x, z) (land, piece or scaffold), or null over open water. */
  groundAt(x: number, z: number): number | null;
  /** Would this build request succeed for this bot right now (snap applied by caller)? */
  canPlace(kind: PieceKind, pos: Vec3, rotY: number): Placement;
};
