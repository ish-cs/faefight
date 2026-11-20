import { DT, ECONOMY, LIFECYCLE, PIECES, WEAPONS } from '../constants';
import { eyePos } from '../combat';
import type { Doorway, IslandLayout } from '../map';
import { NO_INPUT } from '../types';
import type {
  BuildRequest, Difficulty, PieceState, PlayerInput, PlayerState, ShopItem, VaultAction, Vec3, WeaponKind,
} from '../types';
import { add, clone, dist2D, forward, norm, right, scale, sub, v3, yawOf } from '../vec';
import { AIM, Aim, angleBetween, lookAt, turnToward, wrapAngle, type Angles } from './aim';
import { Memory, commitment, rivalScore, type RivalFacts, type Sighting } from './mind';
import { Nav, islandAt, lane, laneAt, laneS, type Lane } from './nav';
import { rollPersonality, type Personality, type Traits } from './personality';
import {
  TALL, bestGun, doorBlocked, doorPieces, isHard, nextPurchase, ownsGun, plugFor, plugSpot, sealKit, shoppingPlan,
  type Needs, type ShopStyle,
} from './plans';
import type { BotView, OtherStatus } from './view';

export type Goal =
  | 'collect' | 'shop' | 'bank' | 'bridge' | 'attack' | 'seal' | 'defend' | 'guard' | 'cut' | 'loot' | 'raid'
  | 'fight' | 'disengage' | 'fleeTide';
const GOALS: Goal[] = [
  'fleeTide', 'defend', 'disengage', 'fight', 'guard', 'bank', 'seal', 'attack', 'cut', 'raid', 'loot', 'bridge', 'shop', 'collect',
];

/** How often a bot reconsiders what to do, and how long it hesitates after changing plans (human thinking time). */
const RESCORE_SEC: Record<Difficulty, number> = { easy: 1.6, medium: 1.0, hard: 0.6 };
const HESITATE_SEC: Record<Difficulty, number> = { easy: 1.2, medium: 0.6, hard: 0.25 };
const STICKY = 0.1;
const NOISE: Record<Difficulty, number> = { easy: 0.3, medium: 0.15, hard: 0.06 };
const BUY_GAP: Record<Difficulty, number> = { easy: 3, medium: 1.5, hard: 0.8 };
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
const PREFERRED_RANGE: Record<WeaponKind, number> = { fists: 1.2, shotgun: 6, smg: 12, pistol: 16, rifle: 25 };
/** Memory horizons: an intruder seen on my island, a rival's whereabouts. */
const INTRUDER_SEC = 8, WHEREABOUTS_SEC = 20;
const LOOT_RANGE = 35;
const RAID_AT = 60;
/** Sandbags carried into sudden death to climb above the tide, bought in the last minutes before it. */
const TOWER_BAGS = 10, TOWER_PREP_SEC = 150;
const COVER_KINDS = new Set(['wood', 'metal', 'steel', 'container']);

