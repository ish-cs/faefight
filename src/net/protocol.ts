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
  /** `rejoin`: the token the host gave this browser for its seat (reconnect grace). */
  | { t: 'hello'; name: string; version: number; rejoin?: string; mkey?: string }
  /** Answer to the host's ping (round-trip time for the scoreboard). */
  | { t: 'pong'; n: number }
  /** `ack`: newest snapshot seq decoded (wire.ts delta baseline). */
  | { t: 'input'; input: PlayerInput; cmds: MoveCmd[]; ack?: number }
  | { t: 'preview'; req: BuildRequest; key: number }
  | { t: 'chat'; text: string }
  /** Spectating (dead/eliminated): the player followed, null = free fly. The host only honours it while you're dead. */
  | { t: 'follow'; id: number | null };

/** Host → remote client. */
export type HostMsg =
  | { t: 'lobby'; slots: Slot[]; you: number; map: MapChoice }
  | { t: 'start'; map: MapDef; playerId: number; island: number }
  /** A NetSnapshot, binary + delta-compressed (wire.ts). */
  | { t: 'snap'; b: ArrayBuffer }
  | { t: 'preview'; result: Placement; key: number }
  | { t: 'chat'; from: string; text: string }
  | { t: 'ping'; n: number }
  /** Connection quality: round-trip ms by seat (null = unknown; the host's own seat is 0) and the host's sim health. */
  | { t: 'net'; rtt: (number | null)[]; host: 'ok' | 'strained' }
  /** Your seat's rejoin token: hello with it after a drop to reclaim the seat from the bot (within the grace period). */
  | { t: 'rejoin'; token: string }
  /**
   * Host migration plan (migration.ts): if the host is lost, seat `seat`'s player takes over and opens room
   * `code`. `key` (the checkpoint key) goes to every guest but the backup, unless the backup is the only guest.
   */
  | { t: 'mplan'; epoch: number; seat: number; code: string; key?: string }
  /** To the backup only: the latest encrypted match checkpoint (checkpoint.ts). */
  | { t: 'ckpt'; epoch: number; b: ArrayBuffer }
  | { t: 'ended'; reason: 'host-left' | 'full' | 'started' | 'version' | 'kicked' | 'flood' };

/** Bump when ClientMsg/HostMsg change shape; host rejects mismatched clients with {t:'ended', reason:'version'}. */
export const NET_VERSION = 9;
