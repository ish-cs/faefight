import * as dm from '../dmath';
import type { Vec3 } from '../types';
import { clone, v3 } from '../vec';
import { islandAt } from './nav';
import type { Traits } from './personality';
import type { BotView } from './view';

/** Where a rival was last seen and how they looked. */
export type Sighting = { pos: Vec3; t: number; hp: number; armed: boolean; island: number };

const GRUDGE_HALF_LIFE = 30;
/** A rival seen shooting someone else (or just in the kill feed as a killer) is busy/weakened this long. */
const BUSY_SEC = 6;
/** A tracer passing this close to me was aimed at me. */
const SHOT_AT_ME = 2.5;

function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = v3(b.x - a.x, b.y - a.y, b.z - a.z);
  const l2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / l2));
  return Math.hypot(a.x + ab.x * t - p.x, a.y + ab.y * t - p.y, a.z + ab.z * t - p.z);
}

/** A bot's short-term memory, built only from what its view shows (sightings, hits, tracers, kill feed). */
export class Memory {
  readonly seen = new Map<number, Sighting>();
  readonly busyUntil = new Map<number, number>();
  readonly diedAt = new Map<number, number>();
  lastHurtAt = -Infinity;
  lastHurtBy: number | null = null;
  private grudge = new Map<number, number>();
  private doneHurt = -Infinity;
  private doneShot = -Infinity;
  private doneFeed = -Infinity;
  private lastNow = NaN;

  update(view: BotView) {
    const now = view.now, me = view.self;
    const dt = Number.isNaN(this.lastNow) ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    if (dt > 0) {
      const k = dm.exp(-Math.LN2 * dt / GRUDGE_HALF_LIFE); // 0.5^(dt/half-life)
      for (const [id, g] of this.grudge) {
        if (g * k < 0.5) this.grudge.delete(id);
        else this.grudge.set(id, g * k);
      }
    }
    for (const e of view.enemies)
      this.seen.set(e.id, { pos: clone(e.pos), t: now, hp: e.hp, armed: e.equipped !== 'fists', island: islandAt(view.map, e.pos) });
    // Teams: what my teammates see counts as seen (shared team info).
    for (const e of view.teamSeen ?? [])
      if (!view.enemies.some((x) => x.id === e.id)) this.seen.set(e.id, { pos: clone(e.pos), t: now, hp: e.hp, armed: e.armed, island: islandAt(view.map, e.pos) });

    let top = this.doneHurt;
    for (const h of view.hurt) {
      if (h.t <= this.doneHurt) continue;
      top = Math.max(top, h.t);
      if (h.t >= this.lastHurtAt) { this.lastHurtAt = h.t; this.lastHurtBy = h.by; }
      if (h.by !== null && h.by !== me.id) this.grudge.set(h.by, (this.grudge.get(h.by) ?? 0) + h.amount);
    }
    this.doneHurt = top;

    top = this.doneShot;
    const chest = v3(me.pos.x, me.pos.y + 1.2, me.pos.z);
    for (const s of view.shots) {
      if (s.t <= this.doneShot) continue;
      top = Math.max(top, s.t);
      if (me.alive && segDist(chest, s.from, s.to) < SHOT_AT_ME) this.grudge.set(s.by, (this.grudge.get(s.by) ?? 0) + 3);
      else this.busyUntil.set(s.by, s.t + BUSY_SEC);
    }
    this.doneShot = top;

    top = this.doneFeed;
    for (const f of view.feed) {
      if (f.t <= this.doneFeed) continue;
      top = Math.max(top, f.t);
      this.diedAt.set(f.victim, f.t);
      if (f.killer !== null && f.killer !== me.id) this.busyUntil.set(f.killer, f.t + BUSY_SEC);
    }
    this.doneFeed = top;
  }

  grudgeOf(id: number): number { return this.grudge.get(id) ?? 0; }

  /** Last sighting no older than `sec`. */
  recent(id: number, now: number, sec: number): Sighting | null {
    const s = this.seen.get(id);
    return s && now - s.t <= sec ? s : null;
  }
}

/** Everything a bot weighs about one rival when choosing whom to go after. */
export type RivalFacts = {
  id: number;
  /** A finished route of bridges exists from where I am (or I'm already there). */
  reach: boolean;
  /** Scaffolds still needed to bridge from my island (0 when reachable). */
  scaffolds: number;
  /** Metres from me to their island. */
  dist: number;
  /** Dead and waiting to respawn (the seal window). */
  respawning: boolean;
  /** Seconds since they last died (Infinity if never seen dying). */
  sinceDeath: number;
  /** Their bunker is sealed: killing them eliminates them. */
  sealed: boolean;
  /** HP when last seen (recently), else null. */
  seenHp: number | null;
  grudge: number;
  /** Seen fighting someone else just now. */
  busy: boolean;
  kills: number;
  leaderKills: number;
  /** Seen on my island recently. */
  onMyIsland: boolean;
  /** Seen away from their own island recently (home unguarded). */
  away: boolean;
  /** I carry a full seal kit. */
  kit?: boolean;
  /** Trapped in their sealed bunker right now (breakout running): a kill finishes them. */
  trapped?: boolean;
  /** Spoils their elimination would pay ($, scoreboard bounty). */
  bounty?: number;
};

/** Spoils of war in rival choice (params drive.spoilsTarget per $1000 of bounty, drive.finishTrapped). */
export type SpoilsWeights = { perK: number; trapped: number };

/** Desirability of going after this rival; higher is better. Personality only shifts weights. */
export function rivalScore(f: RivalFacts, t: Traits, sealAwayTarget = 0.6, spoils: SpoilsWeights = { perK: 0, trapped: 0 }): number {
  let s = 1;
  s -= f.reach ? 0 : Math.min(2, f.scaffolds * 0.06 * (1.2 - 0.4 * t.aggression));
  s -= (f.dist / 100) * (0.25 + 0.35 * t.aggression);
  if (f.respawning) s += (f.reach ? 1 : 0.35) * (0.4 + t.opportunism);
  else if (f.sinceDeath < 40) s += 0.6 * (0.3 + t.opportunism) * (1 - f.sinceDeath / 40);
  if (f.sealed) s += 0.4 + 0.5 * t.opportunism;
  if (f.seenHp !== null) s += (1 - f.seenHp / 100) * 0.6 * (0.3 + t.opportunism);
  s += Math.min(1.5, f.grudge / 35) * (0.2 + t.vengeance);
  if (f.busy) s += 0.5 * t.opportunism;
  if (f.kills > 0 && f.kills >= f.leaderKills) s += 0.15 + 0.25 * t.aggression;
  if (f.onMyIsland) s += 0.5 + 0.6 * t.caution;
  if (f.away && !f.sealed) s += 0.35 * t.opportunism;
  // Kit in hand, owner out and their island in walking reach: seal the empty bunker.
  if (f.kit && f.away && f.reach && !f.sealed) s += sealAwayTarget;
  s += spoilsBonus(f, spoils);
  return s;
}

/**
 * Spoils of war: a rival whose death would eliminate them now (sealed, or trapped mid-breakout) is worth their bounty
 * (capped at $1500), and a trapped one in walking reach is a finish to go and take before they break out.
 */
export function spoilsBonus(f: RivalFacts, w: SpoilsWeights): number {
  if (!f.sealed && !f.trapped) return 0;
  return (w.perK * Math.min(1500, f.bounty ?? 0)) / 1000 + (f.trapped && f.reach ? w.trapped : 0);
}

/** Bonus the current target keeps over challengers, so the bot does not flip-flop. */
export const commitment = (t: Traits) => 0.15 + 0.35 * t.patience;
