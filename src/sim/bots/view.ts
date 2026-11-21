import type { CenterIsland, IslandLayout, StaticBox } from '../map';
import type { Placement } from '../building';
import type { PieceKind, PieceState, PlayerState, StormSnap, Vec3 } from '../types';

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
  /** Neutral center island and what its bonus stations hold (absent in hand-made test views). */
  center?: { island: CenterIsland; gold: number; bags: number; steel: number };
  /** Built-in indestructible cover (obstacles for walking). */
  statics?: StaticBox[];
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
  /**
   * Standing barrels / propane tanks / supply crates (map props, public: everyone sees them). `fusing`: about to
   * blow. `radius`: blast radius (0 for crates). Absent in hand-made test views.
   */
  hazards?: { id: number; kind: 'barrel' | 'propane' | 'crate'; pos: Vec3; center: Vec3; radius: number; fusing: boolean }[];
  /** Clear line of fire from my eye to this point (bullets pass firing slits)? */
  clearShot?(to: Vec3): boolean;
  /**
   * A grappling hook's ray from my eye along `dir` (unit): where it would catch (GRAPPLE.range max; firing slits
   * block it), and the player it would hit, if any. Absent in hand-made test views.
   */
  castHook?(dir: Vec3): { point: Vec3; dist: number; player: number | null } | null;
  /** Positions of loot bags within sight range. */
  loot: Vec3[];
  waterY: number;
  /** Burning pieces and ground fires as circles to stay out of (absent in hand-made test views). */
  fires?: { pos: Vec3; r: number }[];
  suddenDeath: boolean;
  /**
   * Sudden-death storm as anyone sees it on screen: ring centre/radius, how fast it closes (m/s), and the
   * telegraphed lightning strikes. Absent/null before sudden death.
   */
  storm?: (StormSnap & { rate: number }) | null;
  /** Match time sudden death begins (host setting; default LIFECYCLE.suddenDeathAt). */
  suddenDeathAt?: number;
  /** Potion seller positions (anyone may buy there). */
  potionShops?: Vec3[];
  /** Top surface y under (x, z) (land, piece or scaffold), or null over open water. */
  groundAt(x: number, z: number): number | null;
  /** Would this build request succeed for this bot right now (snap applied by caller)? */
  canPlace(kind: PieceKind, pos: Vec3, rotY: number): Placement;
};
