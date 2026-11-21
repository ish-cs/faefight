import * as dm from '../dmath';
import { CHARGE, DT, ECONOMY, GRENADE, LIFECYCLE, MAP, PIECES, PLAYER, SEAL, STORM, WEAPONS } from '../constants';
import { eyePos } from '../combat';
import { isFlammable, steerFromFire } from '../fire';
import type { Doorway, IslandLayout } from '../map';
import { NO_INPUT } from '../types';
import type {
  BuildRequest, Difficulty, PieceKind, PieceState, PlayerInput, PlayerState, ShopItem, VaultAction, Vec3, WeaponKind,
} from '../types';
import { add, clone, dist2D, forward, norm, right, rotateY, scale, sub, v3, yawOf } from '../vec';
import { isRng, mulberry32 } from '../rng';
import { AIM, Aim, angleBetween, lookAt, wrapAngle, type Angles } from './aim';
import { flankSide, fortPlan, fortShare, fumble, ghost, ownBunkerSafe, shields, slotBuilt, type Slot } from './build';
import { BunkerGrid, blockingPieces, breakCost, pieceToBreak } from './escape';
import { DEFAULT_BOT_PARAMS, type BotParams } from './params';
import { Memory, commitment, rivalScore, type RivalFacts, type Sighting } from './mind';
import { Nav, insideBunker, islandAt, landEdge, lane, laneAt, laneS, type Lane } from './nav';
import { rollPersonality, type Personality, type Traits } from './personality';
import {
  TALL, bestGun, doorBlocked, doorPieces, hasAmmo, isHard, nextPurchase, ownsGun, plugFor, plugSpot, potionAction, sealKit,
  shoppingPlan,
  type Needs, type ShopStyle,
} from './plans';
import type { BotView, OtherStatus } from './view';
import { BrainProbe, debugBrain, noteSwitch, type BrainDigest, type GoalSwitch, type ScoreRow } from './introspect';

export type Goal =
  | 'collect' | 'shop' | 'bank' | 'bridge' | 'attack' | 'seal' | 'defend' | 'guard' | 'cut' | 'loot' | 'raid'
  | 'fight' | 'disengage' | 'storm' | 'heal' | 'cover' | 'fortify' | 'contest';
const GOALS: Goal[] = [
  'storm', 'defend', 'disengage', 'cover', 'fight', 'guard', 'bank', 'seal', 'attack', 'cut', 'raid', 'loot', 'bridge',
  'fortify', 'shop', 'heal', 'contest', 'collect',
];
/** Center gold worth a trip, and how far a bot will go out of its way for it. */
const CONTEST_AT = 150;

/** How often a bot reconsiders what to do, and how long it hesitates after changing plans (human thinking time). */
const RESCORE_SEC: Record<Difficulty, number> = { easy: 1.6, medium: 1.0, hard: 0.5, pro: 0.3 };
const HESITATE_SEC: Record<Difficulty, number> = { easy: 1.2, medium: 0.6, hard: 0.15, pro: 0.05 };
const STICKY = 0.1;
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
const COLLECT_AT = 40;
const STUCK_SEC = 2, STUCK_DIST = 0.5, UNSTICK_SEC = 0.6;
const TURN_RATE = 8;
/** Beyond this, an enemy on another island isn't worth abandoning the current goal for. */
const ENGAGE_RANGE = 25;
const CHEST = 1.2;
/** Net forward progress of one scaffold laid end-to-end. */
const SCAFFOLD_STEP = 3.8;
const PREFERRED_RANGE: Record<WeaponKind, number> = { fists: 1.2, shotgun: 6, smg: 12, pistol: 16, rifle: 25, rocket: 20 };
/** Memory horizons: an intruder seen on my island, a rival's whereabouts. */
const INTRUDER_SEC = 8, WHEREABOUTS_SEC = 20;
const LOOT_RANGE = 35;
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
/** Spare decks carried for the bridge to the center; how long into the storm a shop trip out in it is still survivable (low dps). */
const STORM_SPARE_DECKS = 2, STORM_SHOP_GRACE = 45;
const COVER_KINDS = new Set(['wood', 'metal', 'steel', 'container']);
/** Walls a bot throws down for cover, best first (sandbags go up two high). */
const WALLS: PieceKind[] = ['metal', 'wood', 'steel'];
/** Generator cash worth grabbing on the way out, and the level at which it is about to be wasted at the cap. */
const COLLECT_BEFORE_LEAVING = 40, COLLECT_NEAR_CAP = 400;
/** Grenades: throw range (outside the blast), minimum gap between throws, how stale a sighting may be. */
const NADE_MIN = 6.5, NADE_MAX = 22, NADE_GAP = 3, NADE_SEEN_SEC = 2.5;
/** Cash (carried + banked) at which a bot stocks up on grenades (steel seal kit: DriveParams.steelRich). */
const NADE_RICH: Record<Difficulty, number> = { easy: Infinity, medium: 900, hard: 450, pro: 400 };
/** Torching wooden bases: rocket range window (m), one rocket per gap (s), and the cash it takes to buy in. */
const TORCH_RANGE = [9, 45] as const, TORCH_GAP = 8, TORCH_RICH = 900;
/** Rebuy money for after a death: pistol + a box of ammo. */
const INSURANCE = WEAPONS.pistol.price + 25;
/** HP at or below which a bot uses a medkit it carries. */
const MEDKIT_AT: Record<Difficulty, number> = { easy: 35, medium: 45, hard: 55, pro: 55 };
/**
 * Clear of my own bunker (from its center): within SEAL.exitRadius of it while it's sealed starts the 10 s
 * escape countdown, so never hang around closer than this.
 */
const BUNKER_OUT = SEAL.exitRadius + 0.8;

export { DRIVE } from './params';
/** Goals the watchdog keeps an eye on (DriveParams.stallSec; attack gets longer: it waits at doors). */
const STALLABLE = new Set<Goal>(['seal', 'attack', 'bridge', 'contest', 'raid', 'loot', 'shop', 'bank', 'fortify', 'cut']);
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
  build?: BuildRequest;
  shop?: ShopItem;
  vault?: VaultAction;
  placeCharge?: boolean;
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
  homeReach: boolean;
  openDoors: Doorway[];
  /** Node (island, or the center island) the next bridge goes to, and whether I can already walk to the center. */
  bridgeTo: number | null;
  centerReach: boolean;
  /** Someone is shooting at me or close to me right now. */
  danger: boolean;
};