/** What a goal wants this tick; aiming at enemies, weapons and safety are layered on top by think(). */
type Act = {
  dir: Vec3 | null;
  face?: Vec3;
  shootAt?: Vec3;
  build?: BuildRequest;
  shop?: ShopItem;
  vault?: VaultAction;
  placeCharge?: boolean;
  sprint?: boolean;
  jump?: boolean;
  /** Skip the don't-step-toward-water check (climbing a tower in the tide). */
  raw?: boolean;
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
  private view!: BotView;

  constructor(readonly id: number, readonly difficulty: Difficulty, private readonly rng: () => number, personality?: Personality) {
    this.personality = personality ?? rollPersonality(rng);
    this.t = this.personality.traits;
    const t = this.t;
    this.style = {
      upgradeFirst: t.patience > 0.65,
      longGun: t.range > 0.75,
      closeGun: t.range < 0.3,
      metal: t.builder > 0.6,
      steel: t.patience > 0.75 && t.greed > 0.75,
      coverWood: t.builder > 0.6 ? 2 : 0,
    };
    this.aim = new Aim(AIM[difficulty], rng);
  }

  get currentGoal(): Goal { return this.goal; }
  /** Rival this bot is currently going after (player id), if any. */
  get currentTarget(): number | null { return this.targetId; }

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
      this.aim.reset();
      this.stuckRef = null;
      this.retreat = null;
      this.pendingBuy = null;
      this.nextScoreAt = -Infinity;
      return { ...NO_INPUT, yaw: me.yaw, pitch: me.pitch };
    }
    this.view = view;
    this.nav.begin(view);
    this.checkPurchase(me, now);
    if (now >= this.nextScoreAt) this.chooseTarget(view);
    const ctx = this.context(view);
    if (now >= this.nextScoreAt) {
      const next = this.pick(ctx);
      if (next !== this.goal) this.hesitateUntil = now + HESITATE_SEC[this.difficulty] * (0.5 + this.rng());
      this.goal = next;
      this.nextScoreAt = now + RESCORE_SEC[this.difficulty] * (0.75 + 0.5 * this.rng());
    }
    if (this.retreat && now >= this.retreat.until) this.retreat = null;
    // Still deciding what to do next: stand and look around (fighting back still happens below).
    const thinking = now < this.hesitateUntil && !ctx.enemy && this.goal !== 'disengage';
    const act = this.retreat ? { dir: norm(flat(sub(me.pos, this.retreat.from))) } : thinking ? IDLE : this.act(this.goal, ctx);

    // Aim: enemies first, then whatever the goal wants to look or shoot at, else along the walk.
    const eye = eyePos(me);
    const cur: Angles = { yaw: me.yaw, pitch: me.pitch };
    let look: Angles = cur;
    let fire = false;
    const enemy = ctx.enemy;
    const best = bestGun(me.inv, enemy ? ctx.enemyDist : 30);
    const gunReady = (range: number) => {
      const w = me.equipped;
      const ammo = w === 'fists' ? null : me.inv.weapons[w];
      return me.reloadUntil === 0 && me.busyUntil <= now && range <= WEAPONS[w].range * 0.95 && (w === 'fists' || !!ammo && ammo.mag > 0);
    };
    if (enemy) {
      const r = this.aim.track(now, dt, eye, add(enemy.pos, v3(0, CHEST, 0)), enemy.id, cur);
      look = r;
      fire = r.ready && r.onTarget && gunReady(ctx.enemyDist);
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
    }
    if (dir && !act.raw) dir = this.nav.safeDir(dir);
    const move = dir
      ? { moveX: dir.x * right(look.yaw).x + dir.z * right(look.yaw).z, moveZ: dir.x * forward(look.yaw).x + dir.z * forward(look.yaw).z }
      : { moveX: 0, moveZ: 0 };

    const interact = view.map.some((isl) => view.generators[isl.index] >= 1 && dist2D(me.pos, isl.generator) <= USE_RANGE);
    if (act.shop) this.pendingBuy = { item: act.shop, cash: me.inv.cash, at: now };
    return {
      ...NO_INPUT, ...move, yaw: look.yaw, pitch: look.pitch, jump,
      sprint: !!act.sprint && (!enemy || this.goal === 'disengage'),
      fire, reload, interact, slot, build: act.build ?? null, shop: act.shop ? { buy: act.shop } : null,
      vault: act.vault ?? null, placeCharge: !!act.placeCharge,
    };
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
  private chooseTarget(view: BotView) {
    let best: number | null = null, bestScore = -Infinity, cur = -Infinity;
    for (const f of this.rivalFacts(view)) {
      const s = rivalScore(f, this.t) + (this.rng() - 0.5) * NOISE[this.difficulty];
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
    const src = on >= 0 ? on : home.index;
    let rival = this.targetId === null ? null : view.others.find((o) => o.id === this.targetId && !o.eliminated) ?? null;
    if (!rival) {
      this.targetId = null;
      rival = view.others
        .filter((o) => !o.eliminated && o.island !== me.island)
        .sort((a, b) => dist2D(view.map[a.island].center, home.center) - dist2D(view.map[b.island].center, home.center))[0] ?? null;
    }
    const rivalIsl = rival ? view.map[rival.island] : null;
    let enemy: PlayerState | null = null, enemyDist = Infinity;
    for (const e of view.enemies) {
      const d = dist2D(e.pos, me.pos);
      if (e.alive && d < enemyDist) { enemy = e; enemyDist = d; }
    }
    const reach = !!rivalIsl && (on === rivalIsl.index || this.nav.hop(src, rivalIsl.index) !== null);
    const homeReach = on === home.index || on < 0 || this.nav.hop(on, home.index) !== null;
    const openDoors = rivalIsl ? rivalIsl.bunker.doorways.filter((d) => !doorBlocked(view.pieces, d)) : [];
    const danger = view.now - this.mem.lastHurtAt < 3 || (!!enemy && enemyDist < 40);
    return { view, me, home, on, src, rival, rivalIsl, enemy, enemyDist, reach, homeReach, openDoors, danger };
  }

  private scaffoldsNeeded(c: Ctx): number {
    if (c.reach || !c.rivalIsl) return 0;
    return this.scaffoldsTo(c.home.index, c.rivalIsl.index);
  }

  private needs(c: Ctx): Needs {
    const blockers = c.view.sealed[c.home.index] ? this.blockers(c) : [];
    return {
      scaffolds: this.scaffoldsNeeded(c),
      kit: c.openDoors.length,
      charge: blockers.some((p) => isHard(p.kind)),
      tower: c.view.now >= LIFECYCLE.suddenDeathAt - TOWER_PREP_SEC ? TOWER_BAGS : 0,
    };
  }

  /** Shopping plan counting what's in the vault too (it can be withdrawn on the way). */
  private plan(c: Ctx) {
    const me = c.me;
    const total = { ...me, inv: { ...me.inv, cash: me.inv.cash + me.vault.cash } };
    return shoppingPlan(total, this.needs(c), this.difficulty, this.style);
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
        if (s > bestS && s < l.length - Math.sqrt(map[home].radius ** 2 - 9) + 2) { bestS = s; best = p; }
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
    const trapped = me.breakoutUntil !== null;
    switch (g) {
      case 'fleeTide': {
        const g0 = view.groundAt(me.pos.x, me.pos.z) ?? me.pos.y;
        if (!view.suddenDeath) return 0;
        return g0 - view.waterY < 2.5 || (me.inv.pieces.sandbags ?? 0) > 0 ? 1.2 : 0;
      }
      case 'fight': {
        if (!c.enemy) return 0;
        // Someone across the water gets shot at anyway (aim/fire layer on every goal); only drop
        // everything to fight when they're close or on the same island.
        const sameIsland = islandAt(view.map, c.enemy.pos) === islandAt(view.map, me.pos);
        if (!sameIsland && c.enemyDist > ENGAGE_RANGE) return 0.2;
        return (gun || c.enemyDist < 8 ? 0.85 : 0.35) + 0.25 * t.aggression;
      }
      case 'disengage': {
        if (!c.enemy && view.now - this.mem.lastHurtAt > 1.5) return 0;
        const low = 0.25 + 0.35 * t.caution - 0.15 * t.aggression;
        if (hp < low) return 1.15 + (low - hp);
        const outgunned = !gun && !!c.enemy && c.enemy.equipped !== 'fists' && c.enemyDist > 4;
        return outgunned ? 0.95 + 0.2 * t.caution : 0;
      }
      case 'defend':
        if (trapped) return 2;
        if (!view.sealed[home.index] || view.suddenDeath) return 0;
        return (gun || me.inv.charges > 0 || this.blockers(c).some((p) => !isHard(p.kind)) ? 0.85 : 0.3) + 0.1 * t.caution;
      case 'guard': {
        if (!c.homeReach || view.suddenDeath) return 0;
        const s = this.intruder(c);
        if (!s) return 0;
        const fresh = 1 - (view.now - s.t) / INTRUDER_SEC;
        return (0.4 + 0.45 * t.caution) * (0.5 + 0.5 * fresh) + (gun ? 0.1 : -0.2);
      }
      case 'bank': {
        if (c.on !== home.index || view.suddenDeath || me.inv.cash < 100) return 0;
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
        return (stored >= COLLECT_AT ? 0.45 + 0.1 * t.greed + Math.min(stored, 500) / 1000 : 0.15) - away;
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
        if (c.reach || !c.rivalIsl || have === 0) return 0;
        // Bridges are one-way (see Nav.bridge): don't finish one before carrying a full seal kit.
        const need = this.scaffoldsNeeded(c);
        if (need <= 1 && sealKit(me.inv) < c.openDoors.length) return 0;
        return 0.45 + 0.15 * t.aggression + (have >= need ? 0.1 : 0);
      }
      case 'attack': {
        if (!c.reach || !c.rival || view.suddenDeath && !c.enemy && !this.mem.recent(c.rival.id, view.now, WHEREABOUTS_SEC)) {
          return c.reach && view.suddenDeath ? 0.3 : 0;
        }
        if (rivalDown) return 0.3;
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
        return (kit >= c.openDoors.length ? 0.6 : 0.3) + (rivalDown ? 0.5 + 0.3 * t.opportunism : 0) + (near ? 0.1 : 0) +
          (ownerAway ? 0.2 * t.opportunism : 0);
      }
      case 'cut': {
        if (!gun || c.on !== home.index || view.suddenDeath) return 0;
        const deck = this.incomingDeck(c);
        if (!deck) return 0;
        const threat = this.intruder(c) ? 0.3 : 0;
        return 0.15 + 0.5 * t.builder * t.caution + threat - (c.rival && c.reach ? 0.2 * t.aggression : 0);
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

  private pick(c: Ctx): Goal {
    let best: Goal = c.homeReach || !c.reach ? 'collect' : 'attack', bestScore = -Infinity;
    for (const g of GOALS) {
      const base = this.score(g, c);
      if (base <= 0 && g !== best) continue;
      const s = base + (this.rng() - 0.5) * NOISE[this.difficulty] + (g === this.goal ? STICKY : 0);
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
    const wp = this.nav.routeTo(dest);
    if (!wp) { this.nextScoreAt = this.view.now; return IDLE; }
    return { dir: norm(flat(sub(wp, self.pos))), sprint: dist2D(self.pos, dest) > 6 && islandAt(this.view.map, self.pos) >= 0 };
  }

  private doShop(c: Ctx): Act {
    const me = c.me, now = c.view.now;
    // Short of cash for the plan but some is in the vault: fetch it first.
    const plan = this.plan(c);
    const short = Math.min(me.vault.cash, plan.spent - me.inv.cash);
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
    const cash = Math.floor(me.inv.cash - keep);
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
    const target = this.blockers(c)[0];
    if (!target) { this.nextScoreAt = c.view.now; return IDLE; }
    const door = c.home.bunker.doorways.find((d) => doorPieces(c.view.pieces, d).includes(target));
    if (!door) throw new Error(`Bot ${this.id}: blocker ${target.id} matches no doorway`);
    const center = v3(target.pos.x, target.pos.y + PIECES[target.kind].h / 2, target.pos.z);
    const inside = dist2D(c.me.pos, c.home.bunker.center) < 2;
    if (isHard(target.kind) && c.me.inv.charges > 0) {
      const spot = add(door.center, scale(forward(door.yaw), inside ? -1.2 : 1.6));
      const walk = this.goTo(spot, 0.4);
      if (walk.dir) return walk;
      const facing = Math.abs(wrapAngle(c.me.yaw - lookAt(eyePos(c.me), center).yaw)) < 0.1;
      if (facing) this.retreat = { from: center, until: c.view.now + 3.5 };
      return { dir: null, face: center, placeCharge: facing };
    }
    const fists = !ownsGun(c.me.inv);
    // Trapped inside with nothing else to try: punch anyway (a human would).
    if (fists && isHard(target.kind) && c.me.breakoutUntil === null) { this.nextScoreAt = c.view.now; return IDLE; }
    const spot = inside ? c.home.bunker.center : add(door.center, scale(forward(door.yaw), fists ? 1.4 : 3));
    const walk = this.goTo(spot, fists ? 0.3 : 1.0);
    return walk.dir ? walk : { dir: null, shootAt: center };
  }

  /** Someone was seen on my island: get back to the bunker front and watch where they were. */
  private doGuard(c: Ctx): Act {
    const s = this.intruder(c);
    if (!s) { this.nextScoreAt = c.view.now; return IDLE; }
    const b = c.home.bunker;
    const post = add(b.center, scale(norm(flat(sub(s.pos, b.center))), 4.5));
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
    return walk.dir ? walk : { dir: null, shootAt: center };
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
    if (c.on >= 0) consider(c.view.map[c.on].bunker.center, 2.6);
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
    const want = PREFERRED_RANGE[gun] * (0.8 + 0.5 * t.range);
    const side = scale(right(yawOf(to)), this.strafeSign * (want < 2 ? 0.3 : 1));
    const sameIsland = islandAt(c.view.map, e.pos) === c.on;

    // Careful players fight from behind something solid; builders throw a wall down if nothing is near.
    if (gun !== 'fists' && c.enemyDist > 6 && sameIsland && (t.caution > 0.5 || me.hp < 60)) {
      const cover = this.coverFrom(c, e);
      if (cover && dist2D(cover, me.pos) > 0.8) return this.goTo(cover, 0.6);
      if (cover) return { dir: scale(side, 0.4) };
      const spare = TALL.reduce((n, k) => n + (me.inv.pieces[k] ?? 0), 0) - c.openDoors.length;
      if (t.builder > 0.5 && spare > 0 && now - this.lastCoverAt > 8 && me.busyUntil <= now) {
        const kind = TALL.slice().reverse().find((k) => (me.inv.pieces[k] ?? 0) > 0)!;
        const pos = add(me.pos, scale(to, 1.6));
        const rotY = yawOf(to);
        if (c.view.canPlace(kind, pos, rotY).ok) {
          this.lastCoverAt = now;
          return { dir: null, build: { kind, pos, rotY, free: true } };
        }
      }
    }

    const gapM = c.enemyDist - want;
    const radial = Math.abs(gapM) < 2 ? 0 : Math.sign(gapM);
    const dir = add(scale(to, radial), side);
    // Chasing across water needs a route; otherwise just strafe in place.
    if (radial > 0 && !sameIsland) {
      const wp = this.nav.routeTo(e.pos);
      if (wp) return { dir: norm(add(norm(flat(sub(wp, me.pos))), scale(side, 0.5))) };
      return { dir: norm(side) };
    }
    return { dir: norm(dir) };
  }

  /** Back off from whoever is hurting me: home to the bunker if that isn't toward them, else straight away. */
  private doDisengage(c: Ctx): Act {
    const me = c.me;
    const from = c.enemy?.pos ?? (this.mem.lastHurtBy !== null ? this.mem.recent(this.mem.lastHurtBy, c.view.now, 5)?.pos : undefined);
    if (!from) { this.nextScoreAt = c.view.now; return IDLE; }
    const away = norm(flat(sub(me.pos, from)));
    if (c.homeReach) {
      const home = this.goTo(c.home.bunker.center, 1.5);
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
    if (!best) return { dir: null, face: add(me.pos, forward(me.yaw)) };
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
const laneOff = (l: Lane, p: Vec3) => Math.abs((p.x - l.origin.x) * l.dir.z - (p.z - l.origin.z) * l.dir.x);