import type { Placement } from '../sim/building';
import type { IslandLayout } from '../sim/map';
import type { MoveCmd } from '../sim/movement';
import type { MatchSetup } from '../sim/matchApi';
import type { BuildRequest, Inventory, PlayerInput, Snapshot } from '../sim/types';

/** main thread → worker */
export type ToWorker =
  /** humanId = the local (this browser's) player; seat i becomes player id i + 1 on island i. */
  | { type: 'start'; setup: MatchSetup; humanId: number }
  /** Local player's input. */
  | { type: 'input'; input: PlayerInput; cmds?: MoveCmd[] }
  /** A remote player's (already sanitized) input, forwarded by the host session. */
  | { type: 'remoteInput'; playerId: number; input: PlayerInput; cmds?: MoveCmd[] }
  /** Hand a seat to a bot (its human left). */
  | { type: 'botify'; playerId: number }
  | { type: 'preview'; playerId: number; req: BuildRequest; key: number }
  | { type: 'debug'; cmd: 'teleport'; x: number; z: number }
  | { type: 'debug'; cmd: 'give'; inv: Partial<Inventory> }
  | { type: 'debug'; cmd: 'hp'; hp: number };

/** worker → main thread */
export type FromWorker =
  /** islands[id - 1] = island index of player id. */
  | { type: 'map'; map: IslandLayout[]; humanId: number; humanIsland: number; islands: number[] }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'preview'; playerId: number; result: Placement; key: number }
  | { type: 'error'; message: string };
