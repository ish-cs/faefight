import { DT, WEAPONS } from '../sim/constants';
import { shotDamage } from '../sim/gunplay';
import type { MatchEvent, PlayerState, WeaponKind } from '../sim/types';

/**
 * Client-side shot prediction. Your own muzzle flash, tracer, shot sound and (when your aim ray is
 * on someone) hitmarker play the frame you fire instead of a round trip (plus the snapshot delay)
 * later. The host stays authoritative: when its 'shot' events for you arrive they are matched in
 * order to the predicted shots and flagged `echo` (consumers skip their effects: no double flash,
 * tracer or sound); 'hit' events answering a shot whose hit was already predicted are flagged
 * `echo` too (no second hitmarker; damage, kills and the target's reactions still come from them).
 * A shot the host fired but we didn't predict plays normally; a predicted shot the host never fired
 * just expires.
 */

/** Forget an unconfirmed predicted shot after this long (ms): longer than any sane RTT + jitter buffer. */
export const PREDICT_EXPIRE_MS = 1500;

type Pending = { at: number; weapon: WeaponKind; hit: boolean };

/** The sim fires on 30 Hz ticks: the time between shots is 1/rps rounded up to whole ticks. */
export function firePeriodMs(w: WeaponKind): number {
  return Math.ceil(1 / WEAPONS[w].rps / DT - 1e-9) * DT * 1000;
}

/** Unit aim vector for look angles (same convention as the sim's combat.aimDir). */
export function aimDirection(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

/**
 * Damage a predicted hit at `dist` metres would do: the sim's own shotDamage (falloff, headshot), and the
 * `falloff` tag the sim puts on reduced hits, so a predicted hit carries exactly what the host will send.
 */
export function predictedHit(w: WeaponKind, dist: number, head: boolean): { amount: number; falloff?: number } {
  const { amount, mult } = shotDamage(w, dist, head);
  return mult < 1 ? { amount, falloff: Math.round(mult * 100) / 100 } : { amount };
}

export class ShotPredictor {
  private pending: Pending[] = [];
  private nextAt = 0;
  /** Counters (debug/tests). */
  stats = { predicted: 0, confirmed: 0, expired: 0, unpredicted: 0 };

  /**
   * Fire held/clicked this frame: returns the weapon if a shot should be shown now. `me` is your
   * player in the newest snapshot (ammo, reload, gun in hand).
   */
  tryFire(me: PlayerState | undefined, nowMs: number): WeaponKind | null {
    this.expire(nowMs);
    if (!me?.alive) return null;
    const w = me.equipped;
    if (w === 'fists' || me.reloadUntil > 0 || nowMs < this.nextAt) return null;
    const mag = me.inv.weapons[w]?.mag ?? 0;
    const unconfirmed = this.pending.reduce((n, p) => n + (p.weapon === w ? 1 : 0), 0);
    if (mag - unconfirmed <= 0) return null;
    this.nextAt = nowMs + firePeriodMs(w);
    this.pending.push({ at: nowMs, weapon: w, hit: false });
    this.stats.predicted++;
    return w;
  }

  /** The shot just returned by tryFire put a hitmarker on screen. */
  markHit(): void {
    const p = this.pending[this.pending.length - 1];
    if (p) p.hit = true;
  }

  /** Newest snapshot's events (call once per snapshot, as it arrives): flag the echoes of predicted shots. */
  reconcile(events: MatchEvent[], myId: number, nowMs: number): void {
    this.expire(nowMs);
    let hitShown = false;
    for (const e of events) {
      if (e.type === 'shot' && e.data.by === myId) {
        const p = this.pending.shift();
        if (!p) { this.stats.unpredicted++; hitShown = false; continue; }
        e.data.echo = true;
        hitShown = p.hit;
        this.stats.confirmed++;
      } else if (e.type === 'hit' && e.data.by === myId && hitShown) {
        e.data.echo = true;
      }
    }
  }

  /** Weapon changed / died: predictions in flight still get matched, but no cooldown carries over. */
  reset(): void { this.nextAt = 0; }

  get inFlight() { return this.pending.length; }

  private expire(nowMs: number) {
    while (this.pending.length && nowMs - this.pending[0].at > PREDICT_EXPIRE_MS) { this.pending.shift(); this.stats.expired++; }
  }
}
