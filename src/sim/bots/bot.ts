import * as dm from '../dmath';
import { AMMO_BOX, CHARGE, DT, ECONOMY, GRAPPLE, GRENADE, HEAD, LIFECYCLE, MAP, MEDKIT, PIECES, PLAYER, ROCKET, SEAL, STORM, TRAP, WEAPONS } from '../constants';
import { eyePos, glintsAt } from '../combat';
import { isFlammable, steerFromFire } from '../fire';
import { friendly, trapCenter } from '../traps';
import type { DockDef, Doorway, IslandLayout } from '../map';
import { overDock } from '../docks';
import { isHomeOnly } from '../economy';
import { NO_INPUT } from '../types';
import type {
  BuildRequest, Difficulty, HotbarItem, Inventory, Loadout, PieceKind, PieceState, PlayerInput, PlayerState, ShopItem, TrapNet, TrapRequest, VaultAction, Vec3, WeaponKind,
  UtilityKind,
} from '../types';
import { funds } from '../economy';
import { canAdd } from '../hotbar';
import { vaultLevel, vaultSpec, vaultUpgradePrice } from '../vault';
import { add, clone, dist2D, forward, norm, right, rotateY, scale, sub, v3, yawOf } from '../vec';
import { isRng, mulberry32 } from '../rng';
import { AIM, Aim, angleBetween, lookAt, wrapAngle, type Angles } from './aim';
import { flankSide, fortPlan, fortShare, fumble, ghost, ownBunkerSafe, shields, slotBuilt, type Slot } from './build';
import { BunkerGrid, blockingPieces, breakCost, pieceToBreak } from './escape';
import { DEFAULT_BOT_PARAMS, type BotParams } from './params';
import { crossTo, escapeFrom, hookReady, yankReason, type HookIntent } from './hook';
import { dropForHeal, healPlan, healStock, hpHealsHeld, type HealPlan } from './heal';
import { Beliefs } from './belief';
import { Memory, commitment, rivalScore, type RivalFacts, type Sighting } from './mind';
import { Nav, insideBunker, islandAt, landEdge, lane, laneAt, laneS, type Lane } from './nav';
import { rollPersonality, type Personality, type Traits } from './personality';
import {
  GUNS, TALL, bestGun, doorBlocked, doorPieces, hasAmmo, isHard, nextPurchase, ownsGun, plugFor, plugSpot, potionAction, sealKit,
  shoppingPlan,
  type Needs, type ShopStyle,
} from './plans';
import type { AllyStatus, BotView, OtherStatus } from './view';
import { planUtility, utilAngles, utilReact, type UtilSituation } from './utilityPlan';
import { BrainProbe, debugBrain, noteSwitch, type BrainDigest, type GoalSwitch, type ScoreRow } from './introspect';

export type Goal =
  | 'collect' | 'shop' | 'bank' | 'bridge' | 'attack' | 'seal' | 'defend' | 'guard' | 'cut' | 'loot' | 'raid'
  | 'fight' | 'disengage' | 'storm' | 'heal' | 'cover' | 'fortify' | 'contest' | 'trap' | 'assist' | 'regroup';
const GOALS: Goal[] = [
  'storm', 'defend', 'disengage', 'cover', 'fight', 'guard', 'bank', 'seal', 'attack', 'cut', 'raid', 'loot', 'bridge',
  'fortify', 'trap', 'shop', 'heal', 'contest', 'collect', 'assist', 'regroup',
];
/** Center gold worth a trip, and how far a bot will go out of its way for it. */
const CONTEST_AT = 150;

/** How often a bot reconsiders what to do, and how long it hesitates after changing plans (human thinking time). */
const RESCORE_SEC: Record<Difficulty, number> = { easy: 1.6, medium: 1.0, hard: 0.5, pro: 0.3 };
const HESITATE_SEC: Record<Difficulty, number> = { easy: 1.2, medium: 0.6, hard: 0.15, pro: 0.05 };
const STICKY = 0.1;
/** Going back to the goal I left less than this ago skips the thinking pause; goal misjudgements last about this. */
const FLIP_BACK_SEC = 5, NOISE_HOLD_SEC = 3;
/** Misjudgement in goal/target scores (decision mistakes). */
const NOISE: Record<Difficulty, number> = { easy: 0.3, medium: 0.15, hard: 0.08, pro: 0.03 };
const BUY_GAP: Record<Difficulty, number> = { easy: 3, medium: 1.5, hard: 0.6, pro: 0.35 };
/** Chance an easy bot buys sandbags instead of the piece it meant to. */
const EASY_MISBUY = 0.1;
/** A purchase that didn't go through (e.g. no room to carry it) is retried this many times, then left alone a while. */
const BUY_RETRIES = 2;
const BUY_BACKOFF_SEC = 20;
const ARRIVE = 0.6;
const USE_RANGE = ECONOMY.interactRadius - 0.2;
/** Vault this close (m), e.g. from the shop next to it: the level is bought on the same trip (VaultParams.upgradeNear). */
const UPGRADE_NEAR_M = 12;
const COLLECT_AT = 40;
const STUCK_SEC = 2, STUCK_DIST = 0.5, UNSTICK_SEC = 0.6;
/** Disengaging: how long I stick with the enemy I'm getting away from before thinking again about whom to flee. */
const FLEE_KEEP_SEC = 1.5;
/** Fighting: someone just out of sight is still my opponent this long, and only someone this much closer takes over. */
const FOE_HOLD_SEC = 0.5, FOE_SWITCH = 0.7;
/** In a cover spot, drifting this far off it (it moves as the shooter does) is when I walk back into it. */
const COVER_LEAVE_M = 1.5;
/** Out of a barrel's danger zone (hazardAvoid), this much further is where I stop walking straight back toward it. */
const HAZARD_FENCE_M = 1;
const TURN_RATE = 8;
/** Beyond this, an enemy on another island isn't worth abandoning the current goal for. */
const ENGAGE_RANGE = 25;
/** escape(): a grid path out that moves me less than this in ESCAPE_STALL_SEC is a dead end. */
const ESCAPE_STALL_M = 0.3, ESCAPE_STALL_SEC = 1;
/** Attack score in sudden death with no ammo: above collect/shop (≤ 0.9), below storm and survival goals. */
const SD_FISTS_ATTACK = 0.95;
/**
 * Final circle with nobody in sight: storm goal score for hunting there, how near its centre counts as there, and
 * how fast (rad/s) I then sweep round the centre at FINAL_HUNT_NEAR - 1 (one wall at the centre hid two teams from
 * each other 1.7 m apart for 13 min: CI teams 4v4 seed 21).
 */
const FINAL_HUNT = 0.6, FINAL_HUNT_NEAR = 4, FINAL_HUNT_SWEEP = 0.5;
/** Feet below the bunker roof (minus a margin): actually inside, not standing on top of it. */
const underRoof = (home: IslandLayout, p: Vec3) => p.y < home.groundY + MAP.bunker.height - 0.5;
/** My bunker sealed: clear it first unless an enemy is closer than this (then fight; turning my back loses). */
const SEALED_HOME_CLEAR = 12;
const CHEST = 1.2;
/**
 * Where the next deck of a bridge goes, tried in order: [s past the tip, metres to the side]. Straight on first; when
 * that won't fit (the far shore has something on it right at the lane, e.g. a barrier on the center island, and the
 * gap left is shorter than a deck) the same deck shifted sideways, still resting on the tip (decks are 2 m wide).
 */
export const DECK_TRIES: readonly [number, number][] = [
  [2.0, 0], [2.1, 0], [2.2, 0], [2.3, 0], [2.4, 0], [2.6, 0],
  [2.0, 0.5], [2.0, -0.5], [2.0, 0.8], [2.0, -0.8], [2.2, 0.5], [2.2, -0.5], [2.2, 0.8], [2.2, -0.8],
];
/** Net forward progress of one scaffold laid end-to-end. */
const SCAFFOLD_STEP = 3.8;
/** Teams (waitFor): the bridge head is within this of the rival island's shore; a teammate within this of where I
 *  stand (further out) is coming; after a wait, this long before waiting again. */
const WAIT_HEAD_M = 45;
const WAIT_COMING_M = 150;
const WAIT_BREAK_SEC = 30;
const PREFERRED_RANGE: Record<WeaponKind, number> = { fists: 1.2, shotgun: 6, smg: 12, pistol: 16, rifle: 25, rocket: 20, sniper: 45 };
/** Memory horizons: an intruder seen on my island, a rival's whereabouts. */
const INTRUDER_SEC = 8, WHEREABOUTS_SEC = 20;
const LOOT_RANGE = 35;
/** An enemy farther than this doesn't pull my gun off what my goal is shooting at (a plug, a wall). */
const SHOOT_AT_OVER_FOE_M = 25;
/**
 * Explosive props. PRO bots sometimes shoot a barrel standing next to an enemy instead of the enemy (a
 * roll every BARREL_ROLL_SEC while such a shot is on, so it's a choice, not a reflex); everyone keeps out of
 * blast range of live barrels while fighting and runs from a fusing one.
 */
// PRO only: reading a barrel next to an enemy is a PRO skill (measured: it is part of what keeps PRO ahead of hard).
const BARREL_CHANCE: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0, pro: 0.5 };
const BARREL_ROLL_SEC = 1.2, BARREL_AIM_SEC = 1.5;
/** Supply crates: only when this close (a short detour) and nothing else is going on. */
const CRATE_RANGE = 8;
const RAID_AT = 60;
/**
 * Sudden-death storm awareness: how many seconds ahead of the closing ring a bot moves in, the margin it keeps
 * inside the edge, and how long it takes to react to a telegraphed lightning strike (easy ones often don't).
 */
const STORM_LEAD: Record<Difficulty, number> = { easy: 1, medium: 8, hard: 12, pro: 14 };
const STORM_MARGIN: Record<Difficulty, number> = { easy: 0, medium: 3, hard: 4, pro: 4 };
const BOLT_REACT: Record<Difficulty, number> = { easy: 0.6, medium: 0.35, hard: 0.2, pro: 0.15 };
const EASY_DODGE = 0.4;
/** Medium+ bots bridge to the centre island (where the storm ends) from this long before sudden death. */
const STORM_PREP_SEC = 150;
/** Pieces that plug a doorway (sealKit counts tall pieces and sandbag pairs). */
const KIT_PIECES: PieceKind[] = ['steel', 'metal', 'wood', 'sandbags'];
/** Shop score of the trip for a rifle while out-ranged lately (strength.outranged). */
const RIFLE_TRIP = 0.7;
/** Storm goal score for leaving my bunker before sudden death's slabs drop (above every other goal), and how far past the doorway to go. */
const BARRIER_LEAVE = 2, BUNKER_EXIT = 3;
/** Spare decks carried for the bridge to the center; how long into the storm a shop trip out in it is still survivable (low dps). */
const STORM_SPARE_DECKS = 2, STORM_SHOP_GRACE = 45;
/**
 * The first STORM_SHOP_GRACE s of sudden death: the ring has barely moved, a shop trip is still safe. Counted from the
 * match's own sudden-death time (the lobby sets 8-25 min), not the default.
 */
export const inStormShopGrace = (view: Pick<BotView, 'now' | 'suddenDeathAt'>): boolean =>
  view.now - (view.suddenDeathAt ?? LIFECYCLE.suddenDeathAt) < STORM_SHOP_GRACE;
/** Share of top sprint speed a walk to the center island averages (turns, doorways, decks). */
const STORM_TRIP_PACE = 0.75;
const COVER_KINDS = new Set(['wood', 'metal', 'steel', 'container']);
/** Walls a bot throws down for cover, best first (sandbags go up two high). */
const WALLS: PieceKind[] = ['wood', 'metal', 'steel'];
/** Medium and Easy throw down the toughest wall they hold (main's behaviour; situational choice is a Hard/PRO skill). */
const PLAIN_WALLS: PieceKind[] = ['metal', 'wood', 'steel'];
/** Walls for holding a spot (home, a long hold, replacing a cracked wall): toughest first. */
const STRONG_WALLS: PieceKind[] = ['steel', 'metal', 'wood'];
/** Generator cash worth grabbing on the way out, and the level at which it is about to be wasted at the cap. */
const COLLECT_BEFORE_LEAVING = 40, COLLECT_NEAR_CAP = 400;
/** Grenades: throw range (outside the blast), minimum gap between throws, how stale a sighting may be. */
const NADE_MIN = 6.5, NADE_MAX = 22, NADE_GAP = 3, NADE_SEEN_SEC = 2.5;
/** Cash (carried + banked) at which a bot stocks up on grenades (steel seal kit: DriveParams.steelRich). */
const NADE_RICH: Record<Difficulty, number> = { easy: Infinity, medium: 900, hard: 450, pro: 400 };
/** Torching wooden bases: rocket range window (m), one rocket per gap (s), and the cash it takes to buy in. */
const TORCH_RANGE = [9, 45] as const, TORCH_GAP = 8, TORCH_RICH = 900;
/** After a torch shot, the launcher stays in hand this long past TORCH_GAP while I'm still in range of the base. */
const TORCH_KEEP_SEC = 6;
/** Rebuy money for after a death: pistol + a box of ammo. */
const INSURANCE = WEAPONS.pistol.price + 25;
/**
 * Clear of my own bunker (from its center): within SEAL.exitRadius of it while it's sealed starts the 10 s
 * escape countdown, so never hang around closer than this.
 */
const BUNKER_OUT = SEAL.exitRadius + 0.8;
/** Grappling hook: uses are weighed this often; a chosen one holds this long while I turn to fire it. */
const HOOK_CHECK_SEC = 0.25, HOOK_HOLD_SEC = 1.2;
/**
 * Cut off from home with no hook to buy and no way to bridge: hold out (fight, collect) this long before the last
 * resort, the water (a death; the respawn puts me home).
 */
const STRANDED_LAST_SEC = 90;
/** Goals that want me at home (hooked back to when I can't walk there). */
const HOME_GOALS = new Set<Goal>(['shop', 'bank', 'collect', 'fortify', 'defend', 'guard', 'heal']);

export { DRIVE } from './params';
/** Goals the watchdog keeps an eye on (DriveParams.stallSec; attack gets longer: it waits at doors). */
const STALLABLE = new Set<Goal>(['seal', 'attack', 'bridge', 'contest', 'raid', 'loot', 'shop', 'bank', 'fortify', 'cut', 'trap']);
/** Doorways per bunker. */
const MAP_DOORS = 3;
const TARGETED = new Set<Goal>(['seal', 'attack', 'bridge']);
const PUSH_GEAR: ShopItem[] = ['pistol', 'ammo', 'scaffold', 'wood', 'metal', 'steel', 'charge'];

/** What a goal wants this tick; aiming at enemies, weapons and safety are layered on top by think(). */
type Act = {
  dir: Vec3 | null;
  face?: Vec3;
  shootAt?: Vec3;
  /** Shoot `shootAt` even with an enemy in sight (e.g. the deck under someone crossing a bridge). */
  shootFirst?: boolean;
  /** Looking at `face` is the job (lining up a charge on a plug): a far-off enemy doesn't pull the view away. */
  lookFirst?: boolean;
  build?: BuildRequest;
  shop?: ShopItem;
  vault?: VaultAction;
  placeCharge?: boolean;
  /** Set a spike trap here (sim/traps.ts). */
  trap?: TrapRequest;
  sprint?: boolean;
  jump?: boolean;
  /** Sprint even with an enemy in sight (closing the distance). */
  approach?: boolean;
};
const IDLE: Act = { dir: null };

type Ctx = {
  view: BotView;
  me: PlayerState;
  home: IslandLayout;
  on: number;
  /** Island I'm working from: where I stand, or home when on a bridge. */
  src: number;
  rival: OtherStatus | null;
  rivalIsl: IslandLayout | null;
  enemy: PlayerState | null;
  enemyDist: number;
  reach: boolean;
  /**
   * Can't walk to the rival's island but can hook over: where to stand to fire (my shore facing them, or the tip of my
   * bridge toward them once it's within hook range), else null. Counts as a route for attack and seal.
   */
  hookFrom: Vec3 | null;
  /**
   * Node my rival stands on when it's worth going there instead of to their bunker: their bunker is sealed (no respawn
   * to wait for), they were seen there within drive.huntSeenSec, and I can't walk there. Bridge or hook over to it.
   */
  hunt: number | null;
  homeReach: boolean;
  openDoors: Doorway[];
  /** Node (island, or the center island) the next bridge goes to, and whether I can already walk to the center. */
  bridgeTo: number | null;
  /** Node that bridge is laid from: home, or where I stand when I can't walk home (e.g. left on a dead rival's island). */
  bridgeFrom: number;
  centerReach: boolean;
  /** Someone is shooting at me or close to me right now. */
  danger: boolean;
};

export class Bot {
  readonly personality: Personality;
  private readonly t: Traits;
  private style: ShopStyle;
  private goal: Goal = 'collect';
  private targetId: number | null = null;
  /** Teams: this bot is its team's home defender (one stays back while the others push). */
  private defender = false;
  /** Teams: waiting at the bridge head for the team (waitFor): on which rival, since when. */
  private waitRival: number | null = null;
  private waitSince = -Infinity;
  private hesitateUntil = -Infinity;
  private nextScoreAt = -Infinity;
  private lastNow = NaN;
  private readonly aim: Aim;
  private readonly nav = new Nav();
  private readonly mem = new Memory();
  private stuckRef: { pos: Vec3; t: number } | null = null;
  private unstickUntil = -Infinity;
  private unstickSide = 1;
  private unstickDir: Vec3 | null = null;
  private stuckAt: { pos: Vec3; t: number; n: number } | null = null;
  private strafeSign = 1;
  private strafeFlipAt = 0;
  private retreat: { from: Vec3; until: number } | null = null;
  /** Disengaging (doDisengage): from whom, until when that holds, and whether I'm on my way behind my bunker. */
  private flee: { id: number; until: number; home: boolean } | null = null;
  /** Who doFight is squaring up to (held through a blink out of sight). */
  private fightFoe: { id: number; e: PlayerState } | null = null;
  /** Goal I switched away from last and when (no thinking pause for flipping straight back); held goal noise. */
  private prevGoal: Goal | null = null;
  private switchAt = -Infinity;
  private noise = new Map<Goal, { v: number; until: number }>();
  /** doFight: stepping in (1), back (-1) or holding range (0) last tick. */
  private radialWas = 0;
  /** The island (nav node) I last stood on: out on a deck, where I walked out from. */
  private lastNode = -1;
  /** Settled into a cover spot (holdCover). */
  private inCover = false;
  private nextBuyAt = 0;
  private pendingBuy: { item: ShopItem; cash: number; at: number } | null = null;
  private buyFails = new Map<ShopItem, number>();
  private buyBlockedUntil = new Map<ShopItem, number>();
  /** Shot at in the open: who from, the wall(s) I put up, and the hide/peek rhythm behind it. */
  private cover: {
    threatId: number; threat: Vec3; lastContact: number; startAt: number; placed: number;
    phase: 'hide' | 'peek'; phaseUntil: number; side: number;
    /** When I first stood behind a wall in this episode; peeks so far; cracked walls I left (or rolled on). */
    heldSince: number | null; peeks: number; done: number[];
  } | null = null;
  private coverRollAt = -Infinity;
  /** Top of a ramp I threw down in a fight (high ground), while it lasts; how many ramps chained on so far. */
  private perch: { ramp: Vec3; pos: Vec3; until: number; dir: Vec3; chain: number } | null = null;
  /** This fight (fightSince) wants a ramp: rolled once per fight against buildSkill.ramp. */
  private rampRoll: { fight: number; yes: boolean } | null = null;
  /** Why my latest piece went down (spectator brain panel). */
  buildWhy: string | null = null;
  private fightSince: number | null = null;
  private retreatSince: number | null = null;
  private lastPieceAt = -Infinity;
  private slots: Slot[] | null = null;
  private buildMemo: { at: number; total: number; b: Partial<Record<PieceKind, number>> | undefined } | null = null;
  private slotBackoff = new Map<number, number>();
  /** Spike-trap spots (trapSpots index) that wouldn't take one: left alone until then. */
  private trapBackoff = new Map<number, number>();
  /** Last trap I tried to set: spot index and when (a spot still empty a moment later gets backed off). */
  private trapTry: { i: number; at: number } | null = null;
  /** Bridges: furthest deck reached per lane, islands I'm bridging to on the mirror lane (main one got cut), wall spacing. */
  private laneBest = new Map<string, number>();
  private alt = new Set<number>();
  private bridgeStuck: { key: string; since: number; triedAt: number } | null = null;
  private bridgeHoldUntil = -Infinity;
  /** Bridge targets given up on until then (a center lane whose last deck never fits). */
  private laneBan = new Map<number, number>();
  private mirrorCache = new Map<number, { at: number; f: { l: Lane; s: number; complete: boolean } }>();
  private lastWallS = new Map<string, number>();
  private wallsOnBridge: boolean;
  /** Telegraphed strikes already judged (easy bots notice only some), keyed by spot and time. */
  private bolts = new Map<string, boolean>();
  private wander: { to: Vec3; until: number } | null = null;
  /** Respawn-window push on a dead rival (sealRace), and when I last came back from the dead. */
  private window: { id: number; until: number } | null = null;
  private respawnedAt = -Infinity;
  private lastDeaths = 0;
  /** Goal watchdog: where I was when the current goal last made progress (moved, built, bought, shot). */
  private prog: { goal: Goal; at: number; pos: Vec3; far: number } | null = null;
  private lastDidAt = -Infinity;
  /** Goals (and the rival they were aimed at) that went nowhere lately: left alone a while. */
  private goalBan = new Map<Goal, number>();
  /**
   * Extra score per goal from outside (UserProxy, bots/userProxy.ts: its macro tree). Null for every normal bot: the
   * scores are then exactly as without it (adding 0 never changes a float).
   */
  goalBias: ((goal: Goal, view: BotView) => number) | null = null;
  private targetBan = new Map<number, number>();
  private lastNadeAt = -Infinity;
  /** Smoke / flash (utilityPlan.ts): last throw, and the last utility decision for the brain panel. */
  private utilLastAt = -Infinity;
  utilNote: { t: number; text: string } | null = null;
  private lastTorchAt = -Infinity;
  private lastTorchSpot: Vec3 | null = null;
  /** Healing (heal.ts): hp + shield last tick, damage in the current burst and when it began, last time hurt. */
  private lastEff = 0;
  private burst = 0;
  private burstAt = -Infinity;
  private lastDmgAt = -Infinity;
  /** This fight's rolls (coverFirst, reloadWeight), since when I've been breaking line of sight to heal. */
  private healRoll = { cover: true, reload: true };
  private healRng: () => number;
  private healHideAt: number | null = null;
  /** How I'd break line of sight to heal right now (cover close by or a wall to throw), or null: none at hand. */
  private healHideAct: Act | null = null;
  /** When I last started a heal mid-fight (heal.reHealSec commitment). */
  private fightHealAt = -Infinity;
  /** Last heal decision (spectators), heals wanted (stock target), slots dropped to fit a heal (not looted back). */
  private healNote: { t: number; text: string } | null = null;
  private healWant = 0;
  /** Last rifle hit that out-ranged my guns (strength.outranged): who and when. */
  private outranged: { id: number; t: number } | null = null;
  /** Sniper: since when the scoped crosshair has been on the current target (null = not steadying). */
  private steadySince: number | null = null;
  /** Last scope glint that sent me for cover (brain panel). */
  glintNote: { t: number; id: number } | null = null;
  /** Per-enemy beliefs (belief.ts): their gun and range against me, damage to me, kills. */
  readonly beliefs = new Beliefs();
  private lastHealDropAt = -Infinity;
  private healDrops: { pos: Vec3; t: number }[] = [];
  private grid: { key: string; grid: BunkerGrid } | null = null;
  private hideFrom: { pos: Vec3; until: number } | null = null;
  /** escape(): where I was when my grid path out last made headway; a path that doesn't move me is not a way out. */
  private escapeRef: { pos: Vec3; t: number } | null = null;
  private escapeNoPathUntil = 0;
  /** Low on stamina: walk (save it for escapes) until it's back up. */
  private winded = false;
  private lastScores: { goal: string; score: number }[] = [];
  private nadePlan: { yaw: number; pitch: number; until: number } | null = null;
  /** The enemy my gun is on (target hysteresis, see aimTarget) and since when; where I last saw them. */
  private aimId: number | null = null;
  private aimSince = 0;
  private aimAt: Vec3 | null = null;
  private aimLost: { at: Vec3; until: number } | null = null;
  private barrelPlan: { id: number; until: number } | null = null;
  private nextBarrelRollAt = 0;
  /** Grappling hook: what I'm about to use it for, when I next weigh it, and the last use (spectators). */
  private hookIntent: (HookIntent & { until: number }) | null = null;
  private nextHookCheck = 0;
  /** When I noticed I'm stranded with no way home (strandedDitch). */
  private strandedSince: number | null = null;
  hookNote: { t: number; text: string } | null = null;
  /** Blowing out a pier section under an enemy (or under the piece they hide behind): which, how, and why. */
  private dockPlan: { id: number; enemy: number; at: Vec3; weapon: 'rocket' | 'grenade'; why: 'under' | 'cover' | 'defend'; until: number } | null = null;
  private nextDockRollAt = 0;
  /** Burst discipline (params.ts gunSkill): shots fired in the current burst, and the pause after it. */
  private burstN = 0;
  private burstRestUntil = -Infinity;
  private seenShotAt = -Infinity;
  /** Weapon in hand (params.ts weapon): what I want and why (spectators), and when the hand last changed (hold). */
  weaponIntent: { want: WeaponKind; why: string } | null = null;
  private lastEquipped: WeaponKind | null = null;
  private swappedAt = -Infinity;
  private view!: BotView;
  /** Greedy/opportunist bots bridge to the center island first and contest its bonus stations. */
  private readonly centerMinded: boolean;
  /** Spectator introspection (introspect.ts): set only while someone watches this bot; decisions never read it. */
  probe: BrainProbe | null = null;
  /** Last goal switches (introspect.ts decision log): one small entry per switch. */
  readonly switches: GoalSwitch[] = [];
  /** The walk this tick (world space, null = standing) and which layer decided it (moveStats.ts jitter diagnostics;
   *  decisions never read them). */
  moveDir: Vec3 | null = null;
  moveSrc = '';

  /** `params`: tunable strategy (params.ts); the hand-tuned defaults unless a trainer passes its own. */
  constructor(
    readonly id: number, readonly difficulty: Difficulty, private readonly rng: () => number, personality?: Personality,
    private P: BotParams = DEFAULT_BOT_PARAMS,
  ) {
    this.personality = personality ?? rollPersonality(rng);
    this.t = this.personality.traits;
    this.style = this.shopStyle();
    const t = this.t;
    // Aim noise draws every tick while tracking: its own stream (seeded from the match rng's state without
    // drawing from it), so how a bot's hand wobbles never shifts the match's other random rolls. A plain function
    // (hand-made test rng) has no state to read: one draw seeds it.
    const base = isRng(rng) ? rng.state.a : Math.floor(rng() * 4294967296);
    const aimSeed = (base ^ Math.imul(id, 0x9e3779b1) ^ 0x6a09e667) >>> 0;
    this.aim = new Aim({ ...AIM[difficulty], recoilComp: P.gunSkill[difficulty].recoilComp }, mulberry32(aimSeed), P.aim.feel[difficulty]);
    // Heal habits roll on their own stream too (like the aim hand): healing never shifts the match's other rolls.
    this.healRng = mulberry32((base ^ Math.imul(id, 0x85ebca6b) ^ 0x3c6ef372) >>> 0);
    this.wallsOnBridge = rng() < Math.min(1, 0.3 + t.builder);
    this.centerMinded = 0.6 * t.greed + 0.4 * t.opportunism > 0.55;
  }

  get currentGoal(): Goal { return this.goal; }
  /** Rival this bot is currently going after (player id), if any. */
  get currentTarget(): number | null { return this.targetId; }
  /** Teams: stays home to defend while teammates push (told to teammates, shown to spectators). */
  get teamDefender(): boolean { return this.defender; }
  /** Hazard id this bot is deliberately shooting to catch an enemy in the blast, if any. */
  get barrelTarget(): number | null { return this.barrelPlan?.id ?? null; }
  /** Pier section this bot is trying to blow out from under an enemy, if any. */
  get dockTarget(): number | null { return this.dockPlan?.id ?? null; }
  /** The top goal scores of the last decision (why it chose what it's doing), for spectators. */
  get planScores(): { goal: string; score: number }[] { return this.lastScores; }
  /**
   * Burst discipline against recoil and bloom: with an automatic gun past my spray range, stop after
   * `burstShots` shots for `burstPause` s (the climb and bloom settle, then the next burst lands). Up close: full auto.
   * Counts real shots (the sim's lastShotAt moving), so a held trigger between shots doesn't count.
   */
  private burstRest(now: number, me: PlayerState, dist: number): boolean {
    const g = this.P.gunSkill[this.difficulty];
    if (me.lastShotAt !== this.seenShotAt) { this.seenShotAt = me.lastShotAt; if (me.lastShotAt > 0) this.burstN++; }
    if (now < this.burstRestUntil) return true;
    if (WEAPONS[me.equipped].rps < 5 || dist <= g.sprayRange) { this.burstN = 0; return false; }
    if (this.burstN >= g.burstShots) { this.burstN = 0; this.burstRestUntil = now + g.burstPause; return true; }
    return false;
  }

  /** Start / stop recording decisions for a spectator (read-only: never changes what the bot does). */
  watch(on: boolean) { this.probe = on ? this.probe ?? new BrainProbe(this) : null; }
  /** What it's thinking, for the brain inspector (starts recording if it wasn't). */
  debugBrain(): BrainDigest { this.watch(true); return debugBrain(this); }

