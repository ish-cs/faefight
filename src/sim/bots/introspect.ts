/**
 * Read-only bot introspection for spectators (the "brain inspector").
 *
 * Nothing here may change what a bot decides: no rng draws, no writes to bot state. Helpers that touch the
 * navigator's caches run inside `sandbox()`, which puts those caches back exactly as they were. A bot only
 * carries a probe while someone spectates it (Bot.watch), so unwatched bots pay nothing beyond the
 * goal-switch log (one small entry per switch).
 *
 * Player references inside text are written `@<id>` and turned into names by the client.
 */
import { AMMO_BOX, CHARGE, GRAPPLE, GRENADE, MEDKIT, PIECES, POTIONS, TRAP, WEAPONS } from '../constants';
import type { Doorway, IslandLayout } from '../map';
import type { Difficulty, Inventory, PieceKind, PieceState, PlayerState, ShopItem, Vec3, WeaponKind } from '../types';
import { dist2D } from '../vec';
import type { AimProfile, Angles } from './aim';
import type { Bot, Goal } from './bot';
import { rivalScore, type Memory, type RivalFacts, type Sighting } from './mind';
import { hpHealsHeld } from './heal';
import { islandAt } from './nav';
import type { Traits } from './personality';
import { BUILD_TUNING as BT } from './build';
import type { BotParams } from './params';
import { GUNS, ownsGun, plugFor, plugSpot, sealKit, type Needs, type ShopStyle } from './plans';
import type { AllyStatus, BotView, OtherStatus } from './view';

/**
 * One goal's line in the utility table: `raw` from Bot.score, `base` after Bot.drive (the win-seeking push of
 * medium+ bots), plus decision noise and the stickiness bonus.
 */
export type ScoreRow = { goal: Goal; raw?: number; base: number; noise: number; sticky: number; score: number };
export type GoalSwitch = { t: number; from: Goal; to: Goal; why: string };

/** Compact, JSON-friendly digest (also what goes over the wire to a spectating guest). */
export type BrainDigest = {
  id: number; t: number; arch: string; diff: Difficulty;
  /** Traits 0..100 in TRAIT_KEYS order. */
  traits: number[];
  goal: Goal; step: string; why: string;
  /** Still hesitating after a change of plan. */
  thinking: boolean;
  /** Seconds until the next re-score; seconds since the last one (null: no decision seen yet). */
  next: number; decidedAgo: number | null;
  /** [goal, score, base, factors [label, value][], gate (why it scores 0)]. Best first. */
  scores: [Goal, number, number, [string, number][], string?][];
  /** Goal switches, newest first: [t, from, to, why]. */
  log: [number, Goal, Goal, string][];
  /** Enemies it knows of: [id, ageSec (0 = in sight now), x, y, z, hp, armed 0/1]. */
  seen: [number, number, number, number, number, number, number][];
  /** Who hurt it lately: [id (-1 = environment), damage, secAgo]. Grudges: [id, amount]. */
  hurt: [number, number, number][];
  grudge: [number, number][];
  target: { id: number; why: string } | null;
  /** Pushing a dead rival's bunker in their respawn window: [id, seconds left], or null. */
  window: [number, number] | null;
  /** Teams match: its role (defender stays home, the rest push) and the teammates going after the same target. */
  team?: { role: 'defend' | 'push'; focus: number[]; lead?: number };
  /** Rivals as it weighs them: [id, score]. */
  rivals: [number, number][];
  plan: string[]; planAt: number;
  shop: { items: ShopItem[]; why: string; cost: number } | null;
  build: { kind: PieceKind; x: number; y: number; z: number; rotY: number; why: string } | null;
  /** Grappling hook: on a rope now, or its last use (a few seconds), or what it carries it for; absent when none. */
  hook?: string;
  /** Healing intent (heal.ts): the last heal decision (a few seconds), else heals carried vs the stock it wants. */
  heal?: string;
  /** Weapon it wants in hand and why ("rocket: reload it between fights"); absent when dead or not yet decided. */
  weapon?: string;
  /** Route ahead: [x, y, z] points from its feet. */
  path: [number, number, number][];
  /** Where it's aiming / shooting at, and whether it fired this tick. */
  aim: [number, number, number] | null; fire: boolean;
  st: {
    hp: number; sh: number; sta: number; cash: number; vault: number; inv: number;
    /** Damage stress (s left), winded (saving stamina). */
    stress: number; winded: boolean;
    /** Current aim error (deg), reaction delay (s) and what's left of it on the current target. */
    aimErr: number; react: number; reactLeft: number;
    /** Gun handling (params.ts gunSkill): recoil pulled back (0..1), shots this burst / burst cap, rest left (s), full-auto range (m). */
    comp: number; burst: [number, number]; rest: number; spray: number | null;
  };
};

export const TRAIT_KEYS: (keyof Traits)[] = ['aggression', 'caution', 'greed', 'patience', 'vengeance', 'opportunism', 'builder', 'range'];
/**
 * Digest size budget (JSON bytes): at 4 Hz that's at most 10 KB/s, sent only to a dead guest following a bot (a
 * spectator's own snapshot stream is light). 18 goals with their breakdowns and why-zero reasons need ~2.1 KB.
 */
export const BRAIN_DIGEST_BUDGET = 2560;
/** How often digests go out (Hz). */
export const BRAIN_HZ = 4;
const LOG_LEN = 10;

/** The bot's private state, as introspection reads it (TypeScript `private` is compile-time only). */
type Ctx = {
  view: BotView; me: PlayerState; home: IslandLayout; on: number; src: number;
  rival: OtherStatus | null; rivalIsl: IslandLayout | null; enemy: PlayerState | null; enemyDist: number;
  reach: boolean; hookFrom: Vec3 | null; homeReach: boolean; openDoors: Doorway[]; bridgeTo: number | null; centerReach: boolean; danger: boolean;
};
type Act = {
  dir: Vec3 | null; face?: Vec3; shootAt?: Vec3; build?: { kind: PieceKind; pos: Vec3; rotY: number };
  shop?: ShopItem; vault?: { deposit?: Partial<Inventory>; withdraw?: Partial<Inventory> }; placeCharge?: boolean;
  trap?: { pos: Vec3; rotY: number; wall: boolean };
};
type Planned = { node: number; goal: Vec3; at: number; pts: Vec3[] } | null;
type Internals = {
  id: number; difficulty: Difficulty; personality: { archetype: string; traits: Traits };
  t: Traits; style: ShopStyle; goal: Goal; targetId: number | null; hesitateUntil: number; nextScoreAt: number;
  winded: boolean; centerMinded: boolean; view?: BotView; burstN: number; burstRestUntil: number;
  grid: unknown; lastScores: { goal: string; score: number }[];
  aim: { target: number; seenAt: number; lastSeen: number; err: Angles; p: AimProfile };
  nav: { cache: Map<string, unknown>; planned: Planned; bridges: Map<number, unknown>; centerNode: number; nodeAt(p: Vec3): number; routeTo(p: Vec3): Vec3 | null };
  mem: Pick<Memory, 'seen' | 'diedAt' | 'lastHurtAt' | 'lastHurtBy' | 'recent'> & { grudge: Map<number, number> };
  intruder(c: Ctx): Sighting | null; nearestLoot(c: Ctx): Vec3 | null; raidIsland(c: Ctx): IslandLayout | null;
  incomingDeck(c: Ctx): PieceState | null; plan(c: Ctx): { items: ShopItem[]; covered: boolean; spent: number };
  needs(c: Ctx): Needs; trapped(c: Ctx): boolean; blockers(c: Ctx): PieceState[]; canClear(c: Ctx, p: PieceState): boolean;
  crossing(c: Ctx): boolean; stormSafeR(st: NonNullable<BotView['storm']>): number; needCenterBridge(c: Ctx): boolean;
  stormPrep(view: BotView): boolean; scaffoldsNeeded(c: Ctx): number; insuranceDue(me: PlayerState): number;
  spendable(me: PlayerState): number; rivalFacts(view: BotView): RivalFacts[];
  defender: boolean; allyInTrouble(c: Ctx): AllyStatus | null; regroupWith(c: Ctx): AllyStatus | null; offensive(c: Ctx): boolean;
  waitFor(c: Ctx): AllyStatus | null; ownFight(c: Ctx): boolean; teamFocus(view: BotView, id: number): number;
  pushLead(view: BotView): { id: number; target: number | null } | null; allyIsland(view: BotView, i: number): boolean;
  sieging(c: Ctx): boolean; nearestCrate(c: Ctx): { pos: Vec3; center: Vec3 } | null;
  hookNote: { t: number; text: string } | null;
  healNote: { t: number; text: string } | null; healWant: number;
  weaponIntent: { want: string; why: string } | null;
  P: BotParams; inWindow(c: Ctx): boolean; respawnWindow: { id: number; left: number } | null;
};
const inside = (b: Bot) => b as unknown as Internals;

