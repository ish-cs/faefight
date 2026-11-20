import type { MoveCmd } from '../sim/movement';
import type { Placement } from '../sim/building';
import type { MapChoice, MapDef } from '../sim/map';
import type { BuildRequest, Difficulty, PlayerInput } from '../sim/types';

/**
 * A lobby seat. Seat index = island index = player id - 1 once the match starts, except that a spectating
 * host (spectator: true, seat 0 only) gets no player and every later seat moves down one.
 */
export type Slot =
  | { kind: 'open' }
  | { kind: 'human'; name: string; peerId: string; isHost: boolean; spectator?: boolean }
  | { kind: 'bot'; difficulty: Difficulty; name?: string };

export const MAX_PLAYERS = 8;
export const CHAT_MAX_LEN = 200;

/** Remote client → host. */
export type ClientMsg =
  | { t: 'hello'; name: string; version: number }
  /** `ack`: newest snapshot seq decoded (wire.ts delta baseline). */
  | { t: 'input'; input: PlayerInput; cmds: MoveCmd[]; ack?: number }
  | { t: 'preview'; req: BuildRequest; key: number }
  | { t: 'chat'; text: string };

/** Host → remote client. */
export type HostMsg =
  | { t: 'lobby'; slots: Slot[]; you: number; map: MapChoice }
  | { t: 'start'; map: MapDef; playerId: number; island: number }
  /** A NetSnapshot, binary + delta-compressed (wire.ts). */
  | { t: 'snap'; b: ArrayBuffer }
  | { t: 'preview'; result: Placement; key: number }
  | { t: 'chat'; from: string; text: string }
  | { t: 'ended'; reason: 'host-left' | 'full' | 'started' | 'version' | 'kicked' | 'flood' };

/** Bump when ClientMsg/HostMsg change shape; host rejects mismatched clients with {t:'ended', reason:'version'}. */
export const NET_VERSION = 5;
