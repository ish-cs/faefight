import type { MoveState } from './movement';
import type { PropPose } from './props';
import type { EmoteId, QuipId } from './emotes';

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
  /** Spike traps carried (sim/traps.ts). */
  traps: number;
  /** Grappling hook uses left (absent = none). One hotbar slot ('grapple') holds them all. */
  grapples?: number;
};

/** Something that occupies a hotbar slot (amounts live in the inventory). */
export type HotbarItem = Exclude<WeaponKind, 'fists'> | PieceKind | 'grenade' | 'charge' | 'medkit' | PotionKind | 'trap' | 'grapple';

export type GunKind = Exclude<WeaponKind, 'fists'>;
/** `genUpgrade`: next level of your own island's generator. `lock:<gun>`: respawn with that gun from now on. */
export type LockItem = `lock:${GunKind}`;
export type ShopItem = PieceKind | GunKind | 'ammo' | 'grenade' | 'charge' | 'medkit' | PotionKind | 'genUpgrade' | LockItem | 'trap' | 'grapple';
export type ShopAction = { buy: ShopItem };
/**
 * Restock loadout (sim/vault.ts): on respawn the vault refills the hotbar up to these counts (a gun or the
 * grappling hook counts as 1), then tops carried cash up to `keep`; with `buy`, what the vault lacks is bought
 * with vault cash at shop prices.
 */
export type Loadout = { items: Partial<Record<HotbarItem, number>>; keep: number; buy: boolean };
/**
 * Vault moves (withdraw at your own vault; deposit there or, from vault level 2, anywhere on your island; 1 s busy),
 * a vault upgrade (at the vault), and/or a new restock loadout (accepted anywhere).
 */
export type VaultAction = { deposit?: Partial<Inventory>; withdraw?: Partial<Inventory>; loadout?: Loadout; upgrade?: true };

/**
 * `seq`: the movement command (MoveCmd.seq) the client placed after, i.e. where its predicted player stood when it
 * validated the spot and showed the piece. The host places it after simulating that command, just before the next
 * one moves the player (the same position; it waits up to BUILD.seqWaitSec for that next command, else expires), instead of after the whole batch of moves it happens to get this tick (a moving player could otherwise
 * be ahead or behind by several steps: refused as 'blocked'/'too far', or placed while the client already walks
 * on its own copy). Bots and older clients leave it out: placed after this tick's move, as before.
 */
export type BuildRequest = { kind: PieceKind; pos: Vec3; rotY: number; free: boolean; seq?: number };
/**
 * Place a spike trap. Floor: `pos` on the surface, `rotY` the plate's turn. Wall: `pos` on the wall face,
 * spikes pointing along forward(rotY) (out of the wall).
 */
export type TrapRequest = { pos: Vec3; rotY: number; wall: boolean };

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
  /** Camera the player looks through: 0 third person, 1 first person (cosmetic: spectators follow it). */
  view?: 0 | 1;
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
  /** Fire the grappling hook in the selected slot; while one is out, let go of it. Optional: old inputs/replays lack it. */
  grapple?: boolean;
  /**
   * Lag compensation: the sim time of the world this player was looking at when they fired (their
   * interpolated view of everyone else). The host resolves their shots against hitboxes rewound to
   * then (clamped; see lagComp.ts). Absent = no rewind (bots, old clients).
   */
  viewT?: number;
  /** Place a spike trap from the selected slot (one-shot; absent = none, so old replays decode unchanged). */
  trap?: TrapRequest;
};