/** Run fn with the navigator's caches (and the bunker grid) restored afterwards: introspection leaves no trace. */
function sandbox<T>(I: Internals, fn: () => T): T {
  const nav = I.nav;
  const cache = new Map(nav.cache), bridges = new Map(nav.bridges), grid = I.grid;
  const planned = nav.planned ? { ...nav.planned, pts: nav.planned.pts.slice() } : null;
  try { return fn(); } finally {
    nav.cache = cache; nav.bridges = bridges; nav.planned = planned; I.grid = grid;
  }
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const secs = (x: number) => `${Math.max(0, Math.round(x))} s`;
const m = (x: number) => `${Math.round(x)} m`;
const rivalName = (c: Ctx) => (c.rival ? `@${c.rival.id}` : 'my rival');
const gunName = (w: WeaponKind) => (w === 'fists' ? 'bare fists' : w);
const best = (inv: Inventory): WeaponKind => (['rifle', 'smg', 'shotgun', 'pistol', 'rocket'] as WeaponKind[]).find((g) => inv.weapons[g]) ?? 'fists';
const pieceWord = (n: number, kind = 'wall') => `${n} ${kind}${n === 1 ? '' : 's'}`;

type Explained = { f: [string, number][]; why: string; gate?: string };
const zero = (gate: string, why = gate): Explained => ({ f: [], why, gate });

/**
 * Why goal g scores what it does: the factors (mirroring Bot.score term by term) and a plain-English reason.
 * Must be called inside sandbox() with the ctx of the decision being explained.
 */
function explain(g: Goal, I: Internals, c: Ctx): Explained {
  const { view, me, home } = c;
  const t = I.t, now = view.now;
  const away = c.on === home.index ? 0 : 0.25;
  const gun = ownsGun(me.inv);
  const hp = me.hp / 100;
  const rivalDown = !!c.rival && !c.rival.alive && c.rival.respawnAt !== null;
  const easy = I.difficulty === 'easy';
  switch (g) {
    case 'storm': {
      const st = view.storm;
      if (!st) return zero('no storm yet');
      const d = Math.hypot(me.pos.x - st.x, me.pos.z - st.z);
      if (d > st.r) return { f: [['outside ring', easy ? 0.9 : 1.7]], why: `Caught outside the storm ring (${m(d)} from its centre, ring ${m(st.r)}): getting in` };
      const safe = I.stormSafeR(st);
      if (d > safe) return { f: [['ring closing', easy ? 0.4 : 1.3]], why: `The ring closes past me soon (safe line ${m(safe)}, I'm at ${m(d)}): moving in ahead of it` };
      if (I.needCenterBridge(c)) return { f: [['no center bridge', 1.2]], why: 'The storm ends on the centre island and I have no way onto it: bridging there' };
      return zero('safe inside the ring');
    }
    case 'fight': {
      const e = c.enemy;
      if (!e) return zero('no enemy in sight');
      const n = I.nav.nodeAt(me.pos), same = n >= 0 && n === I.nav.nodeAt(e.pos);
      if (!same && c.enemyDist > 25) return { f: [['far enemy', 0.2]], why: `@${e.id} in sight across the water (${m(c.enemyDist)}), too far to chase` };
      const armed = gun || c.enemyDist < 8;
      return {
        f: [[armed ? 'armed' : 'unarmed', armed ? 0.85 : 0.35], ['aggression', 0.25 * t.aggression]],
        why: `Fighting @${e.id} at ${m(c.enemyDist)}: my ${gunName(best(me.inv))} vs their ${gunName(e.equipped)}, they have ${Math.round(e.hp)} hp`,
      };
    }
    case 'disengage': {
      if (!c.enemy && now - I.mem.lastHurtAt > 1.5) return zero('not under fire');
      const low = 0.25 + 0.35 * t.caution - 0.15 * t.aggression;
      if (hp < low) {
        return { f: [['low hp', 1.15], ['below bail line', low - hp]], why: `Down to ${Math.round(me.hp)} hp, under my bail-out line of ${Math.round(low * 100)}: backing off` };
      }
      const e = c.enemy;
      const outgunned = !gun && !!e && e.equipped !== 'fists' && c.enemyDist > 4 &&
        (c.enemyDist < Math.min(25, WEAPONS[e.equipped].range) || now - I.mem.lastHurtAt < 1.5);
      if (!outgunned) return zero('not outmatched');
      return { f: [['outgunned', 0.95], ['caution', 0.2 * t.caution]], why: `Unarmed against @${e!.id}'s ${e!.equipped} at ${m(c.enemyDist)}: getting out of range` };
    }
    case 'defend': {
      if (I.trapped(c)) return { f: [['trapped', 2]], why: 'Sealed inside my own bunker: breaking out is all that matters' };
      if (view.suddenDeath) return zero('sudden death');
      const bl = I.blockers(c);
      if (!bl.length) return zero('my doorways are clear');
      const can = bl.some((p) => I.canClear(c, p));
      const kinds = [...new Set(bl.map((p) => p.kind))].join(', ');
      const how = me.inv.charges > 0 ? 'a charge' : gun ? 'my gun' : 'my fists';
      if (view.sealed[home.index]) {
        return {
          f: [[can ? 'can clear' : 'cannot clear', can ? 0.85 : 0.1], ['caution', 0.1 * t.caution]],
          why: can ? `My bunker is sealed (${kinds}): clearing it with ${how}` : `My bunker is sealed (${kinds}) and nothing I carry gets through`,
        };
      }
      if (!(c.homeReach && can)) return zero(can ? "can't walk home" : `can't clear ${kinds}`);
      if (!ownsGun(me.inv) && GUNS.some((g) => me.inv.weapons[g]) && me.inv.cash + me.vault.cash >= AMMO_BOX.price) {
        return { f: [['plugged door, gun empty', 0.5]], why: `${kinds} in my doorway and my gun is empty: ammo first, then I shoot it out` };
      }
      return { f: [['plugged door', 0.7], ['caution', 0.15 * t.caution]], why: `${bl.length === 1 ? 'A' : bl.length} ${kinds} in my doorway: clearing it with ${how} before heading out` };
    }
    case 'heal': {
      if (view.suddenDeath) return zero('sudden death');
      if (c.enemy) return zero('enemy in sight');
      if (c.on === home.index) return zero('already home');
      if (!c.homeReach) return zero("can't walk home");
      if (me.inv.medkits > 0) return zero('carries a medkit');
      const low = 0.35 + 0.25 * t.caution - 0.15 * t.aggression;
      if (hp >= low) return zero('healthy enough');
      return { f: [['hurt away', 0.75], ['hp gap', low - hp]], why: `${Math.round(me.hp)} hp, away from home and no medkit: going back to recover` };
    }
    case 'assist': {
      if (!view.allies) return zero('no team');
      if (I.ownFight(c)) return zero('in my own fight');
      if (!gun) return zero('no gun');
      if (I.trapped(c)) return zero('sealed in');
      const a = I.allyInTrouble(c);
      if (!a) return zero('no teammate under fire nearby');
      const there = islandAt(view.map, a.pos);
      if (there !== c.on && !I.nav.routeTo(a.pos)) return zero(`no way to @${a.id}`);
      const f: [string, number][] = [['teammate hit', I.P.team.assistScore], ['aggression', 0.2 * t.aggression],
        ['their hp low', I.P.team.assistLowHp * (1 - Math.max(0, Math.min(100, a.hp)) / 100)]];
      if (I.defender && there !== home.index) f.push(['defender', -0.3]);
      return { f, why: `Teammate @${a.id} (${Math.round(a.hp)} hp) is being shot${a.hurtBy !== null ? ` by @${a.hurtBy}` : ''} ${Math.round(dist2D(a.pos, me.pos))} m away: going to help` };
    }
    case 'regroup': {
      if (!view.allies) return zero('no team');
      if (c.enemy) return zero('in my own fight');
      if (!gun) return zero('no gun');
      if (I.trapped(c)) return zero('sealed in');
      if (!I.offensive(c)) return zero('not on offense');
      const a = I.regroupWith(c);
      if (a && (islandAt(view.map, a.pos) === c.on || I.nav.routeTo(a.pos))) {
        return { f: [['regroup', I.P.team.regroupScore]], why: `@${a.id} leads the push on ${rivalName(c)} ${Math.round(dist2D(a.pos, me.pos))} m ahead: catching up so we hit together` };
      }
      const w = I.waitFor(c);
      if (w) return { f: [['wait for team', I.P.team.regroupScore]], why: `At the bridge head to ${rivalName(c)}: waiting for @${w.id} (${Math.round(dist2D(w.pos, me.pos))} m back) so we go in together` };
      return zero(I.defender ? 'defender: holding home' : 'with my team already (or pushing alone)');
    }
    case 'guard': {
      if (!c.homeReach) return zero("can't walk home");
      if (view.suddenDeath) return zero('sudden death');
      const s = I.intruder(c);
      if (!s) return zero('nobody on my island');
      const fresh = 1 - (now - s.t) / 8, k = 0.5 + 0.5 * fresh;
      let who = 'Someone';
      for (const [id, v] of I.mem.seen) if (v === s) who = `@${id}`;
      return {
        f: [['intruder', 0.4 * k], ['caution', 0.45 * t.caution * k], [gun ? 'armed' : 'unarmed', gun ? 0.1 : -0.2]],
        why: `${who} was on my island ${secs(now - s.t)} ago: guarding the bunker front`,
      };
    }
    case 'bank': {
      if (c.on !== home.index) return zero('not home');
      if (view.suddenDeath) return zero('sudden death');
      const sc = me.inv.pieces.scaffold ?? 0, need = I.scaffoldsNeeded(c);
      const close = !!c.enemy && c.enemyDist < 8;
      const due = I.insuranceDue(me);
      if ((c.reach || (sc > 0 && sc >= need)) && due > 0 && !close) return { f: [['insurance', 0.8]], why: `Heading out: banking $${Math.round(due)} so I can rebuy a gun if I die` };
      if (me.inv.cash < 100) return zero('little cash on me');
      const keep = I.plan({ ...c, me: { ...me, vault: { ...me.vault, cash: 0 } } } as Ctx).spent + 25;
      const excess = me.inv.cash - keep;
      if (excess < 80) return zero('cash is earmarked for gear');
      if (close) return zero('enemy too close');
      const k = Math.min(excess, 600) / 600;
      const f: [string, number][] = [['base', 0.2], ['spare cash', 0.3 * k], ['caution', 0.3 * t.caution * k], ['greed', 0.2 * t.greed * k]];
      if (c.danger || I.intruder(c)) f.push(['danger', 0.55]);
      if (c.reach || sc >= need) f.push(['leaving', 0.25]);
      f.push(['walk', -dist2D(me.pos, home.vault) / 80]);
      return { f, why: `Carrying $${Math.round(me.inv.cash)}, only $${Math.round(keep)} earmarked for gear: banking the rest` };
    }
    case 'collect': {
      if (!c.homeReach) return zero("can't walk home");
      const stored = view.generators[home.index];
      const f: [string, number][] = stored >= 40
        ? [['base', 0.45], ['greed', 0.1 * t.greed], ['stored cash', Math.min(stored, 500) / 1000]]
        : [['idle', 0.15]];
      const s0 = f.reduce((a, [, v]) => a + v, 0);
      const sc = me.inv.pieces.scaffold ?? 0;
      const leaving = c.reach || (sc > 0 && sc >= I.scaffoldsNeeded(c));
      let s = s0;
      if (c.on === home.index && stored >= 40 && leaving && !c.enemy) s = Math.max(s, 0.72);
      if (stored >= 400) s = Math.max(s, 0.8);
      if (s > s0) f.push([stored >= 400 ? 'near cap' : 'before leaving', s - s0]);
      if (away) f.push(['away', -away]);
      return { f, why: stored >= 40 ? `My generator holds $${Math.round(stored)}: collecting it` : 'Nothing better to do: waiting at my generator' };
    }
    case 'shop': {
      if (!c.homeReach) return zero("can't walk home");
      const plan = I.plan(c);
      if (!plan.items.length) return zero('nothing to buy');
      const blocked = (I as unknown as { buyBlockedUntil: Map<ShopItem, number> }).buyBlockedUntil.get(plan.items[0]) ?? -Infinity;
      if (blocked > now) return zero(`${plan.items[0]} buy failed, waiting`);
      const list = shopList(plan.items);
      if (dist2D(me.pos, home.shop) < 4 && plan.spent <= me.inv.cash) return { f: [['at the shop', 0.9]], why: `At the shop: buying ${list}` };
      const urgent = plan.items.includes('pistol') || plan.items.includes('charge') || (plan.items[0] === 'ammo' && !ownsGun(me.inv));
      const v = urgent ? 0.75 : plan.items.length >= 3 || plan.covered ? 0.6 : 0;
      if (!v) return zero('saving up');
      const f: [string, number][] = [[urgent ? 'urgent buy' : 'kit affordable', v]];
      if (away) f.push(['away', -away]);
      return { f, why: `Off to buy ${list} ($${Math.round(plan.spent)})${urgent ? `: I need ${plan.items.includes('pistol') ? 'a gun' : plan.items.includes('charge') ? 'a charge' : 'ammo'}` : ''}` };
    }
    case 'bridge': {
      const have = me.inv.pieces.scaffold ?? 0;
      if (c.bridgeTo === null) return zero('nothing to bridge to');
      if (have === 0) return zero('no scaffolds');
      if (now < ((I as unknown as { bridgeHoldUntil?: number }).bridgeHoldUntil ?? -Infinity)) return zero('holding off the bridge');
      const need = I.scaffoldsNeeded(c);
      const toRival = c.bridgeTo !== I.nav.centerNode && !I.allyIsland(view, c.bridgeTo);
      if (toRival && need <= 1 && sealKit(me.inv) < c.openDoors.length) return zero('need a seal kit before landing');
      const f: [string, number][] = [['base', 0.45], ['aggression', 0.15 * t.aggression]];
      if (have >= need) f.push(['enough decks', 0.1]);
      if (!toRival) { f.push(['greed', 0.05 * t.greed]); if (I.stormPrep(view)) f.push(['storm prep', 0.45]); }
      const to = toRival ? `${c.rival && view.map[c.bridgeTo] && c.rival.island === c.bridgeTo ? rivalName(c) : 'a rival'}'s island`
        : c.bridgeTo !== I.nav.centerNode ? `a teammate's island (on the way to ${rivalName(c)})` : 'the centre island';
      return { f, why: `Bridging to ${to}: ${have} decks carried, ${need} still needed` };
    }
    case 'contest': {
      const cv = view.center;
      if (!cv) return zero('no centre island');
      if (!c.centerReach) return zero('no way to the centre');
      if (view.suddenDeath) return zero('sudden death');
      const room = me.hotbar.includes(null) || me.hotbar.includes('sandbags');
      const sup = cv.bags + cv.steel > 0 && room ? 0.12 + 0.05 * cv.steel : 0;
      if (cv.gold < (I.centerMinded ? 150 : 375) && !sup) return zero(`only $${Math.round(cv.gold)} gold in the middle`);
      const far = dist2D(me.pos, cv.island.center) / 150;
      const rich = Math.min(0.3, (me.inv.cash + me.vault.cash) / 3000);
      const f: [string, number][] = [['base', 0.1], ['greed', 0.25 * t.greed], ['opportunism', 0.1 * t.opportunism], ['gold', Math.min(cv.gold, 1000) / 2000]];
      if (sup) f.push(['supplies', sup]);
      f.push(['distance', -far]);
      if (rich) f.push(['already rich', -rich]);
      if (c.danger) f.push(['danger', -0.2]);
      return { f, why: `The centre holds $${Math.round(cv.gold)} gold${sup ? ' and free pieces' : ''}: going to take it` };
    }
    case 'attack': {
      const recent = c.rival ? I.mem.recent(c.rival.id, now, 20) : null;
      if (!(c.reach || c.hookFrom) || !c.rival || (view.suddenDeath && !c.enemy && !recent)) {
        if (c.reach && view.suddenDeath) return { f: [['sudden death', 0.3]], why: `Sudden death: hunting ${rivalName(c)} down` };
        return zero(!c.rival ? 'no rival' : `no route to ${rivalName(c)}'s island`);
      }
      if (I.sieging(c)) {
        return { f: [['siege', I.P.drive.siegeScore], ['sealed hunt', I.P.drive.sealedHunt], ['opportunism', 0.2 * t.opportunism]], why: `${rivalName(c)}'s bunker is sealed: camping it to finish them` };
      }
      if (rivalDown) {
        const wait = gun && sealKit(me.inv) === 0;
        const back = c.rival.respawnAt! - now;
        const win: [string, number][] = I.inWindow(c) ? [['respawn window', I.P.drive.windowPush * 0.5]] : [];
        return {
          f: [...(wait ? [['camp respawn', 0.35], ['opportunism', 0.3 * t.opportunism]] as [string, number][] : [['rival down', 0.3]] as [string, number][]), ...win],
          why: `${rivalName(c)} is dead, back in ${secs(back)}${wait ? ': waiting at their door for the unarmed respawn' : ''}`,
        };
      }
      if (!gun) return { f: [['unarmed', 0.1]], why: `Going for ${rivalName(c)} without a gun` };
      const up = !!(me.inv.weapons.smg || me.inv.weapons.rifle || me.inv.weapons.shotgun);
      const k = 0.5 + 0.5 * Math.max(hp, 1 - t.caution);
      const f: [string, number][] = [['base', 0.3 * k], ['aggression', 0.25 * t.aggression * k]];
      if (!up) f.push(['patience (no upgrade)', -0.12 * t.patience * k]);
      if (c.rivalIsl && view.sealed[c.rivalIsl.index] && c.rival.alive) f.push(['sealed hunt', I.P.drive.sealedHunt]);
      const where = recent ? `seen ${secs(now - recent.t)} ago${recent.island >= 0 && recent.island !== c.rival.island ? ' away from home' : ''}` : 'whereabouts unknown';
      return { f, why: `Going after ${rivalName(c)} (${where}) with my ${gunName(best(me.inv))}${!c.reach ? ', hooking over' : ''}` };
    }
    case 'seal': {
      const kit = sealKit(me.inv);
      if (view.suddenDeath) return zero('sudden death');
      if (!(c.reach || c.hookFrom) || !c.rivalIsl) return zero(`no route to ${rivalName(c)}'s island (no bridge, nothing in hook reach)`);
      if (!kit) return zero('no walls to seal with');
      if (!c.openDoors.length) return zero(`${rivalName(c)}'s bunker already sealed`);
      const near = c.on === c.rivalIsl.index && dist2D(me.pos, c.rivalIsl.bunker.center) < 15;
      const seen = c.rival && c.rival.alive ? I.mem.recent(c.rival.id, now, 20) : null;
      const ownerAway = !!seen && seen.island !== c.rival!.island;
      const f: [string, number][] = [[kit >= c.openDoors.length ? 'full kit' : 'partial kit', kit >= c.openDoors.length ? 0.6 : 0.3]];
      f.push(['seals win', I.P.drive.sealBonus]);
      if (I.inWindow(c)) f.push(['respawn window', I.P.drive.windowPush]);
      if (rivalDown) f.push(['rival dead', 0.5], ['opportunism', 0.3 * t.opportunism]);
      if (near) f.push(['near bunker', 0.1]);
      if (ownerAway) f.push(['owner away', 0.2 * t.opportunism]);
      const died = c.rival ? I.mem.diedAt.get(c.rival.id) : undefined;
      const state = rivalDown
        ? `${died !== undefined ? `died ${secs(now - died)} ago, ` : ''}respawn in ${secs(c.rival!.respawnAt! - now)}`
        : ownerAway ? 'they are away from home' : 'their doors are open';
      return { f, why: `Sealing ${rivalName(c)}'s bunker: ${state}, I carry ${pieceWord(kit)} for ${c.openDoors.length} door${c.openDoors.length === 1 ? '' : 's'}${!c.reach ? ' (hooking over: no bridge yet)' : ''}` };
    }
    case 'cut': {
      if (!gun) return zero('no gun');
      if (c.on !== home.index) return zero('not home');
      if (view.suddenDeath) return zero('sudden death');
      const deck = I.incomingDeck(c);
      if (!deck) return zero('no bridge into my island');
      const crossing = I.crossing(c);
      const intr = I.intruder(c);
      const f: [string, number][] = [['base', 0.15], ['builder×caution', 0.5 * t.builder * t.caution]];
      if (intr) f.push(['intruder', c.enemy ? 0.1 : 0.3]);
      if (crossing) f.push(['someone crossing', 0.65]);
      if (c.rival && c.reach) f.push(['aggression', -0.2 * t.aggression]);
      return { f, why: `@${deck.owner} bridged into my island${crossing && c.enemy ? `, @${c.enemy.id} is on it` : ''}: shooting the deck out` };
    }
    case 'loot': {
      const bag = I.nearestLoot(c), crate = I.nearestCrate(c);
      if (!bag && !crate) return zero('no loot in reach');
      const crateS = crate ? 0.2 + 0.3 * t.greed - dist2D(crate.pos, me.pos) / 30 : 0;
      const bagS = bag ? 0.35 + 0.45 * t.greed + (gun ? 0 : 0.2) - dist2D(bag, me.pos) / 70 : 0;
      if (crate && (!bag || crateS > bagS)) {
        return { f: [['crate', 0.2], ['greed', 0.3 * t.greed], ['distance', -dist2D(crate.pos, me.pos) / 30]], why: `A supply crate ${m(dist2D(crate.pos, me.pos))} away: breaking it open` };
      }
      if (!bag) return zero('no loot in reach');
      const f: [string, number][] = [['base', 0.35], ['greed', 0.45 * t.greed]];
      if (!gun) f.push(['unarmed', 0.2]);
      f.push(['distance', -dist2D(bag, me.pos) / 70]);
      return { f, why: `A loot bag ${m(dist2D(bag, me.pos))} away${gun ? '' : ', maybe a gun'}: picking it up` };
    }
    case 'cover': {
      const cv = (I as unknown as { cover: { threatId: number; placed: number; phase: string; peeks: number } | null }).cover;
      if (!cv) return zero('no cover planned');
      if (c.enemy && c.enemyDist < 5) return zero('enemy too close to build');
      if (c.enemy && c.enemy.hp + c.enemy.shield < me.hp + me.shield - BT.pushLead) return zero('winning the trade: pushing');
      const state = cv.placed ? `${cv.placed} wall${cv.placed > 1 ? 's' : ''} up, ${cv.phase === 'hide' ? 'hiding' : 'peeking'} (peek ${cv.peeks})` : 'throwing up a wall';
      return { f: [['base', BT.coverScore], ['builder', 0.1 * t.builder]], why: `Under fire from @${cv.threatId}: ${state}` };
    }
    case 'fortify': {
      if (view.suddenDeath) return zero('sudden death');
      if (c.on !== home.index) return zero('not home');
      if (c.danger) return zero('danger nearby');
      if (!gun) return zero('no gun');
      if (I.intruder(c)) return zero('intruder on my island');
      const J = I as unknown as { fortWorthIt(c: Ctx): boolean; nextSlot(c: Ctx): unknown };
      if (!J.fortWorthIt(c)) return zero('not worth fortifying');
      if (!J.nextSlot(c)) return zero('fort finished');
      return { f: [['base', BT.fortifyScore], ['builder', 0.3 * t.builder]], why: 'Quiet at home: building up my bunker defences' };
    }
    case 'trap': {
      if (view.suddenDeath) return zero('sudden death');
      if (c.on !== home.index) return zero('not home');
      if (c.danger) return zero('danger nearby');
      if (me.inv.traps <= 0) return zero('no spike traps carried');
      const J = I as unknown as { myTraps(v: BotView): unknown[]; nextTrapSpot(c: Ctx): { req: { wall: boolean } } | null; P: { trap: { setScore: number } } };
      if (J.myTraps(view).length >= TRAP.maxPerPlayer) return zero(`${TRAP.maxPerPlayer} traps already out`);
      const spot = J.nextTrapSpot(c);
      if (!spot) return zero('no free trap spot');
      return {
        f: [['base', J.P.trap.setScore], ['builder', 0.2 * t.builder], ['caution', 0.1 * t.caution]],
        why: `Quiet at home: setting a spike trap ${spot.req.wall ? 'on the wall by my front door' : 'outside a doorway'}`,
      };
    }
    case 'raid': {
      if (view.suddenDeath) return zero('sudden death');
      if (!gun) return zero('no gun');
      const isl = I.raidIsland(c);
      if (!isl) return zero('no unguarded generator');
      const owner = view.others.find((o) => o.island === isl.index);
      const f: [string, number][] = [['base', 0.2], ['greed', 0.45 * t.greed], ['stored cash', Math.min(view.generators[isl.index], 500) / 1000]];
      if (c.on !== isl.index) f.push(['walk', -0.15]);
      return { f, why: `${owner ? `@${owner.id}'s` : 'An'} generator holds $${Math.round(view.generators[isl.index])} and nobody guards it: raiding` };
    }
  }
}

function shopList(items: ShopItem[]): string {
  const n = new Map<string, number>();
  for (const i of items) n.set(i, (n.get(i) ?? 0) + 1);
  const parts = [...n].map(([k, c]) => (c > 1 ? `${c}× ${k}` : k));
  return parts.length > 4 ? `${parts.slice(0, 4).join(', ')}…` : parts.join(', ');
}

function needsWhy(n: Needs): string {
  const p: string[] = [];
  if (n.scaffolds) p.push(`${n.scaffolds} decks to bridge`);
  if (n.kit) p.push(`walls for ${n.kit} door${n.kit === 1 ? '' : 's'}`);
  if (n.charge) p.push('a charge for my plugged door');
  if (n.grenades) p.push(`${n.grenades} grenades`);
  if (n.medkits) p.push(`${n.medkits} medkits`);
  if (n.traps) p.push(`${n.traps} spike trap${n.traps === 1 ? '' : 's'} for my doors`);
  return p.length ? `needs ${p.join(', ')}` : 'upgrades';
}

function targetWhy(f: RivalFacts, now: number, seenAt: number | null): string {
  const p: string[] = [f.reach ? 'reachable' : `${f.scaffolds} decks away`];
  if (f.respawning) p.push('respawning');
  else if (f.sinceDeath < 15) p.push(`died ${secs(f.sinceDeath)} ago`);
  if (f.sealed) p.push('already sealed');
  if (f.trapped) p.push('trapped: finish them');
  if ((f.sealed || f.trapped) && (f.bounty ?? 0) > 0) p.push(`spoils $${f.bounty}`);
  if (f.onMyIsland) p.push('on my island');
  if (f.away) p.push('away from home');
  if (f.seenHp !== null) p.push(`${Math.round(f.seenHp)} hp`);
  else if (seenAt !== null) p.push(`seen ${secs(now - seenAt)} ago`);
  if (f.grudge >= 1) p.push(`grudge ${Math.round(f.grudge)}`);
  if (f.busy) p.push('busy fighting');
  if (f.kills > 0 && f.kills === f.leaderKills) p.push('kill leader');
  return p.join(', ');
}

/** Per-bot recorder: decisions captured at the moment they are made (Bot.pick), acts every tick. */
export class BrainProbe {
  rows: ScoreRow[] | null = null;
  explained = new Map<Goal, Explained>();
  decidedAt: number | null = null;
  why = '';
  target: { id: number; why: string } | null = null;
  rivals: [number, number][] = [];
  shop: BrainDigest['shop'] = null;
  intent: BrainDigest['build'] = null;
  act: Act | null = null;
  look: Angles | null = null;
  fire = false;
  /** Latest goTo destination this tick (set by Bot.goTo). */
  dest: Vec3 | null = null;
  /** No walkable way to my rival but a hook gets me over: where I fire it from. */
  hookFrom: Vec3 | null = null;
  private lastBuild: { b: NonNullable<BrainDigest['build']>; t: number } | null = null;

  constructor(private readonly bot: Bot) {}

  /** Bot.pick just chose `chosen` (rows null: trapped, no scoring). Pure reads only, nav caches sandboxed. */
  decided(c: Ctx, rows: ScoreRow[] | null, chosen: Goal) {
    const I = inside(this.bot);
    const now = c.view.now;
    this.decidedAt = now;
    this.hookFrom = c.reach ? null : c.hookFrom;
    this.rows = rows ? rows.slice().sort((a, b) => b.score - a.score) : null;
    sandbox(I, () => {
      this.explained.clear();
      for (const r of rows ?? [{ goal: chosen } as ScoreRow]) this.explained.set(r.goal, explain(r.goal, I, c));
      this.why = this.explained.get(chosen)?.why ?? '';
      // Rivals as chooseTarget weighs them (without its decision noise).
      const facts = I.rivalFacts(c.view);
      this.rivals = facts.map((f) => [f.id, r2(rivalScore(f, I.t, I.P.drive.sealAwayTarget, { perK: I.P.drive.spoilsTarget[I.difficulty], trapped: I.P.drive.finishTrapped }) + I.teamFocus(c.view, f.id))] as [number, number]).sort((a, b) => b[1] - a[1]);
      const tf = facts.find((f) => f.id === I.targetId);
      this.target = tf ? { id: tf.id, why: targetWhy(tf, now, I.mem.seen.get(tf.id)?.t ?? null) } : c.rival ? { id: c.rival.id, why: 'nearest rival (no pick yet)' } : null;
      if (c.homeReach && !c.view.suddenDeath) {
        const needs = I.needs(c), plan = I.plan(c);
        this.shop = plan.items.length ? { items: plan.items.slice(0, 8), cost: Math.round(plan.spent), why: needsWhy(needs) } : null;
      } else this.shop = null;
      this.intent = null;
      if (chosen === 'seal' && c.rivalIsl && c.openDoors.length) {
        const door = c.openDoors.reduce((a, d) => (dist2D(d.center, c.me.pos) < dist2D(a.center, c.me.pos) ? d : a));
        const plug = plugFor(c.me.inv, c.view.pieces, door);
        if (plug) {
          const p = plugSpot(door, plug.kind, plug.level);
          this.intent = { kind: plug.kind, x: r1(p.x), y: r1(p.y), z: r1(p.z), rotY: r2(door.yaw), why: `plug ${rivalName(c)}'s doorway` };
        }
      }
    });
  }

  /** What the bot did this tick (after aim). */
  acted(act: Act, look: Angles, fire: boolean) {
    this.act = act;
    this.look = look;
    this.fire = fire;
    const b = act.build;
    if (b) {
      const I = inside(this.bot) as Internals & { buildWhy?: string | null };
      const why = I.buildWhy ?? (b.kind === 'scaffold' ? 'next bridge deck' : I.goal === 'seal' ? 'plugging a doorway' : I.goal === 'fortify' ? 'fortifying home' : 'cover from fire');
      this.lastBuild = { b: { kind: b.kind, x: r1(b.pos.x), y: r1(b.pos.y), z: r1(b.pos.z), rotY: r2(b.rotY), why }, t: inside(this.bot).view?.now ?? 0 };
    }
  }

  build(now: number): BrainDigest['build'] {
    if (this.lastBuild && now - this.lastBuild.t < 1.5) return this.lastBuild.b;
    return this.intent;
  }
}

/** Log a goal switch (always on: one entry per switch, capped). The probe's reason when watched, else the scores. */
export function noteSwitch(log: GoalSwitch[], probe: BrainProbe | null, top: { goal: string; score: number }[], t: number, from: Goal, to: Goal) {
  let why = probe?.why ?? '';
  if (!why) {
    const s = (g: string) => top.find((o) => o.goal === g)?.score;
    const a = s(to), b = s(from);
    why = a !== undefined ? `${to} scored ${a.toFixed(2)}${b !== undefined ? ` vs ${from} ${b.toFixed(2)}` : ''}` : `switched to ${to}`;
  }
  log.push({ t, from, to, why });
  if (log.length > LOG_LEN) log.shift();
}

function invValue(inv: Inventory): number {
  let v = 0;
  for (const [k, a] of Object.entries(inv.weapons)) if (k !== 'fists') v += (WEAPONS[k as WeaponKind]?.price ?? 0) + (a && a.spare > 0 ? AMMO_BOX.price * Math.min(1, a.spare / 30) : 0);
  for (const [k, n] of Object.entries(inv.pieces)) v += (PIECES[k as PieceKind]?.price ?? 0) * (n ?? 0);
  for (const [k, n] of Object.entries(inv.potions ?? {})) v += (POTIONS[k as keyof typeof POTIONS]?.price ?? 0) * (n ?? 0);
  return Math.round(v + inv.grenades * GRENADE.price + inv.charges * CHARGE.price + inv.medkits * MEDKIT.price + inv.traps * TRAP.price + ((inv.grapples ?? 0) * GRAPPLE.price) / GRAPPLE.uses);
}

/** Steps of the current goal, and which one it's on (from what it did this tick). */
function planSteps(goal: Goal, I: Internals, p: BrainProbe, view: BotView): { steps: string[]; at: number } {
  const a = p.act;
  const moving = !!a?.dir;
  const two = (walk: string, then: string) => ({ steps: [walk, then], at: moving ? 0 : 1 });
  const rv = I.targetId !== null ? `@${I.targetId}` : 'my rival';
  switch (goal) {
    case 'collect': return two('Walk to my generator', `Collect $${Math.round(view.generators[view.self.island] ?? 0)}`);
    case 'bank': return two('Walk to my vault', 'Deposit spare cash');
    case 'heal': return two('Walk home', 'Recover hp');
    case 'loot': return two('Walk to the loot bag', 'Pick it up');
    case 'raid': return two('Walk to the generator', 'Take its cash');
    case 'guard': return two('Get to the bunker front', 'Watch where the intruder was');
    case 'cut': return two('Walk to the shore', 'Shoot the incoming deck');
    case 'contest': return two('Walk to the centre stations', 'Grab gold / pieces');
    case 'assist': return two('Run to the teammate under fire', 'Shoot whoever is on them');
    case 'regroup': return two('Catch up with the push leader', 'Push in together');
    case 'storm': return { steps: ['Get inside the ring', 'Hold position'], at: moving ? 0 : 1 };
    case 'cover': return { steps: ['Get to the cover spot', 'Place a wall', 'Fight from behind it'], at: a?.build ? 1 : moving ? 0 : 2 };
    case 'fortify': return { steps: ['Walk to the next fort slot', 'Build it', 'Next slot'], at: a?.build ? 1 : moving ? 0 : 1 };
    case 'trap': return { steps: ['Walk to a doorway', 'Set a spike trap', 'Next spot'], at: a?.trap ? 1 : moving ? 0 : 1 };
    case 'fight': return { steps: ['Hold my preferred range', 'Strafe and shoot', 'Take cover if hurt'], at: p.fire ? 1 : 0 };
    case 'disengage': return { steps: ['Break away from the shooter', 'Get behind my bunker'], at: moving ? 0 : 1 };
    case 'defend': return { steps: ['Get to the plugged doorway', 'Clear the plug', 'Walk out'], at: a?.placeCharge || a?.shootAt ? 1 : moving ? 0 : 1 };
    case 'bridge': return { steps: ['Walk to the end of the bridge', 'Lay the next deck', 'Cross over'], at: a?.build ? 1 : moving ? 0 : 1 };
    case 'attack': return p.hookFrom
      ? { steps: [`Walk to where I hook over to ${rv}'s island`, 'Hook across', 'Hunt them / hold their door'], at: moving ? 0 : 1 }
      : { steps: [`Reach ${rv}'s island`, 'Hunt them / hold their door'], at: moving ? 0 : 1 };
    case 'seal': return p.hookFrom
      ? { steps: [`Walk to where I hook over to ${rv}'s island`, 'Hook across', 'Plug their doors'], at: moving ? 0 : 1 }
      : { steps: [`Walk to ${rv}'s nearest open door`, 'Plug it', 'Next door'], at: a?.build ? 1 : moving ? 0 : 1 };
    case 'shop': {
      const items = p.shop?.items ?? [];
      const steps = [...(a?.vault?.withdraw ? ['Withdraw cash from the vault'] : []), 'Walk to the shop', ...items.slice(0, 5).map((i) => `Buy ${i}`)];
      const buying = a?.shop ? steps.indexOf(`Buy ${a.shop}`) : -1;
      return { steps, at: buying >= 0 ? buying : a?.vault ? 0 : steps.indexOf('Walk to the shop') };
    }
  }
}

/** The bot's route ahead: its feet, the planned within-island path, then where it's heading. */
function pathOf(I: Internals, p: BrainProbe, me: PlayerState): [number, number, number][] {
  const pts: Vec3[] = [me.pos];
  const pl = I.nav.planned;
  if (pl && p.act?.dir && I.nav.nodeAt(me.pos) === pl.node) pts.push(...pl.pts.slice(0, 5));
  if (p.dest && p.act?.dir) pts.push(p.dest);
  return pts.slice(0, 8).map((q) => [r1(q.x), r1(q.y), r1(q.z)]);
}

/**
 * Build a digest of what the bot is thinking. Pure reads (call only for spectated bots). The first call on a
 * bot starts its probe; until its next re-score the utility table is empty.
 */
type DockPlan = { id: number; enemy: number; at: Vec3; weapon: 'rocket' | 'grenade'; why: 'under' | 'cover' | 'defend'; until: number };
/** The pier tactic (Bot.dockShot) as a plan step: which section, how, and why. */
export function dockStep(d: DockPlan): string {
  const how = d.weapon === 'rocket' ? 'rocket' : 'grenade';
  if (d.why === 'defend') return `Blowing out my pier under @${d.enemy} as they cross (${how}, section ${d.id})`;
  if (d.why === 'cover') return `Blowing out the pier under @${d.enemy}'s cover (${how}, section ${d.id})`;
  return `Blowing out the pier under @${d.enemy}: into the water (${how}, section ${d.id})`;
}

export function debugBrain(bot: Bot): BrainDigest {
  const I = inside(bot);
  const probe = (bot as unknown as { probe: BrainProbe | null }).probe;
  const view = I.view;
  const me = view?.self;
  const now = view?.now ?? 0;
  const goal = I.goal;
  const p = probe ?? new BrainProbe(bot);
  const scores: BrainDigest['scores'] = (p.rows ?? []).map((r) => {
    const e = p.explained.get(r.goal);
    const f = (e?.f ?? []).map(([k, v]) => [k, r2(v)] as [string, number]);
    const raw = r.raw ?? r.base;
    const other = raw - (e?.f ?? []).reduce((a, [, v]) => a + v, 0);
    if (Math.abs(other) > 0.005) f.push(['other', r2(other)]);
    if (Math.abs(r.base - raw) >= 0.005) f.push(['drive', r2(r.base - raw)]);
    if (Math.abs(r.noise) >= 0.005) f.push(['noise', r2(r.noise)]);
    if (r.sticky) f.push(['sticky', r2(r.sticky)]);
    const row: BrainDigest['scores'][number] = [r.goal, r2(r.score), r2(r.base), f];
    if (r.base <= 0 && e?.gate) row.push(e.gate);
    return row;
  });
  const seen: BrainDigest['seen'] = [];
  const hurt: BrainDigest['hurt'] = [];
  if (view && me) {
    const live = new Set(view.enemies.map((e) => e.id));
    for (const e of view.enemies) seen.push([e.id, 0, r1(e.pos.x), r1(e.pos.y), r1(e.pos.z), Math.round(e.hp), e.equipped === 'fists' ? 0 : 1]);
    for (const [id, s] of I.mem.seen) {
      if (live.has(id) || s.t < (I.mem.diedAt.get(id) ?? -Infinity) || now - s.t > 30) continue;
      if (view.others.find((o) => o.id === id)?.eliminated) continue;
      seen.push([id, r1(now - s.t), r1(s.pos.x), r1(s.pos.y), r1(s.pos.z), Math.round(s.hp), s.armed ? 1 : 0]);
    }
    const by = new Map<number, [number, number]>();
    for (const h of view.hurt) {
      const k = h.by ?? -1, cur = by.get(k) ?? [0, Infinity];
      by.set(k, [cur[0] + h.amount, Math.min(cur[1], now - h.t)]);
    }
    for (const [id, [d, ago]] of by) hurt.push([id, Math.round(d), r1(ago)]);
  }
  const grudge = [...I.mem.grudge].filter(([, g]) => g >= 1).map(([id, g]) => [id, Math.round(g)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const plan = view ? planSteps(goal, I, p, view) : { steps: [], at: -1 };
  const a = p.act;
  const aimPt = view && me
    ? (view.enemies.length && p.look ? nearest(view.enemies, me.pos)?.pos : a?.shootAt ?? a?.face ?? null)
    : null;
  const aim = I.aim, tracking = aim.lastSeen === now && aim.target >= 0;
  const cone = aim.p.coneRad * (1 - 0.3 * Math.min(1, (now - aim.seenAt) / 1));
  const thinking = now < I.hesitateUntil;
  const dock = (bot as unknown as { dockPlan: DockPlan | null }).dockPlan;
  const docking = !!dock && !!me?.alive && now < dock.until;
  const step = !me?.alive ? 'Dead: waiting to respawn' : docking ? dockStep(dock!) : thinking ? 'Thinking it over…' : plan.steps[plan.at] ?? '—';
  const d: BrainDigest = {
    id: I.id, t: r1(now), arch: I.personality.archetype, diff: I.difficulty,
    traits: TRAIT_KEYS.map((k) => Math.round(I.t[k] * 100)),
    goal, step, why: p.why || (p.rows ? '' : 'Waiting for its next decision…'), thinking,
    next: r1(Math.max(0, I.nextScoreAt - now)), decidedAgo: p.decidedAt === null ? null : r1(now - p.decidedAt),
    scores,
    log: (bot as unknown as { switches: GoalSwitch[] }).switches.slice().reverse().map((s) => [r1(s.t), s.from, s.to, s.why.slice(0, 110)]),
    seen: seen.slice(0, 8), hurt: hurt.slice(0, 4), grudge,
    target: p.target, rivals: p.rivals.slice(0, 7),
    window: I.respawnWindow ? [I.respawnWindow.id, r1(I.respawnWindow.left)] : null,
    ...(view?.allies ? { team: { role: I.defender ? 'defend' as const : 'push' as const, focus: view.allies.filter((x) => !x.eliminated && x.target !== null && x.target === I.targetId).map((x) => x.id), ...leadOf(I, view) } } : {}),
    plan: plan.steps, planAt: plan.at,
    shop: p.shop, build: p.build(now),
    ...hookLine(I, me, now),
    ...healLine(I, me, now),
    ...(me?.alive && I.weaponIntent ? { weapon: I.weaponIntent.why } : {}),
    path: me ? pathOf(I, p, me) : [],
    aim: docking ? [r1(dock!.at.x), r1(dock!.at.y), r1(dock!.at.z)] : aimPt ? [r1(aimPt.x), r1(aimPt.y + (view!.enemies.length ? 1.2 : 0)), r1(aimPt.z)] : null, fire: p.fire,
    st: {
      hp: Math.round(me?.hp ?? 0), sh: Math.round(me?.shield ?? 0), sta: Math.round(me?.stamina ?? 0),
      cash: Math.round(me?.inv.cash ?? 0), vault: Math.round(me?.vault.cash ?? 0), inv: me ? invValue(me.inv) : 0,
      stress: r1(me?.mv?.stress ?? 0), winded: I.winded,
      aimErr: r2(tracking ? Math.hypot(aim.err.yaw, aim.err.pitch) * cone * 180 / Math.PI : aim.p.coneRad * 180 / Math.PI),
      react: r2(aim.p.reactSec), reactLeft: r2(tracking ? Math.max(0, aim.seenAt + aim.p.reactSec - now) : 0),
      comp: r2(aim.p.recoilComp), burst: [I.burstN, I.P.gunSkill[I.difficulty].burstShots], rest: r2(Math.max(0, I.burstRestUntil - now)),
      spray: Number.isFinite(I.P.gunSkill[I.difficulty].sprayRange) ? I.P.gunSkill[I.difficulty].sprayRange : null,
    },
  };
  return fitDigest(d);
}

/** Teams: the push lead the bot follows (absent when it leads, or defends). */
function leadOf(I: Internals, view: BotView): { lead?: number } {
  const l = sandbox(I, () => I.pushLead(view));
  return l && l.id !== I.id ? { lead: l.id } : {};
}

/** The brain panel's grappling hook line. */
function hookLine(I: Internals, me: PlayerState | undefined, now: number): { hook?: string } {
  if (!me?.alive) return {};
  const note = I.hookNote && now - I.hookNote.t < 4 ? I.hookNote.text : null;
  if (me.mv?.pull?.yank) return { hook: 'Being yanked by an enemy hook' };
  if (me.mv?.pull) return { hook: `On the rope${note ? `: ${note}` : ''}` };
  if (me.hook) return { hook: note ?? 'Hook out' };
  if (note) return { hook: note };
  const n = me.inv.grapples ?? 0;
  return n > 0 ? { hook: `Carrying one (${n} use${n === 1 ? '' : 's'}): for crossing gaps, getting away, yanking` } : {};
}

/** The brain panel's healing line: what it's doing about health now, else what it carries. */
function healLine(I: Internals, me: PlayerState | undefined, now: number): { heal?: string } {
  if (!me?.alive) return {};
  if (me.healAt !== null) return { heal: 'Using a medkit' };
  if (me.drinking) return { heal: `Drinking ${me.drinking.kind}` };
  if (I.healNote && now - I.healNote.t < 4) return { heal: I.healNote.text };
  const n = hpHealsHeld(me), sh = (me.inv.potions.shieldSmall ?? 0) + (me.inv.potions.shieldBig ?? 0);
  if (!n && !sh && !I.healWant) return {};
  return { heal: `Carrying ${n} heal${n === 1 ? '' : 's'} (wants ${I.healWant})${sh ? `, ${sh} shield potion${sh === 1 ? '' : 's'}` : ''}` };
}

function nearest(es: PlayerState[], p: Vec3): PlayerState | null {
  let b: PlayerState | null = null;
  for (const e of es) if (e.alive && (!b || dist2D(e.pos, p) < dist2D(b.pos, p))) b = e;
  return b;
}

export const digestBytes = (d: BrainDigest) => JSON.stringify(d).length;

/** Trim the least useful parts until the digest fits BRAIN_DIGEST_BUDGET. */
export function fitDigest(d: BrainDigest): BrainDigest {
  const cuts: (() => boolean)[] = [
    () => { const n = d.log.length; d.log = d.log.map((l) => [l[0], l[1], l[2], l[3].length > 72 ? `${l[3].slice(0, 71)}…` : l[3]]); return n > 0; },
    () => d.log.length > 5 && (d.log = d.log.slice(0, 5), true),
    () => d.rivals.length > 3 && (d.rivals = d.rivals.slice(0, 3), true),
    () => d.path.length > 3 && (d.path = d.path.slice(0, 3), true),
    () => d.seen.length > 4 && (d.seen = d.seen.slice(0, 4), true),
    () => { const z = d.scores.filter((s) => s[2] <= 0 && s[4]); for (const s of z) s.length = 4; return z.length > 0; },
    () => { d.scores = d.scores.filter((s) => s[2] > 0 || s[1] > 0); return true; },
    () => { for (const s of d.scores) s[3] = s[3].slice(0, 3); return true; },
    () => d.log.length > 2 && (d.log = d.log.slice(0, 2), true),
    () => { d.why = d.why.slice(0, 80); if (d.shop) d.shop.why = d.shop.why.slice(0, 40); return true; },
  ];
  for (const cut of cuts) {
    if (digestBytes(d) <= BRAIN_DIGEST_BUDGET) return d;
    cut();
  }
  if (digestBytes(d) > BRAIN_DIGEST_BUDGET) { d.log = []; d.scores = d.scores.slice(0, 6); }
  return d;
}
