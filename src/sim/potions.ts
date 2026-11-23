import { ELIM, HEAL_POTION, MAP, PLAYER, POTIONS, SHIELD_MAX, SHIELD_POTIONS, SPEED_POTION } from './constants';
import { POTION_KINDS, isPotionItem, removeIfEmpty } from './hotbar';
import type { PlayerState, PotionKind, PotionShop, ShopItem, Vec3 } from './types';
import { v3 } from './vec';

/**
 * Potions: shield, heal-over-time and speed. Sold only by potion seller NPCs (any player may buy
 * there); the home-island shop keeps everything else, medkits included.
 */
export type ShopKind = 'home' | 'potion';
export const POTION_SHOP_ITEMS: readonly PotionKind[] = POTION_KINDS;
export const SHOP_LABEL: Partial<Record<ShopItem, string>> = {
  shieldSmall: 'Small shield potion', shieldBig: 'Big shield potion', healPotion: 'Heal potion', speedPotion: 'Speed potion', grapple: 'Grappling hook',
};

export const shopFor = (item: ShopItem): ShopKind => (isPotionItem(item) ? 'potion' : 'home');
/** Sold at both counters: the grappling hook (a traveller's tool: the neutral seller stocks it too, so nobody is stuck out there). */
export const soldAt = (item: ShopItem, at: ShopKind): boolean => shopFor(item) === at || item === 'grapple';

/**
 * Where the potion sellers stand. TEMPORARY: until the neutral centre island lands (map work), one
 * seller at the map centre at ground height. Tests/e2e move it with `Match.debugSetPotionShops`.
 */
export function defaultPotionShops(): PotionShop[] {
  return [{ id: 0, pos: v3(0, MAP.groundY, 0) }];
}

export const potionShopsAt = (positions: Vec3[]): PotionShop[] => positions.map((pos, id) => ({ id, pos: { ...pos } }));

type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

/** Why drinking `kind` now would do nothing (null = it would help). */
export function uselessReason(p: PlayerState, kind: PotionKind, now: number): string | null {
  if (kind === 'shieldSmall' || kind === 'shieldBig') {
    const cap = SHIELD_POTIONS[kind].cap;
    if (p.shield >= cap) return cap < SHIELD_MAX ? `small shields only fill to ${cap}` : 'shield already full';
    return null;
  }
  if (kind === 'healPotion') {
    if (p.hp >= PLAYER.hp) return 'already at full health';
    if (p.hp + p.healLeft >= PLAYER.hp) return 'already healing to full';
    return null;
  }
  return now < p.speedUntil ? 'speed boost already active' : null;
}

/** Starts drinking the potion in the selected slot: consumed now, takes effect after its drink time. */
export function startDrink(p: PlayerState, now: number): Result {
  if (!p.alive) return fail('dead');
  const kind = p.hotbar[p.selected];
  if (!isPotionItem(kind)) return fail('select a potion first');
  if ((p.inv.potions[kind] ?? 0) <= 0) return fail('no potions');
  if (now < p.busyUntil) return fail('busy');
  const useless = uselessReason(p, kind, now);
  if (useless) return fail(useless);
  const left = (p.inv.potions[kind] ?? 0) - 1;
  if (left > 0) p.inv.potions[kind] = left; else delete p.inv.potions[kind];
  removeIfEmpty(p.hotbar, p.inv);
  p.drinking = { kind, doneAt: now + POTIONS[kind].useSec };
  p.busyUntil = p.drinking.doneAt;
  return { ok: true };
}

/** Finishes a drink whose time is up, and trickles heal-over-time into hp. */
export function tickPotions(p: PlayerState, now: number, dt: number): void {
  if (!p.alive) return;
  const d = p.drinking;
  if (d && now >= d.doneAt - 1e-9) {
    p.drinking = null;
    if (d.kind === 'shieldSmall' || d.kind === 'shieldBig') {
      const s = SHIELD_POTIONS[d.kind];
      p.shield = Math.max(p.shield, Math.min(s.cap, p.shield + s.amount));
    } else if (d.kind === 'healPotion') {
      p.healLeft += HEAL_POTION.amount;
    } else {
      p.speedUntil = now + SPEED_POTION.sec;
    }
    return;
  }
  if (p.healLeft > 0) {
    const h = Math.min(p.healLeft, (HEAL_POTION.amount / HEAL_POTION.overSec) * dt);
    p.healLeft = h >= p.healLeft - 1e-9 ? 0 : p.healLeft - h;
    p.hp = Math.min(PLAYER.hp, p.hp + h);
  }
}

/** Movement multiplier from an active speed potion and a victory surge (they stack). */
export const speedMult = (p: PlayerState, now: number) =>
  (now < p.speedUntil ? SPEED_POTION.mult : 1) * (now < (p.surgeUntil ?? 0) ? ELIM.surgeSpeed : 1);
