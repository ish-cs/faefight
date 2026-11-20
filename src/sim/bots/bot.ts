import { CHARGE, DT, ECONOMY, GRENADE, LIFECYCLE, MAP, PIECES, PLAYER, ROCKET, SEAL, WEAPONS } from '../constants';
import { eyePos } from '../combat';
import type { Doorway, IslandLayout } from '../map';
import { NO_INPUT } from '../types';
import type {
  BuildRequest, Difficulty, PieceState, PlayerInput, PlayerState, ShopItem, VaultAction, Vec3, WeaponKind,
} from '../types';
import { add, clone, dist2D, forward, norm, right, scale, sub, v3, yawOf } from '../vec';
import { AIM, Aim, angleBetween, lookAt, turnToward, wrapAngle, type Angles } from './aim';
import { BunkerGrid, blockingPieces, breakCost, pieceToBreak } from './escape';
import { Memory, commitment, rivalScore, type RivalFacts, type Sighting } from './mind';
import { Nav, insideBunker, islandAt, lane, laneAt, laneS, type Lane } from './nav';
import { DEFAULT_PARAMS, withTraits, type BotParams, type ParamKey } from './params';
import { rollPersonality, type Personality, type Traits } from './personality';
import {
  TALL, bestGun, doorBlocked, doorPieces, hasAmmo, isHard, nextPurchase, ownsGun, plugFor, plugSpot, potionAction, sealKit,
  shoppingPlan,
  type Needs, type ShopStyle,
} from './plans';
import { Brain, fightOdds, type BrainGoal, type BrainInput } from './brain';
import { DODGE_SKILL, Dodger } from './tactics';
import type { BotView, OtherStatus } from './view';

export type Goal =
  | 'collect' | 'shop' | 'bank' | 'bridge' | 'attack' | 'seal' | 'defend' | 'guard' | 'cut' | 'loot' | 'raid'
  | 'fight' | 'disengage' | 'fleeTide' | 'heal' | 'potions';
const GOALS: Goal[] = [
  'fleeTide', 'defend', 'disengage', 'fight', 'guard', 'bank', 'seal', 'attack', 'cut', 'raid', 'loot', 'bridge',
  'shop', 'heal', 'potions', 'collect',
];
/** Actions that may interrupt the brain's current step (reflexes and quick errands). */
const REFLEXES = new Set<Goal>(['fleeTide', 'defend', 'fight', 'disengage', 'collect', 'loot']);
/** How much the brain's current step outweighs those. */
const STEP_BONUS = 0.4;
const SAFE_STEPS = new Set<Goal>(['heal', 'attack', 'collect', 'bank']);
/** Trainable per-goal utility bias (params.ts). */
const GOAL_BIAS: Partial<Record<Goal, ParamKey>> = {
  fight: 'biasFight', disengage: 'biasDisengage', guard: 'biasGuard', bank: 'biasBank', collect: 'biasCollect',
  shop: 'biasShop', bridge: 'biasBridge', attack: 'biasAttack', seal: 'biasSeal', cut: 'biasCut', loot: 'biasLoot',
  raid: 'biasRaid', heal: 'biasHeal',
};

/** What a bot is up to, for an on-screen debug overlay. */
export type BotDebug = {
  /** Tick-level action right now (shop, bridge, seal, fight, ...). */
  action: Goal;
  /** Brain goal, its reason, and the current step ("2/5 get a seal kit"). */
  goal: BrainGoal['kind'] | null; reason: string; step: string; stepIndex: number; steps: number;
  /** One line, like a human's thought: "Goal: seal (Wavy.Dan is away from home, I have 3 plugs) — step 4/7 bridge to Wavy.Dan's island". */
  thought: string;
  target: number | null; underFire: boolean; enemy: number | null; fightOdds: number | null;
};

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
const STUCK_SEC = 2, STUCK_DIST = 0.5, UNSTICK_SEC = 0.6;
const TURN_RATE = 8;
const CHEST = 1.2;
/** Net forward progress of one scaffold laid end-to-end. */
const SCAFFOLD_STEP = 3.8;
const PREFERRED_RANGE: Record<WeaponKind, number> = { fists: 1.2, shotgun: 6, smg: 12, pistol: 16, rifle: 25, rocket: 20 };
/** Memory horizons: an intruder seen on my island, a rival's whereabouts. */
const INTRUDER_SEC = 8, WHEREABOUTS_SEC = 20;
const LOOT_RANGE = 35;
/** Sandbags carried into sudden death to climb above the tide, bought in the last minutes before it. */
const TOWER_BAGS = 10, TOWER_PREP_SEC = 150;
const COVER_KINDS = new Set(['wood', 'metal', 'steel', 'container']);
/** Snipers go up a sandbag tower this long before sudden death. */
const HIGH_GROUND_SEC = 75;
/** Generator cash worth grabbing on the way out, and the level at which it is about to be wasted at the cap. */
const COLLECT_BEFORE_LEAVING = 40, COLLECT_NEAR_CAP = 400;
/** Grenades: minimum gap between throws, how stale a sighting may be (range is in BotParams). */
const NADE_GAP = 3, NADE_SEEN_SEC = 2.5;
/**
 * Lower-skill players are slower to think of grenades, steel and medkits: multipliers on the trained
 * cash thresholds (easy never buys grenades) and offsets on the medkit HP.
 */
const RICH_MULT: Record<Difficulty, number> = { easy: Infinity, medium: 2.2, hard: 1.1, pro: 1 };
const MEDKIT_SKILL: Record<Difficulty, number> = { easy: -20, medium: -10, hard: 0, pro: 0 };
/** Rebuy money for after a death: pistol + a box of ammo. */
const INSURANCE = WEAPONS.pistol.price + 25;
/**
 * Clear of my own bunker (from its center): within SEAL.exitRadius of it while it's sealed starts the 10 s
 * escape countdown, so never hang around closer than this.
 */