  think(view: BotView): PlayerInput {
    const me = view.self;
    if (me.id !== this.id) throw new Error(`Bot ${this.id} was given the view of player ${me.id}`);
    if (view.generators.length !== view.map.length || view.sealed.length !== view.map.length)
      throw new Error(`Bot ${this.id}: view has ${view.map.length} islands but ${view.generators.length} generators / ${view.sealed.length} seal flags`);
    const now = view.now;
    // Match doesn't call dead bots: a gap of more than a couple of ticks means I just respawned (new body, new
    // facing). Start the aim hand fresh instead of whipping it over the whole gap or "compensating" toward my old aim.
    const skipped = !Number.isNaN(this.lastNow) && now - this.lastNow > 2.5 * DT;
    if (skipped) { this.aim.reset(); this.aimId = null; this.aimLost = null; }
    const dt = Number.isNaN(this.lastNow) || skipped ? DT : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    this.mem.update(view);
    this.beliefs.update(view);
    this.noteOutranged(view);
    if (!me.alive) {
      this.moveDir = null;
      this.aim.reset();
      this.aimId = null;
      this.aimLost = null;
      this.stuckRef = null;
      this.retreat = null;
      this.flee = null;
      this.lastNode = -1;
      this.fightFoe = null;
      this.inCover = false;
      this.pendingBuy = null;
      this.nadePlan = null;
      this.hideFrom = null;
      this.barrelPlan = null;
      this.cover = null;
      this.perch = null;
      this.fightSince = null;
      this.hookIntent = null;
      this.strandedSince = null;
      this.healHideAt = null;
      this.lastEff = 0;
      this.nextScoreAt = -Infinity;
      return { ...NO_INPUT, yaw: me.yaw, pitch: me.pitch };
    }
    this.view = view;
    this.nav.begin(view);
    const onNode = this.nav.nodeAt(me.pos);
    if (onNode >= 0) this.lastNode = onNode;
    this.checkPurchase(me, now);
    // Came back from a death (bots aren't ticked while dead): note it for respawnCautionSec.
    if (me.deaths !== this.lastDeaths) { this.lastDeaths = me.deaths; this.respawnedAt = now; this.window = null; }
    this.defender = this.isDefender(view);
    this.sealRace(view);
    if (now >= this.nextScoreAt) this.chooseTarget(view);
    const ctx = this.context(view);
    this.coverTrigger(ctx);
    if (now >= this.nextScoreAt) {
      const next = this.pick(ctx);
      if (next !== this.goal) {
        // Thinking it over is for a new plan, not for going back to the one I just dropped (a near-tie that tips
        // back and forth would otherwise restart the thinking at every rescore and never act).
        const back = next === this.prevGoal && now - this.switchAt < FLIP_BACK_SEC;
        if (!back) this.hesitateUntil = now + HESITATE_SEC[this.difficulty] * (0.5 + this.rng());
        this.prevGoal = this.goal;
        this.switchAt = now;
        noteSwitch(this.switches, this.probe, this.lastScores, now, this.goal, next);
      }
      this.goal = next;
      if (next === 'disengage' || next === 'heal') this.retreatSince ??= now;
      else this.retreatSince = null;
      if (next !== 'fight') this.fightSince = null;
      else if (this.fightSince === null) this.fightSince = now;
      this.nextScoreAt = now + RESCORE_SEC[this.difficulty] * (0.75 + 0.5 * this.rng());
    }
    this.watchdog(now, me);
    if (this.retreat && now >= this.retreat.until) this.retreat = null;
    // Still deciding what to do next: stand and look around (fighting back still happens below).
    const thinking = now < this.hesitateUntil && !ctx.enemy && this.goal !== 'disengage' && this.goal !== 'storm';
    this.buildWhy = null;
    this.moveSrc = this.retreat ? 'retreat' : thinking ? 'hesitate' : this.goal;
    let act = this.retreat ? { dir: norm(flat(sub(me.pos, this.retreat.from))) } : thinking ? IDLE : this.act(this.goal, ctx);
    // Cut off from home: get a hook here and hook home (fighting comes first: enemies in sight keep the goal's act).
    const rescue = this.strandedAct(ctx);
    if (rescue && !ctx.enemy) { act = rescue; this.moveSrc = 'stranded'; }
    // An enemy spike trap in my way with nobody in sight: shoot it out before walking on.
    if (!ctx.enemy && !act.shootAt && !act.build && !act.trap) {
      const spikes = this.trapInWay(ctx, act.dir);
      if (spikes) act = { ...act, shootAt: spikes };
    }
    // Never hang around inside my own bunker (one plug per door and I'm sealed in): step out.
    if (!act.dir && this.goal !== 'defend' && !this.trapped(ctx) && insideBunker(ctx.home.bunker, me.pos)) { act = { ...act, ...this.escape(ctx) }; this.moveSrc = 'escape'; }
    // Healing (heal.ts), mid-fight included: low with them in my face, break line of sight first (cover, a wall, back off).
    const heal = this.healDecide(ctx);
    if (ctx.enemy && this.healHideAct && this.healHideAt !== null && this.goal !== 'storm' && (heal?.act === 'hide' || heal?.act === 'wait')) act = this.healHideAct;
    // Passing the potion seller short of heals or shields: step over and buy.
    const detour = !ctx.enemy && !heal && !act.shop && !act.build ? this.sellerDetour(ctx) : null;
    if (detour) act = detour;
    const dropSlot = !ctx.enemy && heal?.act !== 'use' && !act.build && !act.shop ? this.healDrop(ctx) : null;

    // Aim: enemies first, then whatever the goal wants to look or shoot at, else along the walk.
    const eye = eyePos(me);
    const cur: Angles = { yaw: me.yaw, pitch: me.pitch };
    // Every look goes through the aim hand (Aim.look: eased, speed- and acceleration-capped); `want` is where to.
    const hand = (want: Angles, rate: number) => this.aim.look(cur, want, dt, rate);
    let look: Angles;
    let fire = false;
    const enemy = ctx.enemy;
    const foe = this.aimTarget(view, enemy, now);
    // Medium+ tactic: a rocket into a rival's wooden base sets it burning (fire.ts).
    const torch = enemy || this.goal === 'disengage' ? null : this.torchTarget(ctx);
    const dock = enemy ? this.dockShot(ctx) : null;
    const W = this.P.weapon;
    // Shotgun range with hysteresis: holding it, keep it a bit past 8 m (no flip-flop as they step in and out).
    const best = torch || dock?.weapon === 'rocket' ? 'rocket'
      : bestGun(me.inv, enemy ? ctx.enemyDist : 30, me.equipped === 'shotgun' ? 8 + W.shotgunHyst : 8, this.sniperM(me));
    const gunReady = (range: number) => {
      const w = me.equipped;
      const ammo = w === 'fists' ? null : me.inv.weapons[w];
      return me.reloadUntil === 0 && me.busyUntil <= now && range <= WEAPONS[w].range * 0.95 && (w === 'fists' || !!ammo && ammo.mag > 0);
    };
    let throwGrenade = false;
    // Grappling hook (hook.ts): get away, cross over, or yank an enemy; on my own rope, look where it pulls.
    const hook = this.hookPlan(ctx, best);
    const rope = me.mv?.pull && !me.mv.pull.yank ? me.mv.pull : null;
    let grapple = false;
    const nade = enemy || this.goal === 'disengage' ? null : this.grenadePlan(ctx);
    const barrel = enemy && !dock ? this.barrelShot(ctx) : null;
    const util = this.utilSituation(ctx, !!heal && (heal.act === 'hide' || heal.act === 'wait' || heal.act === 'use'));
    const utilPlan = planUtility(util);
    const utilAim = utilPlan ? utilAngles(eye, utilPlan.at, utilPlan.kind) : null;
    let throwUtil: UtilityKind | undefined;
    if (act.shootAt && act.shootFirst && me.breakoutUntil !== null) {
      // Countdown running: the plug in my way beats everything else (no hook, barrel or pier tricks first).
      look = hand(lookAt(eye, act.shootAt), TURN_RATE);
      fire = angleBetween(look, lookAt(eye, act.shootAt)) < 0.05 && gunReady(dist2D(me.pos, act.shootAt));
    } else if (hook && hook.why !== 'yank') {
      const want = lookAt(eye, hook.to);
      look = hand(want, TURN_RATE * 1.5);
      grapple = angleBetween(look, want) < 0.02;
    } else if (rope && !enemy) {
      look = hand(lookAt(eye, rope), TURN_RATE);
    } else if (dock?.weapon === 'rocket') {
      // Blow the planks out from under them: aim at the deck at their feet (the blast catches them too), held
      // over for the rocket's drop at that range.
      const tof = dist2D(eye, dock.at) / ROCKET.speed;
      const want = lookAt(eye, v3(dock.at.x, dock.at.y + 0.5 * ROCKET.gravity * tof * tof, dock.at.z));
      look = hand(want, TURN_RATE * 1.2);
      fire = me.equipped === 'rocket' && angleBetween(look, want) < 0.035 && gunReady(dist2D(me.pos, dock.at));
    } else if (dock) {
      const a = throwAngles(eye, dock.at, false);
      if (a) {
        look = hand(a, TURN_RATE * 1.2);
        if (angleBetween(look, a) < 0.03 && me.busyUntil <= now) { throwGrenade = true; this.lastNadeAt = now; this.dockPlan = null; }
      } else { this.dockPlan = null; look = hand(cur, TURN_RATE); } // no throw arc: hold the view, re-plan next tick
    } else if (barrel) {
      // Set the barrel next to them off: aim at its middle like any other shot.
      look = hand(lookAt(eye, barrel), TURN_RATE * 1.2);
      fire = angleBetween(look, lookAt(eye, barrel)) < 0.04 && gunReady(dist2D(me.pos, barrel));
    } else if (act.shootAt && act.shootFirst) {
      look = hand(lookAt(eye, act.shootAt), TURN_RATE);
      fire = angleBetween(look, lookAt(eye, act.shootAt)) < 0.05 && gunReady(dist2D(me.pos, act.shootAt));
    } else if (utilPlan && utilAim) {
      // Smoke / flash (utilityPlan.ts): line the throw up, then let go.
      look = hand(utilAim, TURN_RATE * 1.5);
      if (angleBetween(look, utilAim) < 0.04 && me.busyUntil <= now) {
        throwUtil = utilPlan.kind;
        this.utilLastAt = now;
        this.utilNote = { t: now, text: utilPlan.why };
      }
    } else if (foe && !((act.shootAt || act.lookFirst) && dist2D(foe.pos, me.pos) > SHOOT_AT_OVER_FOE_M)) {
      // (A goal's own target, e.g. a plug in my doorway, beats a far-off enemy I wouldn't hurt anyway.)
      // Only a head showing over a crate: aim for that (the body behind it would only put holes in the crate).
      const aimY = view.peeking?.includes(foe.id) ? HEAD.y : CHEST;
      // Looking through a sniper scope steadies the hand (sniper.scopeAim shrinks the aim cone).
      const scoped = me.equipped === 'sniper' && me.ads;
      const r = this.aim.track(now, dt, eye, add(foe.pos, v3(0, aimY, 0)), foe.id, cur, scoped ? this.P.sniper.scopeAim[this.difficulty] : 1);
      look = r;
      const foeDist = dist2D(foe.pos, me.pos);
      // Past where my gun still does real damage (falloff floor), don't give my position away for scratches,
      // unless they're the one shooting at me.
      const w = WEAPONS[me.equipped];
      const hittingMe = this.mem.lastHurtBy === foe.id && now - this.mem.lastHurtAt < 3;
      const scratch = this.difficulty !== 'easy' && foeDist > w.falloff.end * this.P.drive.fireRangeMult && !hittingMe;
      // Not on my island and far: no drive-by shots across the water (close in and fight instead), unless they're on me
      // or they're the last rival standing (nobody else to give my position away to: a duel is won on first damage).
      // Islands by nav node, so the center island counts as one (islandAt says -1 there, like water).
      const myNode = this.nav.nodeAt(me.pos);
      // (The sniper is for exactly those shots: sniper.crossShots.)
      const across = foeDist > this.P.drive.crossFire[this.difficulty] && !hittingMe &&
        !(me.equipped === 'sniper' && this.P.sniper.crossShots[this.difficulty] >= 0.5) &&
        view.others.some((o) => !o.eliminated && o.id !== foe.id) &&
        (myNode < 0 || this.nav.nodeAt(foe.pos) !== myNode);
      fire = r.ready && r.onTarget && gunReady(foeDist) && !scratch && !across && !this.burstRest(now, me, foeDist);
      // Sniper: scoped in, then on target for sniper.steadySec before the shot (a steady shot, not a hip flick).
      if (me.equipped === 'sniper') {
        const steady = scoped && r.ready && r.onTarget && gunReady(foeDist) && !across;
        this.steadySince = steady ? this.steadySince ?? now : null;
        if (fire) fire = steady && now - this.steadySince! >= this.P.sniper.steadySec[this.difficulty] - 1e-9;
      }
      if (hook?.why === 'yank' && hook.target === foe.id && r.ready && r.onTarget) { grapple = true; fire = false; }
    } else if (nade) {
      look = hand(nade, TURN_RATE);
      if (angleBetween(look, nade) < 0.03 && me.busyUntil <= now) {
        throwGrenade = true;
        this.lastNadeAt = now;
        this.nadePlan = null;
      }
    } else if (torch) {
      const want = lookAt(eye, torch);
      look = hand(want, TURN_RATE);
      fire = me.equipped === 'rocket' && angleBetween(look, want) < 0.03 && gunReady(dist2D(me.pos, torch));
      if (fire) { this.lastTorchAt = now; this.lastTorchSpot = torch; }
    } else if (act.shootAt) {
      look = hand(lookAt(eye, act.shootAt), TURN_RATE);
      fire = angleBetween(look, lookAt(eye, act.shootAt)) < 0.05 && gunReady(dist2D(me.pos, act.shootAt));
    } else if (act.face) {
      look = hand(lookAt(eye, act.face), TURN_RATE);
    } else if (this.aimLost && !act.build) {
      // Just lost sight of who I was shooting at: keep my eyes on where they were a moment (walking still works:
      // movement is relative to the view), instead of whipping round to the walk direction and back.
      look = hand(lookAt(eye, this.aimLost.at), this.aim.maxTurn);
    } else if (act.dir) {
      look = hand({ yaw: yawOf(act.dir), pitch: 0 }, TURN_RATE);
    } else {
      look = hand(cur, TURN_RATE); // nothing to look at: the hand comes to rest
    }

    if (me.equipped !== 'sniper' || !foe) this.steadySince = null;
    // Weapons: hold the best gun, reload when nobody is in sight.
    const ammo = me.equipped === 'fists' ? null : me.inv.weapons[me.equipped];
    const slot = this.weaponSlot(ctx, act, best, !!torch, dock?.weapon === 'rocket', grapple);
    if (slot) fire = false;
    // An empty mag gets reloaded whoever is in sight (a full one only tops up when nobody is).
    const reload = !slot && !!ammo && me.reloadUntil === 0 && ammo.spare > 0 &&
      (ammo.mag === 0 || (!enemy && ammo.mag < WEAPONS[me.equipped].mag * 0.6));

    // Movement: stuck recovery, then never step toward water.
    // Lining up a crossing: stand still for the shot (walking on would only take me off the edge).
    let dir = hook?.why === 'cross' ? null : act.dir;
    let jump = !!act.jump;
    // (Diagnostics: a layer that turns the walk by more than ~30° takes the credit for it in moveSrc.)
    const turned = (a: Vec3 | null, b: Vec3 | null, src: string) => {
      if (a === b) return;
      if (!a || !b || a.x * b.x + a.z * b.z < 0.87) this.moveSrc = src;
    };
    // Steadying a sniper shot: stand still (moving widens the cone), unless I'm getting away or being hit.
    if (this.steadySince !== null && this.goal !== 'disengage' && this.goal !== 'storm' && now - this.mem.lastHurtAt > 1 && !act.build) {
      dir = null; jump = false; this.moveSrc = 'sniperSteady';
    }
    const dodge = this.dodgeBolt(me, view);
    if (dodge) { dir = dodge; act = { ...act, sprint: true }; this.moveSrc = 'dodgeBolt'; }
    // Blinded: back off or hold; never push a fight into their smoke (utilityPlan.ts).
    const react = dodge ? null : utilReact(util, dir);
    if (react) { dir = react.dir; this.moveSrc = 'utility'; if (now - (this.utilNote?.t ?? -Infinity) > 1) this.utilNote = { t: now, text: react.note }; }
    if (now < this.unstickUntil) {
      // Step aside; stuck again at the same spot, back off further each time (around whatever is in the way).
      dir = this.unstickDir ?? scale(right(look.yaw), this.unstickSide);
      jump = true;
      this.moveSrc = 'unstick';
    }
    let was = dir;
    if (!dodge) dir = this.hazardAvoid(ctx, dir);
    turned(was, dir, 'hazard'); was = dir;
    if (dir && !dodge) dir = this.stormFence(me, view, dir);
    turned(was, dir, 'stormFence'); was = dir;
    if (dir) dir = this.nav.safeDir(dir);
    turned(was, dir, 'safeDir'); was = dir;
    // Sudden death: concrete barriers fill every doorway (barriers.ts). Inside a bunker no step leads out: whatever
    // the goal wants, don't push into a slab (the stuck recovery would only thrash about the room).
    if (dir && view.suddenDeath)
      for (const isl of view.map)
        if (insideBunker(isl.bunker, me.pos) && !insideBunker(isl.bunker, add(me.pos, scale(dir, 0.6)))) { dir = null; break; }
    // The slabs drop any moment (drive.barrierLead): no step into a bunker, whatever the goal (inside = out of the game).
    if (dir && this.sealingSoon(view))
      for (const isl of view.map)
        if (!insideBunker(isl.bunker, me.pos) && insideBunker(isl.bunker, add(me.pos, scale(dir, 0.6)))) { dir = null; break; }
    turned(was, dir, 'barrier'); was = dir;
    // Never walk into (or stand in) fire: slide around burning pieces and ground fires (a lightning dodge wins).
    const zones = this.avoidZones(view, me);
    if (zones.length && !dodge) {
      const away = steerFromFire(me.pos, dir, zones);
      if (away !== dir) dir = away && this.nav.safeDir(away);
    }
    turned(was, dir, 'fire'); was = dir;
    // In the air, steer to come down on something solid; standing on the rim over water, step back onto it.
    const airborne = Math.abs(me.vel.y) > 0.05;
    // (Mid-stride over a short gap toward a floor, e.g. a bridge's last metre: keep going.)
    if (airborne ? !this.nav.landsOnGround(dir, !!act.sprint) : view.groundAt(me.pos.x, me.pos.z) === null && !(dir && this.nav.crossable(me.pos, dir))) {
      const back = this.nav.rescue(!!act.sprint);
      if (back) { dir = back; jump = false; }
    }
    turned(was, dir, 'rimRescue');
    // Stranded with no way home at all: walk off into the water toward home (the respawn puts me back there).
    const ditch = this.strandedDitch(ctx);
    if (ditch) { dir = ditch; jump = false; act = { ...act, sprint: true }; this.moveSrc = 'ditch'; }
    this.moveDir = dir;
    // Stuck means pushing and not moving; held back at an edge by safeDir isn't stuck (a hop there goes in the water).
    this.trackStuck(now, me, dir);
    // Only jump where the arc comes down on something solid (never sideways off a deck or an island edge).
    if (jump && !this.nav.safeJump(dir, !!act.sprint)) jump = false;
    if (rope || grapple) jump = false; // a jump lets go of the rope
    const move = dir
      ? { moveX: dir.x * right(look.yaw).x + dir.z * right(look.yaw).z, moveZ: dir.x * forward(look.yaw).x + dir.z * forward(look.yaw).z }
      : { moveX: 0, moveZ: 0 };

    // Heals (heal.ts): between fights, and mid-fight out of their sight, while they reload, or when there's no cover.
    // Using one puts the gun away (a reload in progress is lost): wait for the reload unless I'm low.
    let select: number | null = null, useMedkit = false, drink = false;
    const lowNow = me.hp + me.shield <= this.P.heal.fightHp[this.difficulty];
    // (Healing in front of them: the smoke goes up first, then the medkit.)
    const smokeFirst = utilPlan?.kind === 'smoke' && !!enemy;
    if (heal?.act === 'use' && heal.slot >= 0 && !grapple && !act.placeCharge && !smokeFirst && (me.reloadUntil === 0 || lowNow)) {
      select = heal.slot; fire = false; throwGrenade = false;
      if (heal.item === 'medkit') useMedkit = true; else drink = true;
      this.healNote = { t: now, text: heal.why };
      if (enemy || now - this.mem.lastHurtAt < this.P.heal.quietSec) this.fightHealAt = now;
    }
    // Stamina (movement.ts): like a human, stop sprinting around when winded and keep the rest for getting away.
    if (me.stamina < 30) this.winded = true; else if (me.stamina > 70) this.winded = false;
    const cv = view.center;
    const interact = view.map.some((isl) => view.generators[isl.index] >= 1 && dist2D(me.pos, isl.generator) <= USE_RANGE) ||
      (!!cv && ((cv.gold >= 1 && dist2D(me.pos, cv.island.goldGen) <= USE_RANGE) || (cv.bags + cv.steel > 0 && dist2D(me.pos, cv.island.supplyGen) <= USE_RANGE)));
    if (act.shop) this.pendingBuy = { item: act.shop, cash: funds(me), at: now };
    if (act.shop || act.build || act.vault || act.placeCharge || act.trap || fire || throwGrenade || throwUtil) this.lastDidAt = now;
    if (act.build) {
      this.lastPieceAt = now;
    }
    if (grapple) {
      select = me.hotbar.indexOf('grapple');
      useMedkit = false;
      this.hookNote = { t: now, text: hook!.note };
      this.hookIntent = null;
      this.lastDidAt = now;
    }
    this.probe?.acted(act, look, fire);
    const out = {
      ...NO_INPUT, ...move, yaw: look.yaw, pitch: look.pitch, jump,
      sprint: !!act.sprint && (!enemy || this.goal === 'disengage' || !!act.approach || this.healHideAt !== null) && (!this.winded || this.goal === 'disengage' || !!this.retreat),
      fire, reload: reload && !useMedkit && !drink, interact, slot: useMedkit || drink ? null : slot, select, useMedkit, drink,
      build: useMedkit || drink ? null : act.build ?? null, shop: act.shop && !useMedkit && !drink ? { buy: act.shop } : null,
      vault: this.withLoadout(me, act.vault), placeCharge: !!act.placeCharge, throwGrenade, ...(act.trap ? { trap: act.trap } : {}), ...(throwUtil && !useMedkit && !drink ? { throwUtil } : {}),
      ...(grapple ? { grapple: true, build: null, shop: null } : {}),
      // Same spread rules as players: aim down sights for anything past close range.
      ads: !!enemy && me.equipped !== 'fists' && ctx.enemyDist > 8,
    };
    // Potions: stock up at a potion seller (heal potions toward the heal stock, then shields), drink out of combat.
    if (!act.shop && !act.build && !fire && !useMedkit && !drink && !throwGrenade && !throwUtil && !act.placeCharge && !grapple) {
      const atSeller = (view.potionShops ?? []).some((s) => dist2D(me.pos, s) <= USE_RANGE);
      const pot = potionAction(me, now, !!enemy, atSeller, this.healWant);
      if (pot && 'buy' in pot) out.shop = { buy: pot.buy };
      // (Not mid-reload: drinking takes the gun out of my hands and the reload with it; it can wait a moment.)
      else if (pot && me.reloadUntil === 0) Object.assign(out, { select: pot.drink, slot: null, drink: true });
      else if (dropSlot !== null && select === null) Object.assign(out, { select: dropSlot, slot: null, drop: 'stack' as const });
    }
    return out;
  }

  /**
   * Which weapon to switch to this tick (null = keep what's in hand), like a strong human: commit to a weapon for
   * weapon.holdSec after a switch, finish a reload (a switch cancels it) unless a real threat needs a loaded gun now,
   * don't pick up an empty rocket launcher with an enemy in sight, and reload an empty launcher in a quiet moment (switch to it,
   * reload, switch back) so it's loaded when a pier or a wooden base calls for it.
   */
  private weaponSlot(c: Ctx, act: Act, best: WeaponKind, torch: boolean, dock: boolean, grapple: boolean): WeaponKind | null {
    const { me, enemy } = c, now = c.view.now, W = this.P.weapon;
    if (me.equipped !== this.lastEquipped) { this.lastEquipped = me.equipped; this.swappedAt = now; }
    const ammo = me.equipped === 'fists' ? null : me.inv.weapons[me.equipped];
    const rocket = me.inv.weapons.rocket;
    const threat = !!enemy && (c.enemyDist < W.threatM || now - this.mem.lastHurtAt < W.hurtSec);
    let want = best;
    let why = torch ? 'rocket: torch a wooden base' : dock ? 'rocket: blow the pier out under them' : `${best}: best at this range`;
    if (best === 'sniper' && me.equipped === 'sniper' && enemy)
      why = this.steadySince !== null ? `sniper: scoped, steadying ${(now - this.steadySince).toFixed(1)}/${this.P.sniper.steadySec[this.difficulty]} s` : `sniper: scoping @${enemy.id} at ${Math.round(c.enemyDist)} m`;
    if (want === 'rocket' && rocket && rocket.mag === 0 && enemy) {
      want = bestGun(me.inv, c.enemyDist, 8, this.sniperM(me));
      why = `${want}: no time to reload the rocket`;
    } else if (want !== 'rocket' && this.difficulty !== 'easy' && !enemy && rocket && rocket.mag === 0 && rocket.spare > 0 &&
        now - this.mem.lastHurtAt > 2 && this.goal !== 'disengage' && this.goal !== 'storm' &&
        !act.shootAt && !act.build && !act.trap && !act.placeCharge && !act.shop && !act.vault) {
      want = 'rocket';
      why = 'rocket: reload it between fights';
    } else if (want !== 'rocket' && me.equipped === 'rocket' && !threat && rocket && rocket.mag + rocket.spare > 0 &&
        this.lastTorchSpot && now - this.lastTorchAt < TORCH_GAP + TORCH_KEEP_SEC && dist2D(me.pos, this.lastTorchSpot) <= TORCH_RANGE[1]) {
      // Torching a base, still in range of it and nobody on me (weapon.threatM): the next shot comes once the fire dies
      // down. Keep the launcher in hand (reloading it) instead of a rifle round trip per shot for a long-range plink
      // (two switches each; a bot holding its spot in cover by a rival's wooden base did that every ~10 s).
      want = 'rocket';
      why = 'rocket: next torch shot';
    }
    const loaded = (w: WeaponKind) => w === 'fists' || (me.inv.weapons[w]?.mag ?? 0) > 0;
    let slot: WeaponKind | null = null;
    if (!grapple && want !== me.equipped) {
      const out = !!ammo && ammo.mag + ammo.spare <= 0;
      // Empty in a fight: draw a loaded gun (dropping a rocket reload only for a real threat).
      const draw = !loaded(me.equipped) && loaded(want) && (me.equipped === 'rocket' ? threat : !!enemy);
      if (out || draw) slot = want;
      else if (me.reloadUntil > 0) why = `${me.equipped}: finishing the reload`;
      // A loaded rocket I drew for a shot stays drawn a while (it gets fired, at the pier or at them), unless they're on me.
      else if (now - this.swappedAt < (me.equipped === 'rocket' && !threat ? W.rocketHoldSec : W.holdSec)) why = `${me.equipped}: just drew it`;
      else slot = want;
    }
    this.weaponIntent = { want, why };
    return slot;
  }

  /**
   * Grappling hook: what (if anything) to use it for now (hook.ts). Weighed every HOOK_CHECK_SEC; a choice holds
   * HOOK_HOLD_SEC while I turn to fire. Order: escape when nearly dead, a yank that pays (keeping uses back for a
   * crossing I still need), then a crossing (never with an enemy in sight).
   */
  private hookPlan(c: Ctx, gun: WeaponKind): HookIntent | null {
    const me = c.me, now = c.view.now, H = this.P.hook;
    if (!hookReady(me, now)) { this.hookIntent = null; return null; }
    if (this.hookIntent && now < this.hookIntent.until) return this.hookIntent;
    this.hookIntent = null;
    if (now < this.nextHookCheck) return null;
    this.nextHookCheck = now + HOOK_CHECK_SEC;
    const e = c.enemy, want = this.hookNode(c);
    let it: HookIntent | null = null;
    if (e && c.enemyDist <= H.escapeNear && me.hp + me.shield < H.escapeHp) it = escapeFrom(c.view, H, e.pos, (p) => this.nav.nodeAt(p));
    // No yanks from a bridge or deck over the water: a miss latches whatever is behind them and reels me off it.
    if (!it && e && (me.inv.grapples ?? 0) > (want !== null ? H.keepForTravel : 0) && this.nav.nodeAt(me.pos) >= 0) {
      const why = yankReason(c.view, H, e, c.enemyDist, gun);
      if (why && this.rng() < H.yankRate * HOOK_CHECK_SEC) it = { why: 'yank', target: e.id, note: why };
    }
    if (it?.why === 'escape' && !this.canReturn(c, it.node)) it = null;
    // Never escape out into the storm.
    const st = c.view.storm;
    if (it?.why === 'escape' && st && Math.hypot(it.to.x - st.x, it.to.z - st.z) > this.stormSafeR(st)) it = null;
    // Crossing: not with someone close (a rope ride is a free target), but someone far off across the water doesn't
    // stop a push.
    if (!it && (!e || c.enemyDist > H.escapeNear) && want !== null && this.nav.nodes[want] && this.canReturn(c, want)) it = crossTo(c.view, H, this.nav.nodes[want]);
    if (it) this.hookIntent = { ...it, until: now + HOOK_HOLD_SEC };
    return it;
  }

  /**
   * Would hooking over to node `to` leave me a way home from there: it is home, a walkable bridge leads home, a
   * hook stays in hand for the trip back (HookParams.keepForTravel, at least 1), or I carry the scaffolds to bridge it.
   */
  private canReturn(c: Ctx, to: number): boolean {
    const home = c.home.index;
    if (to === home || this.nav.hop(to, home) !== null) return true;
    if ((c.me.inv.grapples ?? 0) - 1 >= Math.max(1, Math.round(this.P.hook.keepForTravel))) return true;
    return (c.me.inv.pieces.scaffold ?? 0) >= this.scaffoldsTo(to, home);
  }

