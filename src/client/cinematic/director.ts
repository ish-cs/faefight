/**
 * Cinematic mode: the broadcast director. Picks the most exciting storyline (interest.ts) and decides when to
 * cut, calmly: a shot holds at least `minShot` seconds, a fight is followed until it resolves, only a big moment
 * (an elimination, a rocket, a completed seal) interrupts early, and every cut is decided `anticipate` seconds
 * ahead so the camera (camera.ts) can start moving toward the next subject. No kill replays: after a kill the
 * camera stays with the killer, over the shoulder. Pure logic (sim time in, shots out).
 *
 * Commentary (part 2) listens through `director.on('shot' | 'active')` and reads `director.summary()`.
 */
import { InterestTracker, scoreOf, type InterestSnap, type ShotKind, type ShotReason, type Storyline } from './interest';

export type { ShotKind, ShotReason } from './interest';

export interface ShotEvent { playerId: number; reason: ShotReason; kind: ShotKind; otherId?: number; score: number; t: number }
export interface InterestSummary { featured: number | null; storylines: { reason: ShotReason; playerId: number; otherId?: number; score: number }[]; alive: number; t: number }
/** A shot in progress: the event plus where a wide shot is centred and when it started. */
export type Shot = ShotEvent & { at?: { x: number; y: number; z: number }; startedAt: number; seq: number };
/** The next shot, decided `CUT.anticipate` s before it starts (the camera starts turning toward it). */
export type Pending = { playerId: number; otherId?: number; kind: ShotKind; at: number; from: number };

/** Hysteresis (s of sim time) and switching margins. */
export const CUT = {
  /** A shot holds at least this long… */
  minShot: 7,
  /** …and changes (another player or angle) after this long… */
  maxShot: 16,
  /** …except a fight, followed until it resolves (up to this long, changing angle every maxShot). */
  fightMax: 40,
  /** A big moment may interrupt after this long, if it beats the current shot by `preemptMargin`. */
  preemptAfter: 3,
  preemptMargin: 2.5,
  /** After minShot: switch when the best storyline beats the current one by this factor plus `margin`. */
  ratio: 1.4,
  margin: 1,
  /** The next shot is decided this long before the cut. */
  anticipate: 1,
  /** The opening establishing shot (high wide drone). */
  opening: 5,
  /** Quiet moments: up to this much bonus for a player not featured for `freshSec`, and for one near the current subject. */
  freshBonus: 1.5,
  freshSec: 60,
  nearBonus: 1,
  nearDist: 40,
  /** Re-score at most this often (Hz). */
  scoreHz: 6,
} as const;
const BIG: ReadonlySet<ShotReason> = new Set(['elimination', 'rocket', 'seal']);
const FIGHT: ReadonlySet<ShotReason> = new Set(['duel', 'clutch']);