export type PlayerState = {
  id: number;
  name: string;
  isBot: boolean;
  island: number;
  /** Team index in a teams match (sim/teams.ts); absent in free-for-all, where everyone is their own side. */
  team?: number;
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
  /** Respawn restock loadout (sim/vault.ts); absent = none. Private: only sent to its owner. */
  loadout?: Loadout;
  /** Vault level (sim/vault.ts VAULT_LEVELS); absent = 1. Private: only sent to its owner. */
  vaultLevel?: number;
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
  /** Victory surge (an elimination credit) lasts until this sim time: extra move speed (ELIM). Absent = never. */
  surgeUntil?: number;
  /** Public bounty: the spoils eliminating them would pay now, in $10 steps (elimination.ts bountyOf; scoreboard, bots). */
  bounty?: number;
  reloadUntil: number;
  /** Length of the reload in progress (s), for animation; 0 when not reloading. */
  reloadSec: number;
  /** Rounds in the gun when the reload started (tactical vs empty; the shotgun's shell count). */
  reloadMag: number;
  nextFireAt: number;
  /** Aiming down sights (sim-validated: needs a gun in hand, not sprinting or reloading). */
  ads: boolean;
  /** Their camera: 0 third person (bots, default), 1 first person. Cosmetic; spectators follow it. */
  view?: 0 | 1;
  /** Spread bloom (deg) as of `lastShotAt`; it recovers over time (gunplay.ts). */
  bloom: number;
  lastShotAt: number;
  /** Shots in the current burst (recoil climbs with it). */
  burst: number;
  busyUntil: number;
  /** Stamina 0..100 (sprint "stress"; mirrors mv.stamina, which prediction replays). Sent only to its owner and their spectators. */
  stamina: number;
  /** Movement state (grounding, coyote/jump-buffer timers, last applied command seq): see movement.ts. */
  mv?: MoveState;
  /** Cosmetic emote playing since sim time `at` (emotes.ts); absent when none. Moving, firing or damage ends it. */
  emote?: { id: EmoteId; at: number };
  /** Grappling hook out (sim/grapple.ts); absent when none. Public: everyone draws the rope. */
  hook?: HookState;
  /** Host bookkeeping: who last yanked this player with a hook, and when (a drowning soon after is their kill). */
  yankedBy?: { by: number; at: number };
  /**
   * Host bookkeeping: the last player who hurt this one, or broke the piece they stood on, and when. A drowning,
   * fall or storm death within LIFECYCLE.envCreditSec is their kill ("X via water"). Cleared on death.
   */
  hurtBy?: { by: number; at: number };
  /** Host bookkeeping: when your own rocket last launched you (the landing after it doesn't hurt). */
  rocketJumpAt?: number;
  /** The hook can't be fired again before this sim time (absent = ready). */
  hookReadyAt?: number;
  /** Last quick-chat line (speech bubble for QUIP_SHOW_SEC from `at`); absent when none. */
  quip?: { id: QuipId; at: number };
};

/**
 * A grappling hook in use. st: 0 flying out (reaches x,y,z at `at`), 1 latched to the world (reeling its owner
 * in), 2 latched to player `tgt` (yanking them over), 3 missed (retracting; gone at `at`). `t0`: when it was
 * fired. `pc`: the piece it hooked, if any (the rope snaps when that piece breaks). `len`: st 1 rope's rest length
 * (m, mirrored from the owner's mv.pull each tick so every client draws its slack or stretch).
 */
export type HookState = { st: 0 | 1 | 2 | 3; x: number; y: number; z: number; t0: number; at: number; tgt?: number; pc?: number; len?: number };

/** `burning`: on fire right now (sim/fire.ts); omitted when not, so it costs nothing on the wire. */
export type PieceState = { id: number; kind: PieceKind; owner: number; pos: Vec3; rotY: number; hp: number; burning?: true };
/** A ground fire (grass patch, or a burning crate/palm prop): small sim entity, see sim/fire.ts. */
export type FirePatch = { id: number; kind: 'grass' | 'crate' | 'palm'; pos: Vec3 };
/**
 * `noPickup`: a dropped bag its dropper can't grab back until `until`. `ammoOnly`: the guns in it are just
 * ammo (a supply crate drop): only someone who owns that gun can take it, as spare rounds.
 */
export type LootBag = { id: number; pos: Vec3; inv: Inventory; noPickup?: { id: number; until: number }; ammoOnly?: true };

/**
 * A hazard (MapDef.hazards) that isn't intact and at full health, as the snapshot carries it. st: 0 damaged,
 * 1 fusing (about to blow), 2 gone (waiting to respawn). Intact ones are left out, so a quiet map costs nothing.
 */
export type HazardNet = { id: number; st: 0 | 1 | 2; hp: number };

/**
 * A spike trap as the snapshot carries it (sim/traps.ts). `wall`: on a wall, spikes along forward(rotY);
 * else flat on a floor. `fired`: sim time the spikes last sprang (animation; -1 never). `arm`: armed from then.
 */
export type TrapNet = { id: number; owner: number; pos: Vec3; rotY: number; wall: boolean; hp: number; fired: number; arm: number };

