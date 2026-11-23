import { ELIM, LIFECYCLE, PLAYER, SHIELD_MAX } from './constants';
import type { MatchStateCore } from './lifecycle';
import { isAlly } from './teams';
import type { MatchEvent, PlayerState } from './types';

/**
 * Elimination rewards (the user's ideas 1 + 3 + 6, 2026-11-22): who gets the credit for putting a player out for
 * good, the spoils of war, the victory surge, and the 'elimination' event the HUD, commentator and director use.
 *
 * Credit:
 * - killed by a player while their bunker was sealed, or while trapped in it (the breakout window): the killer,
 *   the bunker's sealer (and other plug placers) assist;
 * - sealed while dead (or walked into a sealed bunker) and failed to break out: the sealer who placed the last plug,
 *   other players with pieces in the seal assist;
 * - nobody to credit that way (sudden death's forced seal): whoever hit them last within ELIM.creditHitSec.
 * Teammates of the victim never get credit.
 *
 * Spoils (ELIM): the victim's vault cash + a share of the cash in their death drop + their generator's stored cash,
 * split eliminatorShare / the rest among assists, into carried cash. Surge: full hp, shield, speed (potions.speedMult).
 *
 * All state lives in the plain-data ElimLedger on the Match (forked with it, saved in host-migration checkpoints).
 */
export type ElimLedger = {
  /** Per island: who placed the closing plug of the current seal and who else has pieces in it (null = not sealed). */
  seal: ({ by: number; placers: number[] } | null)[];
  /** Per player id: their last death to a player (killer, and whether their bunker was sealed at that moment). */
  death: Record<number, { at: number; killer: number | null; sealed: boolean }>;
  /** Per player id: the last player to damage them. */
  lastHit: Record<number, { by: number; at: number }>;
};

export const newElimLedger = (islands: number): ElimLedger => ({ seal: Array.from({ length: islands }, () => null), death: {}, lastHit: {} });

export type ElimHow = 'killed' | 'trapped' | 'other';
export type Credit = { by: number | null; assists: number[]; how: ElimHow };

/**
 * Who gets the elimination. `killer`: the player kill that ended them this tick (null = no player kill). Pure, so the
 * three credit cases are unit-tested directly.
 */
export function creditFor(
  victim: PlayerState, players: Map<number, PlayerState>, led: ElimLedger, killer: number | null, now: number, forcedSeal: boolean,
): Credit {
  const ok = (id: number | null | undefined): id is number => {
    if (id === null || id === undefined || id === victim.id) return false;
    const p = players.get(id);
    return !!p && !isAlly(p, victim);
  };
  const seal = led.seal[victim.island];
  const sealers = seal ? [seal.by, ...seal.placers] : [];
  const assistsBut = (by: number | null) => [...new Set(sealers.filter((id) => ok(id) && id !== by))].sort((a, b) => a - b);
  if (ok(killer)) return { by: killer, assists: assistsBut(killer), how: 'killed' };
  // Killed while sealed in, then failed to break out (or sudden death made it final): still the killer's.
  const d = led.death[victim.id];
  if (d && ok(d.killer) && (d.sealed || forcedSeal) && now - d.at <= LIFECYCLE.respawnSec + LIFECYCLE.breakoutSec + 2)
    return { by: d.killer, assists: assistsBut(d.killer), how: 'killed' };
  if (seal && ok(seal.by)) return { by: seal.by, assists: assistsBut(seal.by), how: 'trapped' };
  const h = led.lastHit[victim.id];
  if (h && ok(h.by) && now - h.at <= ELIM.creditHitSec) return { by: h.by, assists: assistsBut(h.by), how: 'other' };
  return { by: null, assists: [], how: 'other' };
}

