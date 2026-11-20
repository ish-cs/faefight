export type Vec3 = { x: number; y: number; z: number };

export type PieceKind = 'sandbags' | 'wood' | 'metal' | 'steel' | 'scaffold' | 'ramp' | 'container';
export type WeaponKind = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle';
export type Difficulty = 'easy' | 'medium' | 'hard';

export type GunAmmo = { mag: number; spare: number };

export type Inventory = {
  cash: number;
  weapons: Partial<Record<WeaponKind, GunAmmo>>;
  pieces: Partial<Record<PieceKind, number>>;
  grenades: number;
  charges: number;
};

export type ShopItem = PieceKind | Exclude<WeaponKind, 'fists'> | 'ammo' | 'grenade' | 'charge';
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
  reload: boolean;
  interact: boolean;
  slot: WeaponKind | null;
  build: BuildRequest | null;
  throwGrenade: boolean;
  placeCharge: boolean;
  shop: ShopAction | null;
  vault: VaultAction | null;
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
  alive: boolean;
  eliminated: boolean;
  respawnAt: number | null;
  /** Set while trapped in a sealed bunker after respawning: eliminated at this time unless out. */
  breakoutUntil: number | null;
  invulnUntil: number;
  /** Sim time of the last damage taken (regen waits after this). */
  lastDamagedAt: number;
  inv: Inventory;
  vault: Inventory;
  equipped: WeaponKind;
  reloadUntil: number;
  nextFireAt: number;
  busyUntil: number;
};

export type PieceState = { id: number; kind: PieceKind; owner: number; pos: Vec3; rotY: number; hp: number };
export type LootBag = { id: number; pos: Vec3; inv: Inventory };

export type MatchEventType =
  | 'kill' | 'sealed' | 'unsealed' | 'eliminated' | 'win' | 'suddenDeath' | 'trapped' | 'escaped'
  | 'hit' | 'shot' | 'explosion' | 'placed' | 'destroyed' | 'pieceHit';
export type MatchEvent = { t: number; type: MatchEventType; data: Record<string, unknown> };

export type Snapshot = {
  time: number;
  tick: number;
  players: PlayerState[];
  pieces: PieceState[];
  loot: LootBag[];
  generators: { island: number; stored: number }[];
  sealed: boolean[];
  waterY: number;
  suddenDeath: boolean;
  winner: number | null;
  events: MatchEvent[];
};

export const NO_INPUT: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, reload: false,
  interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null,
};
