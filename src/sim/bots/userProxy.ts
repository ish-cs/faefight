/**
 * UserProxy (bot-cognition spec §4.1 / §7.1): a stand-in for the human player in benchmarks. A normal Bot whose goal
 * choice is nudged by a small decision tree fit offline to the user's macro decisions (scripts/replays/macros.ts
 * labels, scripts/replays/userproxy.ts fits). The fitted model is private data (it comes from the user's replays):
 * it is never committed; CI gets it from a repository secret, local runs from .replays-local/userproxy.json.
 *
 * The same feature vector is computed from a live BotView here and from a replay's per-second summaries in the
 * labeller, so the tree means the same thing in both places (approximation: the replay side sees every enemy, the
 * live side only the ones in sight).
 */
import type { IslandLayout } from '../map';
import type { Difficulty, WeaponKind } from '../types';
import type { Personality, Traits } from './personality';
import type { BotView } from './view';

/** Macro decisions over a 5 s window (hindsight labels; see scripts/replays/macros.ts for the exact rules). */
export const MACROS = ['seal', 'hunt', 'fight', 'disengage', 'bank', 'shop', 'push', 'fortify', 'center', 'hold'] as const;
export type Macro = (typeof MACROS)[number];

/** Bot goals each macro favours (bot.ts Goal names). */
export const MACRO_GOALS: Record<Macro, readonly string[]> = {
  seal: ['seal'], hunt: ['attack', 'fight'], fight: ['fight'], disengage: ['disengage', 'heal', 'cover'], bank: ['bank'],
  shop: ['shop'], push: ['bridge', 'attack'], fortify: ['fortify', 'trap'], center: ['contest'], hold: ['collect', 'guard', 'defend'],
};

export const FEATURES = ['hpS', 'cash', 'gun', 'enemyDist', 'where', 'ownSealed', 'sealedRivals', 'left', 'tMin', 'hurt'] as const;
/** Nearest-enemy distance cap (m): about sight range. */
export const ENEMY_CAP = 120;
/** Centre island: within this of the centroid of the player islands and on none of them. */
export const CENTER_R = 24;

/** What the feature vector is built from (plain numbers: a live view and a replay summary both fill it). */
export type FeatureInput = {
  hp: number; shield: number; cash: number;
  /** Guns owned (live: inventory; replay: guns seen in hand since the last respawn). */
  guns: readonly string[];
  pos: { x: number; z: number };
  island: number;
  /** Positions of alive enemies (live: in sight; replay: all). */
  enemies: readonly { x: number; z: number }[];
  map: readonly IslandLayout[];
  sealed: readonly (boolean | number)[];
  /** Islands of the rivals still in the game (not eliminated). */
  rivalIslands: readonly number[];
  now: number;
  hurtRecently: boolean;
};

export function gunClass(guns: readonly string[]): number {
  if (guns.includes('rifle')) return 3;
  if (guns.some((g) => g === 'smg' || g === 'shotgun' || g === 'rocket')) return 2;
  return guns.includes('pistol') ? 1 : 0;
}

/** 0 home, 1 a rival's island, 2 the centre, 3 water / bridge. */
export function whereOf(map: readonly IslandLayout[], island: number, p: { x: number; z: number }): number {
  for (const isl of map) if (Math.hypot(isl.center.x - p.x, isl.center.z - p.z) <= isl.radius) return isl.index === island ? 0 : 1;
  let cx = 0, cz = 0;
  for (const isl of map) { cx += isl.center.x; cz += isl.center.z; }
  cx /= Math.max(1, map.length); cz /= Math.max(1, map.length);
  return Math.hypot(p.x - cx, p.z - cz) <= CENTER_R ? 2 : 3;
}

export function features(i: FeatureInput): number[] {
  let d = ENEMY_CAP;
  for (const e of i.enemies) d = Math.min(d, Math.hypot(e.x - i.pos.x, e.z - i.pos.z));
  return [
    i.hp + i.shield, i.cash, gunClass(i.guns), Math.round(d), whereOf(i.map, i.island, i.pos), i.sealed[i.island] ? 1 : 0,
    i.rivalIslands.filter((r) => !!i.sealed[r]).length, i.rivalIslands.length, i.now / 60, i.hurtRecently ? 1 : 0,
  ];
}

export function featuresFromView(view: BotView): number[] {
  const me = view.self;
  return features({
    hp: me.hp, shield: me.shield, cash: me.inv.cash, guns: Object.keys(me.inv.weapons), pos: me.pos, island: me.island,
    enemies: view.enemies.filter((e) => e.alive).map((e) => e.pos), map: view.map, sealed: view.sealed,
    rivalIslands: view.others.filter((o) => !o.eliminated).map((o) => o.island), now: view.now,
    hurtRecently: view.hurt.some((h) => h.by !== null && h.by !== me.id && view.now - h.t <= 5),
  });
}

/** Decision tree: split on feature f at threshold v (x[f] <= v goes left) or a leaf with a macro index. */
export type TreeNode = { f: number; v: number; l: TreeNode; r: TreeNode } | { leaf: number; n?: number };

export function predict(t: TreeNode, x: readonly number[]): number {
  while (!('leaf' in t)) t = x[t.f] <= t.v ? t.l : t.r;
  return t.leaf;
}

export type UserProxyModel = {
  version: 1;
  tree: TreeNode;
  /** Score added to the goals of the predicted macro (when they score at all). */
  bias: number;
  /** Tier whose aim / reaction / thinking speed the proxy uses. */
  difficulty: Difficulty;
  traits: Traits;
  /** Provenance (replays used, accuracy): informational. */
  meta?: Record<string, unknown>;
};

export function isUserProxyModel(v: unknown): v is UserProxyModel {
  const m = v as UserProxyModel | null;
  return !!m && m.version === 1 && typeof m.bias === 'number' && !!m.tree && typeof m.traits === 'object'
    && ['easy', 'medium', 'hard', 'pro'].includes(m.difficulty);
}

export function proxyPersonality(m: UserProxyModel): Personality {
  return { archetype: 'Sniper', traits: { ...m.traits } };
}

/** Goal bias for Bot.goalBias: the predicted macro's goals get +bias (one prediction per sim time). */
export function goalBiasFor(m: UserProxyModel): (goal: string, view: BotView) => number {
  let at = NaN, macro: Macro = 'hold';
  return (goal, view) => {
    if (view.now !== at) { at = view.now; macro = MACROS[predict(m.tree, featuresFromView(view))] ?? 'hold'; }
    return MACRO_GOALS[macro].includes(goal) ? m.bias : 0;
  };
}

/** Used by the labeller and tests: which guns a summary row's `equipped` value counts as. */
export const GUNS: readonly WeaponKind[] = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'];
