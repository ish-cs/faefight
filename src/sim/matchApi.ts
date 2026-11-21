import type { IslandLayout, MapDef, MapTemplate } from './map';
import type { Placement } from './building';
import type { BuildRequest, Difficulty, Inventory, PlayerInput, Snapshot, Vec3 } from './types';

export type MatchSetup = {
  players: { name: string; isBot: boolean; difficulty?: Difficulty }[];
  seed?: number;
  /** Map template (already resolved from the lobby's choice; 'random' never reaches the sim). Default harbor. */
  map?: MapTemplate;
  /**
   * Practice range (offline sandbox, see practice.ts): exactly one human player; the map is the practice layout,
   * targets and dummies are added by the range; no timer, sudden death or elimination; cash and pieces never run out.
   */
  practice?: boolean;
};

/**
 * Contract between the simulation and its hosts (worker now, network host in stage 2).
 *
 * Input semantics (per tick, 30 Hz):
 * - yaw/pitch: absolute aim angles (three.js convention: yaw 0 looks toward -Z, pitch + looks up).
 * - moveX (+ = strafe right), moveZ (+ = forward) in the yaw frame; magnitude clamped to 1.
 * - interact: collect cash at ANY generator within 2.5 m (incl. the center gold generator), and free pieces at the
 *   center supply generator (new kinds only while a hotbar slot is free).
 * - shop: processed only within 2.5 m of your OWN island's shop. vault: same for your own vault (1 s busy).
 * - slot: switch to that weapon if owned ('fists' always). Cancels reload.
 * - build: snapped (unless free) and validated against the player's position; consumes one piece;
 *   player is busy for the piece's placeSec (no firing/building) after placing.
 * - Edge-triggered actions (fire is held; reload/throwGrenade/placeCharge/interact act on each tick they are true).
 */
export interface MatchApi {
  /** Player islands (index = island). Same as def.islands. */
  readonly map: IslandLayout[];
  /** The whole map: islands, center island, cover, cosmetics. */
  readonly def: MapDef;
  /** Player ids controlled by humans (index order of MatchSetup.players). */
  humanIds(): number[];
  /** Advance one tick (1/30 s). Inputs missing for a human = no input. Bots supply their own. */
  tick(inputs: Map<number, PlayerInput>): Snapshot;
  /** Validate a build request for the ghost preview without placing it. */
  previewBuild(playerId: number, req: BuildRequest): Placement;
  /** Hand a seat to a bot (a friend disconnected mid-match). */
  setBot(playerId: number, difficulty: Difficulty): void;
  /** Debug helpers (dev/e2e only). */
  debugTeleport(playerId: number, pos: Vec3): void;
  debugGive(playerId: number, inv: Partial<Inventory>): void;
  debugSetHp(playerId: number, hp: number): void;
}