type Listener<T> = (v: T) => void;
type Pos = { x: number; z: number };

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
  private posOf = new Map<number, Pos>();
  private pendingLine: Storyline | null = null;
  shot: Shot | null = null;
  pending: Pending | null = null;
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
    this.pending = null;
    this.pendingLine = null;
    this.cuts = 0;
    this.lastScoreAt = -Infinity;
    if (!on) { this.tracker.reset(); this.shownAt.clear(); this.posOf.clear(); }
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
    // A decided cut lands on time, whatever the scoring rate.
    if (this.pending && this.pendingLine && t >= this.pending.at) {
      const l = this.pendingLine;
      this.pending = null;
      this.pendingLine = null;
      if (s.players.find((p) => p.id === l.playerId)?.alive) return this.cut(l, t);
    }
    if (t - this.lastScoreAt < 1 / CUT.scoreHz && this.shot) return this.shot;
    this.lastScoreAt = t;
    this.lines = this.tracker.storylines(s);
    this.aliveCount = 0;
    for (const p of s.players) if (p.alive) {
      this.aliveCount++;
      const o = this.posOf.get(p.id);
      if (o) { o.x = p.pos.x; o.z = p.pos.z; } else this.posOf.set(p.id, { x: p.pos.x, z: p.pos.z });
    }
    const best = this.lines[0];
    if (!best) return this.shot;
    if (!this.shot) {
      // Opening: a high wide establishing shot over the busiest player, then the director takes over.
      return this.cut({ ...best, kind: 'wide' }, t);
    }
    const cur = this.shot;
    const age = t - cur.startedAt;
    const curNow = this.currentScore(cur);
    const isNew = (l: Storyline) => l.playerId !== cur.playerId || l.kind !== cur.kind;
    // The featured player is gone: straight to what's next (their killer, usually), no waiting.
    if (!s.players.find((p) => p.id === cur.playerId)?.alive) {
      this.pending = null;
      this.pendingLine = null;
      return this.cut(this.lines.find((l) => l.playerId !== cur.playerId) ?? best, t);
    }
    if (this.pending) return cur; // a cut is already on its way
    // A big moment interrupts early (not one that is just this shot's own story). Only a moment that happened
    // during this shot: an older one was already passed over (it used to win once this shot's own story faded,
    // cutting back to a stale kill ~4 s in). And a shot that is itself a big moment holds its minimum length:
    // with kills seconds apart the camera otherwise hopped killer to killer every few seconds.
    if (age >= CUT.preemptAfter && BIG.has(best.reason) && !BIG.has(cur.reason) && (best.since ?? t) > cur.startedAt
      && best.playerId !== cur.playerId && best.score >= curNow + CUT.preemptMargin) return this.plan(best, t);
    if (cur.seq === 1 && age >= CUT.opening) return this.plan(best, t); // end of the establishing shot
    if (age < CUT.minShot) return cur;
    // A fight is followed until it resolves: only a big moment (above) takes the camera away.
    const fight = FIGHT.has(cur.reason) && this.lines.some((l) => FIGHT.has(l.reason) && (l.playerId === cur.playerId || l.playerId === cur.otherId));
    if (fight) {
      if (age >= CUT.fightMax) return this.plan(this.freshest(t, cur.playerId) ?? best, t);
      // Same fight, new angle every maxShot (over the shoulder <-> drone framing both).
      if (age >= CUT.maxShot) {
        const l = this.lines.find((x) => FIGHT.has(x.reason) && (x.playerId === cur.playerId || x.playerId === cur.otherId))!;
        return this.plan({ ...l, kind: cur.kind === 'drone' ? 'shoulder' : 'drone' }, t);
      }
      return cur;
    }
    if (isNew(best) && best.score > curNow * CUT.ratio + CUT.margin) return this.plan(best, t);
    if (age >= CUT.maxShot) {
      // Held long enough. Nothing big going on: someone not seen for a while, preferably nearby.
      const quiet = best.reason === 'idle' || best.reason === 'leader';
      const next = (quiet ? this.freshest(t, cur.playerId) : null) ?? best;
      return this.plan(next.playerId === cur.playerId && next.kind === cur.kind ? { ...next, kind: varyKind(cur.kind) } : next, t);
    }
    return cur;
  }

  /** Decide the next shot now; it starts `anticipate` s later (the camera begins moving toward it). */
  private plan(l: Storyline, t: number): Shot | null {
    this.pendingLine = l;
    this.pending = { playerId: l.playerId, ...(l.otherId !== undefined ? { otherId: l.otherId } : {}), kind: l.kind, at: t + CUT.anticipate, from: t };
    return this.shot;
  }

  /** Quiet moments: the most interesting player other than `not`, favouring whoever hasn't been on screen lately and is near. */
  private freshest(t: number, not: number): Storyline | null {
    const here = this.posOf.get(not);
    let best: Storyline | null = null, bestV = -Infinity;
    for (const l of this.lines) {
      if (l.playerId === not || l.kind === 'wide') continue;
      const p = this.posOf.get(l.playerId);
      const near = here && p && Math.hypot(p.x - here.x, p.z - here.z) < CUT.nearDist ? CUT.nearBonus : 0;
      const v = l.score + near + CUT.freshBonus * Math.min(1, (t - (this.shownAt.get(l.playerId) ?? -Infinity)) / CUT.freshSec);
      if (v > bestV) { bestV = v; best = l; }
    }
    return best;
  }

  private currentScore(cur: Shot): number {
    const same = this.lines.find((l) => l.playerId === cur.playerId && l.reason === cur.reason);
    return same ? same.score : scoreOf(this.lines, cur.playerId) * 0.8;
  }

  private cut(l: Storyline, t: number): Shot {
    const kind: ShotKind = l.kind === 'orbit' ? 'shoulder' : l.kind; // never a replay orbit
    const shot: Shot = { playerId: l.playerId, reason: l.reason, kind, ...(l.otherId !== undefined ? { otherId: l.otherId } : {}), score: l.score, t, startedAt: t, seq: ++this.seqN, ...(l.at ? { at: l.at } : {}) };
    this.shot = shot;
    this.cuts++;
    this.shownAt.set(shot.playerId, t);
    const ev: ShotEvent = { playerId: shot.playerId, reason: shot.reason, kind: shot.kind, ...(shot.otherId !== undefined ? { otherId: shot.otherId } : {}), score: shot.score, t };
    for (const fn of this.shotListeners) fn(ev);
    return shot;
  }
}

/** Same subject held too long: change the angle (mostly over the shoulder; a drone shot in between). */
export function varyKind(prev: ShotKind): ShotKind {
  return prev === 'shoulder' ? 'drone' : 'shoulder';
}

/** The one director of this page (commentary and the HUD share it). */
export const director = new Director();
if (typeof window !== 'undefined') (window as unknown as { __cinematic: Director }).__cinematic = director;
