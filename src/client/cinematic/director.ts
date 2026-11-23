/**
 * Cinematic mode: the broadcast director. Picks the most exciting storyline (interest.ts) and decides when to
 * cut, with hysteresis: a shot holds at least MIN_SHOT seconds unless something much bigger happens (a kill,
 * an elimination, a rocket, a seal), and at most MAX_SHOT before the angle changes. Pure logic (sim time in,
 * shots out); the camera that frames each shot lives in camera.ts.
 *
 * Commentary (part 2) listens through `director.on('shot' | 'active')` and reads `director.summary()`.
 */
import { InterestTracker, scoreOf, type InterestSnap, type ShotKind, type ShotReason, type Storyline } from './interest';

export type { ShotKind, ShotReason } from './interest';

export interface ShotEvent { playerId: number; reason: ShotReason; kind: ShotKind; otherId?: number; score: number; t: number }
export interface InterestSummary { featured: number | null; storylines: { reason: ShotReason; playerId: number; otherId?: number; score: number }[]; alive: number; t: number }
/** A shot in progress: the event plus where the camera should centre (orbit/drone) and when it started. */
export type Shot = ShotEvent & { at?: { x: number; y: number; z: number }; startedAt: number; seq: number };

/** Hysteresis (s of sim time) and switching margins. */
export const CUT = {
  /** A shot holds at least this long… */
  minShot: 5,
  /** …and changes (another player or angle) after this long. */
  maxShot: 12,
  /** A big moment may interrupt after this long, if it beats the current shot by `preemptMargin`. */
  preemptAfter: 1.5,
  preemptMargin: 2,
  /** After minShot: switch when the best storyline beats the current one by this factor plus `margin`. */
  ratio: 1.25,
  margin: 0.5,
  /** The opening establishing shot. */
  opening: 4,
  /** Quiet moments: up to this much bonus for a player not featured for `freshSec`. */
  freshBonus: 1.5,
  freshSec: 60,
  /** Re-score at most this often (Hz). */
  scoreHz: 6,
} as const;
const BIG: ReadonlySet<ShotReason> = new Set(['elimination', 'rocket', 'seal']);

type Listener<T> = (v: T) => void;

export class Director {
  private tracker = new InterestTracker();
  private shotListeners = new Set<Listener<ShotEvent>>();
  private activeListeners = new Set<Listener<boolean>>();
  private _active = false;
  private lines: Storyline[] = [];
  private lastScoreAt = -Infinity;
  private aliveCount = 0;
  private now = 0;
  private seqN = 0;
  /** When each player was last featured (quiet moments rotate through the field). */
  private shownAt = new Map<number, number>();
  shot: Shot | null = null;
  /** Cuts made since cinematic mode started (e2e). */
  cuts = 0;

  get active() { return this._active; }
  /** Players alive at the last scoring. */
  get alive() { return this.aliveCount; }

  on(ev: 'shot', fn: Listener<ShotEvent>): () => void;
  on(ev: 'active', fn: Listener<boolean>): () => void;
  on(ev: 'shot' | 'active', fn: Listener<ShotEvent> | Listener<boolean>): () => void {
    const set = (ev === 'shot' ? this.shotListeners : this.activeListeners) as Set<typeof fn>;
    set.add(fn);
    return () => { set.delete(fn); };
  }

  setActive(on: boolean) {
    if (on === this._active) return;
    this._active = on;
    this.shot = null;
    this.cuts = 0;
    this.lastScoreAt = -Infinity;
    if (!on) { this.tracker.reset(); this.shownAt.clear(); }
    console.info(`[cinematic] ${on ? 'on' : 'off'}`);
    for (const fn of this.activeListeners) fn(on);
  }