export class Bot {
  readonly personality: Personality;
  private readonly t: Traits;
  private readonly style: ShopStyle;
  private goal: Goal = 'collect';
  private targetId: number | null = null;
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
  private nextBuyAt = 0;
  private pendingBuy: { item: ShopItem; cash: number; at: number } | null = null;
  private buyFails = new Map<ShopItem, number>();
  private buyBlockedUntil = new Map<ShopItem, number>();
  /** Shot at in the open: who from, the wall(s) I put up, and the hide/peek rhythm behind it. */
  private cover: {
    threatId: number; threat: Vec3; lastContact: number; startAt: number; placed: number;
    phase: 'hide' | 'peek'; phaseUntil: number; side: number;
  } | null = null;
  private coverRollAt = -Infinity;
  /** Top of a ramp I threw down in a fight (high ground), while it lasts. */
  private perch: { ramp: Vec3; pos: Vec3; until: number } | null = null;
  private fightSince: number | null = null;
  private retreatSince: number | null = null;
  private lastPieceAt = -Infinity;
  private slots: Slot[] | null = null;
  private buildMemo: { at: number; total: number; b: Partial<Record<PieceKind, number>> | undefined } | null = null;
  private slotBackoff = new Map<number, number>();
  /** Bridges: furthest deck reached per lane, islands I'm bridging to on the mirror lane (main one got cut), wall spacing. */
  private laneBest = new Map<string, number>();
  private alt = new Set<number>();
  private bridgeStuck: { key: string; since: number; triedAt: number } | null = null;
  private bridgeHoldUntil = -Infinity;
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
  private prog: { goal: Goal; at: number; pos: Vec3 } | null = null;
  private lastDidAt = -Infinity;
  /** Goals (and the rival they were aimed at) that went nowhere lately: left alone a while. */
  private goalBan = new Map<Goal, number>();
  private targetBan = new Map<number, number>();
  private lastNadeAt = -Infinity;
  private lastTorchAt = -Infinity;
  private grid: { key: string; grid: BunkerGrid } | null = null;
  private hideFrom: { pos: Vec3; until: number } | null = null;
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
  private view!: BotView;
  /** Greedy/opportunist bots bridge to the center island first and contest its bonus stations. */
  private readonly centerMinded: boolean;
  /** Spectator introspection (introspect.ts): set only while someone watches this bot; decisions never read it. */
  probe: BrainProbe | null = null;
  /** Last goal switches (introspect.ts decision log): one small entry per switch. */
  readonly switches: GoalSwitch[] = [];

  /** `params`: tunable strategy (params.ts); the hand-tuned defaults unless a trainer passes its own. */
  constructor(
    readonly id: number, readonly difficulty: Difficulty, private readonly rng: () => number, personality?: Personality,
    private readonly P: BotParams = DEFAULT_BOT_PARAMS,
  ) {
    this.personality = personality ?? rollPersonality(rng);
    this.t = this.personality.traits;
    const t = this.t;
    this.style = {
      upgradeFirst: t.patience > 0.65,
      longGun: t.range > 0.75,
      closeGun: t.range < 0.3,
      metal: t.builder > 0.6,
      steel: t.patience > 0.75 && t.greed > 0.75,
      coverWood: 0,
      invest: t.patience > 0.75,
      buildFirst: t.builder > 0.7,
    };
    // Aim noise draws every tick while tracking: its own stream (seeded from the match rng's state without
    // drawing from it), so how a bot's hand wobbles never shifts the match's other random rolls. A plain function
    // (hand-made test rng) has no state to read: one draw seeds it.
    const base = isRng(rng) ? rng.state.a : Math.floor(rng() * 4294967296);
    const aimSeed = (base ^ Math.imul(id, 0x9e3779b1) ^ 0x6a09e667) >>> 0;
    this.aim = new Aim(AIM[difficulty], mulberry32(aimSeed), P.aim.feel[difficulty]);
    this.wallsOnBridge = rng() < Math.min(1, 0.3 + t.builder);
    this.centerMinded = 0.6 * t.greed + 0.4 * t.opportunism > 0.55;
  }

