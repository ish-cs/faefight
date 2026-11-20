import type { Placement } from '../sim/building';
import type { MapChoice, MapDef } from '../sim/map';
import type { BuildRequest, Difficulty, PlayerInput } from '../sim/types';
import type { NetSnapshot } from './snapshotCodec';

/** A lobby seat. Seat index = island index = player id - 1 once the match starts. */
export type Slot =
  | { kind: 'open' }
  | { kind: 'human'; name: string; peerId: string; isHost: boolean }
  | { kind: 'bot'; difficulty: Difficulty; name?: string };

export const MAX_PLAYERS = 8;
export const CHAT_MAX_LEN = 200;

/** Remote client → host. */
export type ClientMsg =
  | { t: 'hello'; name: string; version: number }
  | { t: 'input'; input: PlayerInput }
  | { t: 'preview'; req: BuildRequest; key: number }
  | { t: 'chat'; text: string };

/** Host → remote client. */
export type HostMsg =
  | { t: 'lobby'; slots: Slot[]; you: number; map: MapChoice }
  | { t: 'start'; map: MapDef; playerId: number; island: number }
  | { t: 'snap'; s: NetSnapshot }
  | { t: 'preview'; result: Placement; key: number }
  | { t: 'chat'; from: string; text: string }
  | { t: 'ended'; reason: 'host-left' | 'full' | 'started' | 'version' | 'kicked' };

/** Bump when ClientMsg/HostMsg change shape; host rejects mismatched clients with {t:'ended', reason:'version'}. */
export const NET_VERSION = 4;
