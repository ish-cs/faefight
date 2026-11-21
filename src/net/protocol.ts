import type { MoveCmd } from '../sim/movement';
import type { Placement } from '../sim/building';
import type { MapChoice, MapDef } from '../sim/map';
import type { BuildRequest, Difficulty, PieceKind, PlayerInput, ShopItem } from '../sim/types';
import type { BrainDigest } from '../sim/bots/introspect';

/**
 * A lobby seat. Seat index = island index = player id - 1 once the match starts, except that a spectating
 * host (spectator: true, seat 0 only) gets no player and every later seat moves down one.
 */
export type Slot =
  | { kind: 'open' }
  | { kind: 'human'; name: string; peerId: string; isHost: boolean; spectator?: boolean }
  | { kind: 'bot'; difficulty: Difficulty; name?: string };

export const MAX_PLAYERS = 8;

/**
 * What a human player sees that the sim doesn't know: their build ghost, the shop/vault panel they have open
 * and the item they hover. Sent to the host ~4 Hz while it changes; the host forwards it only to a dead
 * friend spectating that player (read-only mirror), never into snapshots or replays.
 */
export type ViewExtras = {
  ghost: { kind: PieceKind; x: number; y: number; z: number; rotY: number; ok: boolean } | null;
  panel: 'shop' | 'potions' | 'vault' | null;
  hover: ShopItem | null;
};
export const CHAT_MAX_LEN = 200;

/** Remote client → host. */
export type ClientMsg =
  /** `rejoin`: the token the host gave this browser for its seat (reconnect grace). */
  | { t: 'hello'; name: string; version: number; rejoin?: string }
  /** Answer to the host's ping (round-trip time for the scoreboard). */
  | { t: 'pong'; n: number }
  /** `ack`: newest snapshot seq decoded (wire.ts delta baseline). */
  | { t: 'input'; input: PlayerInput; cmds: MoveCmd[]; ack?: number }
  | { t: 'preview'; req: BuildRequest; key: number }
  | { t: 'chat'; text: string }
  /** Spectating (dead/eliminated): the player followed, null = free fly. The host only honours it while you're dead. */
  | { t: 'follow'; id: number | null }
  /** My ghost / open panel (ViewExtras), for friends spectating me. */
  | { t: 'view'; v: ViewExtras };

/** Host → remote client. */
export type HostMsg =
  | { t: 'lobby'; slots: Slot[]; you: number; map: MapChoice }
  | { t: 'start'; map: MapDef; playerId: number; island: number }
  /** A NetSnapshot, binary + delta-compressed (wire.ts). */
  | { t: 'snap'; b: ArrayBuffer }
  | { t: 'preview'; result: Placement; key: number }
  | { t: 'chat'; from: string; text: string }
  | { t: 'ping'; n: number }
  /** Brain digest of the bot you're spectating (only while you're dead and following it), ~4 Hz. */
  | { t: 'brain'; d: BrainDigest }
  /** What the human you spectate sees beyond the snapshot (ghost, open panel), ~4 Hz, only while you're dead and following them. */
  | { t: 'view'; id: number; v: ViewExtras }
  /** Connection quality: round-trip ms by seat (null = unknown; the host's own seat is 0) and the host's sim health. */
  | { t: 'net'; rtt: (number | null)[]; host: 'ok' | 'strained' }
  /** Your seat's rejoin token: hello with it after a drop to reclaim the seat from the bot (within the grace period). */
  | { t: 'rejoin'; token: string }
  | { t: 'ended'; reason: 'host-left' | 'full' | 'started' | 'version' | 'kicked' | 'flood' };

/** Bump when ClientMsg/HostMsg change shape; host rejects mismatched clients with {t:'ended', reason:'version'}. */
export const NET_VERSION = 10;
