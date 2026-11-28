import { MEDKIT, PLAYER, POTIONS } from '../constants';
import { countOf } from '../hotbar';
import { uselessReason } from '../potions';
import type { Difficulty, HotbarItem, PlayerState } from '../types';
import type { HealParams } from './params';

/**
 * Healing like a strong player (medkits from the home shop; heal and shield potions from the potion seller).
 * Pure decision code: bot.ts feeds it what the bot knows and acts on the answer.
 *
 * - Out of a fight: patch hp up below `safeHp`, keep shields topped up.
 * - In a fight, hp + shield at or under `fightHp` (or a burst just landed): heal when it's safe enough — out of their
 *   sight, they're far, or they're reloading (an item that finishes before their reload does). Otherwise break line of
 *   sight first (hide: a wall, cover, or back off), and heal in the open only if hiding takes longer than `hideSec`.
 * - Never heal while the one in front of me is about dead and lower than me: press instead.
 */
export type HealItem = 'medkit' | 'healPotion' | 'shieldSmall' | 'shieldBig';
export const HEAL_ITEMS: readonly HealItem[] = ['medkit', 'healPotion', 'shieldSmall', 'shieldBig'];

export type HealSituation = {
  me: PlayerState; now: number; diff: Difficulty;
  /** Nearest enemy in sight: distance, hp + shield, seconds of reload left (0 = not reloading). */
  foe: { dist: number; eff: number; reloadLeft: number } | null;
  /** Seconds since I was last hurt by someone; damage taken in the current burst (about the last second). */
  hurtAgo: number; burst: number;
  /** Seconds spent trying to break line of sight for this heal (null: not hiding). */
  hidingFor: number | null;
  /** This incident's rolls: hide before healing (coverFirst), use enemy reload windows (reloadWeight). */
  coverFirst: boolean; useReload: boolean;
  /** Seconds since my last heal mid-fight (Infinity: none yet). */
  sinceFightHeal?: number;
  /** Behind something solid from the threat (the cover peek's hide phase): as good as out of their sight. */
  sheltered?: boolean;
};

export type HealPlan =
  | { act: 'use'; item: HealItem; slot: number; why: string }
  | { act: 'hide'; why: string }
  | { act: 'wait'; why: string };

const useSec = (k: HealItem) => (k === 'medkit' ? MEDKIT.useSec : POTIONS[k].useSec);

/** Heal items held (medkits + heal potions + shield potions). */
export const healsHeld = (p: PlayerState) => HEAL_ITEMS.reduce((n, k) => n + countOf(p.inv, k), 0);
/** Items that restore hp (medkits, heal potions): what the heal stock counts. */
export const hpHealsHeld = (p: PlayerState) => p.inv.medkits + (p.inv.potions.healPotion ?? 0);

/** True if using `k` now would do something (held, slotted, not wasted). */
function usable(p: PlayerState, k: HealItem, now: number): boolean {
  if (p.hotbar.indexOf(k as HotbarItem) < 0 || countOf(p.inv, k) <= 0) return false;
  if (k === 'medkit') return p.healAt === null && p.hp < PLAYER.hp;
  return uselessReason(p, k, now) === null;
}

/**
 * Best item to use now. `fast`: under fire, quickest first (1 s potions before the 2 s medkit), and only items that
 * finish within `within` s. Out of a fight: the medkit for a big hole (it heals the most), potions for the rest.
 */
export function pickHeal(p: PlayerState, now: number, fast: boolean, within = Infinity): HealItem | null {
  const missing = PLAYER.hp - (p.hp + p.healLeft);
  const order: HealItem[] = fast
    ? [...(missing >= 30 ? ['healPotion' as const] : []), 'shieldSmall', ...(missing >= 30 ? ['medkit' as const] : []), 'shieldBig', 'healPotion', 'medkit']
    : [...(missing >= 40 ? ['medkit' as const] : []), ...(missing >= 20 ? ['healPotion' as const] : []), 'shieldBig', 'shieldSmall', ...(missing >= 20 ? ['medkit' as const] : [])];
  for (const k of order) if (useSec(k) <= within && usable(p, k, now)) return k;
  return null;
}

const use = (p: PlayerState, item: HealItem | null, why: string): HealPlan | null =>
  item ? { act: 'use', item, slot: p.hotbar.indexOf(item), why } : null;