  get currentGoal(): Goal { return this.goal; }
  /** Rival this bot is currently going after (player id), if any. */
  get currentTarget(): number | null { return this.targetId; }
  /** Hazard id this bot is deliberately shooting to catch an enemy in the blast, if any. */
  get barrelTarget(): number | null { return this.barrelPlan?.id ?? null; }
  /** The top goal scores of the last decision (why it chose what it's doing), for spectators. */
  get planScores(): { goal: string; score: number }[] { return this.lastScores; }
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
    if (!me.alive) {
      this.aim.reset();
      this.aimId = null;
      this.aimLost = null;
      this.stuckRef = null;
      this.retreat = null;
      this.pendingBuy = null;
      this.nadePlan = null;
      this.hideFrom = null;
      this.barrelPlan = null;
      this.cover = null;
      this.perch = null;
      this.fightSince = null;
      this.nextScoreAt = -Infinity;
      return { ...NO_INPUT, yaw: me.yaw, pitch: me.pitch };
    }
    this.view = view;
    this.nav.begin(view);
    this.checkPurchase(me, now);
    // Came back from a death (bots aren't ticked while dead): note it for respawnCautionSec.
    if (me.deaths !== this.lastDeaths) { this.lastDeaths = me.deaths; this.respawnedAt = now; this.window = null; }
    this.sealRace(view);
    if (now >= this.nextScoreAt) this.chooseTarget(view);
    const ctx = this.context(view);
    this.coverTrigger(ctx);
    if (now >= this.nextScoreAt) {
      const next = this.pick(ctx);
      if (next !== this.goal) {
        this.hesitateUntil = now + HESITATE_SEC[this.difficulty] * (0.5 + this.rng());
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
    let act = this.retreat ? { dir: norm(flat(sub(me.pos, this.retreat.from))) } : thinking ? IDLE : this.act(this.goal, ctx);
    // Never hang around inside my own bunker (one plug per door and I'm sealed in): step out.
    if (!act.dir && this.goal !== 'defend' && !this.trapped(ctx) && insideBunker(ctx.home.bunker, me.pos)) act = { ...act, ...this.escape(ctx) };

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
    const best = torch ? 'rocket' : bestGun(me.inv, enemy ? ctx.enemyDist : 30);
    const gunReady = (range: number) => {
      const w = me.equipped;
      const ammo = w === 'fists' ? null : me.inv.weapons[w];
      return me.reloadUntil === 0 && me.busyUntil <= now && range <= WEAPONS[w].range * 0.95 && (w === 'fists' || !!ammo && ammo.mag > 0);
    };
    let throwGrenade = false;
    const nade = enemy || this.goal === 'disengage' ? null : this.grenadePlan(ctx);
    const barrel = enemy ? this.barrelShot(ctx) : null;
    if (barrel) {
      // Set the barrel next to them off: aim at its middle like any other shot.
      look = hand(lookAt(eye, barrel), TURN_RATE * 1.2);
      fire = angleBetween(look, lookAt(eye, barrel)) < 0.04 && gunReady(dist2D(me.pos, barrel));
    } else if (act.shootAt && act.shootFirst) {
      look = hand(lookAt(eye, act.shootAt), TURN_RATE);
      fire = angleBetween(look, lookAt(eye, act.shootAt)) < 0.05 && gunReady(dist2D(me.pos, act.shootAt));
    } else if (foe) {
      const r = this.aim.track(now, dt, eye, add(foe.pos, v3(0, CHEST, 0)), foe.id, cur);
      look = r;
      const foeDist = dist2D(foe.pos, me.pos);
      // Past where my gun still does real damage (falloff floor), don't give my position away for scratches,
      // unless they're the one shooting at me.
      const w = WEAPONS[me.equipped];
      const scratch = this.difficulty !== 'easy' && foeDist > w.falloff.end * this.P.drive.fireRangeMult &&
        !(this.mem.lastHurtBy === foe.id && now - this.mem.lastHurtAt < 3);
      fire = r.ready && r.onTarget && gunReady(foeDist) && !scratch;
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
      if (fire) this.lastTorchAt = now;
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

    // Weapons: hold the best gun, reload when nobody is in sight.
    const ammo = me.equipped === 'fists' ? null : me.inv.weapons[me.equipped];
    const slot = best !== me.equipped && (me.reloadUntil === 0 || !ammo || ammo.mag === 0) ? best : null;
    if (slot) fire = false;
    // An empty mag gets reloaded whoever is in sight (a full one only tops up when nobody is).
    const reload = !slot && !!ammo && me.reloadUntil === 0 && ammo.spare > 0 &&
      (ammo.mag === 0 || (!enemy && ammo.mag < WEAPONS[me.equipped].mag * 0.6));

    // Movement: stuck recovery, then never step toward water.
    let dir = act.dir;
    let jump = !!act.jump;
    const dodge = this.dodgeBolt(me, view);
    if (dodge) { dir = dodge; act = { ...act, sprint: true }; }
    if (now < this.unstickUntil) {
      // Step aside; stuck again at the same spot, back off further each time (around whatever is in the way).
      dir = this.unstickDir ?? scale(right(look.yaw), this.unstickSide);
      jump = true;
    }
    if (!dodge) dir = this.hazardAvoid(ctx, dir);
    if (dir && !dodge) dir = this.stormFence(me, view, dir);
    if (dir) dir = this.nav.safeDir(dir);
    // Never walk into (or stand in) fire: slide around burning pieces and ground fires (a lightning dodge wins).
    const zones = view.fires ?? [];
    if (zones.length && !dodge) {
      const away = steerFromFire(me.pos, dir, zones);
      if (away !== dir) dir = away && this.nav.safeDir(away);
    }
    // In the air, steer to come down on something solid; standing on the rim over water, step back onto it.
    const airborne = Math.abs(me.vel.y) > 0.05;
    if (airborne ? !this.nav.landsOnGround(dir, !!act.sprint) : view.groundAt(me.pos.x, me.pos.z) === null) {
      const back = this.nav.rescue(!!act.sprint);
      if (back) { dir = back; jump = false; }
    }
    // Stuck means pushing and not moving; held back at an edge by safeDir isn't stuck (a hop there goes in the water).
    this.trackStuck(now, me, dir);
    // Only jump where the arc comes down on something solid (never sideways off a deck or an island edge).
    if (jump && !this.nav.safeJump(dir, !!act.sprint)) jump = false;
    const move = dir
      ? { moveX: dir.x * right(look.yaw).x + dir.z * right(look.yaw).z, moveZ: dir.x * forward(look.yaw).x + dir.z * forward(look.yaw).z }
      : { moveX: 0, moveZ: 0 };

    // Patch up with a medkit when hurt and nobody is in my face (2 s with my hands busy).
    let select: number | null = null, useMedkit = false;
    const kit = me.hotbar.indexOf('medkit');
    if (kit >= 0 && me.inv.medkits > 0 && me.hp <= MEDKIT_AT[this.difficulty] && me.busyUntil <= now && me.healAt === null &&
        (!enemy || ctx.enemyDist > 30) && now - this.mem.lastHurtAt > 0.5) {
      select = kit; useMedkit = true; fire = false;
    }
    // Stamina (movement.ts): like a human, stop sprinting around when winded and keep the rest for getting away.
    if (me.stamina < 30) this.winded = true; else if (me.stamina > 70) this.winded = false;
    const cv = view.center;
    const interact = view.map.some((isl) => view.generators[isl.index] >= 1 && dist2D(me.pos, isl.generator) <= USE_RANGE) ||
      (!!cv && ((cv.gold >= 1 && dist2D(me.pos, cv.island.goldGen) <= USE_RANGE) || (cv.bags + cv.steel > 0 && dist2D(me.pos, cv.island.supplyGen) <= USE_RANGE)));
    if (act.shop) this.pendingBuy = { item: act.shop, cash: me.inv.cash, at: now };
    if (act.shop || act.build || act.vault || act.placeCharge || fire || throwGrenade) this.lastDidAt = now;
    if (act.build) {
      this.lastPieceAt = now;
    }
    this.probe?.acted(act, look, fire);
    const out = {
      ...NO_INPUT, ...move, yaw: look.yaw, pitch: look.pitch, jump,
      sprint: !!act.sprint && (!enemy || this.goal === 'disengage' || !!act.approach) && (!this.winded || this.goal === 'disengage' || !!this.retreat),
      fire, reload, interact, slot: useMedkit ? null : slot, select, useMedkit, build: act.build ?? null, shop: act.shop ? { buy: act.shop } : null,
      vault: act.vault ?? null, placeCharge: !!act.placeCharge, throwGrenade,
      // Same spread rules as players: aim down sights for anything past close range.
      ads: !!enemy && me.equipped !== 'fists' && ctx.enemyDist > 8,
    };
    // Shields: stock up at a potion seller, drink out of combat (see potionAction).
    if (!act.shop && !act.build && !fire && !useMedkit && !throwGrenade && !act.placeCharge) {
      const atSeller = (view.potionShops ?? []).some((s) => dist2D(me.pos, s) <= USE_RANGE);
      const pot = potionAction(me, now, !!enemy, atSeller);
      if (pot && 'buy' in pot) out.shop = { buy: pot.buy };
      else if (pot) Object.assign(out, { select: pot.drink, slot: null, drink: true });
    }
    return out;
  }

  /**
   * The visible enemy my gun is on. The nearest, but once on someone I stay on them at least `aim.commitSec`, then
   * switch only to one clearly closer (`aim.switchRatio` × their distance) or when they drop out of sight. Losing
   * sight of a living target holds my eyes on where they were for `holdSec` (the look chain in think uses it).
   */
  private aimTarget(view: BotView, nearest: PlayerState | null, now: number): PlayerState | null {
    const me = view.self, A = this.P.aim;
    let cur = this.aimId === null ? null : view.enemies.find((e) => e.id === this.aimId && e.alive) ?? null;
    if (!cur && this.aimId !== null) {
      const alive = view.others.find((o) => o.id === this.aimId)?.alive ?? false;
      this.aimLost = alive && this.aimAt ? { at: this.aimAt, until: now + A.feel[this.difficulty].holdSec } : null;
      this.aimId = null;
    }
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
    if (me.inv.cash < p.cash) { this.buyFails.delete(p.item); return; }
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
    const src = node >= 0 ? node : home;
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
        scaffolds: reach ? 0 : this.scaffoldsTo(home, o.island),
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

  /** Score every rival; keep the current one unless another is clearly better. */
  private chooseTarget(view: BotView) {
    let best: number | null = null, bestScore = -Infinity, cur = -Infinity;
    for (const f of this.rivalFacts(view)) {
      const s = rivalScore(f, this.t, this.P.drive.sealAwayTarget) + (this.rng() - 0.5) * NOISE[this.difficulty] -
        ((this.targetBan.get(f.id) ?? -Infinity) > view.now ? 1.5 : 0);
      if (f.id === this.targetId) cur = s;
      if (s > bestScore) { bestScore = s; best = f.id; }
    }
    if (best === null) { this.targetId = null; return; }
    if (cur > -Infinity && cur + commitment(this.t) >= bestScore) return;
    this.targetId = best;
  }

  // ---------------------------------------------------------------- context

  private context(view: BotView): Ctx {
    const me = view.self;
    const home = view.map[me.island];
    if (!home) throw new Error(`Bot ${this.id}: island ${me.island} is not on the map`);
    const on = islandAt(view.map, me.pos);
    const node = this.nav.nodeAt(me.pos);
    const src = node >= 0 ? node : home.index;
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
      const eff = !view.suddenDeath && view.sealed[e.island] ? d / this.P.drive.sealedFocus : d;
      if (e.alive && eff < pickD) { enemy = e; enemyDist = d; pickD = eff; }
    }
    const reach = !!rivalIsl && (on === rivalIsl.index || this.nav.hop(src, rivalIsl.index) !== null);
    const homeReach = node === home.index || node < 0 || this.nav.hop(node, home.index) !== null;
    const openDoors = rivalIsl ? rivalIsl.bunker.doorways.filter((d) => !doorBlocked(view.pieces, d)) : [];
    const danger = view.now - this.mem.lastHurtAt < 3 || (!!enemy && enemyDist < 40);
    const C = this.nav.centerNode;
    const centerReach = C >= 0 && (node === C || this.nav.hop(src, C) !== null);
    let bridgeTo: number | null = rivalIsl && !reach ? rivalIsl.index : null;
    // Center-minded: bridge to the center island first when it isn't much further than the rival. Anyone else
    // (but easy players) goes via the center when it's the shorter bridge: it's the hub to everyone, and the fights.
    const slack = this.centerMinded ? 2 : this.difficulty !== 'easy' ? 0 : -Infinity;
    if (C >= 0 && slack > -Infinity && !centerReach && !view.suddenDeath &&
        (bridgeTo === null ? this.centerMinded : this.scaffoldsTo(home.index, C) <= this.scaffoldsTo(home.index, bridgeTo) + slack)) bridgeTo = C;
    // The storm ends on the center island: medium+ bots get a bridge there before it comes (anyone would, seeing the clock).
    if (C >= 0 && !centerReach && this.stormPrep(view)) bridgeTo = C;
    return { view, me, home, on, src, rival, rivalIsl, enemy, enemyDist, reach, homeReach, openDoors, bridgeTo, centerReach, danger };
  }

  private scaffoldsNeeded(c: Ctx): number {
    if (c.bridgeTo === null) return 0;
    return this.scaffoldsTo(c.home.index, c.bridgeTo);
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
    return {
      rocket: wooden,
      // Bridging to the center before the storm: spares for decks that get shot out under me (one trip, not five).
      scaffolds: this.scaffoldsNeeded(c) + (c.bridgeTo !== null && c.bridgeTo === this.nav.centerNode && this.stormPrep(c.view) ? STORM_SPARE_DECKS : 0),
      // A full seal kit whenever there's someone to seal: their doors get reopened, the next rival has three.
      kit: c.rival ? Math.max(c.openDoors.length, MAP_DOORS) : 0,
      // A hard plug in my own doorway: only a charge gets through.
      charge: this.blockers(c).some((p) => isHard(p.kind)),
      grenades: total >= NADE_RICH[this.difficulty] ? (skilled ? 2 : 1) : 0,
      medkits: total >= NADE_RICH[this.difficulty] ? (skilled ? 2 : 1) : 0,
      steel: skilled && total >= this.P.drive.steelRich,
      genLevel: c.view.genLevels?.[c.home.index],
      build: this.buildNeeds(c, total),
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
    const add1 = (k: PieceKind, n = 1) => {
      if (n <= 0) return;
      if (!b[k] && !me.hotbar.includes(k)) { if (free <= this.P.buildTuning.freeSlots) return; free--; }
      b[k] = (b[k] ?? 0) + n;
    };
    if (total >= this.P.buildTuning.fortReserve * (1 - t.builder) && this.fortWorthIt(c))
      for (const [i, s] of this.fortSlots().entries())
        if (!slotBuilt(view.pieces, s) && (this.slotBackoff.get(i) ?? -Infinity) <= view.now) add1(s.kind);
    const walls = Math.round(this.P.buildTuning.coverCarry[this.difficulty] * (0.4 + t.builder));
    const skilled = this.difficulty === 'hard' || this.difficulty === 'pro';
    // Cover walls of the kind I already carry for plugs (one hotbar slot), metal once rich.
    const wall: PieceKind = me.hotbar.includes('metal') || (skilled && total >= this.P.buildTuning.metalCoverAt) ? 'metal' : 'wood';
    add1(wall, walls);
    const scaffolds = this.scaffoldsNeeded(c);
    if (sk.bridgeCover && this.wallsOnBridge && scaffolds >= 2 * this.P.buildTuning.scaffoldsPerBridgeWall)
      add1(wall, Math.floor(scaffolds / this.P.buildTuning.scaffoldsPerBridgeWall));
    if (sk.highGround && total >= this.P.buildTuning.rampAt && t.builder >= 0.3) add1('ramp');
    return b;
  }

  /**
   * Tempo first: walls at home pay off when several rivals may come over and I'm already geared; a duel is won by
   * getting there first. Real builders fortify anyway.
   */
  private fortWorthIt(c: Ctx): boolean {
    if (this.t.builder >= this.P.buildTuning.fortEarlyBuilder) return true;
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
    const total = { ...me, inv: { ...me.inv, cash: me.inv.cash + this.spendable(me) } };
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

  /** Vault cash I may spend on gear (everything above the insurance). */
  private spendable(me: PlayerState): number {
    return Math.max(0, me.vault.cash - this.insurance());
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
      const i = islandAt(c.view.map, p);
      if (i !== c.on && !this.nav.routeTo(p)) continue;
      best = p; bestD = d;
    }
    return best;
  }

  /** An enemy generator worth stealing from: the island I'm on, or my target's when I can walk there. */
  private raidIsland(c: Ctx): IslandLayout | null {
    const now = c.view.now;
    for (const i of [c.on, c.reach && c.rivalIsl ? c.rivalIsl.index : -1]) {
      if (i < 0 || i === c.home.index || c.view.generators[i] < RAID_AT) continue;
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
        if (!st) return 0;
        const d = Math.hypot(me.pos.x - st.x, me.pos.z - st.z);
        if (d > st.r) return this.difficulty === 'easy' ? 0.9 : 1.7;
        if (d > this.stormSafeR(st)) return this.difficulty === 'easy' ? 0.4 : 1.3;
        // No way onto the center island yet: the ring will end there, so the bridge comes first.
        return this.needCenterBridge(c) ? 1.2 : 0;
      }
      case 'fight': {
        if (!c.enemy) return 0;
        // Someone across the water gets shot at anyway (aim/fire layer on every goal); only drop
        // everything to fight when they're close or on the same island.
        const sameIsland = islandAt(view.map, c.enemy.pos) === islandAt(view.map, me.pos);
        if (!sameIsland && c.enemyDist > ENGAGE_RANGE) return 0.2;
        // Sudden death with no ammo left anywhere to buy it: fists are all there is.
        const sealedFoe = !view.suddenDeath && view.sealed[c.enemy.island] ? this.P.drive.sealedHunt : 0;
        return (gun || c.enemyDist < 8 || view.suddenDeath ? 0.85 : 0.35) + 0.25 * t.aggression + (gun ? sealedFoe : 0);
      }
      case 'disengage': {
        if (!c.enemy && view.now - this.mem.lastHurtAt > 1.5) return 0;
        // Outside the safe ring, getting in comes first (running from a gun into the storm kills just as well).
        if (view.storm && Math.hypot(me.pos.x - view.storm.x, me.pos.z - view.storm.z) > this.stormSafeR(view.storm)) return 0;
        // Final circle: nowhere left to run (backing off only buys regen, and the fight never ends); fists vs fists
        // in sudden death likewise.
        if (view.storm && (view.storm.r <= view.storm.rf + 0.5 || (!gun && c.enemy?.equipped === 'fists'))) return 0;
        const low = 0.25 + 0.35 * t.caution - 0.15 * t.aggression;
        if (hp < low) return 1.15 + (low - hp);
        // Unarmed vs a gun: back off only from one close enough to matter (not someone across the water).
        const outgunned = !gun && !view.suddenDeath && !!c.enemy && c.enemy.equipped !== 'fists' && c.enemyDist > 4 &&
          (c.enemyDist < Math.min(ENGAGE_RANGE, WEAPONS[c.enemy.equipped].range) || view.now - this.mem.lastHurtAt < 1.5);
        return outgunned ? 0.95 + 0.2 * t.caution : 0;
      }
      case 'defend': {
        if (trapped) return 2;
        if (view.suddenDeath) return 0;
        const blockers = this.blockers(c);
        if (!blockers.length) return 0;
        // Nothing that can clear what's there (steel needs a charge): better to go buy one than stand at the door.
        const can = blockers.some((p) => this.canClear(c, p));
        if (view.sealed[home.index]) return (can ? 0.85 : 0.1) + 0.1 * t.caution;
        // One plugged doorway is most of a seal: clear it before going out.
        return c.homeReach && can ? 0.7 + 0.15 * t.caution : 0;
      }
      case 'heal': {
        // Health comes back slowly out of combat: low and away from home, go back and recover.
        if (view.suddenDeath || c.enemy || c.on === home.index || !c.homeReach || me.inv.medkits > 0) return 0;
        const low = 0.35 + 0.25 * t.caution - 0.15 * t.aggression;
        return hp < low ? 0.75 + (low - hp) : 0;
      }
      case 'guard': {
        if (!c.homeReach || view.suddenDeath) return 0;
        const s = this.intruder(c);
        if (!s) return 0;
        const fresh = 1 - (view.now - s.t) / INTRUDER_SEC;
        return (0.4 + 0.45 * t.caution) * (0.5 + 0.5 * fresh) + (gun ? 0.1 : -0.2);
      }
      case 'bank': {
        if (c.on !== home.index || view.suddenDeath) return 0;
        // Death insurance: before heading out, leave enough in the vault to rebuy a gun after a death.
        const leavingSoon = c.reach || ((me.inv.pieces.scaffold ?? 0) > 0 && (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c));
        if (leavingSoon && this.insuranceDue(me) > 0 && !(c.enemy && c.enemyDist < 8)) return 0.8;
        if (me.inv.cash < 100) return 0;
        const keep = shoppingPlan(me, this.needs(c), this.difficulty, this.style).spent + 25;
        const excess = me.inv.cash - keep;
        if (excess < 80) return 0;
        const close = c.enemy && c.enemyDist < 8;
        if (close) return 0;
        const leaving = c.reach || (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c);
        const want = 0.2 + Math.min(excess, 600) / 600 * (0.3 + 0.3 * t.caution + 0.2 * t.greed);
        return want + (c.danger || this.intruder(c) ? 0.55 : 0) + (leaving ? 0.25 : 0) - dist2D(me.pos, home.vault) / 80;
      }
      case 'collect': {
        if (!c.homeReach) return 0;
        const stored = view.generators[home.index];
        let s = stored >= COLLECT_AT ? 0.45 + 0.1 * t.greed + Math.min(stored, 500) / 1000 : 0.15;
        // Don't leave cash at an unguarded generator (anyone can take it), and don't let it hit the cap.
        const leaving = c.reach || ((me.inv.pieces.scaffold ?? 0) > 0 && (me.inv.pieces.scaffold ?? 0) >= this.scaffoldsNeeded(c));
        if (c.on === home.index && stored >= COLLECT_BEFORE_LEAVING && leaving && !c.enemy) s = Math.max(s, 0.72);
        if (stored >= COLLECT_NEAR_CAP) s = Math.max(s, 0.8);
        return s - away;
      }
      case 'shop': {
        if (!c.homeReach) return 0;
        const plan = this.plan(c);
        if (!plan.items.length || this.buyBlocked(plan.items[0])) return 0;
        if (dist2D(me.pos, home.shop) < 4 && plan.spent <= me.inv.cash) return 0.9;
        const urgent = plan.items.includes('pistol') || plan.items.includes('charge');
        return (urgent ? 0.75 : plan.items.length >= 3 || plan.covered ? 0.6 : 0) - away;
      }
      case 'bridge': {
        const have = me.inv.pieces.scaffold ?? 0;
        if (c.bridgeTo === null || have === 0 || view.now < this.bridgeHoldUntil) return 0;
        // Bridges are one-way (see Nav.bridge): don't finish one to a rival before carrying a full seal kit.
        const need = this.scaffoldsNeeded(c);
        const toRival = c.bridgeTo !== this.nav.centerNode;
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
        if (!c.reach || !c.rival || view.suddenDeath && !c.enemy && !this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)) {
          return c.reach && view.suddenDeath ? 0.3 : 0;
        }
        // Sealed in (or about to respawn into a sealed bunker): be there to finish it.
        if (this.sieging(c)) return this.P.drive.siegeScore + this.P.drive.sealedHunt + 0.2 * t.opportunism;
        // Respawn window with no kit to seal: wait at their door for the unarmed respawn.
        const push = this.inWindow(c) ? this.P.drive.windowPush * 0.5 : 0;
        if (rivalDown) return (gun && sealKit(me.inv) === 0 ? 0.35 + 0.3 * t.opportunism : 0.3) + push;
        if (!gun) return 0.1;
        const upgraded = !!(me.inv.weapons.smg || me.inv.weapons.rifle || me.inv.weapons.shotgun);
        // Their bunker is sealed: every death of theirs is an elimination, so hunting them is worth the most.
        const sealedHunt = c.rivalIsl && view.sealed[c.rivalIsl.index] && c.rival.alive ? this.P.drive.sealedHunt : 0;
        return (0.3 + 0.25 * t.aggression - (upgraded ? 0 : 0.12 * t.patience)) * (0.5 + 0.5 * Math.max(hp, 1 - t.caution)) + sealedHunt;
      }
      case 'seal': {
        const kit = sealKit(me.inv);
        if (view.suddenDeath || !c.reach || !c.rivalIsl || kit === 0 || !c.openDoors.length) return 0;
        const near = c.on === c.rivalIsl.index && dist2D(me.pos, c.rivalIsl.bunker.center) < 15;
        const ownerAway = !!c.rival && c.rival.alive && this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)?.island !== c.rival.island &&
          !!this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC);
        // Standing on their island with nobody home (not seen here lately): the door is open, plug it now.
        const empty = c.on === c.rivalIsl.index && !!c.rival && c.rival.alive && !ownerAway &&
          this.mem.recent(c.rival.id, view.now, this.P.drive.emptyHomeSec)?.island !== c.rival.island;
        return this.P.drive.sealBonus + (this.inWindow(c) ? this.P.drive.windowPush : 0) + (kit >= c.openDoors.length ? 0.6 : 0.3) + (rivalDown ? 0.5 + 0.3 * t.opportunism : 0) + (near ? 0.1 : 0) +
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
      case 'raid': {
        if (view.suddenDeath || !gun) return 0;
        const isl = this.raidIsland(c);
        if (!isl) return 0;
        return 0.2 + 0.45 * t.greed + Math.min(view.generators[isl.index], 500) / 1000 - (c.on === isl.index ? 0 : 0.15);
      }
    }
  }