  /**
   * Where I could hook over to node `to` from (I can't walk there): my shore facing it, or the tip of my bridge toward
   * it, whichever is within hook reach (HookParams.crossMax, rim to rim, from eye height) and I can walk to. Null:
   * no hook in hand, no way back from there (canReturn), or nowhere close enough yet (lay more decks first).
   */
  private hookLaunch(view: BotView, me: PlayerState, node: number, home: number, to: number): Vec3 | null {
    if ((me.inv.grapples ?? 0) <= 0 || view.suddenDeath) return null;
    const dest = this.nav.nodes[to];
    if (!dest) return null;
    const H = this.P.hook;
    const inReach = (p: Vec3) => dist2D(p, dest.center) - dest.radius + H.crossInset <= Math.min(H.crossMax, (view.hookRange ?? GRAPPLE.range) - 0.5) - 1;
    const starts = this.nav.startNodes(me.pos);
    let best: Vec3 | null = null, bestD = Infinity;
    const consider = (p: Vec3) => { const d = dist2D(p, me.pos); if (inReach(p) && d < bestD) { bestD = d; best = p; } };
    for (const s of starts) {
      if (s !== node && node >= 0) continue;
      const n = this.nav.nodes[s];
      const d = flat(sub(dest.center, n.center)), l = Math.hypot(d.x, d.z) || 1;
      consider(v3(n.center.x + (d.x / l) * (n.radius - 0.7), n.groundY, n.center.z + (d.z / l) * (n.radius - 0.7)));
    }
    // The tip of my bridge toward them (I can walk out on it from my island).
    const from = node >= 0 ? node : starts[0] ?? home;
    if (from !== undefined && from !== to && this.nav.nodes[from]) {
      const l = this.nav.lane(from, to), f = this.nav.frontier(l);
      if (!f.complete) { const t = laneAt(l, f.s - 0.6); consider(v3(t.x, me.pos.y, t.z)); }
    }
    if (!best) return null;
    // A way back from there: a spare hook use, scaffolds, or a bridge.
    const back = to === home || this.nav.hop(to, home) !== null || (me.inv.grapples ?? 0) - 1 >= Math.max(1, Math.round(H.keepForTravel)) ||
      (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsTo(to, home);
    return back ? best : null;
  }

  /** Walk to where I hook over to my rival's island from (hookPlan fires once it's in reach and nobody is in sight). */
  private toHookLaunch(c: Ctx): Act {
    const walk = this.goTo(c.hookFrom!, 0.8);
    const to = c.hunt !== null ? this.nav.nodes[c.hunt].center : c.rivalIsl!.center;
    return walk.dir ? { ...walk, sprint: true } : { dir: null, face: to };
  }

  /**
   * Cut off: on a node other than home that I can't walk home from, with no walkable route to any player island (so
   * no shop) and too few scaffolds to bridge home. Tracks since when (strandedSince).
   */
  private cutOff(c: Ctx): boolean {
    const me = c.me, node = this.nav.nodeAt(me.pos), home = c.home.index;
    const cut = node >= 0 && node !== home && !c.homeReach && (me.inv.pieces.scaffold ?? 0) < this.scaffoldsTo(node, home) &&
      !c.view.map.some((isl) => isl.index === node || this.nav.hop(node, isl.index) !== null);
    if (!cut) this.strandedSince = null;
    else this.strandedSince ??= c.view.now;
    return cut;
  }

  /**
   * Getting home when cut off, the way a strong player would: with a hook in hand, walk to my shore nearest home
   * (hookPlan then hooks over: hookNode points home); without one, buy one from a seller on this island (they stock
   * hooks) once I can afford it. Null: nothing to do but play on here (fight, collect: the center pays) until I can.
   */
  private strandedAct(c: Ctx): Act | null {
    if (!this.cutOff(c)) return null;
    const me = c.me, node = this.nav.nodes[this.nav.nodeAt(me.pos)];
    if (!node) return null;
    if ((me.inv.grapples ?? 0) > 0) {
      if (me.hook || me.mv?.pull) return null;
      const d = flat(sub(c.home.center, node.center)), l = Math.hypot(d.x, d.z) || 1;
      const rim = add(node.center, scale(d, (node.radius - 0.7) / l));
      return this.goTo(v3(rim.x, node.groundY, rim.z), 0.8);
    }
    if (funds(me) < GRAPPLE.price) return null;
    const seller = (c.view.potionShops ?? []).find((s) => this.nav.nodeAt(s) === node.index);
    if (!seller) return null;
    if (dist2D(me.pos, seller) <= USE_RANGE) return { dir: null, face: seller, shop: 'grapple' };
    return this.goTo(seller, USE_RANGE - 0.3);
  }

  /**
   * The last resort: cut off for STRANDED_LAST_SEC with no hook and no way to get one here: walk off into the water
   * toward home (the respawn puts me back there). Returns that heading, or null.
   */
  private strandedDitch(c: Ctx): Vec3 | null {
    const me = c.me;
    const held = c.view.now - (this.strandedSince ?? Infinity);
    if (!(held >= STRANDED_LAST_SEC) || me.hook || me.mv?.pull) return null;
    // A hook in hand that never finds a hold home (out of reach from every shore): give it twice as long.
    if ((me.inv.grapples ?? 0) > 0 && held < 2 * STRANDED_LAST_SEC) return null;
    const node = this.nav.nodeAt(me.pos);
    const seller = (c.view.potionShops ?? []).some((s) => this.nav.nodeAt(s) === node);
    if (seller && funds(me) >= GRAPPLE.price) return null;
    return norm(flat(sub(c.home.center, me.pos)));
  }

  /** The node my goal wants me on when I can't walk there (null: walking, or no use for a hook). */
  private hookNode(c: Ctx): number | null {
    const g = this.goal, C = this.nav.centerNode;
    if (this.strandedSince !== null) return c.home.index; // cut off: the hook's job is getting me home
    if (g === 'bridge') return c.bridgeTo;
    if (g === 'attack' && c.hunt !== null) return c.hunt;
    if ((g === 'attack' || g === 'seal') && c.rivalIsl && !c.reach) return c.rivalIsl.index;
    if ((g === 'contest' || g === 'storm') && C >= 0 && !c.centerReach) return C;
    if (HOME_GOALS.has(g) && !c.homeReach) return c.home.index;
    return null;
  }

  /**
   * The visible enemy my gun is on. The nearest, but once on someone I stay on them at least `aim.commitSec`, then
   * switch only to one clearly closer (`aim.switchRatio` × their distance) or when they drop out of sight. Losing
   * sight of a living target holds my eyes on where they were for `holdSec` (the look chain in think uses it).
   */
  private aimTarget(view: BotView, nearest: PlayerState | null, now: number): PlayerState | null {
    const me = view.self, A = this.P.aim;
    let cur = this.aimId === null ? null : view.enemies.find((e) => e.id === this.aimId && e.alive) ?? null;
    if (!cur && this.aimId !== null && !this.aimLost) {
      // Just lost sight: keep them as my target for the hold (a blink behind a crate or a post brings them back
      // into my sights, not onto someone else and back).
      const alive = view.others.find((o) => o.id === this.aimId)?.alive ?? false;
      this.aimLost = alive && this.aimAt ? { at: this.aimAt, until: now + A.feel[this.difficulty].holdSec } : null;
      if (!this.aimLost) this.aimId = null;
    }
    if (!cur && this.aimLost && now >= this.aimLost.until) { this.aimLost = null; this.aimId = null; }
    // While holding on someone I just lost, only a clearly closer enemy takes my eyes off where they were.
    if (!cur && this.aimLost && nearest && dist2D(nearest.pos, me.pos) >= A.switchRatio * dist2D(this.aimLost.at, me.pos)) nearest = null;
    if (cur && nearest && nearest.id !== cur.id && now - this.aimSince >= A.commitSec &&
        dist2D(nearest.pos, me.pos) < A.switchRatio * dist2D(cur.pos, me.pos)) cur = null;
    if (!cur && nearest) { cur = nearest; this.aimId = nearest.id; this.aimSince = now; }
    if (cur) { this.aimAt = add(cur.pos, v3(0, CHEST, 0)); this.aimLost = null; }
    else if (this.aimLost && now >= this.aimLost.until) this.aimLost = null;
    return cur;
  }

  /** Did the last purchase go through? A buy that keeps failing (e.g. nowhere to carry it) is left alone a while. */
  private checkPurchase(me: PlayerState, now: number) {
    const p = this.pendingBuy;
    if (!p || now - p.at < DT * 1.5) return;
    this.pendingBuy = null;
    if (funds(me) < p.cash) { this.buyFails.delete(p.item); return; }
    const n = (this.buyFails.get(p.item) ?? 0) + 1;
    this.buyFails.set(p.item, n);
    if (n >= BUY_RETRIES) {
      this.buyFails.delete(p.item);
      this.buyBlockedUntil.set(p.item, now + BUY_BACKOFF_SEC);
      this.nextScoreAt = now;
    }
  }

  private buyBlocked(item: ShopItem | null) {
    return !!item && (this.buyBlockedUntil.get(item) ?? -Infinity) > this.view.now;
  }

  // ---------------------------------------------------------------- target choice

  private scaffoldsTo(from: number, to: number): number {
    if (this.alt.has(to) && from === this.view.self.island && to < this.view.map.length) {
      const f = this.mirrorFrontier(to);
      return Math.max(1, Math.ceil((f.s - Math.sqrt(this.view.map[to].radius * this.view.map[to].radius - 9)) / SCAFFOLD_STEP));
    }
    return this.nav.scaffoldsTo(from, to, SCAFFOLD_STEP);
  }

  /**
   * The mirror lane home↔to (the line a bridge from `to` would take), scanned from my end: s (measured from `to`)
   * of the last solid point coming out from my shore. Used for an alternate bridge when my main one got shot out.
   */
  private mirrorFrontier(to: number): { l: Lane; s: number; complete: boolean } {
    const hit = this.mirrorCache.get(to);
    if (hit && this.view.now - hit.at < 0.5) return hit.f;
    const f = this.scanMirror(to);
    this.mirrorCache.set(to, { at: this.view.now, f });
    return f;
  }

  private scanMirror(to: number): { l: Lane; s: number; complete: boolean } {
    const map = this.view.map, home = this.view.self.island;
    const l = lane(map, to, home);
    for (let s = l.length - Math.sqrt(map[home].radius * map[home].radius - 9) + 2; s >= 0; s -= 0.25) {
      const p = laneAt(l, s);
      if (this.view.groundAt(p.x, p.z) === null) return { l, s: s + 0.25, complete: false };
      if (islandAt(map, p) === to) return { l, s, complete: true };
    }
    throw new Error(`Bot ${this.id}: mirror lane ${to}>${home} never reached island ${to}`);
  }

  private rivalFacts(view: BotView): RivalFacts[] {
    const me = view.self, now = view.now;
    const home = me.island;
    const node = this.nav.nodeAt(me.pos);
    // Out on a deck: everything the island I walked out from reaches, I reach (not my home's view of the map: at the
    // end of a bridge from a rival's island that swaps my target with each step on and off the deck).
    const src = node >= 0 ? node : this.lastNode >= 0 ? this.lastNode : home;
    const alive = view.others.filter((o) => !o.eliminated && o.island !== home);
    const leaderKills = Math.max(0, ...view.others.map((o) => o.kills));
    return alive.map((o) => {
      const isl = view.map[o.island];
      const reach = src === o.island || this.nav.hop(src, o.island) !== null;
      const seen = this.mem.recent(o.id, now, WHEREABOUTS_SEC);
      const fresh = this.mem.recent(o.id, now, INTRUDER_SEC);
      return {
        id: o.id,
        reach,
        scaffolds: reach ? 0 : this.scaffoldsVia(view, src, home, o),
        dist: dist2D(me.pos, isl.center),
        respawning: !o.alive && o.respawnAt !== null,
        sinceDeath: now - (this.mem.diedAt.get(o.id) ?? -Infinity),
        sealed: view.sealed[o.island],
        seenHp: fresh && o.alive ? fresh.hp : null,
        grudge: this.mem.grudgeOf(o.id),
        busy: (this.mem.busyUntil.get(o.id) ?? -Infinity) > now,
        kills: o.kills,
        leaderKills,
        onMyIsland: !!fresh && o.alive && dist2D(fresh.pos, view.map[home].center) < view.map[home].radius + 6,
        away: !!seen && o.alive && seen.island !== o.island,
        kit: sealKit(me.inv) >= MAP_DOORS,
        trapped: !!o.trapped,
        bounty: o.bounty ?? 0,
      };
    });
  }

  /**
   * Respawn window: a rival is dead (kill feed / scoreboard shows when they're back) and I can sprint to their
   * bunker before they respawn, give or take windowSlackSec: push it now. With a seal kit that's the seal race
   * (plug their doors while they're down: they respawn trapped); without one, hold their door for the respawn.
   * Like a strong player, not right after my own respawn (respawnCautionSec): re-gear first.
   */
  private sealRace(view: BotView) {
    const me = view.self, now = view.now, D = this.P.drive;
    if (this.window && (now > this.window.until || !view.others.some((o) => o.id === this.window!.id && !o.alive && !o.eliminated))) this.window = null;
    if (view.suddenDeath || this.cautious(now)) return;
    for (const o of view.others) {
      if (o.alive || o.eliminated || o.respawnAt === null || o.island === me.island || this.window?.id === o.id) continue;
      const isl = view.map[o.island];
      const d = dist2D(me.pos, isl.bunker.center);
      if (view.sealed[isl.index] || d > D.sealRaceM || d / PLAYER.sprint > o.respawnAt - now + D.windowSlackSec) continue;
      const n = this.nav.nodeAt(me.pos);
      if (n !== isl.index && (n < 0 || this.nav.hop(n, isl.index) === null)) continue;
      this.window = { id: o.id, until: o.respawnAt + D.windowSlackSec };
      this.targetId = o.id;
      this.nextScoreAt = now;
      return;
    }
  }

  /** Just respawned (empty-handed): play it safe for a few seconds, no pushes. */
  private cautious(now: number): boolean {
    return now - this.respawnedAt < this.P.drive.respawnCautionSec;
  }

  /** Pushing a dead rival's bunker in their respawn window: who, and seconds left (spectators / debugBrain). */
  get respawnWindow(): { id: number; left: number } | null {
    return this.window && this.view ? { id: this.window.id, left: Math.max(0, this.window.until - this.view.now) } : null;
  }
  /** Am I in the respawn window on my current target? */
  private inWindow(c: Ctx): boolean {
    return !!this.window && !!c.rival && this.window.id === c.rival.id && !c.rival.alive;
  }

  /** Spoils of war in rival choice (params: drive.spoilsTarget, drive.finishTrapped). */
  private get spoilsWeights() {
    return { perK: this.P.drive.spoilsTarget[this.difficulty], trapped: this.P.drive.finishTrapped };
  }

  /** leaderFocus by player id (0 for anyone not in view.others). */
  leaderFocusId(view: BotView, id: number): number {
    const o = view.others.find((x) => x.id === id);
    return o ? this.leaderFocus(view, o) : 0;
  }

  /** Score every rival; keep the current one unless another is clearly better. */
  private chooseTarget(view: BotView) {
    let best: number | null = null, bestScore = -Infinity, cur = -Infinity;
    for (const f of this.rivalFacts(view)) {
      const s = rivalScore(f, this.t, this.P.drive.sealAwayTarget, this.spoilsWeights) + (this.rng() - 0.5) * NOISE[this.difficulty] -
        ((this.targetBan.get(f.id) ?? -Infinity) > view.now ? 1.5 : 0) + this.teamFocus(view, f.id) + this.leaderFocusId(view, f.id);
      if (f.id === this.targetId) cur = s;
      if (s > bestScore) { bestScore = s; best = f.id; }
    }
    if (best === null) { this.targetId = null; return; }
    if (cur > -Infinity && cur + commitment(this.t) >= bestScore) return;
    this.targetId = best;
  }

  // ---------------------------------------------------------------- teams

  /**
   * One bot per team stays home once the team has P.team.defendMin players left: the lowest-id bot still in
   * (everyone on the team reaches the same answer from the same facts, so exactly one defends).
   */
  private isDefender(view: BotView): boolean {
    if (!view.allies) return false;
    const left = view.allies.filter((a) => !a.eliminated);
    if (left.length + 1 < this.P.team.defendMin) return false;
    return left.every((a) => !a.isBot || a.id > this.id);
  }

  /**
   * Teams: rival-choice bonus. Teammates already after this rival pull me onto them too (focus one target, push
   * one island together); someone who just hurt a teammate near me is the one to go for.
   */
  private teamFocus(view: BotView, id: number): number {
    if (!view.allies) return 0;
    // The push lead picks for the team (not herded onto whatever the defender or the rest happen to chase).
    const lead = this.pushLead(view), leading = !!lead && lead.id === view.self.id;
    let n = 0;
    for (const a of view.allies) {
      if (a.eliminated) continue;
      if (a.target === id && !a.defender && !leading) n++;
      if (a.hurtBy === id && view.now - a.hurtAt <= this.P.team.assistSec && dist2D(a.pos, view.self.pos) <= this.P.team.assistM) n++;
    }
    const follow = lead && !leading && lead.target === id ? this.P.team.follow : 0;
    return this.P.team.focus * Math.min(2, n) + follow;
  }

  /**
   * Teams: who leads the push. The non-defender bot (me included) whose home is nearest an enemy island, lowest id on
   * ties: the frontline. Everyone on the team gets the same answer from the same facts; the rest follow its rival.
   */
  private pushLead(view: BotView): { id: number; target: number | null } | null {
    if (!view.allies) return null;
    const enemyIsl = view.others.filter((o) => !o.eliminated).map((o) => view.map[o.island].center);
    if (!enemyIsl.length) return null;
    const front = (island: number) => Math.min(...enemyIsl.map((p) => dist2D(p, view.map[island].center)));
    let best: { id: number; target: number | null } | null = null, bestD = Infinity;
    const cands: { id: number; island: number; target: number | null }[] = view.allies
      .filter((a) => a.isBot && !a.eliminated && !a.defender).map((a) => ({ id: a.id, island: a.island, target: a.target }));
    if (!this.defender) cands.push({ id: view.self.id, island: view.self.island, target: this.targetId });
    for (const a of cands) {
      const d = front(a.island);
      if (d < bestD - 1 || (Math.abs(d - bestD) <= 1 && best !== null && a.id < best.id)) { best = a; bestD = d; }
    }
    return best;
  }

  /**
   * Teams: a teammate's island to bridge to on the way to `rival` (their home is nearer that island than mine and a
   * shorter bridge from me, and they push that rival themselves, so they lay the rest): one team route, not one each.
   */
  private stageIsland(view: BotView, rival: { id: number; island: number }): number | null {
    // The lead picks its rival on its own merits (staging through followers who copy its pick would loop back).
    if (!view.allies || this.pushLead(view)?.id === view.self.id) return null;
    const map = view.map, home = view.self.island, to = map[rival.island].center;
    const mine = dist2D(map[home].center, to);
    let best: number | null = null, bestN = this.scaffoldsTo(home, rival.island);
    for (const a of view.allies) {
      if (!a.isBot || a.eliminated || a.defender || a.target !== rival.id || a.island === home) continue;
      if (dist2D(map[a.island].center, to) >= mine - 1) continue;
      const n = this.scaffoldsTo(home, a.island);
      if (n < bestN) { best = a.island; bestN = n; }
    }
    return best;
  }

  /** Decks I'd lay to reach rival o's island: in teams only as far as a teammate's island on the way (stageIsland). */
  private scaffoldsVia(view: BotView, src: number, home: number, o: { id: number; island: number }): number {
    const stage = this.stageIsland(view, o);
    if (stage === null) return this.scaffoldsTo(home, o.island);
    return src === stage || this.nav.hop(src, stage) !== null ? 0 : this.scaffoldsTo(home, stage);
  }

  /** Teams: one of my teammates' home islands (a bridge there is the team's road, not a push). */
  private allyIsland(view: BotView, i: number): boolean {
    return !!view.allies?.some((a) => a.island === i);
  }

  /** A teammate under fire close enough to help (the nearest one an enemy hurt lately), or null. */
  private allyInTrouble(c: Ctx): AllyStatus | null {
    const view = c.view;
    let best: AllyStatus | null = null, bestD = this.P.team.assistM;
    for (const a of view.allies ?? []) {
      if (!a.alive || a.hurtBy === null || view.now - a.hurtAt > this.P.team.assistSec) continue;
      const d = dist2D(a.pos, c.me.pos);
      if (d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  /**
   * Standing on the same piece of land (an island, the center included). Two players out on bridges are not: they
   * were counted as one "island" (-1) and traded shots at 70 m from deck to deck.
   */
  private sameGround(a: Vec3, b: Vec3): boolean {
    const n = this.nav.nodeAt(a);
    return n >= 0 && n === this.nav.nodeAt(b);
  }

  /** Teams: an enemy in my face (same island, or within engage range) keeps me in my own fight instead of helping. */
  private ownFight(c: Ctx): boolean {
    return !!c.enemy && (c.enemyDist < ENGAGE_RANGE || this.sameGround(c.me.pos, c.enemy.pos));
  }

  /**
   * Teams: my team role on top of the solo scores. The defender holds home (guard/fortify/cut/defend up, the push
   * down); everyone else pushes harder where a teammate already is (group push on one island).
   */
  private teamDrive(g: Goal, c: Ctx, s: number): number {
    if (!c.view.allies) return s;
    const T = this.P.team;
    if (this.defender) {
      if (g === 'guard' || g === 'fortify' || g === 'cut' || g === 'defend') return s > 0 ? s + T.defendBias : s;
      if (g === 'bridge' || g === 'attack' || g === 'seal') return s - T.defendBias;
      return s;
    }
    if ((g === 'bridge' || g === 'attack' || g === 'seal') && s > 0 && c.rivalIsl) {
      // Push together: teammates already on that island, or going after the same rival, pull me along.
      const rivalIsl = c.rivalIsl.index, rivalId = c.rival?.id ?? null;
      let n = 0;
      for (const a of c.view.allies) {
        if (!a.alive) continue;
        if (islandAt(c.view.map, a.pos) === rivalIsl) n += 1;
        else if (rivalId !== null && a.target === rivalId && !a.defender) n += 0.5;
      }
      return s + T.groupPush * Math.min(2, n);
    }
    return s;
  }

  /**
   * Teams, on offense: the nearest teammate pushing the same rival who is ahead of me (nearer their island) and more
   * than regroupM away, so we arrive together; null when I'm with them already (or alone, or the defender).
   */
  private regroupWith(c: Ctx): AllyStatus | null {
    if (!c.view.allies || this.defender || !c.rival || !c.rivalIsl) return null;
    const T = this.P.team;
    const mine = dist2D(c.me.pos, c.rivalIsl.center);
    let best: AllyStatus | null = null, bestD = Infinity;
    for (const a of c.view.allies) {
      // Only someone out on the push (off their home island): a teammate shopping at home is no one to catch up with.
      if (!a.alive || a.defender || a.target !== c.rival.id || islandAt(c.view.map, a.pos) === a.island) continue;
      const d = dist2D(a.pos, c.me.pos);
      if (d <= T.regroupM || d > 2 * T.assistM || dist2D(a.pos, c.rivalIsl.center) >= mine) continue;
      if (d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  /**
   * Teams, the push lead at the bridge head (the rival island walkable, not on it yet): a teammate pushing the same
   * rival still more than waitM further back is worth waiting for, up to waitSec per push (then a 30 s break), so
   * we step onto their island together. Null when someone is with me already, I'm the defender, or the rival is down.
   */
  private waitFor(c: Ctx): AllyStatus | null {
    const v = c.view, T = this.P.team;
    if (!v.allies || this.defender || T.waitSec <= 0 || !c.rival || !c.rivalIsl || !c.reach || c.on === c.rivalIsl.index) return null;
    // Their owner is down (respawn window): that's a race, not a wait.
    if (!c.rival.alive) return null;
    const mine = dist2D(c.me.pos, c.rivalIsl.center);
    if (mine > c.rivalIsl.radius + WAIT_HEAD_M) return null;
    const since = v.now - this.waitSince;
    if (this.waitRival === c.rival.id && since > T.waitSec && since < T.waitSec + WAIT_BREAK_SEC) return null;
    let best: AllyStatus | null = null, bestD = mine + WAIT_COMING_M;
    for (const a of v.allies) {
      if (!a.alive || a.defender || a.target !== c.rival.id) continue;
      const d = dist2D(a.pos, c.rivalIsl.center);
      if (d <= mine + T.waitM) return null;
      if (d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  private doRegroup(c: Ctx): Act {
    const a = this.regroupWith(c);
    if (a) return this.goTo(a.pos, this.P.team.regroupM * 0.5);
    const w = this.waitFor(c);
    if (!w || !c.rivalIsl || !c.rival) { this.nextScoreAt = c.view.now; return IDLE; }
    const now = c.view.now;
    if (this.waitRival !== c.rival.id || now - this.waitSince >= this.P.team.waitSec + WAIT_BREAK_SEC) { this.waitRival = c.rival.id; this.waitSince = now; }
    return { dir: null, face: add(c.rivalIsl.center, v3(0, CHEST, 0)) };
  }

  /** Go to the teammate under fire (the fight layer shoots whoever shows up). */
  private doAssist(c: Ctx): Act {
    const a = this.allyInTrouble(c);
    if (!a) { this.nextScoreAt = c.view.now; return IDLE; }
    const walk = this.goTo(a.pos, 3);
    const s = a.hurtBy === null ? undefined : this.mem.seen.get(a.hurtBy);
    return walk.dir ? walk : { dir: null, face: s ? add(s.pos, v3(0, CHEST, 0)) : add(a.pos, v3(0, CHEST, 0)) };
  }

  // ---------------------------------------------------------------- context

  private context(view: BotView): Ctx {
    const me = view.self;
    const home = view.map[me.island];
    if (!home) throw new Error(`Bot ${this.id}: island ${me.island} is not on the map`);
    const on = islandAt(view.map, me.pos);
    const node = this.nav.nodeAt(me.pos);
    const src = node >= 0 ? node : this.lastNode >= 0 ? this.lastNode : home.index;
    let rival = this.targetId === null ? null : view.others.find((o) => o.id === this.targetId && !o.eliminated) ?? null;
    if (!rival) {
      this.targetId = null;
      rival = view.others
        .filter((o) => !o.eliminated && o.island !== me.island)
        .sort((a, b) => dist2D(view.map[a.island].center, home.center) - dist2D(view.map[b.island].center, home.center))[0] ?? null;
    }
    const rivalIsl = rival ? view.map[rival.island] : null;
    let enemy: PlayerState | null = null, enemyDist = Infinity;
    // Shoot first at whoever's bunker is sealed (their next death eliminates them), unless someone is much closer.
    let pickD = Infinity;
    for (const e of view.enemies) {
      const d = dist2D(e.pos, me.pos);
      let eff = !view.suddenDeath && view.sealed[e.island] ? d / this.P.drive.sealedFocus : d;
      // Teams: focus fire on whoever is hurting a teammate.
      if (view.allies?.some((a) => a.hurtBy === e.id && view.now - a.hurtAt <= this.P.team.assistSec)) eff /= this.P.team.focusFire;
      // The kill leader is the threat to stop (strength.leaderFocus).
      eff /= 1 + this.leaderFocus(view, e);
      if (this.shutInIgnored(view, e, d)) continue;
      if (e.alive && eff < pickD) { enemy = e; enemyDist = d; pickD = eff; }
    }
    // Off any island (a bridge, a pier): from wherever that walk starts (a dock off a dead rival's island is not home;
    // out on an unfinished bridge, only the island it hangs off: home's bridges don't help me there).
    const stand = node >= 0 ? [node] : this.nav.standNodes(me.pos);
    const from = stand.length ? stand : [src];
    const reach = !!rivalIsl && (on === rivalIsl.index || from.some((n) => n === rivalIsl.index || this.nav.hop(n, rivalIsl.index) !== null));
    const homeReach = stand.length === 0 || stand.some((n) => n === home.index || this.nav.hop(n, home.index) !== null);
    const openDoors = rivalIsl ? rivalIsl.bunker.doorways.filter((d) => !doorBlocked(view.pieces, d)) : [];
    const danger = view.now - this.mem.lastHurtAt < 3 || (!!enemy && enemyDist < 40);
    const C = this.nav.centerNode;
    const centerReach = C >= 0 && (node === C || from.some((n) => n === C || this.nav.hop(n, C) !== null));
    // A rival sealed out of their home, last seen somewhere I can't walk to: hunt them there, don't hold their plugged
    // door for a respawn that never comes (replay a.faereplay: two PROs, each on the other's island, stood 10.7 min).
    const seenAt = rival && rival.alive && !view.suddenDeath && view.sealed[rival.island] ? this.mem.recent(rival.id, view.now, this.P.drive.huntSeenSec) : null;
    const seenNode = seenAt ? this.nav.nodeAt(seenAt.pos) : -1;
    const hunt = seenNode >= 0 && seenNode !== node && !from.some((n) => n === seenNode || this.nav.hop(n, seenNode) !== null) ? seenNode : null;
    // Hunting: bridge toward where they stand, routed like any other bridge (via a teammate or the center when shorter).
    let bridgeTo: number | null = hunt ?? (rivalIsl && !reach ? rivalIsl.index : null);
    const hookFrom = hunt !== null ? this.hookLaunch(view, me, node, home.index, hunt)
      : rivalIsl && !reach ? this.hookLaunch(view, me, node, home.index, rivalIsl.index) : null;
    // Teams: bridge to the teammate whose island is on the way (they lay the rest); already linked to them, wait
    // for their bridge instead of laying a second, longer one of my own.
    const stage = bridgeTo !== null && rival ? this.stageIsland(view, rival) : null;
    if (stage !== null) bridgeTo = node === stage || this.nav.hop(src, stage) !== null ? null : stage;
    // Center-minded: bridge to the center island first when it isn't much further than the rival. Anyone else
    // (but easy players) goes via the center when it's the shorter bridge: it's the hub to everyone, and the fights.
    const slack = this.centerMinded ? 2 : this.difficulty !== 'easy' ? 0 : -Infinity;
    // A center bridge that wouldn't finish (laneBanSec): bridge to them directly for a while.
    if (C >= 0 && slack > -Infinity && !centerReach && !view.suddenDeath && stage === null && !((this.laneBan.get(C) ?? -Infinity) > view.now) &&
        (bridgeTo === null ? this.centerMinded : bridgeTo !== home.index && this.scaffoldsTo(home.index, C) <= this.scaffoldsTo(home.index, bridgeTo) + slack)) bridgeTo = C;
    // The storm ends on the center island: medium+ bots get a bridge there before it comes (anyone would, seeing the clock).
    if (C >= 0 && !centerReach && this.stormPrep(view)) bridgeTo = C;
    const bridgeFrom = !homeReach && stand.length && stand[0] !== bridgeTo ? stand[0] : home.index;
    return { view, me, home, on, src, rival, rivalIsl, enemy, enemyDist, reach, hookFrom, hunt, homeReach, openDoors, bridgeTo, bridgeFrom, centerReach, danger };
  }

  private scaffoldsNeeded(c: Ctx): number {
    if (c.bridgeTo === null) return 0;
    return this.scaffoldsTo(c.bridgeFrom, c.bridgeTo);
  }

  /**
   * A rival's wooden base worth a rocket (3+ flammable pieces of one owner within 5 m, none burning yet) in
   * rocket range; returns where to aim, or null. Medium+ only, one rocket per TORCH_GAP.
   */
  private torchTarget(c: Ctx): Vec3 | null {
    if (this.difficulty === 'easy') return null;
    const me = c.me, w = me.inv.weapons.rocket;
    if (!w || w.mag + w.spare <= 0 || c.view.now - this.lastTorchAt < TORCH_GAP) return null;
    let best: PieceState | null = null, bestD = Infinity;
    for (const p of c.view.pieces) {
      if (p.owner === me.id || p.owner <= 0 || p.burning || !isFlammable(p.kind)) continue;
      const d = dist2D(p.pos, me.pos);
      if (d < TORCH_RANGE[0] || d > TORCH_RANGE[1] || d >= bestD) continue;
      if (this.woodNear(c.view.pieces, p) < 3) continue;
      best = p; bestD = d;
    }
    return best && v3(best.pos.x, best.pos.y + Math.min(1, PIECES[best.kind].h / 2), best.pos.z);
  }

  private woodNear(pieces: PieceState[], p: PieceState): number {
    let n = 0;
    for (const q of pieces) if (q.owner === p.owner && !q.burning && isFlammable(q.kind) && dist2D(q.pos, p.pos) < 5) n++;
    return n;
  }

  private needs(c: Ctx): Needs {
    const total = c.me.inv.cash + c.me.vault.cash;
    const skilled = this.difficulty === 'hard' || this.difficulty === 'pro';
    const wooden = this.difficulty !== 'easy' && total >= TORCH_RICH &&
      c.view.pieces.some((p) => p.owner !== c.me.id && p.owner > 0 && isFlammable(p.kind) && this.woodNear(c.view.pieces, p) >= 3);
    const sniperNext = this.sniperTaste(c) && (this.P.strength.rifleAt[this.difficulty] >= 1e6 || hasAmmo(c.me.inv, 'rifle'));
    return {
      rocket: wooden,
      // Bridging to the center before the storm: spares for decks that get shot out under me (one trip, not five).
      scaffolds: this.scaffoldsNeeded(c) + (c.bridgeTo !== null && c.bridgeTo === this.nav.centerNode && this.stormPrep(c.view) ? STORM_SPARE_DECKS : 0),
      // A full seal kit whenever there's someone to seal: their doors get reopened, the next rival has three.
      kit: c.rival ? Math.max(c.openDoors.length, MAP_DOORS) : 0,
      // A hard plug in my own doorway: only a charge gets through.
      charge: this.blockers(c).some((p) => isHard(p.kind)),
      grenades: total >= NADE_RICH[this.difficulty] ? (skilled ? 2 : 1) : 0,
      smokes: total >= this.P.util.buyAt[this.difficulty] ? this.P.util.carrySmoke[this.difficulty] : 0,
      flashes: total >= this.P.util.buyAt[this.difficulty] ? this.P.util.carryFlash[this.difficulty] : 0,
      // Heals to carry; with the storm coming in, no new ones (the decks and getting inside the ring come first).
      medkits: (this.healWant = this.stormPrep(c.view) ? Math.min(hpHealsHeld(c.me), healStock(total, this.difficulty, this.P.heal))
        : healStock(total, this.difficulty, this.P.heal)),
      traps: total >= this.P.trap.rich && !c.danger ? Math.max(0, this.P.trap.carry[this.difficulty] - this.myTraps(c.view).length) : 0,
      steel: skilled && total >= this.P.drive.steelRich,
      hardKit: this.P.drive.hardKit[this.difficulty],
      // A hook instead of buying a bridge's worth of scaffolds (one already carried: bridge it as before).
      grapple: c.bridgeTo !== null && (c.me.inv.pieces.scaffold ?? 0) < this.scaffoldsNeeded(c) && total >= this.P.hook.crossBuyAt[this.difficulty] ? 'cross'
        : total >= this.P.hook.buyAt[this.difficulty] ? 'rich' : undefined,
      genLevel: c.view.genLevels?.[c.home.index],
      build: this.buildNeeds(c, total),
      combatKit: this.combatKit(c),
      rifle: this.wantsRifle(c),
      // rifleAt past any real cash (Infinity, or a finite 1e9 from a params file) = no early rifle: no slot kept either.
      rifleSlot: this.P.strength.rifleAt[this.difficulty] < 1e6,
      // With the early rifle on (rifleAt), the sniper is the second long gun: only once the rifle is in hand and loaded
      // (its cash and kept slot go to the rifle first; a dry rifle is a gun to restock, not a reason for another).
      sniper: sniperNext && total >= this.P.sniper.buyAt[this.difficulty],
      // The slot is kept only once its price is within reach: kept from the start, it cost smokes/flashes in every game.
      sniperSlot: sniperNext && total >= WEAPONS.sniper.price,
    };
  }

  /**
   * Pieces to carry for building, bought in one shop visit: the unbuilt part of my fortification plan (once I can
   * spare the cash: builders sooner), cover walls for fights, a ramp for high ground, side walls for a long bridge.
   */
  private buildNeeds(c: Ctx, total: number): Partial<Record<PieceKind, number>> | undefined {
    // Asked several times per decision (shop plan, bank, scores): work it out once per tick.
    if (this.buildMemo?.at === c.view.now && this.buildMemo.total === total) return this.buildMemo.b;
    const b = this.computeBuildNeeds(c, total);
    this.buildMemo = { at: c.view.now, total, b };
    return b;
  }

  private computeBuildNeeds(c: Ctx, total: number): Partial<Record<PieceKind, number>> | undefined {
    const { me, view } = c;
    if (view.suddenDeath || !ownsGun(me.inv)) return undefined;
    const t = this.t, sk = this.P.buildSkill[this.difficulty];
    const b: Partial<Record<PieceKind, number>> = {};
    // Hotbar room: a new kind takes a slot; always leave this.P.buildTuning.freeSlots open for guns, heals and the like.
    let free = me.hotbar.filter((k) => k === null).length;
    const reserve = this.buildReserve(me);
    const add1 = (k: PieceKind, n = 1) => {
      if (n <= 0) return;
      if (!b[k] && !me.hotbar.includes(k)) { if (free <= reserve) return; free--; }
      b[k] = (b[k] ?? 0) + n;
    };
    if (total >= this.P.buildTuning.fortReserve * (1 - t.builder) && this.fortWorthIt(c))
      for (const [i, s] of this.fortSlots().entries())
        if (!slotBuilt(view.pieces, s) && (this.slotBackoff.get(i) ?? -Infinity) <= view.now) add1(s.kind);
    const walls = Math.round(this.P.buildTuning.coverCarry[this.difficulty] * (0.4 + t.builder));
    // Cover walls: wood (fast, cheap) for fights, unless metal already takes a slot for plugs and wood doesn't.
    const wall: PieceKind = me.hotbar.includes('metal') && !me.hotbar.includes('wood') ? 'metal' : 'wood';
    add1(wall, walls);
    // Once rich, a couple of metal walls beside them for holding a spot and replacing a cracked wall.
    if (sk.reinforce > 0 && total >= this.P.buildTuning.metalCoverAt) add1('metal', this.P.buildTuning.metalCarry[this.difficulty]);
    const scaffolds = this.scaffoldsNeeded(c);
    if (sk.bridgeCover && this.wallsOnBridge && scaffolds >= 2 * this.P.buildTuning.scaffoldsPerBridgeWall)
      add1(wall, Math.floor(scaffolds / this.P.buildTuning.scaffoldsPerBridgeWall));
    if (sk.highGround && sk.ramp > 0 && total >= this.P.buildTuning.rampAt && t.builder >= 0.3) add1('ramp', this.P.buildTuning.rampCarry[this.difficulty]);
    return b;
  }

  /** Ramps carried from the first shop visit on (skills that ramp in fights; never with a full hotbar). */
  private combatKit(c: Ctx): Partial<Record<PieceKind, number>> | undefined {
    const n = this.P.buildTuning.rampFirst[this.difficulty];
    if (c.view.suddenDeath || n < 1 || !this.P.buildSkill[this.difficulty].highGround) return undefined;
    if (!c.me.hotbar.includes('ramp') && c.me.hotbar.filter((k) => k === null).length <= this.buildReserve(c.me)) return undefined;
    return { ramp: Math.round(n) };
  }

  /**
   * Empty hotbar slots building pieces leave alone. The reserve is for guns and heals: a medkit already on the
   * hotbar (the restock loadout puts one there after every respawn) fills its heal share (VaultParams.healSlot), or
   * the medkit pushes cover walls off the hotbar for good (vault-2: PRO bought half the wood).
   */
  private buildReserve(me: PlayerState): number {
    return this.P.buildTuning.freeSlots - (me.hotbar.includes('medkit') ? Math.round(this.P.vault.healSlot) : 0);
  }

  /**
   * Tempo first: walls at home pay off when several rivals may come over and I'm already geared; a duel is won by
   * getting there first. Real builders fortify anyway.
   */
  private fortWorthIt(c: Ctx): boolean {
    const B = this.P.buildTuning;
    if (this.t.builder >= Math.min(B.fortEarlyBuilder, B.fortSealedRule[this.difficulty])) return true;
    const rivals = c.view.others.filter((o) => !o.eliminated).length;
    return rivals >= this.P.buildTuning.fortMinRivals && !c.reach && sealKit(c.me.inv) >= c.openDoors.length;
  }

  /** My share of the home fortification plan (easy players misplace some of it for good). */
  private fortSlots(): Slot[] {
    if (this.slots) return this.slots;
    const view = this.view, home = view.self.island;
    const sk = this.P.buildSkill[this.difficulty];
    this.slots = fortShare(fortPlan(view.map, home, this.t), this.t, this.difficulty, this.P.buildSkill).map((s) => {
      if (s.after !== undefined || this.rng() >= sk.misplace) return s;
      const f = fumble(s.pos, s.rotY, this.rng);
      return { ...s, pos: f.pos, rotY: f.rotY };
    });
    return this.slots;
  }

  /** Next fortification slot to (re)build: missing, its base standing, not recently failed, and I carry the piece. */
  private nextSlot(c: Ctx): { slot: Slot; i: number } | null {
    const slots = this.fortSlots();
    for (const [i, s] of slots.entries()) {
      if (slotBuilt(c.view.pieces, s) || (this.slotBackoff.get(i) ?? -Infinity) > c.view.now) continue;
      if (s.after !== undefined && !slotBuilt(c.view.pieces, slots[s.after])) continue;
      if ((c.me.inv.pieces[s.kind] ?? 0) > 0) return { slot: s, i };
    }
    return null;
  }

  /** Where a rival believed to be inside their own (open) bunker was last seen, or null. */
  private inTheirBunker(c: Ctx): Sighting | null {
    if (!c.rival || !c.rivalIsl || !c.rival.alive) return null;
    const s = this.mem.seen.get(c.rival.id);
    if (!s || s.t < (this.mem.diedAt.get(c.rival.id) ?? -Infinity) || c.view.now - s.t > 30) return null;
    return insideBunker(c.rivalIsl.bunker, s.pos) ? s : null;
  }

  /** Shopping plan counting what's in the vault too (it can be withdrawn on the way). */
  private plan(c: Ctx) {
    const me = c.me;
    // The banked rebuy money is for exactly this: an empty gun gets restocked from it (else the plan is empty and I sit
    // at home with fists; ffa8-mixed seed 11: 62 s).
    const vault = ownsGun(me.inv) ? this.spendable(me) : me.vault.cash;
    const total = { ...me, inv: { ...me.inv, cash: me.inv.cash + vault } };
    return shoppingPlan(total, this.needs(c), this.difficulty, this.style);
  }

  /** Rebuy money (pistol + ammo) skilled players keep banked; 0 for others. */
  private insurance(): number {
    return this.difficulty === 'hard' || this.difficulty === 'pro' ? INSURANCE : 0;
  }

  /** Cash still to deposit to cover the insurance (limited to what I carry). */
  private insuranceDue(me: PlayerState): number {
    return Math.max(0, Math.min(me.inv.cash, this.insurance() - me.vault.cash));
  }

  /** Cash I may spend at a shop: carried plus banked above the insurance (all of it while I have no working gun). */
  private spendCash(me: PlayerState): number {
    return me.inv.cash + (ownsGun(me.inv) ? this.spendable(me) : me.vault.cash);
  }

  /** Adds my restock loadout to the vault action while the sim doesn't have it yet (set from anywhere, once). */
  private withLoadout(me: PlayerState, v: VaultAction | undefined): VaultAction | null {
    const want = this.restockLoadout();
    if (!want || me.loadout) return v ?? null;
    return { ...v, loadout: want };
  }

  /** My restock loadout (sim/vault.ts) by skill, from VaultParams; null for none. */
  restockLoadout(): Loadout | null {
    const v = this.P.vault, d = this.difficulty;
    const items: Loadout['items'] = {};
    const med = Math.round(v.medkits[d]), sc = Math.round(v.scaffolds[d]);
    if (med > 0) items.medkit = med;
    if (sc > 0) items.scaffold = sc;
    const keep = Math.round(v.keep[d]);
    if (!med && !sc && keep <= 0) return null;
    return { items, keep, buy: v.buy[d] >= 0.5 };
  }

  /** Vault cash I may spend on gear (everything above the insurance). */
  private spendable(me: PlayerState): number {
    // A weak player forgets what they banked: shops only with carried cash (the vault still rebuys a lost gun).
    if (this.difficulty === 'easy') return 0;
    return Math.max(0, me.vault.cash - this.insurance());
  }

  /** Shopping taste from my personality (and strength.longGun). */
  private shopStyle(): ShopStyle {
    const t = this.t;
    return {
      upgradeFirst: t.patience > 0.65,
      longGun: t.range > 0.75,
      noSmg: this.P.strength.longGun[this.difficulty] >= 0.5,
      closeGun: t.range < 0.3,
      metal: t.builder > 0.6,
      steel: t.patience > 0.75 && t.greed > 0.75,
      coverWood: 0,
      invest: t.patience > 0.75,
      buildFirst: t.builder > 0.7,
    };
  }

  /**
   * Swap my strategy params mid-match (the human-proxy benchmark hands a re-run's bots new params at a mined moment).
   * Only strategy: aim feel and gun skill stay as built.
   */
  retune(P: BotParams) {
    this.P = P;
    this.style = this.shopStyle();
  }

  /** Visible intruder or rival seen on/next to my island in the last few seconds. */
  private intruder(c: Ctx): Sighting | null {
    let best: Sighting | null = null;
    for (const o of c.view.others) {
      if (!o.alive) continue;
      const s = this.mem.recent(o.id, c.view.now, INTRUDER_SEC);
      if (s && dist2D(s.pos, c.home.center) < c.home.radius + 6 && (!best || s.t > best.t)) best = s;
    }
    return best;
  }

  private nearestLoot(c: Ctx): Vec3 | null {
    let best: Vec3 | null = null, bestD = LOOT_RANGE;
    for (const p of c.view.loot) {
      const d = dist2D(p, c.me.pos);
      if (d >= bestD || p.y < c.view.waterY + 0.2) continue;
      if (this.healDrops.some((h) => dist2D(h.pos, p) < 3)) continue; // dropped to make room for a heal
      // Out past the storm's safe line: stormFence never lets me walk there (a bag I'd stand and stare at).
      const st = c.view.storm;
      if (st && this.difficulty !== 'easy' && Math.hypot(p.x - st.x, p.z - st.z) > this.stormSafeR(st) - 0.5) continue;
      // No route, even on my own island (e.g. past a wall): goTo would idle on it forever (measured: two medium bots
      // stood 160 s in the final ring, out of ammo, each "looting" a bag it couldn't reach; the watchdog is off then).
      if (!this.nav.routeTo(p)) continue;
      best = p; bestD = d;
    }
    return best;
  }

  /** An enemy generator worth stealing from: the island I'm on, or my target's when I can walk there. */
  private raidIsland(c: Ctx): IslandLayout | null {
    const now = c.view.now;
    for (const i of [c.on, c.reach && c.rivalIsl ? c.rivalIsl.index : -1]) {
      if (i < 0 || i === c.home.index || c.view.generators[i] < RAID_AT || c.view.allies?.some((a) => a.island === i)) continue;
      const owner = c.view.others.find((o) => o.island === i);
      const guarded = owner && owner.alive && this.mem.recent(owner.id, now, 6)?.island === i;
      if (!guarded) return c.view.map[i];
    }
    return null;
  }

  /** A finished bridge someone else built into my island, and its deck nearest my shore. */
  private incomingDeck(c: Ctx): PieceState | null {
    const map = c.view.map, home = c.home.index;
    for (const o of c.view.others) {
      if (o.eliminated) continue;
      const l = lane(map, o.island, home);
      if (!this.nav.frontier(l).complete) continue;
      let best: PieceState | null = null, bestS = -Infinity;
      for (const p of c.view.pieces) {
        if (p.kind !== 'scaffold' || p.owner === c.me.id || laneOff(l, p.pos) > 1.5) continue;
        const s = laneS(l, p.pos);
        if (s > bestS && s < l.length - landEdge(map[home]) + 2) { bestS = s; best = p; }
      }
      if (best) return best;
    }
    return null;
  }

  // ---------------------------------------------------------------- utility

  private score(g: Goal, c: Ctx): number {
    const { view, me, home, t } = { ...c, t: this.t };
    const away = c.on === home.index ? 0 : 0.25;
    const gun = ownsGun(me.inv);
    const hp = me.hp / 100;
    const rivalDown = !!c.rival && !c.rival.alive && c.rival.respawnAt !== null;
    const trapped = this.trapped(c);
    switch (g) {
      case 'storm': {
        const st = view.storm;
        // The doorway slabs drop soon and I'm inside my bunker: out now, before it shuts me in for good.
        if (!st) return this.leaveBeforeBarriers(c) ? BARRIER_LEAVE : 0;
        const d = Math.hypot(me.pos.x - st.x, me.pos.z - st.z);
        if (d > st.r) return this.difficulty === 'easy' ? 0.9 : 1.7;
        if (d > this.stormSafeR(st)) return this.difficulty === 'easy' ? 0.4 : 1.3;
        // The walk to the center island (round by other islands) takes about as long as the ring has left: go now.
        if (this.stormLeave(c)) return 1.5;
        // No way onto the center island yet: the ring will end there, so the bridge comes first.
        if (this.needCenterBridge(c)) return 1.2;
        // Final circle, nobody in sight: the last rivals are in here too, so close in on its centre and find them
        // (CI storm medium seed 2: two armed bots stood 15 m apart behind cover on the center island until the cap).
        return this.finalHunt(c) ? FINAL_HUNT : 0;
      }
      case 'fight': {
        if (!c.enemy) return 0;
        // Someone across the water gets shot at anyway (aim/fire layer on every goal); only drop
        // everything to fight when they're close or on the same island.
        const sameIsland = this.sameGround(me.pos, c.enemy.pos);
        // Sudden death with no ammo: the one I can see is the one to go and punch, however far (else both walk to
        // each other's islands and pass in the ring until the cap).
        if (!sameIsland && c.enemyDist > ENGAGE_RANGE) return view.suddenDeath && !gun ? SD_FISTS_ATTACK + 0.05 : 0.2;
        // Sudden death with no ammo left anywhere to buy it: fists are all there is.
        const sealedFoe = !view.suddenDeath && view.sealed[c.enemy.island] ? this.P.drive.sealedHunt : 0;
        return (gun || c.enemyDist < 8 || view.suddenDeath ? 0.85 : 0.35) + 0.25 * t.aggression + (gun ? sealedFoe : 0);
      }
      case 'disengage': {
        if (!c.enemy && view.now - this.mem.lastHurtAt > 1.5) return 0;
        // Outside the safe ring, getting in comes first (running from a gun into the storm kills just as well).
        if (view.storm && (Math.hypot(me.pos.x - view.storm.x, me.pos.z - view.storm.z) > this.stormSafeR(view.storm) || this.stormLeave(c))) return 0;
        // Final circle: nowhere left to run (backing off only buys regen, and the fight never ends); fists vs fists
        // in sudden death likewise.
        if (view.storm && (view.storm.r <= view.storm.rf + 0.5 || (!gun && c.enemy?.equipped === 'fists'))) return 0;
        const low = 0.25 + 0.35 * t.caution - 0.15 * t.aggression + this.sealedCaution(c);
        if (hp < low) return 1.15 + (low - hp);
        // Unarmed vs a gun: back off only from one close enough to matter (not someone across the water).
        const outgunned = !gun && !view.suddenDeath && !!c.enemy && c.enemy.equipped !== 'fists' && c.enemyDist > 4 &&
          (c.enemyDist < Math.min(ENGAGE_RANGE, WEAPONS[c.enemy.equipped].range) || view.now - this.mem.lastHurtAt < 1.5);
        // A rifle picking me off from across the water, out of my gun's range: get out of its sight, don't trade.
        const outranged = this.outrangedScore(c);
        return Math.max(outgunned ? 0.95 + 0.2 * t.caution : 0, outranged);
      }
      case 'defend': {
        if (trapped) return 2;
        if (view.suddenDeath) return 0;
        const blockers = this.blockers(c);
        if (!blockers.length) return 0;
        // Nothing that can clear what's there (steel needs a charge): better to go buy one than stand at the door.
        const can = blockers.some((p) => this.canClear(c, p));
        // Dying while sealed is an instant elimination: unseal before anything else unless someone is on top of me.
        // No walk home: nothing to do at the plug from here (replay a.faereplay: it stood 10.7 min "shooting" its
        // own plug from the far island); getting home (bridge, hook) or hunting comes first.
        if (view.sealed[home.index] && !c.homeReach) return 0;
        if (view.sealed[home.index]) return (can ? 0.85 + (this.sealedHomeCalm(c) ? this.P.drive.sealedHome[this.difficulty] : 0) : 0.1) + 0.1 * t.caution;
        // One plugged doorway is most of a seal: clear it before going out. Out of ammo with the money for a box
        // (vault too): fetch it first, punching sandbags out one by one takes a minute (ffa8-mixed seed 18: 61 s).
        // (Cash waiting in my generator counts: collect it, then buy.)
        const restock = !ownsGun(me.inv) && GUNS.some((g) => me.inv.weapons[g]) &&
          me.inv.cash + me.vault.cash + view.generators[home.index] >= AMMO_BOX.price;
        return c.homeReach && can ? (restock ? 0.5 : 0.7 + 0.15 * t.caution) : 0;
      }
      case 'heal': {
        // Health comes back slowly out of combat: low and away from home, go back and recover.
        if (view.suddenDeath || c.enemy || c.on === home.index || !c.homeReach || hpHealsHeld(me) > 0) return 0;
        const low = 0.35 + 0.25 * t.caution - 0.15 * t.aggression;
        return hp < low ? 0.75 + (low - hp) : 0;
      }
      case 'assist': {
        // Teams: help a teammate under fire nearby (no one in my own face, a gun, a way there); the lower they are,
        // the sooner.
        if (!view.allies || this.ownFight(c) || !gun || trapped) return 0;
        const a = this.allyInTrouble(c);
        if (!a || (islandAt(view.map, a.pos) !== c.on && !this.nav.routeTo(a.pos))) return 0;
        return this.P.team.assistScore + 0.2 * t.aggression + this.P.team.assistLowHp * (1 - Math.max(0, Math.min(100, a.hp)) / 100) -
          (this.defender && islandAt(view.map, a.pos) !== home.index ? 0.3 : 0);
      }
      case 'regroup': {
        // Teams: catch up with the teammate leading the push on our shared rival, or (leading it) wait at the bridge
        // head for them.
        if (!view.allies || c.enemy || !gun || trapped || !this.offensive(c)) return 0;
        const a = this.regroupWith(c);
        if (a && (islandAt(view.map, a.pos) === c.on || this.nav.routeTo(a.pos))) return this.P.team.regroupScore;
        return this.waitFor(c) ? this.P.team.regroupScore : 0;
      }
      case 'guard': {
        if (!c.homeReach || view.suddenDeath) return 0;
        const s = this.intruder(c);
        if (!s) return 0;
        const fresh = 1 - (view.now - s.t) / INTRUDER_SEC;
        return (0.4 + 0.45 * t.caution) * (0.5 + 0.5 * fresh) + (gun ? 0.1 : -0.2);
      }
      case 'bank': {
        // Storm coming: getting to the center beats a trip to the vault (the shop takes vault cash anyway).
        // Away from home with a lot on me (it drops if I die): the walk home to bank it.
        if (c.on !== home.index) return this.bankAway(c);
        if (view.suddenDeath || this.stormPrep(view)) return 0;
        // Death insurance: before heading out, leave enough in the vault to rebuy a gun after a death.
        const leavingSoon = c.reach || ((me.inv.pieces.scaffold ?? 0) > 0 && (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c));
        if (leavingSoon && this.insuranceDue(me) > 0 && !(c.enemy && c.enemyDist < 8)) return 0.8;
        // Shops pay from the vault anywhere and carried cash drops on death: bank all but pocket money.
        const keep = this.bankKeep(c);
        const excess = me.inv.cash - keep;
        const close = c.enemy && c.enemyDist < 8;
        if (close) return 0;
        // Rich enough for the next vault level (more interest, remote deposits): a trip to the vault to buy it.
        if (this.wantsVaultUpgrade(me)) {
          const d = dist2D(me.pos, home.vault);
          return this.P.vault.upgradeScore + (d < UPGRADE_NEAR_M ? this.P.vault.upgradeNear : 0) - d / 80;
        }
        if (excess < this.P.vault.bankMin) return 0;
        const leaving = c.reach || (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c);
        const want = 0.2 + Math.min(excess, 600) / 600 * (0.3 + 0.3 * t.caution + 0.2 * t.greed);
        // From vault level 2 a deposit works anywhere on my island: no walk.
        const walk = vaultSpec(me).remote ? 0 : dist2D(me.pos, home.vault) / 80;
        return want + (c.danger || this.intruder(c) ? 0.55 : 0) + (leaving ? 0.25 : 0) - walk;
      }
      case 'collect': {
        // Sudden death: the generators have stopped, and home is where the storm is.
        if (!c.homeReach || view.suddenDeath) return 0;
        const stored = view.generators[home.index];
        let s = stored >= COLLECT_AT ? 0.45 + 0.1 * t.greed + Math.min(stored, 500) / 1000 : 0.15;
        // Don't leave cash at an unguarded generator (anyone can take it), and don't let it hit the cap.
        const leaving = c.reach || ((me.inv.pieces.scaffold ?? 0) > 0 && (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c));
        if (c.on === home.index && stored >= COLLECT_BEFORE_LEAVING && leaving && !c.enemy) s = Math.max(s, 0.72);
        if (stored >= COLLECT_NEAR_CAP) s = Math.max(s, 0.8);
        // An empty gun and no money for ammo: the generator is where the next box comes from (seen: a bot stood 250 s
        // in its doorway with an empty pistol and $0, $500 waiting in its generator).
        if (!ownsGun(me.inv) && me.inv.cash + me.vault.cash < AMMO_BOX.price && stored >= AMMO_BOX.price) s = Math.max(s, 0.95);
        return s - away;
      }
      case 'shop': {
        // Can't walk home (e.g. left on a dead rival's island): any island's shop I can walk to serves me.
        const shop = this.shopSpot(c);
        if (!shop) return 0;
        // Sudden death: never a shopping trip out past the safe line of the ring.
        if (view.storm && Math.hypot(shop.x - view.storm.x, shop.z - view.storm.z) > this.stormSafeR(view.storm) - 2) return 0;
        const plan = this.plan(c);
        if (!plan.items.length || this.buyBlocked(plan.items[0])) return 0;
        if (dist2D(me.pos, shop) < 4 && plan.spent <= this.spendCash(me)) return 0.9;
        // Topping up heals is no reason for a trip home once I hold one (they're bought on the next visit anyway).
        const items = hpHealsHeld(me) > 0 ? plan.items.filter((i) => i !== 'medkit') : plan.items;
        if (!items.length || (this.stormPrep(view) && items.every((i) => i === 'medkit'))) return 0;
        // An empty gun is as good as none: restocking it is as urgent as buying one.
        const urgent = items.includes('pistol') || items.includes('charge') || (items[0] === 'ammo' && !ownsGun(me.inv));
        // Out-ranged by a rifle lately and the rifle is next: go get one (strength.outranged).
        const rifle = items[0] === 'rifle' && this.outrangedLately(view.now) ? RIFLE_TRIP : 0;
        return Math.max(urgent ? 0.75 : items.length >= 3 || plan.covered ? 0.6 : 0, rifle, this.endgameKit(c, items)) - away;
      }
      case 'bridge': {
        const have = me.inv.pieces.scaffold ?? 0;
        if (c.bridgeTo === null || have === 0 || view.now < this.bridgeHoldUntil) return 0;
        // Bridges are one-way (see Nav.bridge): don't finish one to a rival before carrying a full seal kit.
        const need = this.scaffoldsNeeded(c);
        const toRival = c.bridgeTo !== this.nav.centerNode && !this.allyIsland(view, c.bridgeTo);
        if (toRival && need <= 1 && sealKit(me.inv) < c.openDoors.length) return 0;
        // Already out over the water laying it: lay what I carry before turning back (a walk home and out again
        // costs more than the decks; with fast placing a trip often ends a deck or two short).
        const outOnIt = this.goal === 'bridge' && c.on !== home.index;
        return 0.45 + 0.15 * t.aggression + (have >= need || outOnIt ? 0.1 : 0) + (toRival ? 0 : 0.05 * t.greed + (this.stormPrep(view) ? 0.45 : 0));
      }
      case 'contest': {
        const cv = view.center;
        if (!cv || !c.centerReach || view.suddenDeath) return 0;
        const room = me.hotbar.includes(null) || me.hotbar.includes('sandbags');
        const supplies = cv.bags + cv.steel > 0 && room ? 0.12 + 0.05 * cv.steel : 0;
        if (cv.gold < (this.centerMinded ? CONTEST_AT : 2.5 * CONTEST_AT) && !supplies) return 0;
        const far = dist2D(me.pos, cv.island.center) / 150;
        // Rich bots have better things to do than farm the middle.
        const rich = Math.min(0.3, (me.inv.cash + me.vault.cash) / 3000);
        return 0.1 + 0.25 * t.greed + 0.1 * t.opportunism + Math.min(cv.gold, 1000) / 2000 + supplies - far - rich - (c.danger ? 0.2 : 0);
      }
      case 'attack': {
        // Seen shut in a bunker since the slabs dropped: nothing to walk to (the storm finishes them).
        if (!c.enemy && this.rivalShutIn(c)) return 0;
        // Hunting them somewhere I can't walk to and can't hook to yet: the bridge (and the shop for its decks) gets me there.
        if (c.hunt !== null && !c.hookFrom) return 0;
        if (!(c.reach || c.hookFrom) || !c.rival || view.suddenDeath && !c.enemy && !this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)) {
          return c.reach && view.suddenDeath ? 0.3 : 0;
        }
        // Sealed in (or about to respawn into a sealed bunker): be there to finish it.
        if (this.sieging(c)) return this.P.drive.siegeScore + this.P.drive.sealedHunt + 0.2 * t.opportunism;
        // Respawn window with no kit to seal: wait at their door for the unarmed respawn.
        const push = this.inWindow(c) ? this.P.drive.windowPush * 0.5 : 0;
        if (rivalDown) return (gun && sealKit(me.inv) === 0 ? 0.35 + 0.3 * t.opportunism : 0.3) + push;
        // Sudden death, out of ammo: generators are off and home is in the storm, so fists are the only way to win
        // (CI ffa8-hard seed 11: the last two, both empty, walked between shop, generator and ring until the cap).
        if (!gun) return view.suddenDeath ? SD_FISTS_ATTACK : 0.1;
        const upgraded = !!(me.inv.weapons.smg || me.inv.weapons.rifle || me.inv.weapons.shotgun);
        // Their bunker is sealed: every death of theirs is an elimination, so hunting them is worth the most.
        const sealedHunt = c.rivalIsl && view.sealed[c.rivalIsl.index] && c.rival.alive ? this.P.drive.sealedHunt : 0;
        return (0.3 + 0.25 * t.aggression - (upgraded ? 0 : 0.12 * t.patience)) * (0.5 + 0.5 * Math.max(hp, 1 - t.caution)) + sealedHunt - this.kitlessAttack(c);
      }
      case 'seal': {
        const kit = sealKit(me.inv);
        if (view.suddenDeath || !(c.reach || c.hookFrom) || !c.rivalIsl || kit === 0 || !c.openDoors.length) return 0;
        const near = c.on === c.rivalIsl.index && dist2D(me.pos, c.rivalIsl.bunker.center) < 15;
        const ownerAway = !!c.rival && c.rival.alive && this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)?.island !== c.rival.island &&
          !!this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC);
        // Standing on their island with nobody home (not seen here lately): the door is open, plug it now.
        const empty = c.on === c.rivalIsl.index && !!c.rival && c.rival.alive && !ownerAway &&
          this.mem.recent(c.rival.id, view.now, this.P.drive.emptyHomeSec)?.island !== c.rival.island;
        return this.P.drive.sealBonus + this.endgameSeal(c) + (this.inWindow(c) ? this.P.drive.windowPush : 0) + (kit >= c.openDoors.length ? 0.6 : 0.3) + (rivalDown ? 0.5 + 0.3 * t.opportunism : 0) + (near ? 0.1 : 0) +
          (ownerAway || empty ? this.P.drive.sealAway + 0.2 * t.opportunism : 0);
      }
      case 'cut': {
        if (!gun || c.on !== home.index || view.suddenDeath) return 0;
        const deck = this.incomingDeck(c);
        if (!deck) return 0;
        // Someone out on the bridge: drop the deck under them (water) or strand them; an attacker who came
        // over it can't run home either.
        const crossing = this.crossing(c) ? 0.65 : 0;
        const threat = this.intruder(c) ? (c.enemy ? 0.1 : 0.3) : 0;
        return 0.15 + 0.5 * t.builder * t.caution + threat + crossing - (c.rival && c.reach ? 0.2 * t.aggression : 0);
      }
      case 'loot': {
        const bag = this.nearestLoot(c);
        const crate = this.nearestCrate(c);
        // Sudden death with no ammo: a bag (guns, rounds) beats punching (CI storm seed 7: two fist-only bots traded
        // punches with regen for 3 min beside full bags).
        if (bag && !gun && view.suddenDeath) return SD_FISTS_ATTACK + 0.1;
        const bagScore = bag ? 0.35 + 0.45 * t.greed + (gun ? 0 : 0.2) - dist2D(bag, me.pos) / 70 : 0;
        // A crate is a small, uncertain prize: worth a short detour, never a trip.
        const crateScore = crate ? 0.2 + 0.3 * t.greed - dist2D(crate.pos, me.pos) / 30 : 0;
        return Math.max(bagScore, crateScore);
      }
      case 'cover': {
        const cv = this.cover;
        if (!cv || (c.enemy && c.enemyDist < 5)) return 0;
        // Winning the trade (they're much lower): push the kill instead of hiding.
        if (c.enemy && c.enemy.hp + c.enemy.shield < me.hp + me.shield - this.P.buildTuning.pushLead) return 0;
        return this.P.buildTuning.coverScore + 0.1 * t.builder;
      }
      case 'fortify': {
        if (view.suddenDeath || c.on !== home.index || c.danger || !gun || this.intruder(c)) return 0;
        if (!this.fortWorthIt(c)) return 0;
        const next = this.nextSlot(c);
        return next ? this.P.buildTuning.fortifyScore + 0.3 * t.builder : 0;
      }
      case 'trap': {
        if (view.suddenDeath || c.on !== home.index || c.danger || me.inv.traps <= 0) return 0;
        if (this.myTraps(view).length >= TRAP.maxPerPlayer || !this.nextTrapSpot(c)) return 0;
        return this.P.trap.setScore + 0.2 * t.builder + 0.1 * t.caution;
      }
      case 'raid': {
        if (view.suddenDeath || !gun) return 0;
        const isl = this.raidIsland(c);
        if (!isl) return 0;
        return 0.2 + 0.45 * t.greed + Math.min(view.generators[isl.index], 500) / 1000 - (c.on === isl.index ? 0 : 0.15);
      }
    }
  }

  /**
   * Going after an unsealed rival without a seal kit I could afford: a kill at their bunker can't become a seal (they're
   * back in 10 s), so shop for the kit first (drive.kitlessAttack). Mixed ×60 on main: 65% of kills within 30 m of the
   * victim's bunker were by a bot holding no plug at all; 3 of 19 such kills a game turned into a seal.
   */
  kitlessAttack(c: Ctx): number {
    const pen = this.P.drive.kitlessAttack[this.difficulty];
    if (pen <= 0 || !c.rivalIsl || c.view.sealed[c.rivalIsl.index] || c.view.suddenDeath) return 0;
    const short = Math.max(c.openDoors.length, 1) - sealKit(c.me.inv);
    if (short <= 0 || c.me.inv.cash + c.me.vault.cash < short * PIECES.wood.price) return 0;
    // Only when the shop would sell me a plug now (a full hotbar can't take a new piece kind: botWeaponCommit seed 1,
    // half the marked-down ticks had no plug in the plan and the bot hung about home instead).
    return this.plan(c).items.some((i) => (KIT_PIECES as string[]).includes(i)) ? pen : 0;
  }

  /** Sniper threshold for bestGun: sniper.useM, or useM - hystM while holding it (no flip-flop at the edge). */
  private sniperM(me: PlayerState): number {
    const S = this.P.sniper;
    return me.equipped === 'sniper' ? S.useM - S.hystM : S.useM;
  }

  /** Does `their` long gun out-range my best gun at `d` m? A rifle beats anything short of a rifle; a sniper beats all but a sniper. */
  private outgunned(their: WeaponKind, inv: Inventory, d: number): boolean {
    const mine = bestGun(inv, d, 8, this.P.sniper.useM);
    return their === 'sniper' ? mine !== 'sniper' : their === 'rifle' && mine !== 'rifle' && mine !== 'sniper';
  }

  /**
   * A visible rifle or sniper just hit me from past strength.outrangedM, where my own best gun doesn't match it: remember
   * it. A rival's scope glinting at me from there (scoped sniper pointed my way) counts too, before the shot (sniper.glint).
   */
  private noteOutranged(view: BotView) {
    const S = this.P.strength;
    if (S.outranged[this.difficulty] <= 0) return;
    if (this.mem.lastHurtBy !== null && view.now - this.mem.lastHurtAt <= 0.1) {
      const e = view.enemies.find((x) => x.id === this.mem.lastHurtBy);
      const d = e ? dist2D(e.pos, view.self.pos) : 0;
      if (e && d >= S.outrangedM && this.outgunned(e.equipped, view.self.inv, d)) { this.outranged = { id: e.id, t: view.now }; return; }
    }
    if (this.P.sniper.glint[this.difficulty] <= 0) return;
    for (const e of view.enemies) {
      if (!e.alive || e.equipped !== 'sniper' || !e.ads) continue;
      const d = dist2D(e.pos, view.self.pos);
      if (d < S.outrangedM || !this.outgunned('sniper', view.self.inv, d) || !glintsAt(e, view.self)) continue;
      this.outranged = { id: e.id, t: view.now };
      this.glintNote = { t: view.now, id: e.id };
      return;
    }
  }

  /** The rifle out-ranging me right now that I can't close on (not on my ground): break line of sight. Null if none. */
  /** Score of breaking line of sight from outrangedBy: strength.outranged after a hit, sniper.glint after a glint alone. */
  outrangedScore(c: Ctx): number {
    if (!this.outrangedBy(c)) return 0;
    const g = this.glintNote, o = this.outranged!;
    return g && g.id === o.id && g.t === o.t ? this.P.sniper.glint[this.difficulty] : this.P.strength.outranged[this.difficulty];
  }

  outrangedBy(c: Ctx): PlayerState | null {
    const o = this.outranged;
    if (!o || c.view.now - o.t > this.P.strength.outrangedSec || c.view.suddenDeath) return null;
    const e = c.view.enemies.find((x) => x.id === o.id && x.alive);
    return e && !this.sameGround(c.me.pos, e.pos) && this.outgunned(e.equipped === 'sniper' ? 'sniper' : 'rifle', c.me.inv, dist2D(e.pos, c.me.pos)) ? e : null;
  }

  /** Out-ranged by a rifle within strength.outrangedMemSec. */
  outrangedLately(now: number): boolean {
    return !!this.outranged && now - this.outranged.t < this.P.strength.outrangedMemSec;
  }

  /** Rifle before bridging gear: rich enough (strength.rifleAt), or out-ranged lately with its price to spend. */
  /** No sniper yet, a long-range taste (sniper.taste) and a long sight line to the rival (sniper.longM): one is wanted (bought at sniper.buyAt). */
  sniperTaste(c: Ctx): boolean {
    const S = this.P.sniper;
    if (c.me.inv.weapons.sniper || this.t.range < S.taste[this.difficulty]) return false;
    return !!c.rivalIsl && dist2D(c.rivalIsl.center, c.home.center) >= S.longM;
  }

  wantsRifle(c: Ctx): boolean {
    if (c.me.inv.weapons.rifle) return false;
    const cash = this.spendCash(c.me);
    const S = this.P.strength;
    // Out-ranged lately, or someone I believe is a rifle user who hits me from range (belief.ts).
    const outranged = this.outrangedLately(c.view.now) || (S.outranged[this.difficulty] > 0 && !!this.beliefs.rifleUser(S.outrangedM));
    return cash >= S.rifleAt[this.difficulty] || (outranged && cash >= WEAPONS.rifle.price);
  }

  /** Away from home carrying at least strength.richCarry, a walk home, nobody near: the trip home to bank it (more the more I carry). */
  bankAway(c: Ctx): number {
    const S = this.P.strength, v = S.bankAway[this.difficulty];
    if (v <= 0 || c.view.suddenDeath || this.stormPrep(c.view) || !c.homeReach || c.me.inv.cash < S.richCarry || this.trapped(c)) return 0;
    if (c.enemy && c.enemyDist < ENGAGE_RANGE) return 0;
    // The more I carry, the more a death costs: up to twice the knob at 2 × richCarry.
    return v * Math.min(2, c.me.inv.cash / S.richCarry) - dist2D(c.me.pos, c.home.vault) / 200;
  }

  /** With strength.endgameLeft or fewer players still in (me included): the seal pressure bonus, else 0. */
  endgameSeal(c: Ctx): number {
    const S = this.P.strength, v = S.endgameSeal[this.difficulty];
    if (v <= 0 || c.view.suddenDeath) return 0;
    return 1 + c.view.others.filter((o) => !o.eliminated).length <= S.endgameLeft ? v : 0;
  }

  /** Endgame, short of a seal kit for the rival's open doors and the shop sells me a plug: that trip's score (else 0). */
  endgameKit(c: Ctx, items: ShopItem[]): number {
    const e = this.endgameSeal(c);
    if (!e || !c.rivalIsl || c.view.sealed[c.rivalIsl.index] || sealKit(c.me.inv) >= Math.max(1, c.openDoors.length)) return 0;
    return items.some((i) => (KIT_PIECES as string[]).includes(i)) ? 0.55 + e : 0;
  }

  /** strength.leaderFocus when `o` leads the kills (at least 2, more than mine, nobody ahead), else 0. */
  leaderFocus(view: BotView, o: { kills: number }): number {
    const v = this.P.strength.leaderFocus[this.difficulty];
    if (v <= 0 || o.kills < 2 || o.kills <= view.self.kills) return 0;
    return view.others.every((x) => x.eliminated || x.kills <= o.kills) ? v : 0;
  }

  /** Extra bail-out hp line while my own bunker is sealed (a death now is final), by tier (drive.sealedCaution). */
  sealedCaution(c: Ctx): number {
    return c.view.sealed[c.home.index] && !c.view.suddenDeath ? this.P.drive.sealedCaution[this.difficulty] : 0;
  }

  /** My bunker is sealed and no enemy is close enough to punish me for turning to clear it. */
  private sealedHomeCalm(c: Ctx): boolean {
    return !c.enemy || c.enemyDist > SEALED_HOME_CLEAR;
  }

  /** Inside my own sealed bunker (respawned into it, or sealed in alive): getting out is all that matters. */
  private trapped(c: Ctx): boolean {
    // Sudden death: concrete barriers fill every doorway (barriers.ts), so from inside there is no getting out at all;
    // fight from where I stand (through the slits) instead of pushing into a slab until the countdown ends.
    if (c.view.suddenDeath && insideBunker(c.home.bunker, c.me.pos)) return false;
    return c.me.breakoutUntil !== null || (c.view.sealed[c.home.index] && !c.view.suddenDeath && insideBunker(c.home.bunker, c.me.pos) && underRoof(c.home, c.me.pos));
  }

  /**
   * Misjudgement of a goal's worth (NOISE): a wrong idea that lasts a few seconds, not one re-rolled at every rescore
   * (fresh noise each time made near-ties flip back and forth every second).
   */
  private goalNoise(g: Goal, now: number): number {
    const n = this.noise.get(g);
    if (n && now < n.until) return n.v;
    // One draw per misjudgement, as when it was re-rolled at every rescore (a second draw would shift the whole rng
    // stream: every goal choice from the first tick on differs). The hold length comes off the same draw's tail digits.
    const r = this.rng(), v = (r - 0.5) * NOISE[this.difficulty];
    this.noise.set(g, { v, until: now + NOISE_HOLD_SEC * (0.75 + 0.5 * ((r * 1024) % 1)) });
    return v;
  }

  private pick(c: Ctx): Goal {
    // Inside my own bunker with a doorway plugged: clearing it (or slipping out round it) comes first. Any other goal
    // walks into the plug (measured: a PRO stood 260 s inside, its collect route running through its plugged door).
    const walledIn = !c.view.suddenDeath && insideBunker(c.home.bunker, c.me.pos) && this.blockers(c).some((p) => this.canClear(c, p));
    if (this.trapped(c) || walledIn) { this.probe?.decided(c, null, 'defend'); return 'defend'; }
    const rows: ScoreRow[] | null = this.probe ? [] : null;
    // Nothing scores: wait at my generator (or go at my rival); in the storm, stay in the ring (doStorm holds inside it).
    let best: Goal = c.view.storm ? 'storm' : (c.homeReach || !c.reach) && !(c.reach && this.difficulty !== 'easy' && this.offensive(c)) ? 'collect' : 'attack', bestScore = -Infinity;
    const scored: { goal: string; score: number }[] = [];
    for (const g of GOALS) {
      if ((this.goalBan.get(g) ?? -Infinity) > c.view.now && !this.stormPrepGoal(g)) continue; // banned for a while (goal watchdog)
      const raw = this.score(g, c);
      const base = this.teamDrive(g, c, this.drive(g, c, raw));
      if (base <= 0 && g !== best) { rows?.push({ goal: g, raw, base, noise: 0, sticky: 0, score: base }); continue; }
      const noise = this.goalNoise(g, c.view.now), sticky = g === this.goal ? STICKY : 0;
      const s = base + noise + sticky + (this.goalBias ? this.goalBias(g, c.view) : 0);
      rows?.push({ goal: g, raw, base, noise, sticky, score: s });
      scored.push({ goal: g, score: s });
      if (s > bestScore) { bestScore = s; best = g; }
    }
    this.lastScores = scored.sort((a, b) => b.score - a.score).slice(0, 4);
    if (rows) this.probe!.decided(c, rows, best);
    return best;
  }

  /** On an offensive plan: gun in hand and either the money for a few walls or enough time gone by. */
  private offensive(c: Ctx): boolean {
    const me = c.me;
    if (c.view.suddenDeath || !ownsGun(me.inv) || this.cautious(c.view.now)) return false;
    return c.view.now >= this.P.drive.offenseAt[this.difficulty] || me.inv.cash + me.vault.cash >= this.P.drive.offenseCash[this.difficulty];
  }

  /**
   * Seek the win (not for easy players): stay home only for a real threat, retreat only while losing and not for
   * long, don't trade shots across the water, and once on offense put bridge/attack/seal (and the shopping for them)
   * ahead of chores.
   */
  private drive(g: Goal, c: Ctx, s: number): number {
    if (this.difficulty === 'easy') return s;
    const { view, me } = c;
    const now = view.now;
    switch (g) {
      case 'guard': {
        const i = this.intruder(c);
        const onIsland = !!i && now - i.t < this.P.drive.guardFreshSec && dist2D(i.pos, c.home.center) < c.home.radius;
        return onIsland ? s : 0;
      }
      case 'disengage': case 'heal': {
        // Retreat only when losing: still ahead of the one in front of me, keep fighting.
        if (g === 'disengage' && c.enemy && c.enemy.hp + c.enemy.shield < me.hp + me.shield) return 0;
        const long = this.retreatSince !== null && now - this.retreatSince > this.P.drive.reengageSec;
        const stillHit = now - this.mem.lastHurtAt < 3;
        return long && !stillHit && me.hp / 100 > this.P.drive.reengageHp ? 0 : s;
      }
      case 'fight': {
        if (!c.enemy || (view.suddenDeath && !ownsGun(me.inv))) return s; // no ammo in sudden death: go and punch
        const sameIsland = this.sameGround(me.pos, c.enemy.pos);
        return !sameIsland && c.enemyDist > this.P.drive.plinkRange ? 0 : s;
      }
    }
    if (!this.offensive(c)) return s;
    switch (g) {
      case 'bridge': case 'attack': case 'seal': return s > 0 ? s + this.P.drive.push[this.difficulty] : s;
      case 'shop': {
        if (!c.homeReach) return s;
        const plan = this.plan(c);
        const push = plan.items.find((i) => PUSH_GEAR.includes(i));
        return push && !this.buyBlocked(push) ? Math.max(s, this.P.drive.shopForPush) : s;
      }
      case 'collect': {
        const stored = view.generators[c.home.index];
        const geared = (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c) && sealKit(me.inv) >= c.openDoors.length;
        return geared && stored < this.P.drive.collectCarried ? Math.min(s, 0.2) : s;
      }
      // The center island is where the fights are: worth going for when it pays.
      case 'contest': return s > 0 ? s + this.P.drive.push[this.difficulty] * 0.5 : s;
      case 'fortify': return this.t.builder >= Math.min(this.P.buildTuning.fortEarlyBuilder, this.P.buildTuning.fortSealedRule[this.difficulty]) ? s * 0.5 : 0;
      case 'trap': return s * 0.6;
      case 'cut': return this.crossing(c) ? s : s * 0.4;
      // Banking with danger near is protecting the money (a death drops it all); idle banking waits.
      // Buying the vault level isn't idle banking (halved, it never beat the shop next door before a seal run).
      case 'bank': return this.insuranceDue(me) > 0 || c.danger || this.wantsVaultUpgrade(me) ? s : s * 0.5;
      case 'loot': return s * 0.6;
    }
    return s;
  }

  private act(g: Goal, c: Ctx): Act {
    switch (g) {
      case 'collect': return this.goTo(c.home.generator, 2.0);
      case 'shop': return this.doShop(c);
      case 'bank': return this.doBank(c);
      case 'bridge': return this.doBridge(c);
      case 'attack': return this.doAttack(c);
      case 'seal': return this.doSeal(c);
      case 'defend': return this.doDefend(c);
      case 'guard': return this.doGuard(c);
      case 'cut': return this.doCut(c);
      case 'loot': return this.doLoot(c);
      case 'raid': return this.doRaid(c);
      case 'heal': return this.goTo(c.home.vault, 2.0);
      case 'fight': return this.doFight(c);
      case 'disengage': return this.doDisengage(c);
      case 'cover': return this.doCover(c);
      case 'fortify': return this.doFortify(c);
      case 'trap': return this.doTrap(c);
      case 'storm': return this.doStorm(c);
      case 'contest': return this.doContest(c);
      case 'assist': return this.doAssist(c);
      case 'regroup': return this.doRegroup(c);
    }
  }

  // ---------------------------------------------------------------- actions

  /** Walk toward dest via the route planner; null dir once within `arrive` m (or when no route exists). */
  private goTo(dest: Vec3, arrive = ARRIVE): Act {
    if (this.probe) this.probe.dest = dest;
    const self = this.view.self;
    if (dist2D(self.pos, dest) <= arrive) return IDLE;
    const home = this.view.map[self.island];
    if (insideBunker(home.bunker, self.pos) && !insideBunker(home.bunker, dest)) {
      // Sudden death: concrete barriers fill every doorway (barriers.ts). No way out: don't push into a slab.
      if (this.view.suddenDeath) return IDLE;
      // Out of my bunker first, around whatever stands in it or in its doorways.
      const path = this.homeGrid({ home, view: this.view } as Ctx).search(self.pos).path;
      if (path) return { dir: norm(flat(sub(path[Math.min(path.length - 1, 3)], self.pos))) };
      this.nextScoreAt = this.view.now;
      return IDLE;
    }
    const wp = this.nav.routeTo(dest);
    if (!wp) { this.nextScoreAt = this.view.now; return IDLE; }
    return { dir: norm(flat(sub(wp, self.pos))), sprint: dist2D(self.pos, dest) > 6 && islandAt(this.view.map, self.pos) >= 0 };
  }

  private doShop(c: Ctx): Act {
    const me = c.me, now = c.view.now;
    // The shop pays from the vault (carried cash first): no trip to fetch it. The rebuy insurance stays banked
    // unless the gun (or its ammo) is what I'm buying.
    const shop = this.shopSpot(c);
    if (!shop) { this.nextScoreAt = now; return IDLE; }
    const walk = this.goTo(shop, 2.0);
    if (dist2D(me.pos, shop) > USE_RANGE || now < this.nextBuyAt) return walk;
    let item = nextPurchase({ ...me, inv: { ...me.inv, cash: this.spendCash(me) } }, this.needs(c), this.difficulty, this.style);
    // Upgrades and gun locks sell only at my own shop.
    if (item && shop !== c.home.shop && isHomeOnly(item)) { this.buyBlockedUntil.set(item, now + BUY_BACKOFF_SEC); item = null; }
    if (!item || this.buyBlocked(item)) { this.nextScoreAt = now; return walk; }
    if (this.difficulty === 'easy' && item in PIECES && item !== 'scaffold' && this.rng() < EASY_MISBUY && me.inv.cash >= PIECES.sandbags.price) item = 'sandbags';
    this.nextBuyAt = now + BUY_GAP[this.difficulty];
    return { ...walk, shop: item };
  }

  private doBank(c: Ctx): Act {
    const me = c.me;
    const upgrade = this.wantsVaultUpgrade(me);
    // Remote vault level: deposit from right here (on my island); an upgrade still needs the vault itself.
    const remote = vaultSpec(me).remote && !upgrade && c.on === c.home.index;
    const walk = remote ? IDLE : this.goTo(c.home.vault, 1.8);
    if ((!remote && dist2D(me.pos, c.home.vault) > USE_RANGE) || me.busyUntil > c.view.now) return walk;
    const cash = Math.max(Math.floor(me.inv.cash - this.bankKeep(c)), this.insuranceDue(me));
    if (cash <= 0 && !upgrade) { this.nextScoreAt = c.view.now; return walk; }
    this.nextScoreAt = c.view.now + 1.2;
    return { ...walk, vault: { ...(cash > 0 ? { deposit: { cash } } : {}), ...(upgrade ? { upgrade: true as const } : {}) } };
  }

  /**
   * Carried cash a bank trip leaves on me: VaultParams.carry by skill in calm times; before a risky moment (danger
   * at home, an intruder, heading out) anyone but easy banks down to pocket money (min with the hard/PRO carry).
   */
  bankKeep(c: Ctx): number {
    const carry = this.P.vault.carry[this.difficulty];
    if (this.difficulty === 'easy') return carry;
    const leaving = c.reach || (c.me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c);
    return c.danger || this.intruder(c) || leaving ? Math.min(carry, this.P.vault.carry.hard) : carry;
  }

  /**
   * The next vault level is affordable with VaultParams.upgradeAt to spare (carried + banked). The first heal my stock
   * wants is bought before it (a PRO put $600 of $1082 into a level, then the hook and decks took the rest: no medkit).
   */
  wantsVaultUpgrade(me: PlayerState): boolean {
    // The heal stock for my money now, not the last plan's (cash just collected flipped this on for a tick, then off:
    // a vault trip started and dropped).
    if (healStock(me.inv.cash + me.vault.cash, this.difficulty, this.P.heal) > 0 && hpHealsHeld(me) === 0) return false;
    const price = vaultUpgradePrice(vaultLevel(me));
    return price !== null && funds(me) >= price + this.P.vault.upgradeAt[this.difficulty];
  }

  /** Grab the center island's gold (and free pieces, when they fit). */
  private doContest(c: Ctx): Act {
    const cv = c.view.center;
    if (!cv) return IDLE;
    const room = c.me.hotbar.includes(null) || c.me.hotbar.includes('sandbags');
    const supplyFirst = cv.bags + cv.steel > 0 && room && (cv.gold < CONTEST_AT ||
      dist2D(c.me.pos, cv.island.supplyGen) < dist2D(c.me.pos, cv.island.goldGen));
    if (cv.gold < 1 && !supplyFirst) { this.nextScoreAt = c.view.now; return IDLE; }
    return this.goTo(supplyFirst ? cv.island.supplyGen : cv.island.goldGen, 1.6);
  }

  private doBridge(c: Ctx): Act {
    if (c.bridgeTo === null) return IDLE;
    const to = c.bridgeTo, now = c.view.now;
    const toRival = to !== this.nav.centerNode && !this.allyIsland(c.view, to);
    // Main lane runs from my side (s grows toward them); the mirror lane (rivals only) is measured from their side.
    const mirror = toRival && this.alt.has(to) && c.bridgeFrom === c.home.index;
    const m = mirror ? this.mirrorFrontier(to) : null;
    const l = m ? m.l : this.nav.lane(c.bridgeFrom, to);
    const f = m ?? this.nav.frontier(l);
    const sign = mirror ? -1 : 1;
    const at = (k: number) => laneAt(l, f.s + sign * k);
    if (f.complete) { this.nextScoreAt = now; return IDLE; }
    if (toRival && this.scaffoldsNeeded(c) <= 1 && sealKit(c.me.inv) < c.openDoors.length) { this.nextScoreAt = now; return IDLE; }
    const key = `${l.from}>${l.to}`;
    // My bridge got shot out (a gap where decks were): skilled players lay an alternate one on the other lane
    // instead of feeding the same spot to whoever is covering it.
    const best = this.laneBest.get(key) ?? -Infinity;
    if (toRival && !mirror && f.s < best - 3) {
      this.laneBest.set(key, f.s);
      if (this.P.buildSkill[this.difficulty].altRoute) { this.alt.add(to); this.nextScoreAt = now; return IDLE; }
    }
    if (!mirror) this.laneBest.set(key, Math.max(best, f.s));
    // The alternate lane is laid under pressure: stock up on enough decks (vault cash too) before walking out,
    // rather than running dry a deck short and walking all the way back.
    if (mirror && c.on === c.home.index && c.homeReach && (c.me.inv.pieces.scaffold ?? 0) < this.scaffoldsNeeded(c)) {
      const buy = this.buyDecks(c);
      if (buy) return buy;
    }
    const stand = at(-1.1);
    const walk = this.goTo(stand, ARRIVE);
    if (walk.dir) return walk;
    const ahead = at(4);
    if (c.me.busyUntil > now) return { dir: null, face: ahead };
    // Long bridge: a wall along the deck edge facing the nearest third island (flank fire), walkway left free.
    const fromR = this.nav.nodes[c.bridgeFrom].radius;
    const shore = Math.sqrt(fromR * fromR - 9);
    const out = mirror ? l.length - shore - f.s : f.s - shore;
    const lastWall = this.lastWallS.get(key) ?? -Infinity;
    const wall = TALL.reduce((n, k) => n + (c.me.inv.pieces[k] ?? 0), 0) > c.openDoors.length ? PLAIN_WALLS.find((k) => (c.me.inv.pieces[k] ?? 0) > 0) : undefined;
    if (wall && this.P.buildSkill[this.difficulty].bridgeCover && this.wallsOnBridge && out > this.P.buildTuning.bridgeWallFrom && Math.abs(f.s - lastWall) >= this.P.buildTuning.bridgeWallEvery) {
      this.lastWallS.set(key, f.s);
      const side = flankSide(c.view.map, l);
      const p = add(at(-1.6), scale(right(yawOf(l.dir)), side * 0.85));
      const act = this.place(c, wall, v3(p.x, c.me.pos.y, p.z), yawOf(l.dir) + Math.PI / 2, ahead, `bridge side wall (${wall})`);
      if (act) return act;
    }
    const rotY = yawOf(l.dir);
    // Butt the new deck against the end of the last one (it sits level with whatever its near end attaches to).
    // Nothing fits (e.g. a gap shorter than a deck, something in the way): look again now and then, not every tick.
    const st = this.bridgeStuck?.key === key ? this.bridgeStuck : null;
    if (st && now - st.triedAt < this.P.buildTuning.bridgeRetrySec) return { dir: null, face: ahead };
    for (const [k, side] of DECK_TRIES) {
      const p = add(at(k), scale(right(rotY), side));
      const pos = v3(p.x, c.me.pos.y, p.z);
      if (!c.view.canPlace('scaffold', pos, rotY).ok) continue;
      this.nav.invalidate(); this.mirrorCache.clear();
      this.bridgeStuck = null;
      return { dir: null, face: ahead, build: { kind: 'scaffold', pos, rotY, free: true } };
    }
    if (!st) this.bridgeStuck = { key, since: now, triedAt: now };
    else {
      st.triedAt = now;
      // Stuck a while: skilled players go round on the other lane; anyone else leaves it for now.
      if (now - st.since > this.P.buildTuning.bridgeStuckSec) {
        this.bridgeStuck = null;
        if (toRival && !mirror && this.P.buildSkill[this.difficulty].altRoute) this.alt.add(to);
        // The center as a stepping stone that won't finish: bridge to the rival directly instead (not in the storm:
        // the center is where it ends).
        else if (to === this.nav.centerNode && !this.stormPrep(c.view)) { this.alt.delete(to); this.laneBan.set(to, now + this.P.buildTuning.laneBanSec); }
        else { this.alt.delete(to); this.bridgeHoldUntil = now + this.P.buildTuning.bridgeHoldSec; }
        this.nextScoreAt = now;
      }
    }
    return { dir: null, face: ahead };
  }

  private doAttack(c: Ctx): Act {
    if (!c.rivalIsl || !c.rival) return IDLE;
    if (c.hunt !== null) {
      if (c.hookFrom) return this.toHookLaunch(c);
      this.nextScoreAt = c.view.now;
      return IDLE;
    }
    if (!c.reach && c.hookFrom) return this.toHookLaunch(c);
    const now = c.view.now;
    // Hunt them where they were last seen, if that's somewhere I can walk to; else go to their bunker.
    const seen = this.mem.recent(c.rival.id, now, 10);
    if (seen && c.rival.alive && seen.island >= 0 && seen.island !== c.rival.island && (seen.island === c.on || this.nav.hop(c.src, seen.island) !== null))
      return this.goTo(seen.pos, 3);
    const b = c.rivalIsl.bunker;
    // Their bunker is sealed: camp the plug most likely to give (weakest), out of grenade reach, and shoot
    // whoever breaks out (respawned inside, they're eliminated if they die before getting clear) or comes
    // home to unseal it.
    if (this.sieging(c) && c.on === c.rivalIsl.index) {
      const hp = (d: Doorway) => doorPieces(c.view.pieces, d).reduce((n, p) => n + p.hp, 0);
      const door = b.doorways.reduce((a, d) => (hp(d) < hp(a) ? d : a));
      const layer = this.reinforce(c, door, hp(door));
      if (layer) return layer;
      const spot = add(door.center, scale(forward(door.yaw), this.P.drive.siegeDist));
      const walk = this.goTo(spot, 1.2);
      return walk.dir ? walk : { dir: null, face: v3(door.center.x, door.center.y + CHEST, door.center.z) };
    }
    // They went into their bunker: take the open doorway that sees inside (grenade it, shoot what comes out).
    const inside = c.on === c.rivalIsl.index ? this.inTheirBunker(c) : null;
    const door = inside ? b.doorways.filter((d) => !doorBlocked(c.view.pieces, d))
      .sort((x, y) => dist2D(x.center, c.me.pos) - dist2D(y.center, c.me.pos))[0] : undefined;
    if (door) {
      const walk = this.goTo(add(door.center, scale(forward(door.yaw), 4.5)), 1.0);
      return walk.dir ? walk : { dir: null, face: v3(b.center.x, b.center.y + CHEST, b.center.z) };
    }
    if (!this.wander || now >= this.wander.until || dist2D(this.wander.to, b.center) > 12) {
      const front = b.doorways[0];
      const base = add(front.center, scale(forward(front.yaw), 7));
      const a = this.rng() * 2 * Math.PI, r = this.rng() * 3;
      this.wander = { to: add(base, v3(dm.cos(a) * r, 0, dm.sin(a) * r)), until: now + 3 + this.rng() * 2 };
    }
    return this.goTo(this.wander.to, 1.0);
  }

  /**
   * Sieging: a second wall outside the softest plug while it's under drive.reinforceHp (a respawn pistol shoots a wood
   * plug out in ~7 s of the 10 s breakout window; two layers outlast it). Null: nothing to add, or no spot for it.
   */
  private reinforce(c: Ctx, door: Doorway, doorHp: number): Act | null {
    const kind = TALL.find((k) => (c.me.inv.pieces[k] ?? 0) > 0);
    if (!kind || doorHp >= this.P.drive.reinforceHp[this.difficulty]) return null;
    const stand = add(door.center, scale(forward(door.yaw), 2.5));
    const walk = this.goTo(stand, ARRIVE);
    if (walk.dir) return walk;
    const base = plugSpot(door, kind, 0);
    if (c.me.busyUntil > c.view.now) return { dir: null, face: base };
    // Just outside whatever already fills the doorway.
    for (const push of [0.2, 0.3, 0.45, 0.6]) {
      const pos = add(base, scale(forward(door.yaw), push));
      if (c.view.canPlace(kind, pos, door.yaw).ok) return { dir: null, face: base, build: { kind, pos, rotY: door.yaw, free: true } };
    }
    return null;
  }

  private doSeal(c: Ctx): Act {
    const isl = c.rivalIsl;
    if (!isl || !c.openDoors.length) return IDLE;
    if (!c.reach && c.hookFrom) return this.toHookLaunch(c);
    const standOf = (d: Doorway) => add(d.center, scale(forward(d.yaw), 2.5));
    const door = c.openDoors.reduce((a, d) => (dist2D(standOf(d), c.me.pos) < dist2D(standOf(a), c.me.pos) ? d : a));
    const plug = plugFor(c.me.inv, c.view.pieces, door);
    if (!plug) { this.nextScoreAt = c.view.now; return IDLE; }
    const walk = this.goTo(standOf(door), ARRIVE);
    if (walk.dir) return walk;
    const base = plugSpot(door, plug.kind, plug.level);
    if (c.me.busyUntil > c.view.now) return { dir: null, face: base };
    for (const push of [0, 0.1, 0.2, 0.3]) {
      const pos = add(base, scale(forward(door.yaw), push));
      if (!c.view.canPlace(plug.kind, pos, door.yaw).ok) continue;
      return { dir: null, face: base, build: { kind: plug.kind, pos, rotY: door.yaw, free: true } };
    }
    return { dir: null, face: base };
  }

  /** My rival's bunker is sealed and they're in it or around it (just died, or seen there lately): camp it. */
  private sieging(c: Ctx): boolean {
    if (!c.rival || !c.rivalIsl || !c.view.sealed[c.rivalIsl.index] || c.view.suddenDeath) return false;
    const now = c.view.now;
    if (now - (this.mem.diedAt.get(c.rival.id) ?? -Infinity) < this.P.drive.siegeAfterDeath) return true;
    const s = this.mem.recent(c.rival.id, now, 10);
    return !!s && s.island === c.rivalIsl.index;
  }

  /** Pieces in my own doorways, softest-to-clear first. */
  private blockers(c: Ctx): PieceState[] {
    return c.home.bunker.doorways.flatMap((d) => doorPieces(c.view.pieces, d)).sort((a, b) => Number(isHard(a.kind)) - Number(isHard(b.kind)));
  }

  private doDefend(c: Ctx): Act {
    const { me, home } = c;
    const b = home.bunker;
    const inside = insideBunker(b, me.pos);
    // Inside: walk out around whatever is in the way, or break through (top priority under the countdown).
    if (inside) return this.escape(c);
    if (me.breakoutUntil !== null) {
      // Countdown running just outside the bunker: step clear of its radius.
      const away = add(b.center, scale(norm(flat(sub(me.pos, b.center))), BUNKER_OUT + 0.5));
      return { ...this.goTo(v3(away.x, home.groundY, away.z), 0.4), sprint: true };
    }
    const all = this.blockers(c);
    const target = all.find((p) => this.canClear(c, p));
    if (!target) { this.nextScoreAt = c.view.now; return IDLE; }
    const door = b.doorways.find((d) => doorPieces(c.view.pieces, d).includes(target));
    if (!door) throw new Error(`Bot ${this.id}: blocker ${target.id} matches no doorway`);
    const fists = !ownsGun(me.inv);
    // Punching from outside means standing within the countdown radius: only while it isn't sealed.
    const noPunch = fists && !inside && c.view.sealed[home.index];
    // A charge for hard plugs, and for a soft one I can't shoot or punch (canClear counted on it: ffa8-mixed seed 10,
    // a gunless Hard with a charge stood 9.5 min "clearing" a wood plug).
    if (me.inv.charges > 0 && (isHard(target.kind) || noPunch)) return this.blast(c, door, target, inside);
    if (noPunch) { this.nextScoreAt = c.view.now; return IDLE; }
    return this.breakPlug(door, target, inside, fists);
  }

  /**
   * Can I get this plug out of my doorway with what I carry? Charges for anything; bullets for soft pieces and
   * (with a rifle) metal; fists only for soft pieces and only while not sealed (punching from outside means
   * standing inside the escape-countdown radius).
   */
  private canClear(c: Ctx, p: PieceState): boolean {
    const inv = c.me.inv;
    if (inv.charges > 0) return true;
    if (p.kind === 'metal') return hasAmmo(inv, 'rifle');
    if (isHard(p.kind)) return false;
    return ownsGun(inv) || !c.view.sealed[c.home.index] || insideBunker(c.home.bunker, c.me.pos);
  }

  /** Shoot (or punch) a plug from in front of its doorway, on my side of it. */
  private breakPlug(door: Doorway, plug: PieceState, inside: boolean, fists: boolean): Act {
    const center = v3(plug.pos.x, plug.pos.y + PIECES[plug.kind].h / 2, plug.pos.z);
    // Fists reach 2 m: stand right at the doorway. Shooting from outside: from beyond the countdown radius.
    const back = inside ? (fists ? -0.7 : -1.6) : fists ? 1.4 : BUNKER_OUT - MAP.bunker.interior / 2 + 0.3;
    const walk = this.goTo(add(door.center, scale(forward(door.yaw), back)), fists ? 0.3 : 1.0);
    return walk.dir ? walk : { dir: null, shootAt: center };
  }

  /** Walk up to a hard plug, put a charge on it, and get clear before it goes off. */
  private blast(c: Ctx, door: Doorway, plug: PieceState, inside: boolean): Act {
    const center = v3(plug.pos.x, plug.pos.y + PIECES[plug.kind].h / 2, plug.pos.z);
    const spot = add(door.center, scale(forward(door.yaw), inside ? -1.2 : 1.6));
    const walk = this.goTo(spot, 0.4);
    if (walk.dir) return walk;
    const facing = Math.abs(wrapAngle(c.me.yaw - lookAt(eyePos(c.me), center).yaw)) < 0.1;
    if (facing && c.me.busyUntil <= c.view.now) {
      this.retreat = { from: center, until: c.view.now + 3.5 };
      return { dir: null, face: center, placeCharge: true, lookFirst: true };
    }
    return { dir: null, face: center, lookFirst: true };
  }

  /** Occupancy grid of my bunker, rebuilt when the pieces around it change. */
  private homeGrid(c: Ctx): BunkerGrid {
    const blockers = blockingPieces(c.home.bunker, c.view.pieces);
    const key = blockers.map((p) => p.id).join(',');
    if (!this.grid || this.grid.key !== key) this.grid = { key, grid: new BunkerGrid(c.home.bunker, blockers) };
    return this.grid.grid;
  }

  /**
   * Out of my own bunker: follow the grid path around walls and pieces; with no way out, break the piece that is
   * cheapest to get through (a charge from a safe spot, else gun or fists, facing it squarely), then walk out.
   */
  private escape(c: Ctx): Act {
    const { me, view } = c;
    const now = view.now;
    const grid = this.homeGrid(c);
    const here = grid.search(me.pos);
    const cells = here.reach.map((k) => grid.center(k));
    // Just planted a charge: keep to the far side until it goes off.
    if (this.hideFrom && now < this.hideFrom.until) {
      const far = cells.reduce<Vec3 | null>((a, p) => (!a || dist2D(p, this.hideFrom!.pos) > dist2D(a, this.hideFrom!.pos) ? p : a), null);
      return far && dist2D(far, me.pos) > 0.2 ? { dir: norm(flat(sub(far, me.pos))) } : IDLE;
    }
    this.hideFrom = null;
    // The grid says there's a way out but walking it gets me nowhere (a plug the grid misreads, physics disagrees):
    // stop trusting it for a while and break something instead (replay 7d6d6fa: trapped bots pressed against a wall
    // for the whole countdown, never firing).
    if (here.path && now >= this.escapeNoPathUntil) {
      if (!this.escapeRef || dist2D(this.escapeRef.pos, me.pos) > ESCAPE_STALL_M || now - this.escapeRef.t > ESCAPE_STALL_SEC * 3) this.escapeRef = { pos: clone(me.pos), t: now };
      else if (now - this.escapeRef.t > ESCAPE_STALL_SEC) { this.escapeNoPathUntil = now + 3; this.escapeRef = null; }
    }
    if (here.path && now >= this.escapeNoPathUntil) {
      const wp = here.path[Math.min(here.path.length - 1, 3)];
      const dir = norm(flat(sub(wp, me.pos)));
      // The way out goes over a piece too low to block (a lone sandbag in a doorway): hop it, don't walk into it.
      const hop = view.pieces.some((p) => {
        if (p.kind === 'ramp' || p.kind === 'scaffold') return false;
        const top = p.pos.y + PIECES[p.kind].h - me.pos.y, to = flat(sub(p.pos, me.pos));
        return top > 0.4 && top < SEAL.blockHeight && dist2D(p.pos, me.pos) < 1.6 && to.x * dir.x + to.z * dir.z > 0;
      });
      return { dir, jump: hop };
    }
    const weapon = bestGun(me.inv, 1.5);
    const w = WEAPONS[weapon];
    const dps = w.dmg * w.pellets * w.rps;
    const charge = me.inv.charges > 0;
    const blastable = (p: PieceState) => charge && p.hp <= CHARGE.pieceDmg;
    const cost = (p: PieceState) => Math.min(breakCost(p, weapon, dps), blastable(p) ? CHARGE.fuseSec + 2 : Infinity);
    const nearDoor = (p: PieceState) => c.home.bunker.doorways.some((d) => dist2D(d.center, p.pos) < 1.8);
    // Nothing I carry gets through anything: still have a go at the weakest doorway plug (a human would).
    // Last resort (no single piece opens a path, e.g. two layers in every doorway): the weakest doorway plug, then
    // the nearest blocker. Trapped, standing still is never the answer.
    const target = pieceToBreak(grid, me.pos, cost, nearDoor) ??
      pieceToBreak(grid, me.pos, (p) => p.hp, nearDoor) ??
      [...grid.blockers].sort((a, b) => (nearDoor(b) ? 1 : 0) - (nearDoor(a) ? 1 : 0) || a.hp - b.hp || dist2D(a.pos, me.pos) - dist2D(b.pos, me.pos))[0] ?? null;
    if (!target) return IDLE;
    const center = v3(target.pos.x, target.pos.y + Math.min(PIECES[target.kind].h / 2, 1.2), target.pos.z);
    const useCharge = blastable(target) && breakCost(target, weapon, dps) > CHARGE.fuseSec + 2;
    // Stand squarely in front of it, in reach (fists 2 m, charge 2.5 m, guns: a bit back).
    const want = useCharge ? 1.3 : weapon === 'fists' ? 1.1 : 1.6;
    // Squarely in front of it, on the bunker side: the reachable cell nearest that ideal point.
    const ideal = add(target.pos, scale(norm(flat(sub(c.home.bunker.center, target.pos))), want));
    const spot = cells.reduce<Vec3 | null>((a, p) => (!a || dist2D(p, ideal) < dist2D(a, ideal) ? p : a), null);
    const inReach = dist2D(me.pos, target.pos) <= want + 0.5;
    if (spot && dist2D(spot, me.pos) > 0.3 && !(inReach && dist2D(spot, me.pos) < 0.8)) return { dir: norm(flat(sub(spot, me.pos))), face: center };
    if (useCharge) {
      const facing = Math.abs(wrapAngle(me.yaw - lookAt(eyePos(me), center).yaw)) < 0.1;
      if (!facing || me.busyUntil > now) return { dir: null, face: center, lookFirst: true };
      this.hideFrom = { pos: target.pos, until: now + CHARGE.fuseSec + 0.3 };
      return { dir: null, face: center, placeCharge: true, lookFirst: true };
    }
    return { dir: null, shootAt: center, shootFirst: true };
  }

  /** What utilityPlan.ts needs to know this tick (smoke / flash decisions and reactions). */
  private utilSituation(c: Ctx, healHiding: boolean): UtilSituation {
    const now = c.view.now;
    const seen = this.targetId !== null ? this.mem.recent(this.targetId, now, this.P.util.seenSec) : null;
    return {
      view: c.view, me: c.me, difficulty: this.difficulty, P: this.P.util, goal: this.goal, enemy: c.enemy, enemyDist: c.enemyDist,
      target: seen && this.targetId !== null ? { id: this.targetId, pos: seen.pos, t: seen.t } : null,
      rivalBunker: c.rivalIsl?.bunker.center ?? null,
      retreating: this.goal === 'disengage' || this.goal === 'heal' || healHiding || !!this.retreat,
      lastAt: this.utilLastAt, lastHurtAt: this.mem.lastHurtAt,
    };
  }

  /** A visible enemy out on a bridge coming toward my island. */
  private crossing(c: Ctx): boolean {
    const e = c.enemy;
    return !!e && islandAt(c.view.map, e.pos) < 0 && dist2D(e.pos, c.home.center) < c.home.radius + MAP.gap;
  }

  /**
   * Yaw/pitch for a grenade at a rival who just ducked out of sight (lobbed high over their cover), or at one
   * holed up in their bunker while I stand at an open doorway (thrown flat through it). Null if there's no such throw.
   */
  private grenadePlan(c: Ctx): Angles | null {
    const { view, me } = c;
    const now = view.now;
    if (me.inv.grenades <= 0 || now - this.lastNadeAt < NADE_GAP || view.suddenDeath && c.on < 0) { this.nadePlan = null; return null; }
    if (this.nadePlan && now < this.nadePlan.until) return this.nadePlan;
    this.nadePlan = null;
    const eye = eyePos(me);
    for (const o of view.others) {
      if (!o.alive) continue;
      const s = this.mem.seen.get(o.id);
      if (!s || s.t < (this.mem.diedAt.get(o.id) ?? -Infinity)) continue;
      const age = now - s.t, d = dist2D(me.pos, s.pos);
      const isl = s.island >= 0 ? view.map[s.island] : null;
      let low = false;
      if (isl && insideBunker(isl.bunker, s.pos)) {
        // Through a doorway I'm standing in front of.
        if (age > 30) continue;
        const door = isl.bunker.doorways.find((dw) => {
          const rel = flat(sub(me.pos, dw.center)), out = forward(dw.yaw);
          const ahead = rel.x * out.x + rel.z * out.z;
          return !doorBlocked(view.pieces, dw) && ahead > 1.5 && ahead < 10 && Math.abs(rel.x * out.z - rel.z * out.x) < 0.5;
        });
        if (!door) continue;
        low = true;
      } else if (age > NADE_SEEN_SEC || age < 0.3 || d < NADE_MIN || d > NADE_MAX) continue;
      const a = throwAngles(eye, v3(s.pos.x, s.pos.y + 0.3, s.pos.z), low);
      if (!a) continue;
      // Thrown by hand: as accurate as this player's aim.
      const cone = AIM[this.difficulty].coneRad * (low ? 0.5 : 1);
      const r = this.rng() * cone, th = this.rng() * 2 * Math.PI;
      this.nadePlan = { yaw: a.yaw + dm.cos(th) * r, pitch: a.pitch + dm.sin(th) * r, until: now + 1.2 };
      return this.nadePlan;
    }
    return null;
  }

  /** Someone was seen on my island: get back to the bunker front and watch where they were. */
  private doGuard(c: Ctx): Act {
    const s = this.intruder(c);
    if (!s) { this.nextScoreAt = c.view.now; return IDLE; }
    const b = c.home.bunker;
    const post = add(b.center, scale(norm(flat(sub(s.pos, b.center))), BUNKER_OUT + 0.5));
    const walk = this.goTo(post, 1.2);
    return walk.dir ? walk : { dir: null, face: add(s.pos, v3(0, CHEST, 0)) };
  }

  /** Shoot out the deck of an incoming bridge nearest my shore. */
  private doCut(c: Ctx): Act {
    const deck = this.incomingDeck(c);
    if (!deck) { this.nextScoreAt = c.view.now; return IDLE; }
    const center = v3(deck.pos.x, deck.pos.y + PIECES.scaffold.h / 2, deck.pos.z);
    const toDeck = norm(flat(sub(deck.pos, c.home.center)));
    const spot = add(c.home.center, scale(toDeck, c.home.radius - 6));
    const walk = this.goTo(v3(spot.x, c.home.groundY, spot.z), 1.5);
    return walk.dir ? walk : { dir: null, shootAt: center, shootFirst: this.crossing(c) };
  }

  private doLoot(c: Ctx): Act {
    const bag = this.nearestLoot(c);
    const crate = this.nearestCrate(c);
    if (crate && (!bag || dist2D(crate.pos, c.me.pos) + 4 < dist2D(bag, c.me.pos))) {
      // Walk up and break it (a punch or two shots), the loot bag lands where it stood.
      const d = dist2D(crate.pos, c.me.pos);
      const fists = c.me.equipped === 'fists';
      if (d > (fists ? 1.3 : 4)) return { ...this.goTo(crate.pos, fists ? 1.1 : 3.5), shootAt: undefined };
      return { dir: null, shootAt: crate.center };
    }
    if (!bag) { this.nextScoreAt = c.view.now; return IDLE; }
    return this.goTo(bag, 0.3);
  }

  /** A standing supply crate close by on ground I can walk to (only when it's cheap: near and quiet). */
  private nearestCrate(c: Ctx): { pos: Vec3; center: Vec3 } | null {
    // Never a detour while the storm closes in (sudden death): getting inside the ring comes first.
    if (c.enemy || c.danger || c.view.suddenDeath || c.view.storm) return null;
    let best: { pos: Vec3; center: Vec3 } | null = null, bestD = CRATE_RANGE;
    for (const h of c.view.hazards ?? []) {
      if (h.kind !== 'crate') continue;
      const d = dist2D(h.pos, c.me.pos);
      if (d >= bestD || Math.abs(h.pos.y - c.me.pos.y) > 1.5) continue;
      if (islandAt(c.view.map, h.pos) !== c.on) continue;
      best = h; bestD = d;
    }
    return best;
  }

  /**
   * PRO: a live barrel or tank right next to the enemy, out of my own blast range, in clear view: now
   * and then shoot it instead of them. Returns the point to shoot, or null.
   */
  private barrelShot(c: Ctx): Vec3 | null {
    const e = c.enemy, view = c.view, me = c.me;
    if (!e || BARREL_CHANCE[this.difficulty] <= 0 || me.equipped === 'fists') return null;
    const live = (id: number) => (view.hazards ?? []).find((h) => h.id === id && !h.fusing);
    if (this.barrelPlan) {
      const h = live(this.barrelPlan.id);
      if (h && view.now < this.barrelPlan.until && dist2D(h.pos, e.pos) < h.radius * 0.7) return h.center;
      this.barrelPlan = null;
    }
    if (view.now < this.nextBarrelRollAt) return null;
    let pick: { id: number; center: Vec3 } | null = null, bestD = Infinity;
    for (const h of view.hazards ?? []) {
      if (h.radius <= 0 || h.fusing) continue;
      const toEnemy = dist2D(h.pos, e.pos);
      const mine = dist2D(h.pos, me.pos);
      if (toEnemy >= h.radius * 0.6 || mine < h.radius + 1.5 || mine > WEAPONS[me.equipped].range * 0.8 || toEnemy >= bestD) continue;
      pick = h; bestD = toEnemy;
    }
    if (!pick) return null;
    this.nextBarrelRollAt = view.now + BARREL_ROLL_SEC;
    if (this.rng() >= BARREL_CHANCE[this.difficulty] || !view.clearShot?.(pick.center)) return null;
    this.barrelPlan = { id: pick.id, until: view.now + BARREL_AIM_SEC };
    return pick.center;
  }

  /**
   * A visible enemy standing on a pier section (or hiding behind a piece built on one): blow the section out
   * with a rocket (or a grenade) and drop them in the water. Rolled every dockRollSec at dockShot (+ dockDefend on
   * my own pier: an attacker crossing toward me); never from closer than dockMinRange, never a section near my feet.
   */
  private dockShot(c: Ctx): { at: Vec3; weapon: 'rocket' | 'grenade' } | null {
    const { view, me } = c;
    const e = c.enemy, docks = view.docks;
    const D = this.P.drive;
    if (!e || !docks?.length || D.dockShot[this.difficulty] <= 0) { this.dockPlan = null; return null; }
    // A loaded launcher only: with them in sight there's no time for a 3 s reload (weaponSlot reloads it in a lull).
    const rocket = me.inv.weapons.rocket, rockets = !!rocket && rocket.mag > 0;
    const nades = me.inv.grenades > 0 && view.now - this.lastNadeAt >= NADE_GAP;
    if (!rockets && !nades) { this.dockPlan = null; return null; }
    const top = (d: DockDef) => d.center.y + d.half.y;
    // The deck just in front of their feet (a rocket at the feet would burst on their legs first, a bit higher).
    const feet = (d: DockDef, p: Vec3) => {
      const t = norm(flat(sub(me.pos, p)));
      const f = v3(p.x + t.x * 0.7, top(d) + 0.05, p.z + t.z * 0.7);
      return overDock(d, f) ? f : v3(p.x, top(d) + 0.05, p.z);
    };
    const onDeck = (d: DockDef, p: Vec3, pad: number) => overDock(d, p, pad) && Math.abs(p.y - top(d)) < 0.8;
    const safe = (d: DockDef) => dist2D(d.center, me.pos) >= D.dockMinRange && !docks.some((x) => onDeck(x, me.pos, 0.5) && dist2D(x.center, d.center) < 4);
    const plan = this.dockPlan;
    if (plan) {
      const d = docks.find((x) => x.id === plan.id);
      // Still standing, still the same enemy on it (or still behind that cover), and the shot is still mine to take.
      if (d && plan.enemy === e.id && view.now < plan.until && safe(d) && dist2D(e.pos, plan.at) < 2.5 && (plan.weapon === 'grenade' ? nades : rockets)) {
        if (plan.why !== 'cover') plan.at = feet(d, e.pos);
        return plan;
      }
      this.dockPlan = null;
    }
    if (view.now < this.nextDockRollAt) return null;
    let pick: { d: DockDef; at: Vec3; why: 'under' | 'cover' | 'defend' } | null = null;
    for (const d of docks) {
      if (!safe(d)) continue;
      if (onDeck(d, e.pos, 0.3)) { pick = { d, at: feet(d, e.pos), why: d.island === c.home.index ? 'defend' : 'under' }; break; }
    }
    if (!pick && view.clearShot && !view.clearShot(add(e.pos, v3(0, CHEST, 0)))) {
      // Behind something built on a pier: take the planks out under that piece and the cover goes with them.
      for (const p of view.pieces) {
        if (dist2D(p.pos, e.pos) > 2.5) continue;
        const d = docks.find((x) => onDeck(x, p.pos, 0.1) && safe(x));
        if (d) { pick = { d, at: feet(d, p.pos), why: 'cover' }; break; }
      }
    }
    if (!pick) return null;
    this.nextDockRollAt = view.now + D.dockRollSec;
    const range = dist2D(me.pos, pick.at);
    const weapon = rockets && range <= WEAPONS.rocket.range * 0.9 ? 'rocket' : nades && range <= NADE_MAX ? 'grenade' : null;
    const chance = D.dockShot[this.difficulty] + (pick.d.island === c.home.index ? D.dockDefend : 0);
    if (!weapon || this.rng() >= chance) return null;
    if (weapon === 'rocket' && view.clearShot && !view.clearShot(pick.at) && pick.why !== 'cover') return null;
    this.dockPlan = { id: pick.d.id, enemy: e.id, at: pick.at, weapon, why: pick.why, until: view.now + 2.5 };
    return this.dockPlan;
  }

  /** Run from a fusing barrel; in a fight (outside the storm), also step out of blast range of live ones (they could be shot). */
  private hazardAvoid(c: Ctx, dir: Vec3 | null): Vec3 | null {
    const me = c.me;
    let push: Vec3 | null = null;
    for (const h of c.view.hazards ?? []) {
      // A live barrel is only a maybe; in the storm, staying inside the ring matters more (fusing ones still send everyone running).
      if (h.radius <= 0 || (!h.fusing && (!c.enemy || c.view.storm))) continue;
      const d = dist2D(h.pos, me.pos);
      // Fights: only out of the inner part of a live barrel's blast, where it would really hurt (measured on the
      // bot ladder: a wider berth costs the stronger bot its fights).
      const R = h.fusing ? h.radius + 1 : h.radius * 0.6;
      if (d >= R + HAZARD_FENCE_M) continue;
      const away = d < 0.05 ? right(me.yaw) : norm(flat(sub(me.pos, h.pos)));
      if (d >= R) {
        // Just got out: don't walk straight back in (the fight pulls me toward them, the barrel pushes me out, and I
        // shuffle on the line between): slide along the edge instead.
        const k = dir ? dir.x * away.x + dir.z * away.z : 0;
        if (dir && k < 0) { const t = v3(dir.x - away.x * k, 0, dir.z - away.z * k); dir = Math.hypot(t.x, t.z) < 0.2 ? null : norm(t); }
        continue;
      }
      push = add(push ?? v3(), scale(away, (h.fusing ? 3 : 2) * (1 - d / R) + 0.4));
    }
    if (!push) return dir;
    return norm(add(dir ?? v3(), push));
  }

  private doRaid(c: Ctx): Act {
    const isl = this.raidIsland(c);
    if (!isl) { this.nextScoreAt = c.view.now; return IDLE; }
    return this.goTo(isl.generator, 1.5);
  }

  /**
   * Into a cover spot and stay there: once in (0.8 m), only drifting COVER_LEAVE_M off it walks me back (no stepping
   * out and in again every tick). `shuffle`: a step along it in the strafe rhythm, as long as it keeps me in.
   */
  private holdCover(c: Ctx, spot: Vec3, shuffle: Vec3 | null): Act {
    const me = c.me, d = dist2D(spot, me.pos);
    if (d <= 0.8) this.inCover = true;
    else if (d > COVER_LEAVE_M) this.inCover = false;
    if (!this.inCover) return this.goTo(spot, 0.6);
    if (shuffle && dist2D(add(me.pos, scale(norm(shuffle), 0.3)), spot) < Math.max(d, 1)) return { dir: shuffle };
    return { dir: null };
  }

  /** Best spot behind solid cover from a shooter at e within reach, or null. */
  private coverFrom(c: Ctx, e: { pos: Vec3 }): Vec3 | null {
    const me = c.me;
    let best: Vec3 | null = null, bestD = 10;
    const consider = (center: Vec3, half: number) => {
      const away = norm(flat(sub(center, e.pos)));
      const spot = add(center, scale(away, half + 0.9));
      const d = dist2D(spot, me.pos);
      if (d >= bestD || dist2D(spot, e.pos) < 4) return;
      const g = c.view.groundAt(spot.x, spot.z);
      if (g === null || Math.abs(g - me.pos.y) > 0.6) return;
      best = v3(spot.x, g, spot.z); bestD = d;
    };
    // My own bunker only from beyond the escape-countdown radius.
    if (c.on >= 0) consider(c.view.map[c.on].bunker.center, c.on === c.home.index ? BUNKER_OUT - 0.9 : 2.6);
    for (const p of c.view.pieces) {
      if (!COVER_KINDS.has(p.kind) || dist2D(p.pos, me.pos) > 10 || Math.abs(p.pos.y - me.pos.y) > 0.6) continue;
      consider(p.pos, PIECES[p.kind].d / 2 + (p.kind === 'container' ? 1 : 0));
    }
    return best;
  }

  private doFight(c: Ctx): Act {
    const now = c.view.now, me = c.me, t = this.t;
    // Who I'm fighting: kept through a blink out of sight (FOE_HOLD_SEC, where I last saw them) and over someone not
    // clearly closer. A body ducking in and out of sight past a corner otherwise swaps my footwork to someone else
    // (or to nothing) and back every few ticks.
    let e: PlayerState | null = c.enemy;
    const held = this.fightFoe;
    if (held && e?.id !== held.id) {
      const s = this.mem.recent(held.id, now, FOE_HOLD_SEC);
      const alive = c.view.others.some((o) => o.id === held.id && o.alive);
      if (s && alive && (!e || dist2D(e.pos, me.pos) >= FOE_SWITCH * dist2D(s.pos, me.pos))) e = { ...held.e, pos: s.pos };
    }
    if (!e) { this.fightFoe = null; return IDLE; }
    if (e === c.enemy) this.fightFoe = { id: e.id, e };
    const enemyDist = dist2D(e.pos, me.pos);
    if (now >= this.strafeFlipAt) {
      this.strafeSign = this.rng() < 0.5 ? -1 : 1;
      this.strafeFlipAt = now + 0.6 + this.rng() * 0.8;
    }
    const to = norm(flat(sub(e.pos, me.pos)));
    // They're healing (hands busy for a second or two) and I'm fit to fight: rush them before it lands.
    if (e === c.enemy && (e.healAt !== null || e.drinking) && me.hp + me.shield >= this.P.heal.punishHp && this.difficulty !== 'easy') {
      this.healNote = { t: now, text: `@${e.id} is healing: rushing them` };
      const wp = this.sameGround(me.pos, e.pos) ? null : this.nav.routeTo(e.pos);
      if (this.sameGround(me.pos, e.pos) || wp) return { dir: norm(flat(sub(wp ?? e.pos, me.pos))), sprint: true, approach: true };
    }
    const gun = bestGun(me.inv, enemyDist, 8, this.sniperM(me));
    const pref = PREFERRED_RANGE[gun] * (0.8 + 0.5 * t.range);
    // Skilled players close in rather than trade shots from afar.
    const want = this.difficulty === 'easy' ? pref : Math.min(pref, this.P.drive.maxRange[this.difficulty]);
    const side = scale(right(yawOf(to)), this.strafeSign * (want < 2 ? 0.3 : 1));
    const sameIsland = islandAt(c.view.map, e.pos) === c.on;

    // High ground: hold the top of a ramp I threw down while it stands.
    if (this.perch && (now > this.perch.until || !c.view.pieces.some((p) => p.kind === 'ramp' && dist2D(p.pos, this.perch!.ramp) < 0.3))) this.perch = null;
    if (this.perch) {
      const d = dist2D(me.pos, this.perch.pos);
      this.moveSrc = 'fight:perch';
      if (d > 0.35) return { dir: norm(flat(sub(this.perch.pos, me.pos))) };
      return this.chainRamp(c, e) ?? { dir: null };
    }
    const ramp = this.highGround(c, e, to, gun, sameIsland);
    if (ramp) return ramp;
    // Careful players fight from behind something solid.
    if (gun !== 'fists' && enemyDist > 6 && sameIsland && (t.caution > 0.5 || me.hp < 60)) {
      const cover = this.coverFrom(c, e);
      if (cover) { this.moveSrc = 'fight:coverSpot'; return this.holdCover(c, cover, scale(side, 0.4)); }
    }
    this.inCover = false;

    const gapM = enemyDist - want;
    // Hold range within a couple of metres; with fists (reach 2 m) only a step's slack, or they circle out of reach.
    // Once stepping in (or back), keep at it until well inside the band: no in-out-in at its edge every few ticks.
    const band = want < 2 ? 0.4 : 2, was = this.radialWas;
    const radial = Math.abs(gapM) >= band || (was !== 0 && Math.sign(gapM) === was && Math.abs(gapM) > 0.4 * band) ? Math.sign(gapM) : 0;
    this.radialWas = radial;
    const dir = add(scale(to, radial), side);
    const rush = this.difficulty !== 'easy' && gapM > this.P.drive.sprintGap;
    // Chasing across water needs a route; otherwise just strafe in place.
    this.moveSrc = radial > 0 && !sameIsland ? 'fight:route' : rush ? 'fight:rush' : 'fight:strafe';
    if (radial > 0 && !sameIsland) {
      const wp = this.nav.routeTo(e.pos);
      if (wp) return { dir: norm(add(norm(flat(sub(wp, me.pos))), scale(side, 0.5))), sprint: rush, approach: rush };
      return { dir: norm(side) };
    }
    // Closing a big gap: mostly straight at them, a little weave.
    if (rush) return { dir: norm(add(to, scale(side, 0.35))), sprint: true, approach: true };
    return { dir: norm(dir) };
  }

  // ---------------------------------------------------------------- building

  /** Place a piece if the sim would take it and it keeps my own bunker open; null otherwise. */
  private place(c: Ctx, kind: PieceKind, pos: Vec3, rotY: number, face: Vec3, why?: string): Act | null {
    const r = c.view.canPlace(kind, pos, rotY);
    if (!r.ok) return null;
    if (!c.view.suddenDeath && !ownBunkerSafe(c.home.bunker, c.view.pieces, ghost(kind, r.pos, rotY, c.me.id))) return null;
    this.buildWhy = why ?? null;
    return { dir: null, face, build: { kind, pos, rotY, free: true } };
  }

  /** Busy placing, or still between two pieces of a sequence (better players chain them tighter). */
  private building(c: Ctx, kind?: PieceKind, combat = false): boolean {
    const sk = this.P.buildSkill[this.difficulty];
    const wait = Math.max((kind ? PIECES[kind].placeSec : 0) + sk.gap, combat ? sk.pieceSec : 0);
    return c.me.busyUntil > c.view.now || c.view.now < this.lastPieceAt + wait;
  }

  /**
   * Walls I may throw down for cover: tall pieces beyond the seal kit, else sandbags. Mid-fight the fastest, cheapest
   * wall (wood) does; `strong` (holding a spot, at home, replacing a cracked wall) takes the toughest I carry.
   */
  private wallKind(c: Ctx, strong = false): PieceKind | null {
    const inv = c.me.inv;
    const tall = TALL.reduce((n, k) => n + (inv.pieces[k] ?? 0), 0);
    const pick = () => (strong ? STRONG_WALLS : this.coverSkilled() ? WALLS : PLAIN_WALLS).find((k) => (inv.pieces[k] ?? 0) > 0) ?? null;
    if (tall > c.openDoors.length) return pick();
    if ((inv.pieces.sandbags ?? 0) > 0) return 'sandbags';
    // Masters (reinforce > 0.8) spend a plug on cover when the doors are far off (they'll buy another): staying alive first.
    const far = !c.rivalIsl || dist2D(c.me.pos, c.rivalIsl.bunker.center) > this.P.buildTuning.kitCoverM;
    return tall > 0 && false && far ? pick() : null;
  }

  /** Should the next cover wall be the strongest I carry: at home, rich enough to spend it, or I've held this spot a while. */
  private strongCover(c: Ctx): boolean {
    const cv = this.cover;
    return c.on === c.home.index || c.me.inv.cash + c.me.vault.cash >= this.P.buildTuning.metalCoverAt ||
      (!!cv && cv.heldSince !== null && c.view.now - cv.heldSince >= this.P.buildTuning.holdSec);
  }

  /** Patching up behind cover with the shooter still in sight takes nerve: Hard and PRO (buildSkill.reinforce > 0.5). */
  skilledHealer(): boolean { return this.P.buildSkill[this.difficulty].reinforce > 0.5; }

  /** Situational wall material: Hard and PRO (buildSkill.reinforce > 0.5). */
  private coverSkilled(): boolean { return this.P.buildSkill[this.difficulty].reinforce > 0.5; }

  /** Behind something solid from whoever is shooting at me (heals are safe here even with them in sight). */
  sheltered(c: Ctx): boolean {
    const from = this.cover?.threat ?? c.enemy?.pos;
    if (!from) return false;
    const eye = add(from, v3(0, PLAYER.eyeHeight, 0)), chest = add(c.me.pos, v3(0, CHEST, 0));
    return c.view.pieces.some((p) => dist2D(p.pos, c.me.pos) < 3 && shields(p, eye, chest));
  }

  /** Where the shooter with this id is (seen now, their tracer, or last sighting). */
  private threatPos(c: Ctx, id: number): Vec3 | null {
    const e = c.view.enemies.find((x) => x.id === id);
    if (e) return clone(e.pos);
    let best: { t: number; from: Vec3 } | null = null;
    for (const sh of c.view.shots) if (sh.by === id && (!best || sh.t > best.t)) best = sh;
    if (best) return v3(best.from.x, best.from.y - PLAYER.eyeHeight, best.from.z);
    return this.mem.recent(id, c.view.now, 3)?.pos ?? null;
  }

  /**
   * Shot at in the open with nothing solid nearby: decide (once per incident, odds by skill and taste) to throw a
   * wall down between me and the shooter after a human reaction time. A second shooter from another side gets
   * a wall too (walling off a flank).
   */
  private coverTrigger(c: Ctx) {
    const { view, me } = c;
    const now = view.now;
    const cv = this.cover;
    if (cv) {
      if (c.enemy?.id === cv.threatId) { cv.threat = clone(c.enemy.pos); cv.lastContact = now; }
      if (now - cv.lastContact > this.P.buildTuning.coverForgetSec) { this.cover = null; this.nextScoreAt = now; }
    }
    const by = this.mem.lastHurtBy;
    if (by === null || by === me.id || now - this.mem.lastHurtAt > 1.0) return;
    if (view.suddenDeath || insideBunker(c.home.bunker, me.pos)) return;
    if (c.on < 0) return;
    const from = this.threatPos(c, by);
    if (!from) return;
    if (this.cover?.threatId === by) { this.cover.threat = from; this.cover.lastContact = now; return; }
    if (now < this.coverRollAt) return;
    this.coverRollAt = now + this.P.buildTuning.coverRetrySec;
    if (dist2D(from, me.pos) < 5 || !this.wallKind(c)) return;
    // Skilled players only build when they're losing the trade; a shooter they're well ahead of gets pushed.
    const shooter = view.enemies.find((e) => e.id === by);
    const skilled = this.difficulty === 'hard' || this.difficulty === 'pro';
    if (skilled && shooter && shooter.hp + shooter.shield < me.hp + me.shield - this.P.buildTuning.pushLead) return;
    const eye = add(from, v3(0, PLAYER.eyeHeight, 0)), chest = add(me.pos, v3(0, CHEST, 0));
    if (view.pieces.some((p) => dist2D(p.pos, me.pos) < 4 && shields(p, eye, chest))) return;
    const spot = this.coverFrom(c, { pos: from });
    if (spot && dist2D(spot, me.pos) < this.P.buildTuning.coverNearSpot) return;
    const sk = this.P.buildSkill[this.difficulty];
    if (this.rng() >= sk.coverChance * Math.min(1, 0.55 + this.t.builder)) return;
    this.cover = {
      threatId: by, threat: from, lastContact: now, startAt: now + sk.coverDelay * (0.7 + 0.6 * this.rng()), placed: 0,
      phase: 'hide', phaseUntil: 0, side: this.rng() < 0.5 ? -1 : 1, heldSince: null, peeks: 0, done: [],
    };
    this.nextScoreAt = Math.min(this.nextScoreAt, now + sk.coverDelay * 0.5);
  }

  /** What healing wants this tick (heal.ts); tracks damage bursts and rolls this fight's habits on its first hit. */
  private healDecide(c: Ctx): HealPlan | null {
    const me = c.me, now = c.view.now, H = this.P.heal;
    const eff = me.hp + me.shield;
    if (eff < this.lastEff) {
      if (now - this.lastDmgAt > H.quietSec) {
        this.healRoll = { cover: this.healRng() < H.coverFirst[this.difficulty], reload: this.healRng() < H.reloadWeight[this.difficulty] };
      }
      if (now - this.burstAt > 1) { this.burst = 0; this.burstAt = now; }
      this.burst += this.lastEff - eff;
      this.lastDmgAt = now;
    }
    this.lastEff = eff;
    const e = c.enemy;
    // Hiding only works with cover at hand (or a wall to throw): backing off across the map just drags the fight out.
    this.healHideAct = e && eff <= H.fightHp[this.difficulty] + H.burstHp ? this.healHide(c, e) : null;
    const plan = healPlan({
      me, now, diff: this.difficulty,
      foe: e ? { dist: c.enemyDist, eff: e.hp + e.shield, reloadLeft: e.reloadUntil > now ? e.reloadUntil - now : 0 } : null,
      hurtAgo: now - this.mem.lastHurtAt, burst: now - this.burstAt <= 1.5 ? this.burst : 0,
      hidingFor: this.healHideAt === null ? null : now - this.healHideAt,
      // Racing the storm or near its edge: no hiding (backing off walks me out into it), heal where I am.
      coverFirst: this.healRoll.cover && !!this.healHideAct && this.goal !== 'storm' && !this.nearStormEdge(c), useReload: this.healRoll.reload, sheltered: false,
      sinceFightHeal: now - this.fightHealAt,
    }, H);
    if (plan?.act === 'hide') { this.healHideAt ??= now; this.healNote = { t: now, text: plan.why }; }
    // Stay hidden only while the heal itself is going (a "wait" to trade or press means fight on, not keep hiding).
    else if (!(plan?.act === 'wait' && plan.why === 'healing') || !e) this.healHideAt = null;
    if (plan?.act === 'wait' && plan.why !== 'healing') this.healNote = { t: now, text: plan.why };
    return plan;
  }

  /** Within a few metres of (or past) the line the storm is about to close to. */
  private nearStormEdge(c: Ctx): boolean {
    const st = c.view.storm;
    return !!st && Math.hypot(c.me.pos.x - st.x, c.me.pos.z - st.z) > this.stormSafeR(st) - 4;
  }

  /** Low with an enemy in sight: get out of their line of sight to heal (cover within heal.hideM, or a wall thrown down); null: none at hand. */
  private healHide(c: Ctx, e: PlayerState): Act | null {
    const me = c.me, face = add(e.pos, v3(0, CHEST, 0));
    const got = this.coverWall(c, e.pos);
    if (got) return dist2D(me.pos, got.hide) > 0.35 ? { dir: norm(flat(sub(got.hide, me.pos))), face, sprint: true } : { dir: null, face };
    const spot = this.coverFrom(c, e);
    if (spot && dist2D(spot, me.pos) < this.P.heal.hideM) return { ...this.goTo(spot, 0.4), face, sprint: true };
    const kind = c.enemyDist >= 5 ? this.wallKind(c) : null;
    if (kind && !this.building(c, kind)) {
      const to = norm(flat(sub(e.pos, me.pos)));
      for (const d of this.P.buildTuning.coverDist) {
        const a = this.place(c, kind, add(me.pos, scale(to, d)), yawOf(to), face);
        if (a) return a;
      }
    }
    return null;
  }

  /** A potion seller close by on this island while I'm short of heals it would sell me: walk over. */
  private sellerDetour(c: Ctx): Act | null {
    const me = c.me, H = this.P.heal;
    if (H.detourM <= 0 || c.view.suddenDeath || ['storm', 'disengage', 'defend', 'cover'].includes(this.goal)) return null;
    const node = this.nav.nodeAt(me.pos);
    if (node < 0) return null;
    const s = (c.view.potionShops ?? []).find((p) => dist2D(p, me.pos) <= H.detourM && this.nav.nodeAt(p) === node);
    if (!s || dist2D(me.pos, s) <= USE_RANGE - 0.3) return null;
    // Only for heals (shields are bought when at the counter anyway, not worth a detour).
    const buy = potionAction(me, c.view.now, false, true, this.healWant);
    if (!buy || !('buy' in buy) || buy.buy !== 'healPotion') return null;
    return this.goTo(s, USE_RANGE - 0.3);
  }

  /**
   * A full hotbar keeping a heal out (none held, the stock wants one, cash for a medkit, at home): the least-wanted
   * slot (HealParams keep weights) to drop, or null. At most one drop per 5 s.
   */
  private healDrop(c: Ctx): number | null {
    const me = c.me, now = c.view.now;
    this.healDrops = this.healDrops.filter((h) => now - h.t < 90);
    if (now - this.lastHealDropAt < 5 || c.on !== c.home.index || me.hotbar.includes(null) || hpHealsHeld(me) > 0) return null;
    const n = this.needs(c);
    if ((n.medkits ?? 0) <= 0 || this.spendCash(me) < MEDKIT.price) return null;
    const needed = new Set<HotbarItem>(Object.keys(n.build ?? {}) as PieceKind[]);
    if (n.grapple === 'cross' || this.strandedSince !== null) needed.add('grapple');
    if ((n.traps ?? 0) > 0) needed.add('trap');
    const slot = dropForHeal(me, this.P.heal, needed);
    if (slot === null) return null;
    this.lastHealDropAt = now;
    this.healDrops.push({ pos: clone(me.pos), t: now });
    this.healNote = { t: now, text: `dropping ${me.hotbar[slot]} to make room for a heal` };
    return slot;
  }

  /** A piece near me that shields a spot just behind it from the threat, and that spot. */
  private coverWall(c: Ctx, threat: Vec3, skip: number[] = []): { wall: PieceState; hide: Vec3 } | null {
    const eye = add(threat, v3(0, PLAYER.eyeHeight, 0));
    let best: { wall: PieceState; hide: Vec3 } | null = null, bestD = 4;
    for (const p of c.view.pieces) {
      if (p.kind === 'scaffold' || p.kind === 'ramp' || skip.includes(p.id)) continue;
      const d = dist2D(p.pos, c.me.pos);
      if (d >= bestD || Math.abs(p.pos.y - c.me.pos.y) > 1.2) continue;
      const away = norm(flat(sub(p.pos, threat)));
      const hide = add(v3(p.pos.x, c.me.pos.y, p.pos.z), scale(away, PIECES[p.kind].d / 2 + 0.6));
      if (!shields(p, eye, add(hide, v3(0, CHEST, 0)))) continue;
      best = { wall: p, hide }; bestD = d;
    }
    return best;
  }

  /** Under fire: throw the wall up (two bags high if it's sandbags), then hide behind it and peek out to shoot. */
  private doCover(c: Ctx): Act {
    const cv = this.cover;
    if (!cv) { this.nextScoreAt = c.view.now; return IDLE; }
    const { me, view } = c;
    const now = view.now;
    const sk = this.P.buildSkill[this.difficulty];
    const face = add(cv.threat, v3(0, CHEST, 0));
    const got = this.coverWall(c, cv.threat, cv.done);
    if (!got) {
      if (now < cv.startAt || this.building(c, undefined, true)) return c.enemy ? this.doFight(c) : { dir: null, face };
      const strong = this.strongCover(c);
      const kind = this.wallKind(c, strong);
      if (!kind || cv.placed >= this.P.buildTuning.coverMaxPieces) { this.cover = null; this.nextScoreAt = now; return IDLE; }
      const to = norm(flat(sub(cv.threat, me.pos)));
      // A bag already lying between us: stack the next one on it.
      const low = kind === 'sandbags' ? view.pieces.find((p) => p.kind === 'sandbags' && p.owner === me.id && dist2D(p.pos, me.pos) < 2.2 &&
        Math.abs(p.pos.y - me.pos.y) < 0.3 && (p.pos.x - me.pos.x) * to.x + (p.pos.z - me.pos.z) * to.z > 0.5) : undefined;
      if (low) {
        const act = this.place(c, kind, v3(low.pos.x, me.pos.y + 0.4, low.pos.z), low.rotY, face, `cover: second bag vs @${cv.threatId}`);
        if (act) { cv.placed++; return act; }
      }
      // Set off to the side away from where I'll peek, so stepping out to shoot is one short step.
      const off = scale(right(yawOf(to)), -cv.side * this.P.buildTuning.coverOffset);
      const why = `cover: ${kind} vs @${cv.threatId} (${strong ? 'strongest: home, rich or holding' : 'fast, cheap'})`;
      for (const d of this.P.buildTuning.coverDist) {
        let pos = add(add(me.pos, scale(to, d)), off), rotY = yawOf(to);
        if (this.rng() < sk.misplace) ({ pos, rotY } = fumble(pos, rotY, this.rng));
        const act = this.place(c, kind, pos, rotY, face, why);
        if (act) { cv.placed++; return act; }
      }
      // Nowhere to put it: fight it out.
      this.cover = null;
      this.nextScoreAt = now;
      return c.enemy ? this.doFight(c) : IDLE;
    }
    // Peek rhythm: hide behind the wall, step out to the side and shoot, back in.
    const { wall, hide } = got;
    const away = norm(flat(sub(wall.pos, cv.threat)));
    const along = right(yawOf(away));
    cv.heldSince ??= now;
    // The wall is cracking: a fresh one (the strongest I carry) beside it on my peek side, and move behind that.
    if (wall.hp < PIECES[wall.kind].hp * this.P.buildTuning.crackedAt && !cv.done.includes(-wall.id - 1) && !this.building(c, undefined, true)) {
      cv.done.push(wall.id);
      const kind = cv.placed < this.P.buildTuning.coverMaxPieces && this.rng() < sk.reinforce ? this.wallKind(c, true) : null;
      if (kind) {
        const pos = add(v3(wall.pos.x, me.pos.y, wall.pos.z), scale(along, cv.side * (PIECES[wall.kind].w / 2 + PIECES[kind].w / 2 + 0.05)));
        const act = this.place(c, kind, pos, yawOf(away), face, `reinforce: ${wall.kind} wall cracked (${Math.round(wall.hp)} hp), ${kind} beside it`);
        if (act) { cv.placed++; cv.phase = 'hide'; cv.phaseUntil = 0; return act; }
      }
      cv.done.pop(); // nothing went up: keep using the cracked wall (no second roll on it)
      cv.done.push(-wall.id - 1);
    }
    const peek = add(hide, scale(along, cv.side * (PIECES[wall.kind].w / 2 + this.P.buildTuning.peekStep)));
    // Patching up (medkit) or in the middle of placing: stay in behind the wall till it's done.
    const busy = me.healAt !== null || me.busyUntil > now;
    if (busy && cv.phase === 'peek') { cv.phase = 'hide'; cv.phaseUntil = 0; }
    const spot = cv.phase === 'hide' ? hide : peek;
    this.moveSrc = `cover:${cv.phase}`;
    const there = dist2D(me.pos, spot) < 0.35;
    if (there && cv.phaseUntil === 0) cv.phaseUntil = now + (cv.phase === 'hide' ? sk.peekHide : sk.peekOut) * (0.75 + 0.5 * this.rng());
    if (cv.phaseUntil > 0 && now >= cv.phaseUntil && !busy) {
      cv.phase = cv.phase === 'hide' ? 'peek' : 'hide';
      cv.phaseUntil = 0;
      if (cv.phase === 'peek') { cv.peeks++; if (this.rng() < 0.3) cv.side = -cv.side; }
    }
    return there ? { dir: null, face } : { dir: norm(flat(sub(spot, me.pos))), face };
  }

  /**
   * Mid-range fight on the same island for a while (sooner if they stand above me): a ramp toward them and fight
   * from its top. Whether this fight calls for one is rolled once per fight (buildSkill.ramp).
   */
  private highGround(c: Ctx, e: PlayerState, to: Vec3, gun: WeaponKind, sameIsland: boolean): Act | null {
    const { me, view } = c;
    const now = view.now;
    const sk = this.P.buildSkill[this.difficulty], bt = this.P.buildTuning;
    const [lo, hi] = bt.highGroundRange;
    if (!sk.highGround || (me.inv.pieces.ramp ?? 0) === 0 || !sameIsland || gun === 'fists' || this.fightSince === null ||
      c.enemyDist < lo || c.enemyDist > hi || c.on < 0 || me.pos.y - view.map[c.on].groundY > 0.3) return null;
    const above = e.pos.y - me.pos.y;
    // Up to someone standing higher (a ramp reaches 1.5 m, two of them 3 m); a level fight after highGroundAfter.
    if (above > PIECES.ramp.h * 2.2 || (above < bt.rampUpTo && now - this.fightSince < bt.highGroundAfter)) return null;
    if (this.rampRoll?.fight !== this.fightSince) this.rampRoll = { fight: this.fightSince, yes: this.rng() < sk.ramp };
    if (!this.rampRoll.yes || this.building(c, 'ramp', true)) return null;
    const pos = add(me.pos, scale(to, 2.1));
    const why = above >= bt.rampUpTo ? `ramp: up to @${e.id} (${above.toFixed(1)} m above me)` : `ramp: high ground on @${e.id}`;
    const act = this.place(c, 'ramp', pos, yawOf(to) + Math.PI, add(e.pos, v3(0, CHEST, 0)), why);
    if (!act) return null;
    this.perch = { ramp: v3(pos.x, me.pos.y, pos.z), pos: add(pos, scale(to, 1.0)), until: now + bt.perchSec, dir: to, chain: 0 };
    return act;
  }

  /**
   * On my perch with the rival still out of reach (or above me): chain the next ramp on from this one's top, forward
   * and up toward them, and move the perch to its top (buildSkill.rampChain ramps per fight at most).
   */
  private chainRamp(c: Ctx, e: PlayerState): Act | null {
    const pr = this.perch!, me = c.me, now = c.view.now;
    const sk = this.P.buildSkill[this.difficulty], bt = this.P.buildTuning;
    if (pr.chain >= sk.rampChain || (me.inv.pieces.ramp ?? 0) === 0 || this.building(c, 'ramp', true)) return null;
    const toE = norm(flat(sub(e.pos, me.pos)));
    // Still facing them (they didn't go round me), and still worth closing: far, or higher than my perch.
    if (toE.x * pr.dir.x + toE.z * pr.dir.z < 0.8) return null;
    if (c.enemyDist < bt.highGroundRange[0] + PIECES.ramp.d && e.pos.y - me.pos.y < bt.rampUpTo) return null;
    const top = pr.ramp.y + PIECES.ramp.h;
    const pos = v3(pr.ramp.x + pr.dir.x * PIECES.ramp.d, top, pr.ramp.z + pr.dir.z * PIECES.ramp.d);
    const act = this.place(c, 'ramp', pos, yawOf(pr.dir) + Math.PI, add(e.pos, v3(0, CHEST, 0)), `ramp: chained forward and up toward @${e.id}`);
    if (!act) return null;
    pr.ramp = pos; pr.pos = add(pos, scale(pr.dir, 1.0)); pr.chain++; pr.until = now + bt.perchSec;
    return act;
  }

  /** My own spike traps standing (in sight: home is where they go, so that's all of them while I'm there). */
  private myTraps(view: BotView): TrapNet[] {
    return (view.traps ?? []).filter((t) => t.owner === view.self.id);
  }

  /**
   * Where I set spike traps at home, best first: just outside each doorway (the choke points anyone sealing or
   * raiding me must stand in), then the bunker wall either side of the front door (spikes out at whoever hugs it).
   */
  private trapSpots(c: Ctx): TrapRequest[] {
    const b = c.home.bunker, out: TrapRequest[] = [];
    for (const d of b.doorways) {
      const p = add(d.center, scale(forward(d.yaw), 1.6));
      const y = c.view.groundAt(p.x, p.z);
      if (y !== null) out.push({ pos: v3(p.x, y, p.z), rotY: d.yaw, wall: false });
    }
    const fd = b.doorways[0];
    if (fd) for (const side of [1, -1]) {
      const p = add(fd.center, scale(right(fd.yaw), side * (fd.width / 2 + 0.9)));
      out.push({ pos: v3(p.x, c.home.groundY + 1.0, p.z), rotY: fd.yaw, wall: true });
    }
    return out;
  }

  /** The next free trap spot that takes one (validated as placed), or null. */
  private nextTrapSpot(c: Ctx): { req: TrapRequest; i: number } | null {
    if (!c.view.canTrap) return null;
    const spots = this.trapSpots(c), taken = c.view.traps ?? [];
    for (const [i, s] of spots.entries()) {
      if ((this.trapBackoff.get(i) ?? -Infinity) > c.view.now) continue;
      if (taken.some((t) => dist2D(t.pos, s.pos) < TRAP.minGap + 0.4)) continue;
      // Validated from where I'll stand to set it, not from where I am now.
      if (c.view.canTrap(s, this.trapStand(c, s)).ok) return { req: s, i };
    }
    return null;
  }

  /** Where I stand to set a trap: a little out in front of it (outside the doorway / off the wall). */
  private trapStand(c: Ctx, req: TrapRequest): Vec3 {
    const p = add(req.pos, scale(forward(req.rotY), req.wall ? 1.6 : 1.4));
    return v3(p.x, c.home.groundY, p.z);
  }

  /** Walk to the next trap spot and set one there. */
  private doTrap(c: Ctx): Act {
    const next = this.nextTrapSpot(c);
    if (!next) { this.nextScoreAt = c.view.now; return IDLE; }
    const { req, i } = next, now = c.view.now;
    const stand = this.trapStand(c, req);
    const face = req.wall ? req.pos : v3(req.pos.x, req.pos.y + 0.2, req.pos.z);
    const walk = this.goTo(stand, 0.6);
    if (walk.dir) return walk;
    if (c.me.busyUntil > now) return { dir: null, face };
    if (this.trapTry?.i === i && now - this.trapTry.at > 1) {
      // (backoff lives here, not in nextTrapSpot: scoring and introspection must not change state)
      // Tried a while ago and the spot is still empty: something's in the way.
      this.trapBackoff.set(i, now + this.P.buildTuning.slotBackoffSec);
      this.trapTry = null;
      this.nextScoreAt = now;
      return { dir: null, face };
    }
    if (this.trapTry?.i !== i) this.trapTry = { i, at: now };
    return { dir: null, face, trap: req };
  }

  /** Teams: my team when `id` is a teammate (their traps are friendly), else undefined. */
  private allyTeam(view: BotView, id: number): number | undefined {
    return view.allies?.some((a) => a.id === id) ? view.self.team : undefined;
  }

  /** Fires plus every enemy spike trap I can see, as circles to keep out of. */
  private avoidZones(view: BotView, me: PlayerState): { pos: Vec3; r: number }[] {
    const fires = view.fires ?? [];
    const traps = view.traps;
    if (!traps?.length) return fires;
    const r = TRAP.half + PLAYER.radius + this.P.trap.avoidPad;
    const out = [...fires];
    for (const t of traps) if (!friendly(t.owner, me, this.allyTeam(view, t.owner))) {
      const c = trapCenter(t);
      out.push({ pos: t.wall ? add(c, scale(forward(t.rotY), TRAP.zone / 2)) : v3(c.x, t.pos.y, c.z), r: t.wall ? r + TRAP.zone / 2 : r });
    }
    return out;
  }

  /**
   * An enemy trap within shootRange that lies along where I'm walking (or right by me when I've stopped), with a
   * clear shot: where to aim. Destroying it beats walking the long way round a doorway.
   */
  private trapInWay(c: Ctx, dir: Vec3 | null): Vec3 | null {
    const traps = c.view.traps;
    if (!traps?.length) return null;
    const me = c.me, R = this.P.trap.shootRange;
    let best: Vec3 | null = null, bestD = Infinity;
    for (const t of traps) {
      if (friendly(t.owner, me, this.allyTeam(c.view, t.owner))) continue;
      const at = trapCenter(t);
      const d = dist2D(at, me.pos);
      if (d > R || d >= bestD || Math.abs(at.y - me.pos.y) > 3) continue;
      if (dir) {
        const rel = v3(at.x - me.pos.x, 0, at.z - me.pos.z);
        const along = rel.x * dir.x + rel.z * dir.z;
        const off = Math.abs(rel.x * dir.z - rel.z * dir.x);
        if (along < 0 || off > 1.6) continue;
      } else if (d > 3) continue;
      if (c.view.clearShot && !c.view.clearShot(at)) continue;
      best = at; bestD = d;
    }
    return best;
  }

  /** Walk to the next fortification slot and build it (also rebuilds pieces that got shot out). */
  private doFortify(c: Ctx): Act {
    const next = this.nextSlot(c);
    if (!next) { this.nextScoreAt = c.view.now; return IDLE; }
    const { slot, i } = next;
    const { home, view } = c;
    const stand = slot.after !== undefined
      ? add(this.fortSlots()[slot.after].pos, scale(right(slot.rotY), 1.9))
      : add(slot.pos, scale(norm(flat(sub(home.center, slot.pos))), dist2D(slot.pos, home.center) < 1 ? 0 : 2.2));
    const face = add(slot.pos, v3(0, 0.5, 0));
    const walk = this.goTo(v3(stand.x, home.groundY, stand.z), 0.6);
    if (walk.dir) return walk;
    if (this.building(c, slot.kind)) return { dir: null, face };
    const act = this.place(c, slot.kind, slot.pos, slot.rotY, face, `fortify: ${slot.tag} ${slot.kind}`);
    if (act) return act;
    this.slotBackoff.set(i, view.now + this.P.buildTuning.slotBackoffSec);
    this.nextScoreAt = view.now;
    return { dir: null, face };
  }


  /** Back off from whoever is hurting me: home to the bunker if that isn't toward them, else straight away. */
  private doDisengage(c: Ctx): Act {
    const me = c.me, now = c.view.now;
    // Who I'm getting away from: whoever is in sight, else whoever hurt me last. Kept a moment (FLEE_KEEP_SEC) unless
    // someone much closer turns up: a far enemy blinking in and out of sight past a corner would otherwise swing
    // "away" (and the spot behind the bunker) round and back every few ticks.
    const posOf = (id: number | null) => (id === null ? undefined : id === c.enemy?.id ? c.enemy.pos : this.mem.recent(id, now, 5)?.pos);
    let id = c.enemy?.id ?? this.mem.lastHurtBy;
    const f = this.flee;
    if (f && now < f.until && f.id !== id) {
      const keep = posOf(f.id), cand = posOf(id);
      if (keep && !(cand && dist2D(cand, me.pos) < 0.6 * dist2D(keep, me.pos))) id = f.id;
    }
    const from = posOf(id);
    if (id === null || !from) { this.flee = null; this.nextScoreAt = now; return IDLE; }
    if (!f || f.id !== id || now >= f.until) this.flee = { id, until: now + FLEE_KEEP_SEC, home: f?.home ?? false };
    // Out of heals: the shop first (buy, heal, re-peek), not minutes of backing off on low hp.
    const restock = this.restockHeal(c);
    if (restock) return restock;
    const away = norm(flat(sub(me.pos, from)));
    if (c.homeReach) {
      // Behind my bunker, not inside it (inside, one plug per door seals me in); once there, stay in its lee.
      const b = c.home.bunker;
      const behind = add(b.center, scale(norm(flat(sub(b.center, from))), BUNKER_OUT));
      const spot = v3(behind.x, c.home.groundY, behind.z);
      const home = this.goTo(spot, 1.5);
      if (!home.dir && dist2D(me.pos, spot) <= 1.5) { this.flee!.home = true; return { dir: null }; }
      // The way there may lead round the bunker toward them for a bit: once on it, keep on it (no swapping between it
      // and running straight away at each bend).
      const k = home.dir ? home.dir.x * away.x + home.dir.z * away.z : -Infinity;
      this.flee!.home = k > (this.flee!.home ? -0.6 : -0.2);
      if (this.flee!.home) return { ...home, sprint: true };
    }
    const cover = c.enemy || this.mem.recent(id, now, FLEE_KEEP_SEC) ? this.coverFrom(c, { pos: from }) : null;
    if (cover) return { ...this.holdCover(c, cover, null), sprint: true };
    this.inCover = false;
    // Straight away from them, or the nearest heading that keeps me on land (measured: botDrown medium seed 3, a bot
    // landed from a hook escape on an island rim and ran on into the sea).
    const dir = this.landward(me.pos, away);
    return dir ? { dir, sprint: true } : IDLE;
  }

  /** `want`, or the heading closest to it whose ground 2.5 m ahead is dry land or a deck; null if none is. */
  private landward(from: Vec3, want: Vec3): Vec3 | null {
    for (const a of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4]) {
      const d = a === 0 ? want : rotateY(want, a);
      const g = this.view.groundAt(from.x + d.x * 2.5, from.z + d.z * 2.5);
      if (g !== null && g > this.view.waterY + 0.5) return d;
    }
    return null;
  }

  /**
   * Low and out of heals, with the cash for one and my shop in reach (heal.restock): run to it and buy a medkit; heal.ts
   * uses it once they're far or out of sight, and the retreat ends. Round-11 heals CI: PRO sat in 'disengage' ~4× as
   * long as before, always holding no heal with the cash for several (seed 5: 100 s at hp 20-35, $1400, foes 90-110 m off).
   */
  private restockHeal(c: Ctx): Act | null {
    const me = c.me, now = c.view.now;
    if (this.P.heal.restock[this.difficulty] < 0.5 || !c.homeReach || c.view.suddenDeath || hpHealsHeld(me) > 0 ||
        this.spendCash(me) < MEDKIT.price || !canAdd(me.hotbar, 'medkit') || this.buyBlocked('medkit')) return null;
    const walk = { ...this.goTo(c.home.shop, 2.0), sprint: true };
    this.healNote = { t: now, text: 'out of heals: running to my shop for a medkit' };
    if (dist2D(me.pos, c.home.shop) > USE_RANGE || now < this.nextBuyAt) return walk;
    this.nextBuyAt = now + BUY_GAP[this.difficulty];
    return { ...walk, shop: 'medkit' };
  }

  /** Radius I want to be inside: the ring as it will be a few seconds from now, minus a margin. */
  private stormSafeR(st: NonNullable<BotView['storm']>): number {
    const ahead = st.r - st.rate * STORM_LEAD[this.difficulty] - STORM_MARGIN[this.difficulty];
    return Math.max(Math.min(st.rf - 2, st.r), ahead);
  }

  /** Sudden death, the ring at its final size, no enemy in sight, and I'm not yet near its centre. */
  private finalHunt(c: Ctx): boolean {
    const st = c.view.storm;
    return !!st && c.view.suddenDeath && !c.enemy && st.r <= st.rf + 0.5;
  }

  /**
   * Seconds of walking (a little under top sprint speed) from here onto the center island along finished bridges, and
   * where to aim on it; null when no walkable route leads there (or I'm on it). Out on a bridge: via either end.
   */
  private centerTrip(c: Ctx): { sec: number; to: Vec3 } | null {
    const C = this.nav.centerNode, me = c.me;
    if (C < 0) return null;
    const node = this.nav.nodes[C];
    const here = this.nav.nodeAt(me.pos);
    let best = Infinity;
    for (const s of this.nav.startNodes(me.pos)) {
      if (s === C) return null;
      const r = this.nav.route(s, C);
      if (!r) continue;
      // Through the centres of the islands on the way (an overestimate: the safe side), from my feet.
      let len = 0, at = me.pos;
      for (const n of r.slice(here === s ? 1 : 0)) { len += dist2D(at, this.nav.nodes[n].center); at = this.nav.nodes[n].center; }
      best = Math.min(best, len - node.radius);
    }
    if (best === Infinity) return null;
    const d = flat(sub(me.pos, node.center)), l = Math.hypot(d.x, d.z) || 1, k = Math.max(0, node.radius - 3);
    return { sec: Math.max(0, best) / (PLAYER.sprint * STORM_TRIP_PACE), to: v3(node.center.x + (d.x / l) * k, node.groundY, node.center.z + (d.z / l) * k) };
  }

  /**
   * Sudden death: time to leave for the center island (where the ring ends) now: the ring reaches me in less than the
   * walk there (round by other islands, not straight in) plus my lead (DriveParams.stormLead).
   */
  private stormLeave(c: Ctx): { sec: number; to: Vec3; slack: number } | null {
    const st = c.view.storm;
    if (!st || !(st.rate > 0)) return null;
    const trip = this.centerTrip(c);
    if (!trip) return null;
    const d = Math.hypot(c.me.pos.x - st.x, c.me.pos.z - st.z);
    const slack = (st.r - d) / st.rate - trip.sec;
    return slack < this.P.drive.stormLead[this.difficulty] ? { ...trip, slack } : null;
  }

  /**
   * Sudden-death storm: get inside the ring ahead of it. When the walk onto the center island takes about as long as
   * the ring has left to reach me, go there now. Otherwise straight toward the centre when that stays on land I can
   * walk to, else to the walkable spot closest to the centre (on my island or one I can reach by bridge; out on a
   * bridge, via whichever end leads on). No walkable way at all: bridge there (decks from any shop I can reach).
   */
  private doStorm(c: Ctx): Act {
    const { view, me } = c;
    const st = view.storm;
    if (!st) {
      if (!this.leaveBeforeBarriers(c)) return IDLE;
      // Out through the nearest doorway (goTo routes round whatever stands in the room) and clear of the slab.
      const door = c.home.bunker.doorways.reduce((p, d) => (dist2D(d.center, me.pos) < dist2D(p.center, me.pos) ? d : p));
      const out = add(door.center, scale(forward(door.yaw), BUNKER_EXIT));
      return { ...this.goTo(v3(out.x, c.home.groundY, out.z), 0.8), sprint: true };
    }
    if (this.finalHunt(c)) {
      // Close in on the centre, then circle it: whoever hides behind cover there comes into view.
      const far = Math.hypot(me.pos.x - st.x, me.pos.z - st.z) > FINAL_HUNT_NEAR;
      const a = view.now * FINAL_HUNT_SWEEP + this.id * 2.4, r = FINAL_HUNT_NEAR - 1;
      const walk = far ? this.goTo(v3(st.x, me.pos.y, st.z), r) : this.goTo(v3(st.x + dm.cos(a) * r, me.pos.y, st.z + dm.sin(a) * r), 1);
      if (walk.dir) return walk;
    }
    const go = this.stormLeave(c);
    if (go) {
      const walk = this.goTo(go.to, 1.5);
      if (walk.dir) return { ...walk, sprint: true };
    }
    const ctr = v3(st.x, me.pos.y, st.z);
    const want = this.stormSafeR(st) - 1;
    const d = dist2D(me.pos, ctr);
    const out = d > 0.5 ? norm(flat(sub(me.pos, ctr))) : forward(me.yaw);
    const spot = add(ctr, scale(out, Math.min(d, want)));
    const here = this.nav.nodeAt(me.pos);
    const target = this.nav.nodeAt(spot);
    const edge = d > want && target >= 0 && (target === here || this.nav.routeTo(spot));
    // Holding the ring's edge on an island with no way onto the center island only waits for the ring to pass it:
    // with no walkable way there, getting the bridge built (decks bought while the shop is safe) comes first.
    if (edge && !this.needCenterBridge(c)) return { ...this.goTo(spot, 1), sprint: true };
    const starts = this.nav.startNodes(me.pos);
    let best: Vec3 | null = null, bestD = Infinity;
    for (const n of this.nav.nodes) {
      if (!starts.some((s) => s === n.index || this.nav.hop(s, n.index) !== null)) continue;
      const toC = dist2D(n.center, ctr);
      const k = toC < 0.5 ? 0 : Math.max(0, toC - n.radius + 2.5) / toC;
      const p = v3(n.center.x + (ctr.x - n.center.x) * (1 - k), n.groundY, n.center.z + (ctr.z - n.center.z) * (1 - k));
      const pd = dist2D(p, ctr) + dist2D(p, me.pos) * 0.05;
      if (pd < bestD) { bestD = pd; best = p; }
    }
    if ((bestD > want || this.needCenterBridge(c)) && c.bridgeTo !== null && c.bridgeTo === this.nav.centerNode) {
      const have = me.inv.pieces.scaffold ?? 0, need = this.scaffoldsNeeded(c);
      const shop = this.shopSpot(c);
      // Stock up in one shop visit (the whole bridge, not a deck per trip) while still on land with a shop, and only
      // while that shop is inside the ring (it takes vault cash: no vault trip): shopping out in the storm kills too.
      const shopSafe = !!shop && (dist2D(shop, ctr) < st.r - 2 || inStormShopGrace(view));
      const shopNode = shop ? this.nav.nodeAt(shop) : -1;
      const onLand = here >= 0 && shopNode >= 0 && (here === shopNode || this.nav.hop(here, shopNode) !== null);
      const buy = have < need && shopSafe && (have === 0 || onLand) ? this.buyDecks(c) : null;
      if (buy) return buy;
      if (have > 0) {
        const b = this.doBridge(c);
        if (b.dir || b.build || b.face) return b;
      }
    }
    if (edge) return { ...this.goTo(spot, 1), sprint: true };
    if (!best) return { dir: norm(flat(sub(ctr, me.pos))), sprint: true };
    return { ...this.goTo(best, 1), sprint: true };
  }

  /**
   * The shop I'd buy at: my own when I can walk home, else the nearest island shop I can walk to (shop keepers serve
   * anyone and take vault cash; upgrades and gun locks stay home-only). Null: none in reach.
   */
  private shopSpot(c: Ctx): Vec3 | null {
    if (c.homeReach) return c.home.shop;
    const starts = this.nav.standNodes(c.me.pos);
    let best: Vec3 | null = null, bestD = Infinity;
    for (const isl of c.view.map) {
      const n = this.nav.nodeAt(isl.shop);
      if (n < 0 || !starts.some((s) => s === n || this.nav.hop(s, n) !== null)) continue;
      const d = dist2D(isl.shop, c.me.pos);
      if (d < bestD) { bestD = d; best = isl.shop; }
    }
    return best;
  }

  /** Walk to a shop I can reach and buy scaffolds (the shop takes vault cash too); null when I can't afford one. */
  private buyDecks(c: Ctx): Act | null {
    const me = c.me, now = c.view.now, price = PIECES.scaffold.price;
    if (funds(me) < price) return null;
    const shop = this.shopSpot(c);
    if (!shop) return null;
    const walk = this.goTo(shop, 2.0);
    if (dist2D(me.pos, shop) > USE_RANGE || now < this.nextBuyAt || this.buyBlocked('scaffold')) return { ...walk, sprint: true };
    this.nextBuyAt = now + BUY_GAP[this.difficulty];
    return { ...walk, shop: 'scaffold' };
  }

  /** Sudden death and no walkable route onto the center island (medium+). */
  private needCenterBridge(c: Ctx): boolean {
    return !!c.view.storm && this.nav.centerNode >= 0 && !c.centerReach && this.stormPrep(c.view);
  }

  /** Bridging to the center island ahead of the storm (medium+, from STORM_PREP_SEC before sudden death). */
  private stormPrep(view: BotView): boolean {
    return this.difficulty !== 'easy' && (view.suddenDeath || view.now >= (view.suddenDeathAt ?? LIFECYCLE.suddenDeathAt) - STORM_PREP_SEC);
  }

  /** Storm prep's own goals (decks to the center, buying them): never dropped by the watchdog. */
  private stormPrepGoal(g: Goal): boolean {
    return (g === 'bridge' || g === 'shop') && this.stormPrep(this.view);
  }

  /** Sudden death's doorway slabs drop within drive.barrierLead s (0 for easy: unaware of them). */
  private sealingSoon(view: BotView): boolean {
    const lead = this.P.drive.barrierLead[this.difficulty];
    return lead > 0 && !view.suddenDeath && view.now >= (view.suddenDeathAt ?? LIFECYCLE.suddenDeathAt) - lead;
  }

  /** Sudden death: shut in a bunker behind the slabs and further than drive.shutInRange: the storm's, not mine to chase. */
  private shutInIgnored(view: BotView, e: PlayerState, d: number): boolean {
    const r = this.P.drive.shutInRange[this.difficulty];
    return r > 0 && view.suddenDeath && d > r && view.map.some((isl) => insideBunker(isl.bunker, e.pos));
  }

  /** My rival was seen inside a bunker after sudden death's slabs dropped (so is still in it), and I know what that means. */
  private rivalShutIn(c: Ctx): boolean {
    if (!c.rival || !c.view.suddenDeath || this.P.drive.shutInRange[this.difficulty] <= 0) return false;
    const s = this.mem.seen.get(c.rival.id);
    return !!s && s.t >= (c.view.suddenDeathAt ?? LIFECYCLE.suddenDeathAt) && c.view.map.some((isl) => insideBunker(isl.bunker, s.pos));
  }

  /** Inside my bunker with the slabs about to drop: getting out beats anything else. */
  private leaveBeforeBarriers(c: Ctx): boolean {
    return this.sealingSoon(c.view) && insideBunker(c.home.bunker, c.me.pos);
  }

  /** Whatever I'm doing, don't walk back out toward the storm once at the edge of where I want to be (not easy). */
  private stormFence(me: PlayerState, view: BotView, dir: Vec3): Vec3 | null {
    const st = view.storm;
    if (!st || this.difficulty === 'easy') return dir;
    const d = Math.hypot(me.pos.x - st.x, me.pos.z - st.z);
    // Only at the edge of where I want to be: further out, the storm goal is taking me in (or back home for decks).
    const safe = this.stormSafeR(st);
    if (d < 0.5 || d < safe - 1.5 || d > safe + 1) return dir;
    const out = v3((me.pos.x - st.x) / d, 0, (me.pos.z - st.z) / d);
    const k = dir.x * out.x + dir.z * out.z;
    if (k <= 0) return dir;
    const t = v3(dir.x - out.x * k, 0, dir.z - out.z * k);
    return Math.hypot(t.x, t.z) < 0.2 ? null : norm(t);
  }

  /**
   * A telegraphed lightning strike about to land on me: step out of it (toward the safe side of the ring
   * when that works too). Reaction time by difficulty; easy bots notice only some strikes.
   */
  private dodgeBolt(me: PlayerState, view: BotView): Vec3 | null {
    const st = view.storm;
    if (!st?.strikes.length) { if (this.bolts.size) this.bolts.clear(); return null; }
    for (const b of st.strikes) {
      const d = Math.hypot(me.pos.x - b.x, me.pos.z - b.z);
      if (d > STORM.boltRadius + 0.8 || view.now >= b.at || view.now < b.at - STORM.telegraphSec + BOLT_REACT[this.difficulty]) continue;
      const key = `${b.x},${b.z},${b.at}`;
      let seen = this.bolts.get(key);
      if (seen === undefined) { seen = this.difficulty !== 'easy' || this.rng() < EASY_DODGE; this.bolts.set(key, seen); }
      if (!seen) continue;
      const away = d > 0.3 ? norm(v3(me.pos.x - b.x, 0, me.pos.z - b.z)) : forward(me.yaw + Math.PI / 2);
      const inside = (dir: Vec3) => Math.hypot(me.pos.x + dir.x * 3 - st.x, me.pos.z + dir.z * 3 - st.z) < st.r - 1;
      for (const a of [0, 0.8, -0.8, 1.4, -1.4]) {
        const dir = a ? norm(v3(away.x * dm.cos(a) - away.z * dm.sin(a), 0, away.x * dm.sin(a) + away.z * dm.cos(a))) : away;
        if (inside(dir)) return dir;
      }
      return away;
    }
    return null;
  }

  /**
   * A goal that goes nowhere (no ground covered, nothing built, bought or shot for a while) is a plan that doesn't
   * work from here, e.g. a route the map says exists but I can't walk: drop it (and the rival it was aimed at) for
   * a while and think again, like a player giving up on a dead end.
   */
  private watchdog(now: number, me: PlayerState) {
    const limit = !STALLABLE.has(this.goal) ? undefined : this.P.drive.stallSec * (this.goal === 'attack' ? 1.5 : 1);
    // Getting set for the storm (decks to the center, buying them) is never given up; any other goal still is
    // (mixed ×60 seed 9: a PRO stood 70 s at home on a 'seal' with no walkable route, 13:50-15:00).
    if (limit === undefined || this.stormPrepGoal(this.goal)) { this.prog = null; return; }
    const p = this.prog;
    if (!p || p.goal !== this.goal || this.lastDidAt > p.at) {
      this.prog = { goal: this.goal, at: now, pos: clone(me.pos), far: 0 };
      return;
    }
    // Progress = getting further from where this goal started than ever before (by stallDist): walking somewhere
    // counts, pacing back and forth over the same few metres (a deck whose route flip-flops) doesn't.
    const d = dist2D(p.pos, me.pos);
    if (d > p.far + this.P.drive.stallDist) { p.far = d; p.at = now; return; }
    if (now - p.at < limit) return;
    this.goalBan.set(this.goal, now + this.P.drive.stallBanSec);
    if (this.targetId !== null && TARGETED.has(this.goal)) this.targetBan.set(this.targetId, now + this.P.drive.stallBanSec);
    this.prog = null;
    this.nextScoreAt = now;
  }

  private trackStuck(now: number, me: PlayerState, want: Vec3 | null) {
    if (!want || now < this.unstickUntil) { this.stuckRef = null; return; }
    if (!this.stuckRef) { this.stuckRef = { pos: clone(me.pos), t: now }; return; }
    if (now - this.stuckRef.t < STUCK_SEC) return;
    if (dist2D(me.pos, this.stuckRef.pos) < STUCK_DIST) {
      const again = this.stuckAt && dist2D(this.stuckAt.pos, me.pos) < 3 && now - this.stuckAt.t < 15;
      const n = again ? Math.min(3, this.stuckAt!.n + 1) : 0;
      this.stuckAt = { pos: clone(me.pos), t: now, n };
      this.unstickSide = this.rng() < 0.5 ? -1 : 1;
      // 90° aside the first time, then further round toward backing off (135°, 180°), for longer.
      const turn = this.unstickSide * (Math.PI / 2 + Math.min(n, 2) * Math.PI / 4);
      this.unstickDir = n === 0 ? null : rotateY(norm(flat(want)), turn);
      this.unstickUntil = now + UNSTICK_SEC * (1 + n);
      this.nextScoreAt = now + UNSTICK_SEC * (1 + n);
      this.wander = null;
    }
    this.stuckRef = { pos: clone(me.pos), t: now };
  }
}

const flat = (p: Vec3): Vec3 => v3(p.x, 0, p.z);

/**
 * Aim for a grenade to land at `to` (same launch as combat.throwGrenade: throwSpeed along the aim plus 3 m/s up,
 * gravity integrated per tick). `low`: flattest arc (through a doorway), else the high lob that drops in behind cover
 * when one lands within the fuse.
 * Null when out of range or the flight would outlast the fuse.
 */
export function throwAngles(eye: Vec3, to: Vec3, low: boolean): Angles | null {
  const d = dist2D(eye, to), dy = to.y - eye.y;
  const yaw = lookAt(eye, to).yaw;
  const heightAt = (pitch: number) => {
    const vx = GRENADE.throwSpeed * dm.cos(pitch), vy = GRENADE.throwSpeed * dm.sin(pitch) + 3;
    const tt = d / vx;
    return { y: vy * tt - (PLAYER.gravity * tt * (tt + DT)) / 2, t: tt, falling: vy - PLAYER.gravity * tt < 0 };
  };
  // Scan the arc up from flat (low) or down from steep (high) for where it first comes down through the target.
  // No grenade explodes in the air, so a lob that would outlast the fuse falls back to the flatter arc
  // (it may clip the cover instead, still well inside the blast radius).
  let prevBelow = false;
  for (let i = 0; i <= 200; i++) {
    const pitch = low ? -0.6 + i * 0.01 : 1.38 - i * 0.01;
    const h = heightAt(pitch);
    if (h.y >= dy && prevBelow) {
      if (h.t <= GRENADE.fuseSec - 0.1 && (low || h.falling)) return { yaw, pitch };
      return low ? null : throwAngles(eye, to, true);
    }
    prevBelow = h.y < dy;
  }
  return null;
}
const laneOff = (l: Lane, p: Vec3) => Math.abs((p.x - l.origin.x) * l.dir.z - (p.z - l.origin.z) * l.dir.x);