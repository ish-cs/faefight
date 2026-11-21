import type { MoveState } from './movement';

export type Vec3 = { x: number; y: number; z: number };

export type PieceKind = 'sandbags' | 'wood' | 'metal' | 'steel' | 'scaffold' | 'ramp' | 'container';
export type WeaponKind = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'rocket';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'pro';
export type PotionKind = 'shieldSmall' | 'shieldBig' | 'healPotion' | 'speedPotion';

export type GunAmmo = { mag: number; spare: number };

export type Inventory = {
  cash: number;
  weapons: Partial<Record<WeaponKind, GunAmmo>>;
  pieces: Partial<Record<PieceKind, number>>;
  grenades: number;
  charges: number;
  medkits: number;
  potions: Partial<Record<PotionKind, number>>;
};

/** Something that occupies a hotbar slot (amounts live in the inventory). */
export type HotbarItem = Exclude<WeaponKind, 'fists'> | PieceKind | 'grenade' | 'charge' | 'medkit' | PotionKind;

export type GunKind = Exclude<WeaponKind, 'fists'>;
/** `genUpgrade`: next level of your own island's generator. `lock:<gun>`: respawn with that gun from now on. */
export type LockItem = `lock:${GunKind}`;
export type ShopItem = PieceKind | GunKind | 'ammo' | 'grenade' | 'charge' | 'medkit' | PotionKind | 'genUpgrade' | LockItem;
export type ShopAction = { buy: ShopItem };
export type VaultAction = { deposit?: Partial<Inventory>; withdraw?: Partial<Inventory> };

export type BuildRequest = { kind: PieceKind; pos: Vec3; rotY: number; free: boolean };

export type PlayerInput = {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  /** Aim down sights (held): tighter spread, zoom, slower move. */
  ads: boolean;
  reload: boolean;
  interact: boolean;
  slot: WeaponKind | null;
  build: BuildRequest | null;
  throwGrenade: boolean;
  placeCharge: boolean;
  shop: ShopAction | null;
  vault: VaultAction | null;
  /** Hotbar slot to hold (0-8); held state, sent every input by the client. */
  select: number | null;
  /** Drop from the selected slot: one unit (a gun with its ammo) or the whole stack. */
  drop: 'one' | 'stack' | null;
  /** Swap two hotbar slots. */
  moveSlot: { from: number; to: number } | null;
  /** Start using a medkit (the selected slot must hold one). */
  useMedkit: boolean;
  /** Start drinking the potion in the selected slot. */
  drink: boolean;
  /**
   * Lag compensation: the sim time of the world this player was looking at when they fired (their
   * interpolated view of everyone else). The host resolves their shots against hitboxes rewound to
   * then (clamped; see lagComp.ts). Absent = no rewind (bots, old clients).
   */
  viewT?: number;
};

export type PlayerState = {
  id: number;
  name: string;
  isBot: boolean;
  island: number;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  /** Shield (0..SHIELD_MAX): soaks damage before hp. Never regenerates; reset to 0 on death. */
  shield: number;
  alive: boolean;
  eliminated: boolean;
  /** Scoreboard: kills credited to this player (not suicides or environment deaths) and times died. */
  kills: number;
  deaths: number;
  respawnAt: number | null;
  /** Set while trapped in a sealed bunker after respawning: eliminated at this time unless out. */
  breakoutUntil: number | null;
  invulnUntil: number;
  /** How many of your own bunker's 3 doorways no one can walk out through (3 = sealed). Only sent to you. */
  doorsBlocked?: number;
  /** Just respawned and hasn't left the bunker or attacked yet (anti spawn-camping). */
  spawnProtected?: boolean;
  /** Sim time of the last damage taken (regen waits after this). */
  lastDamagedAt: number;
  inv: Inventory;
  vault: Inventory;
  /** Guns bought back on every respawn (full mag + one spare). Private: only sent to their owner. */
  locked: GunKind[];
  /** Nine slots of item kinds held; counts are in `inv`. */
  hotbar: (HotbarItem | null)[];
  /** Selected hotbar slot (0-8). */
  selected: number;
  /** Derived from the selected slot: its gun, else fists. */
  equipped: WeaponKind;
  /** A medkit in use heals at this time (null when not healing). */
  healAt: number | null;
  /** A potion being drunk takes effect at `doneAt` (null when not drinking). */
  drinking: { kind: PotionKind; doneAt: number } | null;
  /** HP still to come from heal potions (heal over time). */
  healLeft: number;
  /** Speed potion buff lasts until this sim time (0 = none). */
  speedUntil: number;
  reloadUntil: number;
  /** Length of the reload in progress (s), for animation; 0 when not reloading. */
  reloadSec: number;
  /** Rounds in the gun when the reload started (tactical vs empty; the shotgun's shell count). */
  reloadMag: number;
  nextFireAt: number;
  /** Aiming down sights (sim-validated: needs a gun in hand, not sprinting or reloading). */
  ads: boolean;
  /** Spread bloom (deg) as of `lastShotAt`; it recovers over time (gunplay.ts). */
  bloom: number;
  lastShotAt: number;
  /** Shots in the current burst (recoil climbs with it). */
  burst: number;
  busyUntil: number;
  /** Movement state (grounding, coyote/jump-buffer timers, last applied command seq): see movement.ts. */
  mv?: MoveState;
};