  /** Inside my own sealed bunker (respawned into it, or sealed in alive): getting out is all that matters. */
  private trapped(c: Ctx): boolean {
    return c.me.breakoutUntil !== null || (c.view.sealed[c.home.index] && !c.view.suddenDeath && insideBunker(c.home.bunker, c.me.pos));
  }

  private pick(c: Ctx): Goal {
    if (this.trapped(c)) { this.probe?.decided(c, null, 'defend'); return 'defend'; }
    const rows: ScoreRow[] | null = this.probe ? [] : null;
    let best: Goal = (c.homeReach || !c.reach) && !(c.reach && this.difficulty !== 'easy' && this.offensive(c)) ? 'collect' : 'attack', bestScore = -Infinity;
    const scored: { goal: string; score: number }[] = [];
    for (const g of GOALS) {
      if ((this.goalBan.get(g) ?? -Infinity) > c.view.now && !this.stormPrep(c.view)) continue; // banned for a while (goal watchdog)
      const raw = this.score(g, c);
      const base = this.drive(g, c, raw);
      if (base <= 0 && g !== best) { rows?.push({ goal: g, raw, base, noise: 0, sticky: 0, score: base }); continue; }
      const noise = (this.rng() - 0.5) * NOISE[this.difficulty], sticky = g === this.goal ? STICKY : 0;
      const s = base + noise + sticky;
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
        if (!c.enemy) return s;
        const sameIsland = islandAt(view.map, c.enemy.pos) === c.on;
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
      case 'fortify': return this.t.builder >= this.P.buildTuning.fortEarlyBuilder ? s * 0.5 : 0;
      case 'cut': return this.crossing(c) ? s : s * 0.4;
      // Banking with danger near is protecting the money (a death drops it all); idle banking waits.
      case 'bank': return this.insuranceDue(me) > 0 || c.danger ? s : s * 0.5;
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
      case 'storm': return this.doStorm(c);
      case 'contest': return this.doContest(c);
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
    // Short of cash for the plan but some is in the vault: fetch it first.
    const plan = this.plan(c);
    // Live or die, keep the rebuy money in the vault (unless the gun is what I'm buying).
    const short = Math.min(plan.items[0] === 'pistol' || plan.items[0] === 'ammo' ? me.vault.cash : this.spendable(me), plan.spent - me.inv.cash);
    if (short > 0) {
      const walk = this.goTo(c.home.vault, 1.8);
      if (dist2D(me.pos, c.home.vault) > USE_RANGE || me.busyUntil > now) return walk;
      return { ...walk, vault: { withdraw: { cash: short } } };
    }
    const walk = this.goTo(c.home.shop, 2.0);
    if (dist2D(me.pos, c.home.shop) > USE_RANGE || now < this.nextBuyAt) return walk;
    let item = nextPurchase(me, this.needs(c), this.difficulty, this.style);
    if (!item || this.buyBlocked(item)) { this.nextScoreAt = now; return walk; }
    if (this.difficulty === 'easy' && item in PIECES && item !== 'scaffold' && this.rng() < EASY_MISBUY && me.inv.cash >= PIECES.sandbags.price) item = 'sandbags';
    this.nextBuyAt = now + BUY_GAP[this.difficulty];
    return { ...walk, shop: item };
  }

  private doBank(c: Ctx): Act {
    const me = c.me;
    const walk = this.goTo(c.home.vault, 1.8);
    if (dist2D(me.pos, c.home.vault) > USE_RANGE || me.busyUntil > c.view.now) return walk;
    const keep = shoppingPlan(me, this.needs(c), this.difficulty, this.style).spent + 25;
    const cash = Math.max(Math.floor(me.inv.cash - keep), this.insuranceDue(me));
    if (cash <= 0) { this.nextScoreAt = c.view.now; return walk; }
    this.nextScoreAt = c.view.now + 1.2;
    return { ...walk, vault: { deposit: { cash } } };
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
    const toRival = to !== this.nav.centerNode;
    // Main lane runs from my side (s grows toward them); the mirror lane (rivals only) is measured from their side.
    const mirror = toRival && this.alt.has(to);
    const m = mirror ? this.mirrorFrontier(to) : null;
    const l = m ? m.l : this.nav.lane(c.home.index, to);
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
    const shore = Math.sqrt(c.home.radius * c.home.radius - 9);
    const out = mirror ? l.length - shore - f.s : f.s - shore;
    const lastWall = this.lastWallS.get(key) ?? -Infinity;
    const wall = TALL.reduce((n, k) => n + (c.me.inv.pieces[k] ?? 0), 0) > c.openDoors.length ? WALLS.find((k) => (c.me.inv.pieces[k] ?? 0) > 0) : undefined;
    if (wall && this.P.buildSkill[this.difficulty].bridgeCover && this.wallsOnBridge && out > this.P.buildTuning.bridgeWallFrom && Math.abs(f.s - lastWall) >= this.P.buildTuning.bridgeWallEvery) {
      this.lastWallS.set(key, f.s);
      const side = flankSide(c.view.map, l);
      const p = add(at(-1.6), scale(right(yawOf(l.dir)), side * 0.85));
      const act = this.place(c, wall, v3(p.x, c.me.pos.y, p.z), yawOf(l.dir) + Math.PI / 2, ahead);
      if (act) return act;
    }
    const rotY = yawOf(l.dir);
    // Butt the new deck against the end of the last one (it sits level with whatever its near end attaches to).
    // Nothing fits (e.g. a gap shorter than a deck, something in the way): look again now and then, not every tick.
    const st = this.bridgeStuck?.key === key ? this.bridgeStuck : null;
    if (st && now - st.triedAt < this.P.buildTuning.bridgeRetrySec) return { dir: null, face: ahead };
    for (const k of [2.0, 2.1, 2.2, 2.3, 2.4, 2.6]) {
      const p = at(k);
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
        else { this.alt.delete(to); this.bridgeHoldUntil = now + this.P.buildTuning.bridgeHoldSec; }
        this.nextScoreAt = now;
      }
    }
    return { dir: null, face: ahead };
  }