const BUNKER_OUT = SEAL.exitRadius + 0.8;

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
  /** Skip the don't-step-toward-water check (climbing a tower in the tide). */
  raw?: boolean;
  /** Stay put on purpose (hiding behind cover): no dodging. */
  hold?: boolean;
  /** Hold this weapon for `shootAt` (e.g. a rocket at a steel plug). */
  weapon?: WeaponKind;
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
  /** Someone is shooting at me or close to me right now. */
  danger: boolean;
  /** Under fire (noticed): where it's coming from. */
  fire: Vec3 | null;
  /** Armed enemies in sight within fighting range. */
  armedNear: number;
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
  private strafeSign = 1;
  private strafeFlipAt = 0;
  private retreat: { from: Vec3; until: number } | null = null;
  private nextBuyAt = 0;
  private pendingBuy: { item: ShopItem; cash: number; at: number } | null = null;
  private buyFails = new Map<ShopItem, number>();
  private buyBlockedUntil = new Map<ShopItem, number>();
  private lastCoverAt = -Infinity;
  private towerYaw: number | null = null;
  private wander: { to: Vec3; until: number } | null = null;
  private lastNadeAt = -Infinity;
  private grid: { key: string; grid: BunkerGrid } | null = null;
  private hideFrom: { pos: Vec3; until: number } | null = null;
  private nadePlan: { yaw: number; pitch: number; until: number } | null = null;
  private view!: BotView;
  /** Strategy/tactics weights: the trained defaults with this bot's personality folded in. */
  readonly params: BotParams;
  private readonly brain: Brain;
  private lastOdds: number | null = null;
  readonly dodger: Dodger;
  private wasAlive = true;
  private lastEnemy: number | null = null;
  private peek: { out: boolean; until: number } = { out: false, until: 0 };
  private fireFrom: Vec3 | null = null;

  constructor(
    readonly id: number, readonly difficulty: Difficulty, private readonly rng: () => number, personality?: Personality,
    params: BotParams = DEFAULT_PARAMS,
  ) {
    this.personality = personality ?? rollPersonality(rng);
    this.t = this.personality.traits;
    const t = this.t;
    this.params = withTraits(params, t);
    this.brain = new Brain(rng);
    this.dodger = new Dodger(rng, DODGE_SKILL[difficulty]);
    this.style = {
      upgradeFirst: t.patience > 0.65,
      longGun: t.range > 0.75,
      closeGun: t.range < 0.3,
      metal: t.builder > 0.6,
      steel: t.patience > 0.75 && t.greed > 0.75,
      coverWood: t.builder > 0.6 ? 2 : 0,
      invest: t.patience > 0.75,
    };
    this.aim = new Aim(AIM[difficulty], rng);
  }

  get currentGoal(): Goal { return this.goal; }
  /** Rival this bot is currently going after (player id), if any. */
  get currentTarget(): number | null { return this.targetId; }
  /** Current brain goal (with reason and steps), or null before the first decision. */
  get currentPlan(): BrainGoal | null { return this.brain.goal; }
  /** Brain events seen so far (died, targetGone, ...). */
  get planEvents() { return this.brain.history; }
  /** Everything an on-screen debug overlay (or the training dashboard) wants to show about this bot. */
  get debug(): BotDebug {
    const g = this.brain.goal;
    const st = g && g.step < g.steps.length ? g.steps[g.step] : null;
    return {
      action: this.goal, goal: g?.kind ?? null, reason: g?.reason ?? '', step: st?.label ?? '',
      stepIndex: g ? g.step + 1 : 0, steps: g?.steps.length ?? 0, thought: this.brain.thought,
      target: this.targetId, underFire: this.fireFrom !== null, enemy: this.lastEnemy, fightOdds: this.lastOdds,
    };
  }

  think(view: BotView): PlayerInput {
    const me = view.self;
    if (me.id !== this.id) throw new Error(`Bot ${this.id} was given the view of player ${me.id}`);
    if (view.generators.length !== view.map.length || view.sealed.length !== view.map.length)
      throw new Error(`Bot ${this.id}: view has ${view.map.length} islands but ${view.generators.length} generators / ${view.sealed.length} seal flags`);
    const now = view.now;
    const dt = Number.isNaN(this.lastNow) ? DT : Math.min(0.25, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    this.mem.update(view);
    if (!me.alive) {
      if (this.wasAlive) this.brain.notify('died', now);
      this.wasAlive = false;
      this.fireFrom = null;
      this.aim.reset();
      this.stuckRef = null;
      this.retreat = null;
      this.pendingBuy = null;
      this.nadePlan = null;
      this.hideFrom = null;
      this.nextScoreAt = -Infinity;
      return { ...NO_INPUT, yaw: me.yaw, pitch: me.pitch };
    }
    this.wasAlive = true;
    this.view = view;
    this.nav.begin(view);
    this.checkPurchase(me, now);
    const rescore = now >= this.nextScoreAt;
    const facts = rescore ? this.rivalFacts(view) : null;
    if (facts) this.chooseTarget(facts);
    let ctx = this.context(view);
    if (facts) {
      // The brain: self-assess, choose a goal for a reason, break it into steps; its target overrides the plain rival choice.
      const inp = this.brainInput(ctx, facts);
      this.lastOdds = inp.enemy ? fightOdds(inp) : null;
      const goal = this.brain.update(inp, this.params, NOISE[this.difficulty] * 3);
      if (goal.target !== null && goal.target !== this.targetId) { this.targetId = goal.target; ctx = this.context(view); }
    }
    if (rescore) {
      const next = this.pick(ctx);
      if (next !== this.goal) this.hesitateUntil = now + HESITATE_SEC[this.difficulty] * (0.5 + this.rng());
      this.goal = next;
      this.nextScoreAt = now + RESCORE_SEC[this.difficulty] * (0.75 + 0.5 * this.rng());
    }
    if (this.retreat && now >= this.retreat.until) this.retreat = null;
    // Still deciding what to do next: stand and look around (fighting back still happens below).
    const thinking = now < this.hesitateUntil && !ctx.enemy && this.goal !== 'disengage';
    let act = this.retreat ? { dir: norm(flat(sub(me.pos, this.retreat.from))) } : thinking ? IDLE : this.act(this.goal, ctx);
    // Never hang around inside my own bunker (one plug per door and I'm sealed in): step out.
    if (!act.dir && this.goal !== 'defend' && !this.trapped(ctx) && insideBunker(ctx.home.bunker, me.pos)) act = { ...act, ...this.escape(ctx) };

    // Aim: enemies first, then whatever the goal wants to look or shoot at, else along the walk.
    const eye = eyePos(me);
    const cur: Angles = { yaw: me.yaw, pitch: me.pitch };
    let look: Angles = cur;
    let fire = false;
    const enemy = ctx.enemy;
    // Rockets: for a rival dug in behind cover or up on a structure (splash at their feet), and for hard plugs.
    const rocketAtEnemy = !!enemy && this.rocketTarget(ctx);
    const best = act.weapon && hasAmmo(me.inv, act.weapon) ? act.weapon
      : rocketAtEnemy ? 'rocket' : bestGun(me.inv, enemy ? ctx.enemyDist : 30);
    const gunReady = (range: number) => {
      const w = me.equipped;
      const ammo = w === 'fists' ? null : me.inv.weapons[w];
      return me.reloadUntil === 0 && me.busyUntil <= now && range <= WEAPONS[w].range * 0.95 && (w === 'fists' || !!ammo && ammo.mag > 0);
    };
    let throwGrenade = false;
    const nade = enemy || this.goal === 'disengage' ? null : this.grenadePlan(ctx);
    if (act.shootAt && act.shootFirst) {
      look = turnToward(cur, lookAt(eye, act.shootAt), TURN_RATE, dt);
      fire = angleBetween(look, lookAt(eye, act.shootAt)) < 0.05 && gunReady(dist2D(me.pos, act.shootAt));
    } else if (enemy) {
      const r = this.aim.track(now, dt, eye, add(enemy.pos, v3(0, rocketAtEnemy ? 0.15 : CHEST, 0)), enemy.id, cur);
      look = r;
      fire = r.ready && r.onTarget && gunReady(ctx.enemyDist);
    } else if (nade) {
      look = turnToward(cur, nade, TURN_RATE, dt);
      if (angleBetween(look, nade) < 0.03 && me.busyUntil <= now) {
        throwGrenade = true;
        this.lastNadeAt = now;
        this.nadePlan = null;
      }
    } else if (act.shootAt) {
      look = turnToward(cur, lookAt(eye, act.shootAt), TURN_RATE, dt);
      fire = angleBetween(look, lookAt(eye, act.shootAt)) < 0.05 && gunReady(dist2D(me.pos, act.shootAt));
    } else if (act.face) {
      look = turnToward(cur, lookAt(eye, act.face), TURN_RATE, dt);
    } else if (act.dir) {
      look = turnToward(cur, { yaw: yawOf(act.dir), pitch: 0 }, TURN_RATE, dt);
    }

    // Weapons: hold the best gun, reload when nobody is in sight.
    const ammo = me.equipped === 'fists' ? null : me.inv.weapons[me.equipped];
    const slot = best !== me.equipped && (me.reloadUntil === 0 || !ammo || ammo.mag === 0) ? best : null;
    if (slot) fire = false;
    const reload = !enemy && !slot && !!ammo && me.reloadUntil === 0 && ammo.spare > 0 && ammo.mag < WEAPONS[me.equipped].mag * 0.6;

    // Movement: stuck recovery, then never step toward water.
    let dir = act.dir;
    let jump = !!act.jump;
    this.trackStuck(now, me, dir !== null);
    if (now < this.unstickUntil) {
      dir = scale(right(look.yaw), this.unstickSide);
      jump = true;
    } else if (ctx.fire && this.mayDodge(act, ctx)) {
      // Under fire: strafe jukes across the shooter's line (and jump now and then), whatever else I'm doing.
      const j = this.dodger.juke(dir, me, ctx.fire, now, this.params);
      dir = j.dir;
      jump ||= j.jump;
    }
    if (dir && !act.raw) dir = this.nav.safeDir(dir);
    const move = dir
      ? { moveX: dir.x * right(look.yaw).x + dir.z * right(look.yaw).z, moveZ: dir.x * forward(look.yaw).x + dir.z * forward(look.yaw).z }
      : { moveX: 0, moveZ: 0 };

    // Patch up with a medkit when hurt and nobody is in my face (2 s with my hands busy).
    let select: number | null = null, useMedkit = false;
    const kit = me.hotbar.indexOf('medkit');
    if (kit >= 0 && me.inv.medkits > 0 && me.hp <= this.params.medkitHp + MEDKIT_SKILL[this.difficulty] && me.busyUntil <= now && me.healAt === null &&
        (!enemy || ctx.enemyDist > 30) && now - this.mem.lastHurtAt > 0.5) {
      select = kit; useMedkit = true; fire = false;
    }
    const interact = view.map.some((isl) => view.generators[isl.index] >= 1 && dist2D(me.pos, isl.generator) <= USE_RANGE);
    if (act.shop) this.pendingBuy = { item: act.shop, cash: me.inv.cash, at: now };
    const out = {
      ...NO_INPUT, ...move, yaw: look.yaw, pitch: look.pitch, jump,
      // Sprint travelling to a goal, closing in, or getting away; never while shooting (it spoils the aim), and
      // keep a little stamina back for an escape (when the movement code has stamina).
      sprint: !!act.sprint && !fire && (!enemy || this.goal === 'disengage' || this.goal === 'fight' || this.brain.goal?.kind === 'retreat') &&
        (staminaFrac(me) > 0.15 || this.goal === 'disengage'),
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
   * Jukes would wreck what I'm doing: placing a piece or charge, buying, banking, climbing the tide tower,
   * getting out of my own bunker. Low on health, a human drops the task and dodges anyway.
   */
  private mayDodge(act: Act, c: Ctx): boolean {
    if (act.raw || act.hold || this.retreat || this.goal === 'fleeTide' || this.trapped(c) || insideBunker(c.home.bunker, c.me.pos)) return false;
    const busy = !!(act.build || act.placeCharge || act.shop || act.vault) || this.goal === 'seal' || this.goal === 'bridge' || this.goal === 'defend';
    return !busy || c.me.hp < 100 * this.params.breakLosHp * 0.6;
  }

  /**
   * My target just respawned (seen spawn-protected, or died under 15 s ago and seen at/inside their bunker):
   * they're stuck at home with a pistol, so their doorways are the play, not their head.
   */
  private sealWindow(c: Ctx): boolean {
    const r = c.rival;
    if (!r || !r.alive || !c.rivalIsl) return false;
    const now = c.view.now;
    const seen = c.view.enemies.find((e) => e.id === r.id);
    if (seen && seen.invulnUntil > now) return true;
    const died = this.mem.diedAt.get(r.id);
    if (died === undefined || now - died > 15) return false;
    const s = this.mem.recent(r.id, now, 5);
    return !s || dist2D(s.pos, c.rivalIsl.bunker.center) < 8;
  }

  /** Two or fewer rivals left: only eliminations matter now. */
  private endgame(c: Ctx): boolean {
    return c.view.others.filter((o) => !o.eliminated && o.id !== c.me.id).length <= 2;
  }

  /** A visible rival worth a rocket: 10–45 m away (clear of my own blast) and behind cover or up on a structure. */
  private rocketTarget(c: Ctx): boolean {
    const e = c.enemy;
    if (!e || !hasAmmo(c.me.inv, 'rocket') || c.enemyDist < 10 || c.enemyDist > 45) return false;
    const isl = islandAt(c.view.map, e.pos);
    const high = isl >= 0 && e.pos.y - c.view.map[isl].groundY > 1.2;
    return high || c.view.pieces.some((p) => COVER_KINDS.has(p.kind) && dist2D(p.pos, e.pos) < 2.5);
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
    const map = this.view.map;
    const l = lane(map, from, to);
    const left = l.length - Math.sqrt(map[to].radius ** 2 - 9) - this.nav.frontier(l).s;
    return Math.max(1, Math.ceil(left / SCAFFOLD_STEP));
  }

  private rivalFacts(view: BotView): RivalFacts[] {
    const me = view.self, now = view.now;
    const home = me.island;
    const on = islandAt(view.map, me.pos);
    const src = on >= 0 ? on : home;
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
      };
    });
  }

  /** Score every rival; keep the current one unless another is clearly better. */
  private chooseTarget(facts: RivalFacts[]) {
    let best: number | null = null, bestScore = -Infinity, cur = -Infinity;
    for (const f of facts) {
      const s = rivalScore(f, this.params) + (this.rng() - 0.5) * NOISE[this.difficulty];
      if (f.id === this.targetId) cur = s;
      if (s > bestScore) { bestScore = s; best = f.id; }
    }
    if (best === null) { this.targetId = null; return; }
    if (cur > -Infinity && cur + commitment(this.params) >= bestScore) return;
    this.targetId = best;
  }

  /** What the brain gets to see (all from the view and my memory of it). */
  private brainInput(c: Ctx, facts: RivalFacts[]): BrainInput {
    const { view, me, home } = c;
    const now = view.now;
    const inv = me.inv;
    const killed = this.mem.killedBy;
    return {
      now, suddenDeath: view.suddenDeath, hp: me.hp / 100, home: home.index, on: c.on,
      rivals: facts.map((f) => {
        const o = view.others.find((x) => x.id === f.id)!;
        const isl = view.map[o.island];
        const guarded = o.alive && this.mem.recent(o.id, now, 6)?.island === o.island;
        const seen = view.enemies.find((e) => e.id === o.id);
        const died = this.mem.diedAt.get(o.id);
        const atHome = this.mem.recent(o.id, now, 5);
        const protectedNow = o.alive && (!!seen && seen.invulnUntil > now ||
          died !== undefined && now - died < 15 && (!atHome || dist2D(atHome.pos, isl.bunker.center) < 8));
        return {
          ...f, island: o.island, name: o.name || `#${o.id}`, generator: view.generators[o.island], guarded, protectedNow,
          openDoors: isl.bunker.doorways.filter((d) => !doorBlocked(view.pieces, d)).length,
        };
      }),
      gun: ownsGun(inv), upgraded: !!(inv.weapons.smg || inv.weapons.rifle || inv.weapons.shotgun),
      shield: (me.shield ?? 0) / 100, scaffolds: inv.pieces.scaffold ?? 0, medkits: inv.medkits,
      myWeapon: bestGun(inv, c.enemy ? c.enemyDist : 30),
      enemy: c.enemy ? { id: c.enemy.id, dist: c.enemyDist, hp: c.enemy.hp + (c.enemy.shield ?? 0), weapon: c.enemy.equipped } : null,
      armedNear: c.armedNear, underFire: !!c.fire,
      kit: sealKit(inv), carried: inv.cash, banked: me.vault.cash, insuranceDue: this.insuranceDue(me),
      nearVault: dist2D(me.pos, home.vault) < 6, canClearHome: this.blockers(c).every((p) => this.canClear(c, p)),
      bankable: Math.max(0, Math.floor(inv.cash - this.keepFor(c) - 25)),
      intruder: !!this.intruder(c), homeSealed: view.sealed[home.index], homePlugged: this.blockers(c).length > 0,
      incomingBridge: !!this.incomingDeck(c),
      killedBy: killed ? { id: killed.id, ago: now - killed.t } : null,
      seller: this.nearestSeller(c) !== null, wantShields: this.wantShields(me), endgame: this.endgame(c),
    };
  }

  /** Cash my shopping plan needs; with an enemy in sight only the essentials (no grenades/medkits shopping now). */
  private keepFor(c: Ctx): number {
    const needs = this.needs(c);
    if (c.enemy) { needs.grenades = 0; needs.medkits = 0; }
    return shoppingPlan(c.me, needs, this.difficulty, this.style).spent;
  }

  private wantShields(me: PlayerState): boolean {
    const n = (me.inv.potions?.shieldBig ?? 0) + (me.inv.potions?.shieldSmall ?? 0);
    return n < 2 && me.inv.cash + this.spendable(me) >= 300;
  }

  // ---------------------------------------------------------------- context

  private context(view: BotView): Ctx {
    const me = view.self;
    const home = view.map[me.island];
    if (!home) throw new Error(`Bot ${this.id}: island ${me.island} is not on the map`);
    const on = islandAt(view.map, me.pos);
    const src = on >= 0 ? on : home.index;
    let rival = this.targetId === null ? null : view.others.find((o) => o.id === this.targetId && !o.eliminated) ?? null;
    if (!rival) {
      this.targetId = null;
      rival = view.others
        .filter((o) => !o.eliminated && o.island !== me.island)
        .sort((a, b) => dist2D(view.map[a.island].center, home.center) - dist2D(view.map[b.island].center, home.center))[0] ?? null;
    }
    const rivalIsl = rival ? view.map[rival.island] : null;
    // Whom to shoot among those in sight: the one shooting me, the one nearly dead, my plan's target, the
    // nearest; keep the current one unless another is clearly better (focus fire).
    const P = this.params, now = view.now;
    let enemy: PlayerState | null = null, enemyDist = Infinity, bestScore = -Infinity, armedNear = 0;
    const shooter = this.mem.shotAtMe && now - this.mem.shotAtMe.t < 2 ? this.mem.shotAtMe.by : now - this.mem.lastHurtAt < 2 ? this.mem.lastHurtBy : null;
    for (const e of view.enemies) {
      // Spawn-protected players can't be hurt (visible on screen): don't waste shots, use the window to seal.
      if (!e.alive || e.invulnUntil > now) continue;
      const d = dist2D(e.pos, me.pos);
      if (e.equipped !== 'fists' && d < 35) armedNear++;
      const s = -d * P.tgtDist + (1 - e.hp / 100) * P.tgtLowHp + (e.id === shooter ? P.tgtShootingMe : 0) +
        (e.id === this.targetId ? P.tgtPlanTarget : 0) + (e.id === this.lastEnemy ? P.tgtKeep : 0) - (d > 60 ? 1 : 0);
      if (s > bestScore) { bestScore = s; enemy = e; enemyDist = d; }
    }
    this.lastEnemy = enemy?.id ?? null;
    const reach = !!rivalIsl && (on === rivalIsl.index || this.nav.hop(src, rivalIsl.index) !== null);
    const homeReach = on === home.index || on < 0 || this.nav.hop(on, home.index) !== null;
    const openDoors = rivalIsl ? rivalIsl.bunker.doorways.filter((d) => !doorBlocked(view.pieces, d)) : [];
    const danger = now - this.mem.lastHurtAt < 3 || (!!enemy && enemyDist < 40);
    const fire = this.dodger.threat(this.mem, now, P);
    this.fireFrom = fire;
    return { view, me, home, on, src, rival, rivalIsl, enemy, enemyDist, reach, homeReach, openDoors, danger, fire, armedNear };
  }

  private scaffoldsNeeded(c: Ctx): number {
    if (c.reach || !c.rivalIsl) return 0;
    return this.scaffoldsTo(c.home.index, c.rivalIsl.index);
  }

  private needs(c: Ctx): Needs {
    const total = c.me.inv.cash + c.me.vault.cash;
    const skilled = this.difficulty === 'hard' || this.difficulty === 'pro';
    return {
      scaffolds: this.scaffoldsNeeded(c),
      kit: c.openDoors.length,
      // A hard plug in my own doorway: only a charge gets through.
      charge: this.blockers(c).some((p) => isHard(p.kind)),
      // Every 1 m of tower buys 20 s against the tide: the richer, the taller.
      tower: c.view.now >= LIFECYCLE.suddenDeathAt - TOWER_PREP_SEC ? TOWER_BAGS + Math.min(4, Math.floor(total / 250)) : 0,
      grenades: total >= this.params.nadeRich * RICH_MULT[this.difficulty] ? (skilled ? 2 : 1) : 0,
      medkits: total >= this.params.nadeRich * RICH_MULT[this.difficulty] ? (skilled ? 2 : 1) : 0,
      steel: skilled && total >= this.params.steelRich,
      genLevel: c.view.genLevels?.[c.home.index],
    };
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

  /** Nearest potion seller I can walk to, or null. */
  private nearestSeller(c: Ctx): Vec3 | null {
    let best: Vec3 | null = null, bestD = Infinity;
    for (const s of c.view.potionShops ?? []) {
      const d = dist2D(s, c.me.pos);
      if (d >= bestD || c.view.groundAt(s.x, s.z) === null) continue;
      if (d < 3 || this.nav.routeTo(s)) { best = s; bestD = d; }
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
      if (i < 0 || i === c.home.index || c.view.generators[i] < this.params.raidAt) continue;
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
        if (s > bestS && s < l.length - Math.sqrt(map[home].radius ** 2 - 9) + 2) { bestS = s; best = p; }
      }
      if (best) return best;
    }
    return null;
  }

  // ---------------------------------------------------------------- utility

  private score(g: Goal, c: Ctx): number {
    const { view, me, home, t } = { ...c, t: this.t };
    const P = this.params;
    const away = c.on === home.index ? 0 : 0.25;
    const gun = ownsGun(me.inv);
    const hp = me.hp / 100;
    const rivalDown = !!c.rival && !c.rival.alive && c.rival.respawnAt !== null;
    const trapped = this.trapped(c);
    switch (g) {
      case 'fleeTide': {
        const g0 = view.groundAt(me.pos.x, me.pos.z) ?? me.pos.y;
        const up = c.on >= 0 && g0 - view.map[c.on].groundY > 0.6;
        if (!view.suddenDeath) {
          // Snipers take the high ground before sudden death and shoot from up there.
          if (t.range <= 0.7 || view.now < LIFECYCLE.suddenDeathAt - HIGH_GROUND_SEC) return 0;
          return up ? 1.6 : (me.inv.pieces.sandbags ?? 0) >= 4 && c.on >= 0 ? 1.0 : 0;
        }
        // Up on a tower: stay there (stepping off means a fall, then the tide).
        if (up || (c.on < 0 && g0 - view.waterY > 0.6)) return 1.6;
        return g0 - view.waterY < 2.5 || (me.inv.pieces.sandbags ?? 0) > 0 ? 1.2 : 0;
      }
      case 'fight': {
        if (!c.enemy) return 0;
        // Someone across the water gets shot at anyway (aim/fire layer on every goal); only drop
        // everything to fight when they're close or on the same island.
        const sameIsland = islandAt(view.map, c.enemy.pos) === islandAt(view.map, me.pos);
        if (!sameIsland && c.enemyDist > P.engageRange) return 0.2;
        return (gun || c.enemyDist < 8 ? 0.85 : 0.35) + 0.25 * t.aggression;
      }
      case 'disengage': {
        if (!c.enemy && view.now - this.mem.lastHurtAt > 1.5) return 0;
        const low = P.lowHp;
        if (hp < low) return 1.15 + (low - hp);
        // Unarmed vs a gun: back off only from one close enough to matter (not someone across the water).
        const outgunned = !gun && !!c.enemy && c.enemy.equipped !== 'fists' && c.enemyDist > 4 &&
          (c.enemyDist < Math.min(P.engageRange, WEAPONS[c.enemy.equipped].range) || view.now - this.mem.lastHurtAt < 1.5);
        if (outgunned) return 0.95 + 0.2 * t.caution;
        // Two or more guns on me at once: don't take that fight, especially hurt.
        if (c.armedNear >= 2) return 0.6 + P.outnumbered * (c.armedNear - 1) + (1 - hp) * 0.4;
        return 0;
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
        const low = P.healHp;
        return hp < low ? 0.75 + (low - hp) : 0;
      }
      case 'potions': {
        // Shields at a seller I can walk to, when I can afford them and nobody is on me.
        if (view.suddenDeath || c.enemy || !this.wantShields(me)) return 0;
        const s = this.nearestSeller(c);
        return s ? 0.25 + 0.1 * t.caution - dist2D(s, me.pos) / 150 : 0;
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
        const keep = this.keepFor(c) + 25;
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
        let s = stored >= P.collectAt ?0.45 + 0.1 * t.greed + Math.min(stored, 500) / 1000 : 0.15;
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
        // No kit while the rival is down / protected, or in the endgame: kills don't win, seals do.
        const kitShort = sealKit(me.inv) < Math.max(1, c.openDoors.length) && !view.suddenDeath;
        if (kitShort && (rivalDown || this.sealWindow(c) || this.endgame(c)) && plan.items.some((i) => i === 'wood' || i === 'metal' || i === 'steel'))
          return 0.95 - away;
        const urgent = plan.items.includes('pistol') || plan.items.includes('charge');
        return (urgent ? 0.75 : plan.items.length >= 3 || plan.covered ? 0.6 : 0) - away;
      }
      case 'bridge': {
        const have = me.inv.pieces.scaffold ?? 0;
        if (c.reach || !c.rivalIsl || have === 0) return 0;
        // Bridges are one-way (see Nav.bridge): don't finish one before carrying a full seal kit.
        const need = this.scaffoldsNeeded(c);
        if (need <= 1 && sealKit(me.inv) < c.openDoors.length) return 0;
        return 0.45 + 0.15 * t.aggression + (have >= need ? 0.1 : 0) + (this.endgame(c) && sealKit(me.inv) > 0 ? 0.2 : 0);
      }
      case 'attack': {
        if (!c.reach || !c.rival || view.suddenDeath && !c.enemy && !this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)) {
          return c.reach && view.suddenDeath ? 0.3 : 0;
        }
        // Respawn window with no kit: a kill that can't be followed by a seal is wasted (and respawns are
        // protected), so go get a kit rather than camp the door.
        if (rivalDown || this.sealWindow(c)) return sealKit(me.inv) === 0 && c.homeReach ? 0.1 : 0.3;
        if (!gun) return 0.1;
        const upgraded = !!(me.inv.weapons.smg || me.inv.weapons.rifle || me.inv.weapons.shotgun);
        return (0.3 + 0.25 * t.aggression - (upgraded ? 0 : 0.12 * t.patience)) * (0.5 + 0.5 * Math.max(hp, 1 - t.caution));
      }
      case 'seal': {
        const kit = sealKit(me.inv);
        if (view.suddenDeath || !c.reach || !c.rivalIsl || kit === 0 || !c.openDoors.length) return 0;
        const near = c.on === c.rivalIsl.index && dist2D(me.pos, c.rivalIsl.bunker.center) < 15;
        const ownerAway = !!c.rival && c.rival.alive && this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)?.island !== c.rival.island &&
          !!this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC);
        // Dead, respawning or spawn-protected rival: sealing now is an elimination; it beats every fight.
        const window = rivalDown || this.sealWindow(c);
        return (kit >= c.openDoors.length ? 0.6 : 0.3) + (window ? 1.0 + 0.3 * t.opportunism : 0) + (near ? 0.1 : 0) +
          (ownerAway ? 0.2 * t.opportunism : 0) + (this.endgame(c) ? 0.25 : 0);
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
        if (!bag) return 0;
        return 0.35 + 0.45 * t.greed + (gun ? 0 : 0.2) - dist2D(bag, me.pos) / 70;
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

  /**
   * Tick-level action: the brain's current step, unless a reflex interrupts it (the tide, being trapped, a fight
   * in my face, getting out of one I'd lose) or a quick errand is worth it on the way (cash about to cap, a loot bag).
   */
  private pick(c: Ctx): Goal {
    if (this.trapped(c)) return 'defend';
    const step = this.brain.stepAct;
    const retreating = this.brain.goal?.kind === 'retreat';
    let best: Goal = step ?? (c.homeReach || !c.reach ? 'collect' : 'attack'), bestScore = -Infinity;
    for (const g of GOALS) {
      if (g !== step && !REFLEXES.has(g)) continue;
      // Running from a fight I'd lose: only shoot back when cornered.
      if (g === 'fight' && retreating && c.enemyDist > 5) continue;
      // A step whose own situational score is nil (e.g. "heal up" while already home) still runs: walking home,
      // hanging around the generator or the target's door is harmless.
      const base = Math.max(this.score(g, c), g === step && SAFE_STEPS.has(g) ? 0.05 : 0);
      if (base <= 0 && g !== best) continue;
      const bias = GOAL_BIAS[g];
      const s = base + (bias ? this.params[bias] : 0) + (g === step ? STEP_BONUS + this.params.stepPush : 0) +
        (this.rng() - 0.5) * NOISE[this.difficulty] + (g === this.goal ? STICKY : 0);
      if (s > bestScore) { bestScore = s; best = g; }
    }
    return best;
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
      case 'potions': {
        const s = this.nearestSeller(c);
        if (!s) { this.nextScoreAt = c.view.now; return IDLE; }
        return this.goTo(s, USE_RANGE - 0.3);
      }
      case 'fight': return this.doFight(c);
      case 'disengage': return this.doDisengage(c);
      case 'fleeTide': return this.doFleeTide(c);
    }
  }

  // ---------------------------------------------------------------- actions

  /** Walk toward dest via the route planner; null dir once within `arrive` m (or when no route exists). */
  private goTo(dest: Vec3, arrive = ARRIVE): Act {
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
    const keep = this.keepFor(c) + 25;
    const cash = Math.max(Math.floor(me.inv.cash - keep), this.insuranceDue(me));
    if (cash <= 0) { this.nextScoreAt = c.view.now; return walk; }
    this.nextScoreAt = c.view.now + 1.2;
    return { ...walk, vault: { deposit: { cash } } };
  }

  private doBridge(c: Ctx): Act {
    if (!c.rivalIsl) return IDLE;
    const l = lane(c.view.map, c.home.index, c.rivalIsl.index);
    const f = this.nav.frontier(l);
    if (f.complete) { this.nextScoreAt = c.view.now; return IDLE; }
    if (this.scaffoldsNeeded(c) <= 1 && sealKit(c.me.inv) < c.openDoors.length) { this.nextScoreAt = c.view.now; return IDLE; }
    const stand = laneAt(l, f.s - 1.1);
    const walk = this.goTo(stand, ARRIVE);
    if (walk.dir) return walk;
    const ahead = laneAt(l, f.s + 4);
    if (c.me.busyUntil > c.view.now) return { dir: null, face: ahead };
    const rotY = yawOf(l.dir);
    // Butt the new deck against the end of the last one (it sits level with whatever its near end attaches to).
    for (const k of [2.0, 2.1, 2.2, 2.3, 2.4, 2.6]) {
      const p = laneAt(l, f.s + k);
      const pos = v3(p.x, c.me.pos.y, p.z);
      if (!c.view.canPlace('scaffold', pos, rotY).ok) continue;
      this.nav.invalidate();
      return { dir: null, face: ahead, build: { kind: 'scaffold', pos, rotY, free: true } };
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
      this.wander = { to: add(base, v3(Math.cos(a) * r, 0, Math.sin(a) * r)), until: now + 3 + this.rng() * 2 };
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
    if (isHard(target.kind) && hasAmmo(me.inv, 'rocket') && !inside) {
      // A rocket breaks even steel: fire from well outside its blast (and the escape-countdown radius).
      const center = v3(target.pos.x, target.pos.y + PIECES[target.kind].h / 2, target.pos.z);
      const walk = this.goTo(add(door.center, scale(forward(door.yaw), ROCKET.radius + 2.5)), 1.0);
      return walk.dir ? walk : { dir: null, shootAt: center, shootFirst: true, weapon: 'rocket' };
    }
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
    if (inv.charges > 0 || hasAmmo(inv, 'rocket')) return true;
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
      } else if (age > NADE_SEEN_SEC || age < 0.3 || d < this.params.nadeMin || d > this.params.nadeMax) continue;
      const a = throwAngles(eye, v3(s.pos.x, s.pos.y + 0.3, s.pos.z), low);
      if (!a) continue;
      // Thrown by hand: as accurate as this player's aim.
      const cone = AIM[this.difficulty].coneRad * (low ? 0.5 : 1);
      const r = this.rng() * cone, th = this.rng() * 2 * Math.PI;
      this.nadePlan = { yaw: a.yaw + Math.cos(th) * r, pitch: a.pitch + Math.sin(th) * r, until: now + 1.2 };
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
    if (!bag) { this.nextScoreAt = c.view.now; return IDLE; }
    return this.goTo(bag, 0.3);
  }

  private doRaid(c: Ctx): Act {
    const isl = this.raidIsland(c);
    if (!isl) { this.nextScoreAt = c.view.now; return IDLE; }
    return this.goTo(isl.generator, 1.5);
  }

  /** Best spot behind solid cover from enemy e within reach, or null. */
  private coverFrom(c: Ctx, e: PlayerState): Vec3 | null {
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
    const P = this.params;
    const want = PREFERRED_RANGE[gun] * P.rangeMult;
    const side = scale(right(yawOf(to)), this.strafeSign * (want < 2 ? 0.3 : 1));
    const sameIsland = islandAt(c.view.map, e.pos) === c.on;
    // Hurt and being hit: break line of sight first (behind the nearest solid thing), then peek back out.
    const breakLos = !!c.fire && me.hp < 100 * P.breakLosHp;

    // Careful players fight from behind something solid; builders throw a wall down if nothing is near.
    if (gun !== 'fists' && (c.enemyDist > 6 || breakLos) && (sameIsland || breakLos) && (t.caution > 0.5 || me.hp < P.coverHp || breakLos)) {
      const cover = this.coverFrom(c, e);
      if (cover && dist2D(cover, me.pos) > 0.8 && (breakLos || !this.peek.out)) return { ...this.goTo(cover, 0.6), sprint: breakLos };
      if (cover) {
        // In cover: alternate hiding and peeking out to shoot, with human-irregular timing.
        if (now >= this.peek.until) {
          this.peek.out = !this.peek.out && !breakLos;
          this.peek.until = now + (this.peek.out ? P.peekSec : P.hideSec) * (0.5 + this.rng());
        }
        return this.peek.out ? { dir: norm(side) } : { dir: null, hold: true };
      }
      const spare = TALL.reduce((n, k) => n + (me.inv.pieces[k] ?? 0), 0) - c.openDoors.length;
      if (t.builder > 0.5 && spare > 0 && now - this.lastCoverAt > 8 && me.busyUntil <= now) {
        const kind = TALL.slice().reverse().find((k) => (me.inv.pieces[k] ?? 0) > 0)!;
        const pos = add(me.pos, scale(to, 1.6));
        const rotY = yawOf(to);
        const blocksMyDoor = c.home.bunker.doorways.some((d) => dist2D(d.center, pos) < 2.5);
        if (!blocksMyDoor && c.view.canPlace(kind, pos, rotY).ok) {
          this.lastCoverAt = now;
          return { dir: null, build: { kind, pos, rotY, free: true } };
        }
      }
    }

    const gapM = c.enemyDist - want;
    const radial = Math.abs(gapM) < 2 ? 0 : Math.sign(gapM);
    const dir = add(scale(to, radial), side);
    // Well out of my range: sprint in to close (sprinting spoils aim, so not while in range).
    const closing = radial > 0 && gapM > 6;
    // Chasing across water needs a route; otherwise just strafe in place.
    if (radial > 0 && !sameIsland) {
      const wp = this.nav.routeTo(e.pos);
      if (wp) return { dir: norm(add(norm(flat(sub(wp, me.pos))), scale(side, 0.5))), sprint: closing };
      return { dir: norm(side) };
    }
    return { dir: norm(dir), sprint: closing };
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

  /**
   * Sudden death: climb. With sandbags, stack a staircase (place one ahead at my feet, hop onto it, repeat);
   * without, go to the highest piece around.
   */
  private doFleeTide(c: Ctx): Act {
    const { view, me } = c;
    const now = view.now;
    const step = view.pieces.find((p) => p.kind === 'sandbags' && dist2D(p.pos, me.pos) < 1.9 &&
      p.pos.y + PIECES.sandbags.h - me.pos.y > 0.6 && p.pos.y + PIECES.sandbags.h - me.pos.y < 1.3);
    if (step) return { dir: norm(flat(sub(step.pos, me.pos))), jump: true, raw: true, face: add(step.pos, v3(0, 1, 0)) };
    if ((me.inv.pieces.sandbags ?? 0) > 0) {
      // Start in the open middle of the island I'm on, away from walls.
      if (this.towerYaw === null && c.on >= 0 && dist2D(me.pos, view.map[c.on].center) > 3 && me.pos.y - view.map[c.on].groundY < 0.5) {
        const walk = this.goTo(view.map[c.on].center, 2.5);
        if (walk.dir) return walk;
      }
      if (me.busyUntil > now) return IDLE;
      const base = this.towerYaw ?? me.yaw;
      for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI])
        for (const d of [1.3, 1.1, 1.5]) {
          const yaw = base + turn;
          const pos = add(me.pos, scale(forward(yaw), d));
          const r = view.canPlace('sandbags', pos, yaw);
          if (!r.ok || Math.abs(r.pos.y - me.pos.y) > 0.35) continue;
          this.towerYaw = yaw;
          return { dir: null, face: add(pos, v3(0, 0.5, 0)), build: { kind: 'sandbags', pos, rotY: yaw, free: true } };
        }
    }
    const here = view.groundAt(me.pos.x, me.pos.z) ?? me.pos.y;
    let best: Vec3 | null = null, bestScore = here + 0.3;
    for (const p of view.pieces) {
      if (p.kind !== 'scaffold' && p.kind !== 'container' && p.kind !== 'sandbags') continue;
      const top = p.pos.y + PIECES[p.kind].h;
      const s = top - dist2D(p.pos, me.pos) * 0.02;
      if (s > bestScore) { bestScore = s; best = p.pos; }
    }
    const elevated = c.on >= 0 && here - view.map[c.on].groundY > 0.6;
    if (!best || elevated) return { dir: null, face: add(me.pos, forward(me.yaw)) };
    return this.goTo(best, 0.5);
  }

  private trackStuck(now: number, me: PlayerState, moving: boolean) {
    if (!moving || now < this.unstickUntil) { this.stuckRef = null; return; }
    if (!this.stuckRef) { this.stuckRef = { pos: clone(me.pos), t: now }; return; }
    if (now - this.stuckRef.t < STUCK_SEC) return;
    if (dist2D(me.pos, this.stuckRef.pos) < STUCK_DIST) {
      this.unstickUntil = now + UNSTICK_SEC;
      this.unstickSide = this.rng() < 0.5 ? -1 : 1;
      this.nextScoreAt = now + UNSTICK_SEC;
      this.wander = null;
    }
    this.stuckRef = { pos: clone(me.pos), t: now };
  }
}

const flat = (p: Vec3): Vec3 => v3(p.x, 0, p.z);

/** Sprint stamina as a fraction (1 until the movement code has stamina; 0..1 or 0..100 either way). */
function staminaFrac(p: PlayerState): number {
  const s = (p as { stamina?: number }).stamina;
  return s === undefined ? 1 : s > 1 ? s / 100 : s;
}

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
    const vx = GRENADE.throwSpeed * Math.cos(pitch), vy = GRENADE.throwSpeed * Math.sin(pitch) + 3;
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