export type MatchEventType =
  | 'kill' | 'sealed' | 'unsealed' | 'eliminated' | 'win' | 'suddenDeath' | 'trapped' | 'escaped' | 'spawn'
  | 'hit' | 'shot' | 'explosion' | 'placed' | 'destroyed' | 'pieceHit' | 'dry' | 'cosmeticBroken' | 'centerCollect' | 'lightning'
  /** Emote / quick-chat wheel use: data { by, id } (emotes.ts). */
  | 'wheel' | 'hazard'
  /** Grappling hook: data { by, phase: 'fire' | 'latch' | 'yank' | 'miss' | 'release', target? }. */
  | 'grapple'
  /** Spike trap: data { what: 'placed' | 'fired' | 'broken', id, pos, by / owner } (sim/traps.ts). */
  | 'trap'
  /** A wooden pier section broke (docks.ts): data { id, island, row, pos, rotY, by, kind }. */
  | 'dockBroken'
  /** Respawn restock from the vault (sim/vault.ts): data { player, moved, bought, cash }. */
  | 'restock'
  /** Bought a vault level: data { player, level }. */
  | 'vaultUpgrade'
  /**
   * Elimination credit (elimination.ts): data { victim, by (eliminator, null = nobody), assists: number[],
   * how: 'killed' | 'sealed' | 'trapped' | 'other', spoils (total $), shares: [id, $][] }.
   */
  | 'elimination'
  /** Sudden death sealed every bunker at once and dropped the doorway barriers (barriers.ts): data { barriers }. */
  | 'allSealed';
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
  /** Ground fires burning now (grass, props); omitted when there are none. */
  fires?: FirePatch[];
  generators: { island: number; stored: number }[];
  /** Center island bonus stations: cash at the gold generator, free pieces at the supply generator. */
  center?: { gold: number; bags: number; steel: number };
  /** Ids of broken cosmetic props (MapDef.cosmetics), in the order they broke. */
  broken?: number[];
  /** Tier A props away from their spawn pose (props.ts), ascending id; absent ids are at their spawn. */
  props?: PropPose[];
  /** Hazards (barrels, tanks, crates) that are damaged, fusing or gone; absent when every one is intact. */
  hz?: HazardNet[];
  /** Spike traps placed (absent when there are none). */
  traps?: TrapNet[];
  /** Ids of broken pier sections (MapDef.docks), in the order they broke; absent while every one stands. */
  docks?: number[];
  /** Ids of damaged (scorched) pier sections still standing; absent when none. */
  dockHurt?: number[];
  /** Generator level (1-4) of each island, by island index. */
  genLevels: number[];
  sealed: boolean[];
  waterY: number;
  suddenDeath: boolean;
  /** Sim time the sudden-death doorway barriers dropped (barriers.ts); absent before. */
  barrierAt?: number;
  /** Sudden-death storm (null/absent before it starts). Optional so hand-built snapshots can omit it. */
  storm?: StormSnap | null;
  winner: number | null;
  /** Potion seller NPCs (anyone may buy there). Optional so hand-built snapshots (tests, tools) can omit it. */
  potionShops?: PotionShop[];
  /** Host side only: every bot's current thinking. Remote spectators get just the followed bot's (net/interest.ts). */
  brains?: BotBrainInfo[];
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

/** A lightning strike due to land at (x, z) at sim time `at` (shown from `at - STORM.telegraphSec`). */
export type StormStrike = { x: number; z: number; at: number };
/** Sudden-death storm as clients see it: ring centre and radius, and the strikes being telegraphed. */
/** `rf`: the final circle the ring closes to. */
export type StormSnap = { x: number; z: number; r: number; rf: number; strikes: StormStrike[] };
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
  /** Eliminations credited (elimination.ts) and assists on them. */
  elims: number;
  assists: number;
  /** Spoils of war collected ($). */
  spoils: number;
};

/**
 * What a bot is thinking (bots/bot.ts debug), for spectators: personality, goal + reason, its steps
 * (`step` = index of the current one), fight odds (0..1, null when not fighting) and a one-line thought.
 */
export type BotBrainInfo = {
  id: number; personality: string; difficulty: Difficulty; action: string;
  goal: string | null; reason: string; steps: string[]; step: number; fightOdds: number | null; thought: string;
  /** Rival it's going after (player id). */
  target: number | null;
  /** Top-scored options of its last decision, best first (why it chose this). */
  options: { goal: string; score: number }[];
};

export const NO_INPUT: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ads: false, reload: false,
  interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null,
  select: null, drop: null, moveSlot: null, useMedkit: false, drink: false,
};