  private doAttack(c: Ctx): Act {
    if (!c.rivalIsl || !c.rival) return IDLE;
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

  private doSeal(c: Ctx): Act {
    const isl = c.rivalIsl;
    if (!isl || !c.openDoors.length) return IDLE;
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
    if (isHard(target.kind) && me.inv.charges > 0) return this.blast(c, door, target, inside);
    const fists = !ownsGun(me.inv);
    // Punching from outside means standing within the countdown radius: only while it isn't sealed.
    if (fists && !inside && c.view.sealed[home.index]) { this.nextScoreAt = c.view.now; return IDLE; }
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
      return { dir: null, face: center, placeCharge: true };
    }
    return { dir: null, face: center };
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
    if (here.path) {
      const wp = here.path[Math.min(here.path.length - 1, 3)];
      return { dir: norm(flat(sub(wp, me.pos))) };
    }
    const weapon = bestGun(me.inv, 1.5);
    const w = WEAPONS[weapon];
    const dps = w.dmg * w.pellets * w.rps;
    const charge = me.inv.charges > 0;
    const blastable = (p: PieceState) => charge && p.hp <= CHARGE.pieceDmg;
    const cost = (p: PieceState) => Math.min(breakCost(p, weapon, dps), blastable(p) ? CHARGE.fuseSec + 2 : Infinity);
    const nearDoor = (p: PieceState) => c.home.bunker.doorways.some((d) => dist2D(d.center, p.pos) < 1.8);
    // Nothing I carry gets through anything: still have a go at the weakest doorway plug (a human would).
    const target = pieceToBreak(grid, me.pos, cost, nearDoor) ??
      (pieceToBreak(grid, me.pos, (p) => p.hp, nearDoor));
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
      if (!facing || me.busyUntil > now) return { dir: null, face: center };
      this.hideFrom = { pos: target.pos, until: now + CHARGE.fuseSec + 0.3 };
      return { dir: null, face: center, placeCharge: true };
    }
    return { dir: null, shootAt: center, shootFirst: true };
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
      if (d >= R) continue;
      const away = d < 0.05 ? right(me.yaw) : norm(flat(sub(me.pos, h.pos)));
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
    const e = c.enemy;
    if (!e) return IDLE;
    const now = c.view.now, me = c.me, t = this.t;
    if (now >= this.strafeFlipAt) {
      this.strafeSign = this.rng() < 0.5 ? -1 : 1;
      this.strafeFlipAt = now + 0.6 + this.rng() * 0.8;
    }
    const to = norm(flat(sub(e.pos, me.pos)));
    const gun = bestGun(me.inv, c.enemyDist);
    const pref = PREFERRED_RANGE[gun] * (0.8 + 0.5 * t.range);
    // Skilled players close in rather than trade shots from afar.
    const want = this.difficulty === 'easy' ? pref : Math.min(pref, this.P.drive.maxRange[this.difficulty]);
    const side = scale(right(yawOf(to)), this.strafeSign * (want < 2 ? 0.3 : 1));
    const sameIsland = islandAt(c.view.map, e.pos) === c.on;