  summary(): InterestSummary {
    const seen = new Set<string>();
    const storylines: InterestSummary['storylines'] = [];
    for (const l of this.lines) {
      if (l.reason === 'idle') continue;
      const k = `${l.reason}:${l.playerId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      storylines.push({ reason: l.reason, playerId: l.playerId, ...(l.otherId !== undefined ? { otherId: l.otherId } : {}), score: Math.round(l.score * 100) / 100 });
      if (storylines.length >= 3) break;
    }
    return { featured: this.shot?.playerId ?? null, storylines, alive: this.aliveCount, t: this.now };
  }

  /** Feed every new snapshot (cheap when the tick hasn't changed). Returns the shot to frame. */
  update(s: InterestSnap): Shot | null {
    if (!this._active) return null;
    this.tracker.ingest(s);
    const t = s.time;
    this.now = t;
    if (t - this.lastScoreAt < 1 / CUT.scoreHz && this.shot) return this.shot;
    this.lastScoreAt = t;
    this.lines = this.tracker.storylines(s);
    this.aliveCount = s.players.filter((p) => p.alive).length;
    const best = this.lines[0];
    if (!best) return this.shot;
    if (!this.shot) {
      // Opening: a wide establishing shot of the busiest player, then the director takes over.
      this.cut({ ...best, kind: best.kind === 'shoulder' ? 'wide' : best.kind }, t);
      return this.shot;
    }
    const cur = this.shot;
    const age = t - cur.startedAt;
    const curNow = this.currentScore(cur);
    const featuredGone = !s.players.find((p) => p.id === cur.playerId)?.alive && cur.kind !== 'orbit' && cur.kind !== 'drone';
    const isNew = (l: Storyline) => l.playerId !== cur.playerId || l.reason !== cur.reason || l.kind !== cur.kind;
    // A big moment interrupts early.
    if (age >= CUT.preemptAfter && BIG.has(best.reason) && isNew(best) && best.score >= curNow + CUT.preemptMargin) return this.cut(best, t);
    if (featuredGone && age >= CUT.preemptAfter) return this.cut(this.lines.find((l) => l.playerId !== cur.playerId) ?? best, t);
    if (cur.seq === 1 && age >= CUT.opening && isNew(best)) return this.cut(best, t); // end of the establishing shot
    if (age < CUT.minShot) return cur;
    if (isNew(best) && best.score > curNow * CUT.ratio + CUT.margin) return this.cut(best, t);
    if (age >= CUT.maxShot) {
      // Held long enough. Nothing big going on: show someone not seen for a while. Else the best storyline
      // again, from a different angle if it's the same one.
      const quiet = best.reason === 'idle' || best.reason === 'leader';
      const fresh = quiet ? this.freshest(t, cur.playerId) : null;
      // A fresh player in a quiet moment alternates angle with the last shot (shoulder <-> wide).
      const next = fresh ? { ...fresh, kind: varyKind(cur.kind, fresh) } : isNew(best) ? best : { ...best, kind: varyKind(cur.kind, best) };
      return this.cut(next.playerId === cur.playerId && next.kind === cur.kind ? { ...next, kind: varyKind(cur.kind, next) } : next, t);
    }
    return cur;
  }

  /** Quiet moments: the most interesting player other than `not`, favouring whoever hasn't been on screen lately. */
  private freshest(t: number, not: number): Storyline | null {
    let best: Storyline | null = null, bestV = -Infinity;
    for (const l of this.lines) {
      if (l.playerId === not || l.kind === 'orbit') continue;
      const v = l.score + CUT.freshBonus * Math.min(1, (t - (this.shownAt.get(l.playerId) ?? -Infinity)) / CUT.freshSec);
      if (v > bestV) { bestV = v; best = l; }
    }
    return best;
  }

  private currentScore(cur: Shot): number {
    const same = this.lines.find((l) => l.playerId === cur.playerId && l.reason === cur.reason);
    return same ? same.score : scoreOf(this.lines, cur.playerId) * 0.8;
  }

  private cut(l: Storyline, t: number): Shot {
    const shot: Shot = { playerId: l.playerId, reason: l.reason, kind: l.kind, ...(l.otherId !== undefined ? { otherId: l.otherId } : {}), score: l.score, t, startedAt: t, seq: ++this.seqN, ...(l.at ? { at: l.at } : {}) };
    this.shot = shot;
    this.cuts++;
    this.shownAt.set(shot.playerId, t);
    const ev: ShotEvent = { playerId: shot.playerId, reason: shot.reason, kind: shot.kind, ...(shot.otherId !== undefined ? { otherId: shot.otherId } : {}), score: shot.score, t };
    for (const fn of this.shotListeners) fn(ev);
    return shot;
  }
}

/** Same storyline held too long: change the angle (over the shoulder <-> wide; orbit/drone settle to a shoulder shot). */
export function varyKind(prev: ShotKind, l: Storyline): ShotKind {
  if (l.kind === 'drone' && prev !== 'drone') return 'drone';
  return prev === 'shoulder' ? 'wide' : 'shoulder';
}

/** The one director of this page (commentary and the HUD share it). */
export const director = new Director();
if (typeof window !== 'undefined') (window as unknown as { __cinematic: Director }).__cinematic = director;
