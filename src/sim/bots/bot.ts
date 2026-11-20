import { DT, ECONOMY, PIECES, WEAPONS } from '../constants';
import { eyePos } from '../combat';
import type { Doorway, IslandLayout } from '../map';
import { NO_INPUT } from '../types';
import type { BuildRequest, Difficulty, PieceState, PlayerInput, PlayerState, ShopItem, Vec3, WeaponKind } from '../types';
import { add, clone, dist2D, forward, norm, right, scale, sub, v3, yawOf } from '../vec';
import { AIM, Aim, angleBetween, lookAt, turnToward, wrapAngle, type Angles } from './aim';
import { Nav, islandAt, lane, laneAt } from './nav';
import {
  bestGun, doorBlocked, doorPieces, isHard, nextPurchase, ownsGun, plugFor, plugSpot, sealKit, shoppingPlan, type Needs,
} from './plans';
import type { BotView, OtherStatus } from './view';

export type Goal = 'collect' | 'shop' | 'bridge' | 'attack' | 'seal' | 'defend' | 'fight' | 'fleeTide';

const RESCORE_SEC = 0.5;
const STICKY = 0.1;
const NOISE: Record<Difficulty, number> = { easy: 0.3, medium: 0.15, hard: 0.06 };
const BUY_GAP: Record<Difficulty, number> = { easy: 0.5, medium: 0.35, hard: 0.2 };
/** Chance an easy bot buys sandbags instead of the piece it meant to. */
const EASY_MISBUY = 0.1;
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

/** What a goal wants this tick; aiming at enemies, weapons and safety are layered on top by think(). */
type Act = {
  dir: Vec3 | null;
  face?: Vec3;
  shootAt?: Vec3;
  build?: BuildRequest;
  shop?: ShopItem;
  placeCharge?: boolean;
  sprint?: boolean;
};
const IDLE: Act = { dir: null };

type Ctx = {
  view: BotView;
  me: PlayerState;
  home: IslandLayout;
  on: number;
  rival: OtherStatus | null;
  rivalIsl: IslandLayout | null;
  enemy: PlayerState | null;
  enemyDist: number;
  reach: boolean;
  homeReach: boolean;
  openDoors: Doorway[];
};

export class Bot {
  private goal: Goal = 'collect';
  private nextScoreAt = -Infinity;
  private lastNow = NaN;
  private readonly aim: Aim;
  private readonly nav = new Nav();
  private stuckRef: { pos: Vec3; t: number } | null = null;
  private unstickUntil = -Infinity;
  private unstickSide = 1;
  private strafeSign = 1;
  private strafeFlipAt = 0;
  private retreat: { from: Vec3; until: number } | null = null;
  private nextBuyAt = 0;
  private wander: { to: Vec3; until: number } | null = null;
  private view!: BotView;

  constructor(readonly id: number, readonly difficulty: Difficulty, private readonly rng: () => number) {
    this.aim = new Aim(AIM[difficulty], rng);
  }

  get currentGoal(): Goal { return this.goal; }