export function healPlan(s: HealSituation, H: HealParams): HealPlan | null {
  const { me, now, foe } = s;
  if (!me.alive || healsHeld(me) === 0) return null;
  if (me.healAt !== null || me.drinking) return { act: 'wait', why: 'healing' };
  if (now < me.busyUntil) return null;
  const eff = me.hp + me.shield + me.healLeft;
  const inFight = !!foe || s.hurtAgo < H.quietSec;
  if (!inFight) {
    if (me.hp + me.healLeft <= H.safeHp[s.diff]) return use(me, pickHeal(me, now, false), 'patching up between fights');
    // Shields out of a fight whenever they'd add something (the potion seller's whole point).
    const sh = (['shieldBig', 'shieldSmall'] as const).find((k) => usable(me, k, now));
    return use(me, sh ?? null, 'topping up shield');
  }
  // Weak players heal only once the fight is over.
  if (H.midFight[s.diff] < 0.5) return null;
  const burst = s.burst >= H.burst;
  const low = eff <= H.fightHp[s.diff] || (burst && eff <= H.fightHp[s.diff] + H.burstHp);
  if (!low) return null;
  // Commitment: one heal per exchange. Healed a moment ago: trade (or get out) instead, unless a burst just landed.
  if ((s.sinceFightHeal ?? Infinity) < H.reHealSec && !burst) return { act: 'wait', why: 'healed a moment ago: trading instead' };
  // Clearly ahead of the one in front of me: push the kill, don't give them time.
  if (foe && foe.eff + H.pressLead <= eff) return { act: 'wait', why: `pressing: I'm ahead (${Math.round(eff)} vs ${Math.round(foe.eff)})` };
  if (!foe || s.sheltered) return use(me, pickHeal(me, now, true), s.sheltered ? 'behind cover: healing mid-fight' : 'out of their sight: healing mid-fight');
  if (foe.eff <= H.pressHp && foe.eff <= eff) return { act: 'wait', why: `pressing: they're on ${Math.round(foe.eff)}` };
  if (foe.dist >= H.openDist) return use(me, pickHeal(me, now, true), 'they are far: healing');
  if (s.useReload && foe.reloadLeft > 0) {
    const r = use(me, pickHeal(me, now, true, foe.reloadLeft + H.reloadSlack), 'they are reloading: healing now');
    if (r) return r;
  }
  if (s.coverFirst && (s.hidingFor === null || s.hidingFor < H.hideSec)) return { act: 'hide', why: 'low: breaking line of sight to heal' };
  return use(me, pickHeal(me, now, true), 'no cover: healing in the open');
}

/** Heals (medkits + heal potions) to carry at this much cash (carried + banked). */
export function healStock(total: number, diff: Difficulty, H: HealParams): number {
  if (total < H.stockAt[diff]) return 0;
  return Math.min(H.stockMax, H.stock[diff] + Math.floor((total - H.stockAt[diff]) / H.stockPer));
}

/** Hotbar items a bot may drop to make room for a heal, with how much it wants to keep each (0..1). */
export type KeepWeights = HealParams['keep'];

/**
 * The slot to drop so a heal fits a full hotbar: the item worth least (its keep weight under `slotValue`). Guns other
 * than a spare pistol, the seal kit, scaffolds, charges and heals are never dropped. `needed` lists kinds the bot's
 * plans still want (never dropped). Null: nothing worth giving up.
 */
export function dropForHeal(p: PlayerState, H: HealParams, needed: ReadonlySet<HotbarItem>): number | null {
  if (p.hotbar.includes(null)) return null;
  const otherGun = (['smg', 'rifle', 'shotgun', 'sniper'] as const).some((g) => { const a = p.inv.weapons[g]; return !!a && a.mag + a.spare > 0; });
  let best: number | null = null, bestKeep = H.slotValue;
  for (const [i, k] of p.hotbar.entries()) {
    if (!k || needed.has(k)) continue;
    const w = k === 'pistol' ? (otherGun ? H.keep.pistol : Infinity) : (H.keep as Record<string, number>)[k];
    if (w === undefined || w >= bestKeep) continue;
    best = i; bestKeep = w;
  }
  return best;
}