    // High ground: hold the top of a ramp I threw down while it stands.
    if (this.perch && (now > this.perch.until || !c.view.pieces.some((p) => p.kind === 'ramp' && dist2D(p.pos, this.perch!.ramp) < 0.3))) this.perch = null;
    if (this.perch) {
      const d = dist2D(me.pos, this.perch.pos);
      return d > 0.35 ? { dir: norm(flat(sub(this.perch.pos, me.pos))) } : { dir: null };
    }
    const ramp = this.highGround(c, e, to, gun, sameIsland);
    if (ramp) return ramp;
    // Careful players fight from behind something solid.
    if (gun !== 'fists' && c.enemyDist > 6 && sameIsland && (t.caution > 0.5 || me.hp < 60)) {
      const cover = this.coverFrom(c, e);
      if (cover && dist2D(cover, me.pos) > 0.8) return this.goTo(cover, 0.6);
      if (cover) return { dir: scale(side, 0.4) };
    }

    const gapM = c.enemyDist - want;
    // Hold range within a couple of metres; with fists (reach 2 m) only a step's slack, or they circle out of reach.
    const radial = Math.abs(gapM) < (want < 2 ? 0.4 : 2) ? 0 : Math.sign(gapM);
    const dir = add(scale(to, radial), side);
    const rush = this.difficulty !== 'easy' && gapM > this.P.drive.sprintGap;
    // Chasing across water needs a route; otherwise just strafe in place.
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
  private place(c: Ctx, kind: PieceKind, pos: Vec3, rotY: number, face: Vec3): Act | null {
    const r = c.view.canPlace(kind, pos, rotY);
    if (!r.ok) return null;
    if (!c.view.suddenDeath && !ownBunkerSafe(c.home.bunker, c.view.pieces, ghost(kind, r.pos, rotY, c.me.id))) return null;
    return { dir: null, face, build: { kind, pos, rotY, free: true } };
  }

