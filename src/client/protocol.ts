import type { Placement } from '../sim/building';
import type { IslandLayout } from '../sim/map';
import type { BuildRequest, Difficulty, Inventory, PlayerInput, Snapshot } from '../sim/types';

/** main thread → worker */
export type ToWorker =
  | { type: 'start'; difficulty: Difficulty }
  | { type: 'input'; input: PlayerInput }
  | { type: 'preview'; req: BuildRequest }
  | { type: 'debug'; cmd: 'teleport'; x: number; z: number }
  | { type: 'debug'; cmd: 'give'; inv: Partial<Inventory> };

/** worker → main thread */
export type FromWorker =
  | { type: 'map'; map: IslandLayout[]; humanId: number; humanIsland: number }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'preview'; result: Placement }
  | { type: 'error'; message: string };
