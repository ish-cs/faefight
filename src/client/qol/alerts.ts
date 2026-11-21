// Bunker-threat and generator alerts: pure decisions (no DOM, no Web Audio) so they can be unit-tested.

import { generatorSpec } from '../../sim/economy';
import type { PlayerState, Snapshot } from '../../sim/types';

/** Minimum gap between two alarms at the same (or a lower) blocked count; a higher count always sounds at once. */
export const ALARM_COOLDOWN_MS = 8000;
/** Minimum gap between two "Bunker reopened" toasts (a seal flickering open/closed stays quiet). */
export const REOPEN_COOLDOWN_MS = 5000;
/** Minimum gap between two generator toasts of the same kind. */
export const GEN_COOLDOWN_MS = 20000;

/** Per-key minimum gap. `allow` both checks and, when it passes, records the time. */
export class RateLimiter {
  private last = new Map<string, number>();
  constructor(private readonly gapMs: number) {}
  allow(key: string, nowMs: number): boolean {
    const t = this.last.get(key);
    if (t !== undefined && nowMs - t < this.gapMs) return false;
    this.last.set(key, nowMs);
    return true;
  }
  reset() { this.last.clear(); }
}

export type BunkerAlert =
  /** More doorways blocked (1 or 2): alarm at this level. */
  | { kind: 'alarm'; count: number }
  /** Was sealed, now at least one doorway is clear again. */
  | { kind: 'reopened' };

/**
 * Watches your own blocked-doorway count. Alarms only when the count rises because of someone else's
 * placement (your own building never alarms you), escalates immediately to a higher count, and otherwise
 * stays quiet for ALARM_COOLDOWN_MS. The seal itself (3/3) is voiced by the existing seal announcement.
 */
export class BunkerWatch {
  private prev: number | null = null;
  private alarmAt = -Infinity;
  private alarmCount = 0;
  private reopen = new RateLimiter(REOPEN_COOLDOWN_MS);

  reset() { this.prev = null; this.alarmAt = -Infinity; this.alarmCount = 0; this.reopen.reset(); }

  /** `byOthers`: the rise came with a placement by someone else (or a placement we can't attribute). */
  update(count: number, byOthers: boolean, nowMs: number): BunkerAlert | null {
    const prev = this.prev;
    this.prev = count;
    if (prev === null) return null; // first look (join / rejoin): just show the state, no sound
    if (prev === 3 && count < 3) return this.reopen.allow('reopen', nowMs) ? { kind: 'reopened' } : null;
    if (count <= prev || count >= 3 || !byOthers) return null;
    if (count <= this.alarmCount && nowMs - this.alarmAt < ALARM_COOLDOWN_MS) return null;
    this.alarmAt = nowMs;
    this.alarmCount = count;
    return { kind: 'alarm', count };
  }
}

/** Did this snapshot's rise in blocked doorways come from someone else? Unattributed (no placement seen) counts as yes. */
export function blockedByOthers(s: Snapshot, me: number): boolean {
  const placed = s.events.filter((e) => e.type === 'placed');
  return placed.length === 0 || placed.some((e) => e.data.by !== me);
}

export type GenAlert = { kind: 'full' | 'high'; stored: number; cap: number };

/**
 * Your home generator crossing the alert threshold (`pct` of its cap; 100 = only when full, 0 = off).
 * Fires once per crossing; re-arms only after the cash drops back below the threshold (you collected).
 * With a threshold under 100 % it also fires once more when the generator fills up.
 */
export class GenWatch {
  private prev: number | null = null;
  private limit = new RateLimiter(GEN_COOLDOWN_MS);

  reset() { this.prev = null; this.limit.reset(); }

  update(stored: number, level: number, pct: number, nowMs: number): GenAlert | null {
    const prev = this.prev;
    this.prev = stored;
    if (prev === null || pct <= 0) return null;
    const cap = generatorSpec(level).cap;
    const crossed = (at: number) => prev < at && stored >= at;
    if (crossed(cap)) return this.limit.allow('full', nowMs) ? { kind: 'full', stored, cap } : null;
    if (pct < 100 && crossed((cap * pct) / 100)) return this.limit.allow('high', nowMs) ? { kind: 'high', stored, cap } : null;
    return null;
  }
}

export const genAlertText = (a: GenAlert) =>
  a.kind === 'full' ? `Generator full: $${Math.floor(a.stored)} waiting` : `Generator ${Math.round((100 * a.stored) / a.cap)}%: $${Math.floor(a.stored)} waiting`;

export const doorsText = (n: number) => `Your bunker: ${n}/3 doorways blocked`;
export const SEALED_OUTSIDE_TEXT = 'Your bunker is SEALED: clear a doorway before you die';

/** Visible enemies standing on your island (hidden = out of your perception: never counted). */
export function enemiesOnIsland(s: Snapshot, me: PlayerState, isl: { center: { x: number; z: number }; radius: number }): number {
  const hidden = new Set(s.hidden ?? []);
  let n = 0;
  for (const p of s.players)
    if (p.id !== me.id && p.alive && !hidden.has(p.id) && Math.hypot(p.pos.x - isl.center.x, p.pos.z - isl.center.z) <= isl.radius + 1) n++;
  return n;
}