  /** Busy placing, or still between two pieces of a sequence (better players chain them tighter). */
  private building(c: Ctx, kind?: PieceKind): boolean {
    const gap = this.P.buildSkill[this.difficulty].gap;
    return c.me.busyUntil > c.view.now || c.view.now < this.lastPieceAt + (kind ? PIECES[kind].placeSec : 0) + gap;
  }

  /** Walls I may throw down for cover: tall pieces beyond the seal kit, else sandbags. */
  private wallKind(c: Ctx): PieceKind | null {
    const inv = c.me.inv;
    const tall = TALL.reduce((n, k) => n + (inv.pieces[k] ?? 0), 0);
    if (tall > c.openDoors.length) return WALLS.find((k) => (inv.pieces[k] ?? 0) > 0) ?? null;
    return (inv.pieces.sandbags ?? 0) > 0 ? 'sandbags' : null;
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
    if (view.suddenDeath || c.on < 0 || insideBunker(c.home.bunker, me.pos)) return;
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
      phase: 'hide', phaseUntil: 0, side: this.rng() < 0.5 ? -1 : 1,
    };
    this.nextScoreAt = Math.min(this.nextScoreAt, now + sk.coverDelay * 0.5);
  }

  /** A piece near me that shields a spot just behind it from the threat, and that spot. */
  private coverWall(c: Ctx, threat: Vec3): { wall: PieceState; hide: Vec3 } | null {
    const eye = add(threat, v3(0, PLAYER.eyeHeight, 0));
    let best: { wall: PieceState; hide: Vec3 } | null = null, bestD = 4;
    for (const p of c.view.pieces) {
      if (p.kind === 'scaffold' || p.kind === 'ramp') continue;
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
    const got = this.coverWall(c, cv.threat);
    if (!got) {
      if (now < cv.startAt || this.building(c)) return c.enemy ? this.doFight(c) : { dir: null, face };
      const kind = this.wallKind(c);
      if (!kind || cv.placed >= this.P.buildTuning.coverMaxPieces) { this.cover = null; this.nextScoreAt = now; return IDLE; }
      const to = norm(flat(sub(cv.threat, me.pos)));
      // A bag already lying between us: stack the next one on it.
      const low = kind === 'sandbags' ? view.pieces.find((p) => p.kind === 'sandbags' && p.owner === me.id && dist2D(p.pos, me.pos) < 2.2 &&
        Math.abs(p.pos.y - me.pos.y) < 0.3 && (p.pos.x - me.pos.x) * to.x + (p.pos.z - me.pos.z) * to.z > 0.5) : undefined;
      if (low) {
        const act = this.place(c, kind, v3(low.pos.x, me.pos.y + 0.4, low.pos.z), low.rotY, face);
        if (act) { cv.placed++; return act; }
      }
      for (const d of this.P.buildTuning.coverDist) {
        let pos = add(me.pos, scale(to, d)), rotY = yawOf(to);
        if (this.rng() < sk.misplace) ({ pos, rotY } = fumble(pos, rotY, this.rng));
        const act = this.place(c, kind, pos, rotY, face);
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
    const peek = add(hide, scale(right(yawOf(away)), cv.side * (PIECES[wall.kind].w / 2 + 0.7)));
    const spot = cv.phase === 'hide' ? hide : peek;
    const there = dist2D(me.pos, spot) < 0.35;
    if (there && cv.phaseUntil === 0) cv.phaseUntil = now + (cv.phase === 'hide' ? sk.peekHide : sk.peekOut) * (0.75 + 0.5 * this.rng());
    if (cv.phaseUntil > 0 && now >= cv.phaseUntil) {
      cv.phase = cv.phase === 'hide' ? 'peek' : 'hide';
      cv.phaseUntil = 0;
      if (cv.phase === 'peek' && this.rng() < 0.3) cv.side = -cv.side;
    }
    return there ? { dir: null, face } : { dir: norm(flat(sub(spot, me.pos))), face };
  }

  /** Mid-range fight on the same island for a while: a ramp toward them and fight from its top. */
  private highGround(c: Ctx, e: PlayerState, to: Vec3, gun: WeaponKind, sameIsland: boolean): Act | null {
    const { me, view } = c;
    const now = view.now;
    const [lo, hi] = this.P.buildTuning.highGroundRange;
    if (!this.P.buildSkill[this.difficulty].highGround || (me.inv.pieces.ramp ?? 0) === 0 || !sameIsland || gun === 'fists' ||
      c.enemyDist < lo || c.enemyDist > hi || this.fightSince === null || now - this.fightSince < this.P.buildTuning.highGroundAfter ||
      c.on < 0 || me.pos.y - view.map[c.on].groundY > 0.3 || e.pos.y - me.pos.y > 1 || this.building(c)) return null;
    const pos = add(me.pos, scale(to, 2.1));
    const act = this.place(c, 'ramp', pos, yawOf(to) + Math.PI, add(e.pos, v3(0, CHEST, 0)));
    if (!act) return null;
    this.perch = { ramp: v3(pos.x, me.pos.y, pos.z), pos: add(pos, scale(to, 1.0)), until: now + this.P.buildTuning.perchSec };
    return act;
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
    const act = this.place(c, slot.kind, slot.pos, slot.rotY, face);
    if (act) return act;
    this.slotBackoff.set(i, view.now + this.P.buildTuning.slotBackoffSec);
    this.nextScoreAt = view.now;
    return { dir: null, face };
  }


  /** Back off from whoever is hurting me: home to the bunker if that isn't toward them, else straight away. */
  private doDisengage(c: Ctx): Act {
    const me = c.me;
    const from = c.enemy?.pos ?? (this.mem.lastHurtBy !== null ? this.mem.recent(this.mem.lastHurtBy, c.view.now, 5)?.pos : undefined);
    if (!from) { this.nextScoreAt = c.view.now; return IDLE; }
    const away = norm(flat(sub(me.pos, from)));
    if (c.homeReach) {
      // Behind my bunker, not inside it (inside, one plug per door seals me in).
      const b = c.home.bunker;
      const behind = add(b.center, scale(norm(flat(sub(b.center, from))), BUNKER_OUT));
      const home = this.goTo(v3(behind.x, c.home.groundY, behind.z), 1.5);
      if (home.dir && home.dir.x * away.x + home.dir.z * away.z > -0.2) return { ...home, sprint: true };
    }
    const cover = c.enemy ? this.coverFrom(c, c.enemy) : null;
    if (cover && dist2D(cover, me.pos) > 0.8) return { ...this.goTo(cover, 0.6), sprint: true };
    return { dir: away, sprint: true };
  }

  /** Radius I want to be inside: the ring as it will be a few seconds from now, minus a margin. */
  private stormSafeR(st: NonNullable<BotView['storm']>): number {
    const ahead = st.r - st.rate * STORM_LEAD[this.difficulty] - STORM_MARGIN[this.difficulty];
    return Math.max(Math.min(st.rf - 2, st.r), ahead);
  }

  /**
   * Sudden-death storm: get inside the ring ahead of it. Straight toward the centre when that stays on land
   * I can walk to; otherwise to the walkable spot closest to the centre (the near shore of my island or of one
   * I can reach by bridge).
   */
  private doStorm(c: Ctx): Act {
    const { view, me } = c;
    const st = view.storm;
    if (!st) return IDLE;
    const ctr = v3(st.x, me.pos.y, st.z);
    const want = this.stormSafeR(st) - 1;
    const d = dist2D(me.pos, ctr);
    const out = d > 0.5 ? norm(flat(sub(me.pos, ctr))) : forward(me.yaw);
    const spot = add(ctr, scale(out, Math.min(d, want)));
    const here = this.nav.nodeAt(me.pos);
    const target = this.nav.nodeAt(spot);
    if (d > want && target >= 0 && (target === here || this.nav.routeTo(spot))) return { ...this.goTo(spot, 1), sprint: true };
    // The walkable spot closest to the centre: on my island, or one I can reach (center island included).
    let best: Vec3 | null = null, bestD = Infinity;
    for (const n of this.nav.nodes) {
      if (n.index !== here && (here < 0 || this.nav.hop(here, n.index) === null)) continue;
      const toC = dist2D(n.center, ctr);
      const k = toC < 0.5 ? 0 : Math.max(0, toC - n.radius + 2.5) / toC;
      const p = v3(n.center.x + (ctr.x - n.center.x) * (1 - k), n.groundY, n.center.z + (ctr.z - n.center.z) * (1 - k));
      const pd = dist2D(p, ctr) + dist2D(p, me.pos) * 0.05;
      if (pd < bestD) { bestD = pd; best = p; }
    }
    // Nothing walkable inside the ring, or no way onto the center island where it ends: bridge there
    // (buy the decks first if I have none).
    if ((bestD > want || this.needCenterBridge(c)) && c.bridgeTo !== null && c.bridgeTo === this.nav.centerNode) {
      const have = me.inv.pieces.scaffold ?? 0, need = this.scaffoldsNeeded(c);
      // Stock up in one shop visit (not one deck per trip) while still on my island.
      // Only while the shop (and the vault, if I need cash from it) is still inside the ring: a trip out into the
      // storm to shop kills just as surely.
      const shopSafe = [c.home.shop, ...(me.inv.cash < PIECES.scaffold.price ? [c.home.vault] : [])]
        .every((p) => dist2D(p, ctr) < st.r - 2) || view.now - LIFECYCLE.suddenDeathAt < STORM_SHOP_GRACE;
      const buy = have < need && c.homeReach && shopSafe && (have === 0 || dist2D(me.pos, c.home.shop) < 6) ? this.buyDecks(c) : null;
      if (buy) return buy;
      if (have > 0) {
        const b = this.doBridge(c);
        if (b.dir || b.build || b.face) return b;
      }
    }
    if (!best) return { dir: norm(flat(sub(ctr, me.pos))), sprint: true };
    return { ...this.goTo(best, 1), sprint: true };
  }

  /** Walk to my shop and buy scaffolds (cash from the vault if needed); null when I can't afford one. */
  private buyDecks(c: Ctx): Act | null {
    const me = c.me, now = c.view.now, price = PIECES.scaffold.price;
    if (me.inv.cash < price) {
      if (me.vault.cash < price) return null;
      const walk = this.goTo(c.home.vault, 1.8);
      if (dist2D(me.pos, c.home.vault) > USE_RANGE || me.busyUntil > now) return walk;
      return { ...walk, vault: { withdraw: { cash: Math.min(me.vault.cash, price * 20) } } };
    }
    const walk = this.goTo(c.home.shop, 2.0);
    if (dist2D(me.pos, c.home.shop) > USE_RANGE || now < this.nextBuyAt || this.buyBlocked('scaffold')) return { ...walk, sprint: true };
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
    // Getting set for the storm (decks to the center, buying them) is never given up.
    if (limit === undefined || this.stormPrep(this.view)) { this.prog = null; return; }
    const p = this.prog;
    if (!p || p.goal !== this.goal || dist2D(p.pos, me.pos) > this.P.drive.stallDist || this.lastDidAt > p.at) {
      this.prog = { goal: this.goal, at: now, pos: clone(me.pos) };
      return;
    }
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