  think(view: BotView): PlayerInput {
    const me = view.self;
    if (me.id !== this.id) throw new Error(`Bot ${this.id} was given the view of player ${me.id}`);
    if (view.generators.length !== view.map.length || view.sealed.length !== view.map.length)
      throw new Error(`Bot ${this.id}: view has ${view.map.length} islands but ${view.generators.length} generators / ${view.sealed.length} seal flags`);
    const now = view.now;
    const dt = Number.isNaN(this.lastNow) ? DT : Math.min(0.25, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    if (!me.alive) {
      this.aim.reset();
      this.stuckRef = null;
      this.retreat = null;
      this.nextScoreAt = -Infinity;
      return { ...NO_INPUT, yaw: me.yaw, pitch: me.pitch };
    }
    this.view = view;
    this.nav.begin(view);
    const ctx = this.context(view);
    if (now >= this.nextScoreAt) {
      this.goal = this.pick(ctx);
      this.nextScoreAt = now + RESCORE_SEC;
    }
    if (this.retreat && now >= this.retreat.until) this.retreat = null;
    const act = this.retreat ? { dir: norm(flat(sub(me.pos, this.retreat.from))) } : this.act(this.goal, ctx);

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
    let jump = false;
    this.trackStuck(now, me, dir !== null);
    if (now < this.unstickUntil) {
      dir = scale(right(look.yaw), this.unstickSide);
      jump = true;
    }
    if (dir) dir = this.nav.safeDir(dir);
    const move = dir
      ? { moveX: dir.x * right(look.yaw).x + dir.z * right(look.yaw).z, moveZ: dir.x * forward(look.yaw).x + dir.z * forward(look.yaw).z }
      : { moveX: 0, moveZ: 0 };

    const interact = view.map.some((isl) => view.generators[isl.index] >= 1 && dist2D(me.pos, isl.generator) <= USE_RANGE);
    return {
      ...NO_INPUT, ...move, yaw: look.yaw, pitch: look.pitch, jump, sprint: !!act.sprint && !enemy,
      fire, reload, interact, slot, build: act.build ?? null, shop: act.shop ? { buy: act.shop } : null,
      placeCharge: !!act.placeCharge,
    };
  }

  private context(view: BotView): Ctx {
    const me = view.self;
    const home = view.map[me.island];
    if (!home) throw new Error(`Bot ${this.id}: island ${me.island} is not on the map`);
    const on = islandAt(view.map, me.pos);
    const rival = view.others
      .filter((o) => !o.eliminated && o.island !== me.island)
      .sort((a, b) => dist2D(view.map[a.island].center, home.center) - dist2D(view.map[b.island].center, home.center))[0] ?? null;
    const rivalIsl = rival ? view.map[rival.island] : null;
    let enemy: PlayerState | null = null, enemyDist = Infinity;
    for (const e of view.enemies) {
      const d = dist2D(e.pos, me.pos);
      if (e.alive && d < enemyDist) { enemy = e; enemyDist = d; }
    }
    const reach = !!rivalIsl && (on === rivalIsl.index || !!this.nav.bridge(home.index, rivalIsl.index));
    const homeReach = on === home.index || on < 0 || !!this.nav.bridge(on, home.index);
    const openDoors = rivalIsl ? rivalIsl.bunker.doorways.filter((d) => !doorBlocked(view.pieces, d)) : [];
    return { view, me, home, on, rival, rivalIsl, enemy, enemyDist, reach, homeReach, openDoors };
  }

  private scaffoldsNeeded(c: Ctx): number {
    if (c.reach || !c.rivalIsl) return 0;
    const l = lane(c.view.map, c.home.index, c.rivalIsl.index);
    const left = l.length - Math.sqrt(c.rivalIsl.radius ** 2 - 9) - this.nav.frontier(l).s;
    return Math.max(1, Math.ceil(left / SCAFFOLD_STEP));
  }

  private needs(c: Ctx): Needs {
    const blockers = c.view.sealed[c.home.index] ? this.blockers(c) : [];
    return {
      scaffolds: this.scaffoldsNeeded(c),
      kit: c.openDoors.length,
      charge: blockers.some((p) => isHard(p.kind)),
    };
  }

  private score(g: Goal, c: Ctx): number {
    const { view, me, home } = c;
    const away = c.on === home.index ? 0 : 0.25;
    const gun = ownsGun(me.inv);
    const rivalDown = !!c.rival && !c.rival.alive && c.rival.respawnAt !== null;
    switch (g) {
      case 'fleeTide': {
        const g0 = view.groundAt(me.pos.x, me.pos.z) ?? me.pos.y;
        return view.suddenDeath && g0 - view.waterY < 2.5 ? 1.2 : 0;
      }
      case 'fight': {
        if (!c.enemy) return 0;
        // Someone across the water gets shot at anyway (aim/fire layer on every goal); only drop
        // everything to fight when they're close or on the same island.
        const sameIsland = islandAt(view.map, c.enemy.pos) === islandAt(view.map, me.pos);
        if (!sameIsland && c.enemyDist > ENGAGE_RANGE) return 0.2;
        return gun || c.enemyDist < 8 ? 1 : 0.4;
      }
      case 'defend':
        if (!view.sealed[home.index] || view.suddenDeath) return 0;
        return gun || me.inv.charges > 0 || this.blockers(c).some((p) => !isHard(p.kind)) ? 0.85 : 0.3;
      case 'collect': {
        if (!c.homeReach) return 0;
        const stored = view.generators[home.index];
        return (stored >= COLLECT_AT ? 0.5 + Math.min(stored, 500) / 1000 : 0.15) - away;
      }
      case 'shop': {
        if (!c.homeReach) return 0;
        const plan = shoppingPlan(me, this.needs(c), this.difficulty);
        if (!plan.items.length) return 0;
        if (dist2D(me.pos, home.shop) < 4) return 0.9;
        const urgent = plan.items.includes('pistol') || plan.items.includes('charge');
        return (urgent ? 0.75 : plan.items.length >= 3 || plan.covered ? 0.6 : 0) - away;
      }
      case 'bridge': {
        const have = me.inv.pieces.scaffold ?? 0;
        if (c.reach || !c.rivalIsl || have === 0) return 0;
        // Bridges are one-way (see Nav.bridge): don't finish one before carrying a full seal kit.
        const need = this.scaffoldsNeeded(c);
        if (need <= 1 && sealKit(me.inv) < c.openDoors.length) return 0;
        return 0.55 + (have >= need ? 0.1 : 0);
      }
      case 'attack':
        if (!c.reach || !c.rival) return 0;
        return rivalDown ? 0.3 : gun ? 0.45 : 0.1;
      case 'seal': {
        const kit = sealKit(me.inv);
        if (!c.reach || !c.rivalIsl || kit === 0 || !c.openDoors.length) return 0;
        const near = c.on === c.rivalIsl.index && dist2D(me.pos, c.rivalIsl.bunker.center) < 15;
        return (kit >= c.openDoors.length ? 0.6 : 0.3) + (rivalDown ? 0.3 : 0) + (near ? 0.1 : 0);
      }
    }
  }

  private pick(c: Ctx): Goal {
    const goals: Goal[] = ['fleeTide', 'fight', 'defend', 'seal', 'attack', 'bridge', 'shop', 'collect'];
    let best: Goal = c.homeReach || !c.reach ? 'collect' : 'attack', bestScore = -Infinity;
    for (const g of goals) {
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
      case 'bridge': return this.doBridge(c);
      case 'attack': return this.doAttack(c);
      case 'seal': return this.doSeal(c);
      case 'defend': return this.doDefend(c);
      case 'fight': return this.doFight(c);
      case 'fleeTide': return this.doFleeTide(c);
    }
  }

  /** Walk toward dest via the route planner; null dir once within `arrive` m (or when no route exists). */
  private goTo(dest: Vec3, arrive = ARRIVE): Act {
    const self = this.view.self;
    if (dist2D(self.pos, dest) <= arrive) return IDLE;
    const wp = this.nav.routeTo(dest);
    if (!wp) { this.nextScoreAt = this.view.now; return IDLE; }
    return { dir: norm(flat(sub(wp, self.pos))), sprint: dist2D(self.pos, dest) > 6 && islandAt(this.view.map, self.pos) >= 0 };
  }

  private doShop(c: Ctx): Act {
    const walk = this.goTo(c.home.shop, 2.0);
    if (dist2D(c.me.pos, c.home.shop) > USE_RANGE || c.view.now < this.nextBuyAt) return walk;
    let item = nextPurchase(c.me, this.needs(c), this.difficulty);
    if (!item) { this.nextScoreAt = c.view.now; return walk; }
    if (this.difficulty === 'easy' && item in PIECES && item !== 'scaffold' && this.rng() < EASY_MISBUY && c.me.inv.cash >= PIECES.sandbags.price) item = 'sandbags';
    this.nextBuyAt = c.view.now + BUY_GAP[this.difficulty];
    return { ...walk, shop: item };
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
    if (!c.rivalIsl) return IDLE;
    const b = c.rivalIsl.bunker;
    const now = c.view.now;
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
    if (fists && isHard(target.kind)) { this.nextScoreAt = c.view.now; return IDLE; }
    const spot = inside ? c.home.bunker.center : add(door.center, scale(forward(door.yaw), fists ? 1.4 : 3));
    const walk = this.goTo(spot, fists ? 0.3 : 1.0);
    return walk.dir ? walk : { dir: null, shootAt: center };
  }

  private doFight(c: Ctx): Act {
    const e = c.enemy;
    if (!e) return IDLE;
    const now = c.view.now;
    if (now >= this.strafeFlipAt) {
      this.strafeSign = this.rng() < 0.5 ? -1 : 1;
      this.strafeFlipAt = now + 0.6 + this.rng() * 0.8;
    }
    const to = norm(flat(sub(e.pos, c.me.pos)));
    const want = PREFERRED_RANGE[bestGun(c.me.inv, c.enemyDist)];
    const gapM = c.enemyDist - want;
    const radial = Math.abs(gapM) < 2 ? 0 : Math.sign(gapM);
    const side = scale(right(yawOf(to)), this.strafeSign * (want < 2 ? 0.3 : 1));
    const dir = add(scale(to, radial), side);
    // Chasing across water needs a route; otherwise just strafe in place.
    if (radial > 0 && islandAt(c.view.map, e.pos) !== c.on) {
      const wp = this.nav.routeTo(e.pos);
      if (wp) return { dir: norm(add(norm(flat(sub(wp, c.me.pos))), scale(side, 0.5))) };
      return { dir: norm(side) };
    }
    return { dir: norm(dir) };
  }

  private doFleeTide(c: Ctx): Act {
    const { view, me } = c;
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
