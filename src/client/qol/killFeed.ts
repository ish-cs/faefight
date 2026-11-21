import type { MatchEvent } from '../../sim/types';

/**
 * Kill feed (pure): turns a snapshot's events into feed entries (who killed whom, with what, and how:
 * headshot / explosion / fall / water / storm) plus seal entries, and keeps the visible list: newest
 * first, at most FEED_MAX, each fading out over its last FEED_FADE_MS (CSS) and gone after FEED_LIFE_MS.
 */

export const FEED_MAX = 5;
export const FEED_LIFE_MS = 6000;
export const FEED_FADE_MS = 1000;

export type FeedMarker = 'headshot' | 'explosion' | 'fall' | 'water' | 'storm' | 'lightning';

export type FeedEntry = {
  kind: 'kill' | 'sealed';
  /** Kill: who got it (null: the world did). Seal: who placed the closing piece (null: unknown). */
  killer: number | null;
  /** Kill: who died. Seal: the bunker's owner (null if the island has no owner). */
  victim: number | null;
  /** Seal: the island whose bunker closed. */
  island?: number;
  /** Icon key (pistol, rocket, grenade, charge…), null when unknown. */
  weapon: string | null;
  markers: FeedMarker[];
  /** Your kill / your seal: highlighted. */
  mine: boolean;
  /** You died / your bunker was sealed. */
  me: boolean;
};

const BLASTS = new Set(['rocket', 'grenade', 'charge']);

export type FeedCtx = {
  humanId: number;
  /** Owner (player id) of an island, if any. */
  ownerOf(island: number): number | null;
};

/** Feed entries for one snapshot's events, in event order. */
export function feedEntries(events: readonly MatchEvent[], ctx: FeedCtx): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const e of events) {
    const d = e.data;
    if (e.type === 'kill' && typeof d.victim === 'number') {
      const victim = d.victim;
      const killer = typeof d.killer === 'number' && d.killer !== victim ? d.killer : null;
      const self = d.killer === victim;
      // The killing hit is in the same tick (it may come after the kill event in the list).
      // Prefer the killer's last hit on the victim; else the last hit on them at all.
      let hit: Record<string, unknown> | null = null, anyHit: Record<string, unknown> | null = null;
      for (const h of events) {
        if (h.type !== 'hit' || h.data.target !== victim || h.t !== e.t) continue;
        anyHit = h.data;
        if (h.data.by === d.killer) hit = h.data;
      }
      hit ??= anyHit;
      const markers: FeedMarker[] = [];
      let weapon = typeof hit?.weapon === 'string' ? hit.weapon : null;
      if (hit?.part === 'head') markers.push('headshot');
      if (weapon && BLASTS.has(weapon)) markers.push('explosion');
      if (weapon === 'fall') { markers.push('fall'); weapon = null; }
      // The sim names world causes (the storm ring, a lightning strike); a plain drowning is water.
      if (d.cause === 'storm' || d.cause === 'lightning') { markers.push(d.cause); weapon = null; }
      else if (d.inWater === true) { markers.push('water'); weapon = null; }
      if (self && !weapon && !markers.length) markers.push('explosion');
      out.push({
        kind: 'kill', killer, victim, weapon, markers,
        mine: killer === ctx.humanId, me: victim === ctx.humanId,
      });
    } else if (e.type === 'sealed' && typeof d.island === 'number') {
      const owner = typeof d.owner === 'number' ? d.owner : ctx.ownerOf(d.island);
      const by = typeof d.by === 'number' ? d.by : null;
      out.push({
        kind: 'sealed', killer: by, victim: owner, island: d.island, weapon: null, markers: [],
        mine: by !== null && by === ctx.humanId && owner !== ctx.humanId, me: owner === ctx.humanId,
      });
    }
  }
  return out;
}

const CAUSE: Record<FeedMarker, string> = {
  headshot: 'died', explosion: 'blew up', fall: 'fell', water: 'drowned', storm: 'was caught in the storm', lightning: 'was struck by lightning',
};

/** Plain text of an entry ("A ⟶ B", "B drowned", "A sealed B's bunker"); `name` gives "You" for you. */
export function feedText(e: FeedEntry, name: (id: number) => string): string {
  if (e.kind === 'sealed') {
    const owner = e.victim === null ? 'a' : e.me ? 'your' : `${name(e.victim)}'s`;
    return e.killer === null ? `${e.me ? 'Your' : e.victim === null ? 'A' : `${name(e.victim)}'s`} bunker sealed` : `${name(e.killer)} sealed ${owner} bunker`;
  }
  const victim = e.victim === null ? '?' : name(e.victim);
  if (e.killer !== null) return `${name(e.killer)} ⟶ ${victim}`;
  const cause = e.markers.find((m) => m !== 'headshot');
  return `${victim} ${cause ? CAUSE[cause] : 'died'}`;
}

/** The visible list: newest first, capped, expiring. T = whatever the HUD keeps per entry (its node). */
export class FeedList<T> {
  items: { at: number; value: T }[] = [];

  /** Add an entry; returns the ones pushed off the end (to remove from the screen). */
  push(value: T, now: number): T[] {
    this.items.unshift({ at: now, value });
    return this.items.splice(FEED_MAX).map((x) => x.value);
  }

  /** Drop expired entries; returns them. */
  expire(now: number): T[] {
    const gone = this.items.filter((x) => now - x.at >= FEED_LIFE_MS);
    if (gone.length) this.items = this.items.filter((x) => now - x.at < FEED_LIFE_MS);
    return gone.map((x) => x.value);
  }
}
