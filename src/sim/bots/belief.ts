import type { WeaponKind } from '../types';
import { dist2D } from '../vec';
import type { BotView } from './view';

/**
 * What a bot believes about each enemy (bot-cognition spec §2, phase P1 subset), built only from its view (sightings,
 * tracers, hits on me, scoreboard): no hidden state. Memory (mind.ts) stays the observation log; this is the model on
 * top of it. P1 keeps the fields its rules use; `where`, `cash`, `sealIntent` and `hpEst` come with later phases.
 */
export type EnemyBelief = {
  id: number;
  lastSeen: { t: number } | null;
  /** Pseudo-counts of the gun seen in their hands (one per second of sight) and fired at me. */
  weapon: Partial<Record<WeaponKind, number>>;
  /** EMA of the distance (m) at which they hit me: their preferred range against me. 0 = never hit me. */
  engageDist: number;
  /** Damage they did to me this match. */
  dmgToMe: number;
  /** Scoreboard kills (the composite threat's main term). */
  kills: number;
};

const EMA = 0.3;

export class Beliefs {
  readonly of = new Map<number, EnemyBelief>();
  private lastSec = -Infinity;
  private doneHurt = -Infinity;

  private get(id: number): EnemyBelief {
    let b = this.of.get(id);
    if (!b) { b = { id, lastSeen: null, weapon: {}, engageDist: 0, dmgToMe: 0, kills: 0 }; this.of.set(id, b); }
    return b;
  }

  update(view: BotView) {
    const now = view.now, me = view.self;
    for (const o of view.others) this.get(o.id).kills = o.kills;
    const sec = now - this.lastSec >= 1;
    if (sec) this.lastSec = now;
    for (const e of view.enemies) {
      const b = this.get(e.id);
      b.lastSeen = { t: now };
      if (sec && e.equipped !== 'fists') b.weapon[e.equipped] = (b.weapon[e.equipped] ?? 0) + 1;
    }
    let top = this.doneHurt;
    for (const h of view.hurt) {
      if (h.t <= this.doneHurt || h.by === null || h.by === me.id) continue;
      top = Math.max(top, h.t);
      const b = this.get(h.by);
      b.dmgToMe += h.amount;
      const e = view.enemies.find((x) => x.id === h.by);
      if (e) {
        const d = dist2D(e.pos, me.pos);
        b.engageDist = b.engageDist === 0 ? d : b.engageDist + EMA * (d - b.engageDist);
        if (e.equipped !== 'fists') b.weapon[e.equipped] = (b.weapon[e.equipped] ?? 0) + 1;
      }
    }
    this.doneHurt = top;
  }

  /** Their most-seen gun (null before any sighting). */
  static mainGun(b: EnemyBelief): WeaponKind | null {
    let best: WeaponKind | null = null, n = 0;
    for (const [k, v] of Object.entries(b.weapon) as [WeaponKind, number][]) if (v > n) { best = k; n = v; }
    return best;
  }

  /** A rifle user who hits me from at least `m` metres (the 8a2134 loss): answer with a rifle of my own. */
  rifleUser(m: number): EnemyBelief | null {
    for (const b of this.of.values()) if (Beliefs.mainGun(b) === 'rifle' && b.engageDist >= m) return b;
    return null;
  }
}