export type PieceState = { id: number; kind: PieceKind; owner: number; pos: Vec3; rotY: number; hp: number };
/** `noPickup`: a dropped bag its dropper can't grab back until `until`. */
export type LootBag = { id: number; pos: Vec3; inv: Inventory; noPickup?: { id: number; until: number } };

export type MatchEventType =
  | 'kill' | 'sealed' | 'unsealed' | 'eliminated' | 'win' | 'suddenDeath' | 'trapped' | 'escaped'
  | 'hit' | 'shot' | 'explosion' | 'placed' | 'destroyed' | 'pieceHit' | 'dry' | 'cosmeticBroken' | 'centerCollect';
export type MatchEvent = { t: number; type: MatchEventType; data: Record<string, unknown> };

/** A grenade, breach charge or rocket in the world (sent to every client so it can be drawn). */
export type Projectile = { id: number; kind: 'grenade' | 'charge' | 'rocket'; pos: Vec3; vel: Vec3 };

export type Snapshot = {
  time: number;
  tick: number;
  players: PlayerState[];
  pieces: PieceState[];
  loot: LootBag[];
  /** In flight now (the sim always sends it; optional so older/partial snapshots stay valid). */
  projectiles?: Projectile[];
  generators: { island: number; stored: number }[];
  /** Center island bonus stations: cash at the gold generator, free pieces at the supply generator. */
  center?: { gold: number; bags: number; steel: number };
  /** Ids of broken cosmetic props (MapDef.cosmetics), in the order they broke. */
  broken?: number[];
  /** Generator level (1-4) of each island, by island index. */
  genLevels: number[];
  sealed: boolean[];
  waterY: number;
  suddenDeath: boolean;
  winner: number | null;
  /** Potion seller NPCs (anyone may buy there). Optional so hand-built snapshots (tests, tools) can omit it. */
  potionShops?: PotionShop[];
  events: MatchEvent[];
  /**
   * Remote clients only (net/interest.ts): players this client can't currently perceive. They stay
   * in `players` (name, alive, eliminated) with a stale position and neutral state; don't render them.
   */
  hidden?: number[];
  /** Match totals per player: only present once the match has a result (end-screen summary). */
  stats?: PlayerStats[];
};

export type PotionShop = { id: number; pos: Vec3 };

/** Per-player match totals for the end-screen summary (sent only once the match has a result). */
export type PlayerStats = {
  id: number;
  kills: number;
  deaths: number;
  /** Damage dealt to other players (shield + hp). */
  damage: number;
  /** Bunkers sealed (credited to whoever placed the closing piece). */
  seals: number;
  /** Pieces placed. */
  built: number;
  /** Cash collected from generators. */
  cash: number;
  /** Longest time alive in one life (s). */
  longestLife: number;
  headshots: number;
};

export const NO_INPUT: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ads: false, reload: false,
  interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null,
  select: null, drop: null, moveSlot: null, useMedkit: false, drink: false,
};
