import type { MoveCmd } from '../sim/movement';
import type { Placement } from '../sim/building';
import type { MapChoice, MapDef } from '../sim/map';
import type { GameSettings } from '../sim/settings';
import type { BuildRequest, Difficulty, PieceKind, PlayerInput, ShopItem } from '../sim/types';
import type { BrainDigest } from '../sim/bots/introspect';
import type { WheelId } from '../sim/emotes';

/**
 * A lobby seat. Seat index = island index = player id - 1 once the match starts, except that a spectating
 * host (spectator: true, seat 0 only) gets no player and every later seat moves down one.
 */
export type Slot =
  | { kind: 'open' }
  /** ready: a guest's Ready toggle (the host is always ready). color: palette index they picked (unique per lobby). */
  /** team: the side they picked for a teams match (lobby.ts seatTeams balances everyone else). */
  | { kind: 'human'; name: string; peerId: string; isHost: boolean; spectator?: boolean; ready?: boolean; color?: number; team?: number }
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
  | { t: 'hello'; name: string; version: number; rejoin?: string; mkey?: string }
  /** Answer to the host's ping (round-trip time for the scoreboard). */
  | { t: 'pong'; n: number }
  /** `ack`: newest snapshot seq decoded (wire.ts delta baseline). */
  | { t: 'input'; input: PlayerInput; cmds: MoveCmd[]; ack?: number }
  | { t: 'preview'; req: BuildRequest; key: number }
  | { t: 'chat'; text: string }
  /** Spectating (dead/eliminated): the player followed, null = free fly. The host only honours it while you're dead. */
  | { t: 'follow'; id: number | null }
  /** Lobby: the guest's Ready toggle. */
  | { t: 'ready'; ready: boolean }
  /** Lobby: the palette colour the guest wants (host refuses one another player picked). */
  | { t: 'color'; color: number }
  /** Lobby, teams mode: the team the guest wants (kept while it has room). */
  | { t: 'team'; team: number }
  /** My ghost / open panel (ViewExtras), for friends spectating me. */
  | { t: 'view'; v: ViewExtras }
  /** Emote / quick-chat wheel pick (sim/emotes.ts); the host rate-limits it to one per 2 s. */
  | { t: 'wheel'; id: WheelId };

/** Host → remote client. */
export type HostMsg =
  /** settings: the host's game settings (read-only for guests). */
  | { t: 'lobby'; slots: Slot[]; you: number; map: MapChoice; settings: GameSettings }
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
  /**
   * Host migration plan (migration.ts): if the host is lost, seat `seat`'s player takes over and opens room
   * `code`. `key` (the checkpoint key) goes to every guest but the backup, unless the backup is the only guest.
   */
  | { t: 'mplan'; epoch: number; seat: number; code: string; key?: string }
  /** To the backup only: the latest encrypted match checkpoint (checkpoint.ts). */
  | { t: 'ckpt'; epoch: number; b: ArrayBuffer }
  | { t: 'ended'; reason: 'host-left' | 'full' | 'started' | 'version' | 'kicked' | 'flood' };

/** Bump when ClientMsg/HostMsg change shape; host rejects mismatched clients with {t:'ended', reason:'version'}. */
export const NET_VERSION = 34; // 34: respawn 5 → 10 s, dying with your bunker sealed (or in sudden death) eliminates on the spot (eliminated event reason). 33: vault overhaul (shops pay from the vault, restock loadout on respawn, VaultAction.loadout; sim rules); 32: grapple reach per map = min(26, narrowest island gap - 8) (harbor 26 m, yard 18 m; was 40: lay a few decks before hooking over), bridge gaps <= 1.5 m walkable for bots (sim rules); 31: rocket jump (own rocket max 25 dmg + launch impulse, soft landing; sim rules); 30: elimination rewards (spoils of war, victory surge, 'elimination' event; player surgeUntil/bounty; stats elims/assists/spoils). 29: environmental kill credit (drown/fall/storm soon after a player hurt you or broke your floor is their kill; sim rule); 28: grapple cooldown 0.5 s (miss 0.2 s), rockets x1.5 player damage (sim rules); 27: ramps are thin sloped slabs, open underneath (collider change) + builds carry the move seq they were checked after (fall-through fix); 26: everyone starts with a pistol in hand (sim rule); 25: gameplay props (snapshot `props`, wire keys pr/p/q appended) on top of 24 (main: stranded bots)