/** Takes the spoils from the victim (vault, share of the drop bag's cash, generator). Integers only. */
export function takeSpoils(s: MatchStateCore, victim: PlayerState, bagId: number | null): number {
  const vault = Math.floor(victim.vault.cash);
  victim.vault.cash -= vault;
  let carried = 0;
  const bag = bagId !== null ? s.loot.get(bagId) : undefined;
  if (bag) {
    carried = Math.floor(bag.inv.cash * ELIM.carriedShare);
    bag.inv.cash -= carried;
  }
  let gen = 0;
  const g = s.generators.find((x) => x.island === victim.island);
  if (g) { gen = Math.floor(g.stored); g.stored -= gen; }
  return vault + carried + gen;
}

/** What takeSpoils would collect from `p` now (their drop share counted from carried cash), in $10 steps; 0 once out. */
export function bountyOf(s: MatchStateCore, p: PlayerState): number {
  if (p.eliminated) return 0;
  const g = s.generators.find((x) => x.island === p.island);
  const v = Math.floor(p.vault.cash) + Math.floor(p.inv.cash * ELIM.carriedShare) + Math.floor(g?.stored ?? 0);
  return Math.floor(v / 10) * 10;
}

/** Eliminator's and assists' cuts of `total` (integers summing to total; ascending assist ids). */
export function splitSpoils(total: number, by: number, assists: number[]): [number, number][] {
  if (!assists.length) return [[by, total]];
  const each = Math.floor((total * (1 - ELIM.eliminatorShare)) / assists.length);
  return [[by, total - each * assists.length], ...assists.map((id): [number, number] => [id, each])];
}

/** Victory surge for the eliminator (alive only); a small shield for assists. */
export function surge(p: PlayerState, now: number, assist: boolean): void {
  if (!p.alive) return;
  if (assist) { p.shield = Math.min(SHIELD_MAX, p.shield + ELIM.assistShield); return; }
  p.hp = PLAYER.hp;
  p.shield = Math.min(SHIELD_MAX, p.shield + ELIM.surgeShield);
  p.surgeUntil = now + ELIM.surgeSec;
}

/**
 * Once per tick, after seals are updated: learn from this tick's hits / kills / escapes, then credit each
 * 'eliminated' event. Returns the 'elimination' events to append.
 */
export function resolveEliminations(
  s: MatchStateCore, led: ElimLedger, events: readonly MatchEvent[], now: number, sealedNow: (island: number) => boolean,
): MatchEvent[] {
  const kills = new Map<number, { killer: number | null; bag: number | null }>();
  for (const e of events) {
    const d = e.data;
    if (e.type === 'hit' && typeof d.by === 'number' && d.by !== d.target) led.lastHit[d.target as number] = { by: d.by, at: e.t };
    else if (e.type === 'escaped') delete led.death[d.player as number];
    else if (e.type === 'kill') {
      const v = d.victim as number, p = s.players.get(v);
      const killer = typeof d.killer === 'number' ? d.killer : null;
      kills.set(v, { killer, bag: typeof d.bag === 'number' ? d.bag : null });
      // Player kills only: the breakout running out is a killer-less death that must not hide who killed them before.
      if (p && killer !== null && killer !== v) led.death[v] = { at: e.t, killer, sealed: sealedNow(p.island) };
    }
  }
  const out: MatchEvent[] = [];
  for (const e of events) {
    if (e.type !== 'eliminated') continue;
    const victim = s.players.get(e.data.player as number);
    if (!victim) continue;
    const k = kills.get(victim.id);
    const c = creditFor(victim, s.players, led, k?.killer ?? null, now, s.forcedSeal);
    delete led.death[victim.id];
    if (c.by === null) {
      out.push({ t: now, type: 'elimination', data: { victim: victim.id, by: null, assists: [], how: c.how, spoils: 0, shares: [] } });
      continue;
    }
    const total = takeSpoils(s, victim, k?.bag ?? null);
    const shares = splitSpoils(total, c.by, c.assists);
    for (const [id, amt] of shares) {
      const p = s.players.get(id)!;
      p.inv.cash += amt;
      surge(p, now, id !== c.by);
    }
    out.push({ t: now, type: 'elimination', data: { victim: victim.id, by: c.by, assists: c.assists, how: c.how, spoils: total, shares } });
  }
  return out;
}
