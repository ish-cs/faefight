import type { Placement } from '../sim/building';
import type { MapDef } from '../sim/map';
import type { MoveCmd } from '../sim/movement';
import type { MatchSetup } from '../sim/matchApi';
import type { PracticeCmd } from '../sim/practice';
import type { BuildRequest, Inventory, PlayerInput, Snapshot } from '../sim/types';

/** main thread → worker */
export type ToWorker =
  /** humanId = the local (this browser's) player, 0 = none (spectating host); setup.players[i] becomes player id i + 1. */
  | { type: 'start'; setup: MatchSetup; humanId: number }
  /** Local player's input. */
  | { type: 'input'; input: PlayerInput; cmds?: MoveCmd[] }
  /** A remote player's (already sanitized) input, forwarded by the host session. */
  | { type: 'remoteInput'; playerId: number; input: PlayerInput; cmds?: MoveCmd[] }
  /** Hand a seat to a bot (its human left). */
  | { type: 'botify'; playerId: number }
  /** A reconnected friend takes their seat back from the bot. */
  | { type: 'humanize'; playerId: number }
  /** Vs bot only: stop / restart ticking (pause card). */
  | { type: 'pause'; paused: boolean }
  /** Practice range panel (reset, clear pieces, dummy toggles). */
  | { type: 'practice'; cmd: PracticeCmd }
  | { type: 'preview'; playerId: number; req: BuildRequest; key: number }
  | { type: 'debug'; cmd: 'teleport'; x: number; z: number }
  | { type: 'debug'; cmd: 'give'; inv: Partial<Inventory>; id?: number }
  | { type: 'debug'; cmd: 'hp'; hp: number }
  | { type: 'debug'; cmd: 'eliminate' | 'kill'; playerId: number }
  | { type: 'debug'; cmd: 'shield'; shield: number; id?: number }
  | { type: 'debug'; cmd: 'potionShop'; x: number; z: number }
  /** Perf testing: n pieces on rings around (x, z), placement rules skipped. */
  | { type: 'debug'; cmd: 'pieces'; x: number; z: number; n: number };

/** worker → main thread */
export type FromWorker =
  /** islands[id - 1] = island index of player id; humanId 0 / humanIsland -1 = no local player. */
  | { type: 'map'; map: MapDef; humanId: number; humanIsland: number; islands: number[] }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'preview'; playerId: number; result: Placement; key: number }
  | { type: 'error'; message: string };
