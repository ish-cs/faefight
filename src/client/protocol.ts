import type { Placement } from '../sim/building';
import type { MapDef } from '../sim/map';
import type { MoveCmd } from '../sim/movement';
import type { MatchSetup } from '../sim/matchApi';
import type { PracticeCmd } from '../sim/practice';
import type { BuildRequest, Inventory, PieceKind, PlayerInput, Snapshot } from '../sim/types';
import type { ReplayKind, ReplayMeta } from '../sim/replay/format';

/** main thread → worker */
export type ToWorker =
  /** humanId = the local (this browser's) player, 0 = none (spectating host); setup.players[i] becomes player id i + 1. */
  | { type: 'start'; setup: MatchSetup; humanId: number; record?: { kind: ReplayKind; build: string } | null }
  /** Stop recording now (game torn down early) and send what there is; answered by 'replay' (if any) then 'recordingDone'. */
  | { type: 'finishRecording' }
  /** Encode the recording so far WITHOUT stopping it (tab hidden mid-match: upload what there is); answered by 'replay' with partial. */
  | { type: 'peekRecording' }
  /** Host migration: snapshot the whole match (answer: 'checkpoint'). */
  | { type: 'checkpoint' }
  /**
   * Host migration, on the new host: run the gzipped checkpoint `match` instead of a fresh match. `botify`
   * the old host's player, fast-forward to `toTick` (bots act, humans idle), then tick live (answer: 'restored').
   */
  | { type: 'restore'; match: Uint8Array; humanId: number; botify: number[]; toTick: number }
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
  | { type: 'debug'; cmd: 'clearLoadout'; id?: number }
  | { type: 'debug'; cmd: 'hp'; hp: number }
  | { type: 'debug'; cmd: 'time'; t: number }
  | { type: 'debug'; cmd: 'strike'; x: number; z: number }
  | { type: 'debug'; cmd: 'eliminate' | 'kill'; playerId: number }
  | { type: 'debug'; cmd: 'shield'; shield: number; id?: number }
  | { type: 'debug'; cmd: 'potionShop'; x: number; z: number }
  /** Alert testing: a steel plate on doorway `door` of the human's bunker (placed by `owner`), removing one, generator cash. */
  | { type: 'debug'; cmd: 'plugDoor'; door: number; owner: number }
  | { type: 'debug'; cmd: 'removePiece'; id: number }
  | { type: 'debug'; cmd: 'genStored'; stored: number }
  /** Perf testing: n pieces on rings around (x, z), placement rules skipped. */
  | { type: 'debug'; cmd: 'pieces'; x: number; z: number; n: number }
  | { type: 'debug'; cmd: 'place'; kind: PieceKind; x: number; z: number; rotY: number; up: number; owner: number }
  | { type: 'debug'; cmd: 'explode'; kind: 'rocket' | 'grenade' | 'charge'; x: number; z: number; up: number };

/** worker → main thread */
export type FromWorker =
  /** islands[id - 1] = island index of player id; humanId 0 / humanIsland -1 = no local player. */
  | { type: 'map'; map: MapDef; humanId: number; humanIsland: number; islands: number[] }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'preview'; playerId: number; result: Placement; key: number }
  | { type: 'error'; message: string }
  /** A finished recording (match over, or finishRecording). */
  | { type: 'replay'; bytes: Uint8Array; meta: ReplayMeta; partial?: boolean }
  | { type: 'recordingDone' }
  /** Gzipped match checkpoint (matchCheckpoint.ts) as of `tick`. */
  | { type: 'checkpoint'; match: Uint8Array; tick: number }
  | { type: 'restored'; tick: number };
