import * as dm from '../dmath';
import type { PlayerState, Vec3 } from '../types';
import { yawOf } from '../vec';
import { lookAt, wrapAngle, type Angles } from './aim';
import type { GazeParams, GazeSkill } from './params';

const DEG = Math.PI / 180;
/** Calm view drift: OU mean reversion (1/s), slow like a resting hand. */
const DRIFT_HZ = 0.5;
/** Calm pitch: a touch below the horizon, like someone watching the ground ahead. */
const REST_PITCH = -3 * DEG;
/** A look-around glance swings this far off the path (rad), either side. */
const AROUND_MIN = 40 * DEG, AROUND_MAX = 120 * DEG;
/** The way ahead is the walk direction low-passed over this long (s): nav corners, strafes and small corrections don't swing the view. */
const PATH_TAU = 0.4;
/** A stop shorter than this keeps looking the way I was going (stop-and-go walking doesn't swing the view about). */
const PAUSE_SEC = 1.5;
/** Calm view within this of where it wants to be: leave it (people correct in small saccades, they don't servo). */
const DEADBAND = 20 * DEG;

const gauss = (rng: () => number) => (rng() + rng() + rng() - 1.5) * 2;

export type GazeMode = 'engage' | 'path' | 'rest' | 'first' | 'check' | 'around' | 'hurt';
type Glance = { mode: 'first' | 'check'; id: number; until: number } | { mode: 'around' | 'hurt'; at: Vec3 | null; yaw: number; until: number };

/**
 * Where a bot looks when it isn't shooting. People walk looking where they go, with a slowly wandering view and the
 * odd glance: at someone they just spotted (a short look, then back to the path), to check an enemy they know about,
 * toward where a shot came from, or just around. Eyes stay on an enemy only while engaging them (about to shoot,
 * shooting, or threatened: hit lately, or aimed at), which is decided by the caller through `engaged` and handed to
 * the aim system (aim.ts track). Purely the view: what a bot knows (BotView) is untouched. Its own rng stream.
 */
export class Gaze {
  mode: GazeMode = 'rest';
  private glance: Glance | null = null;
  private nextGlanceAt = 0;
  private engagedUntil = -Infinity;
  /** Last time each enemy was in sight (first-look bookkeeping). */
  private seen = new Map<number, number>();
  private drift: Angles = { yaw: 0, pitch: 0 };
  /** Low-passed walk direction (x, z); length < ~0.3 = no settled heading yet. */
  private heading = { x: 0, z: 0 };
  /** Yaw of the way ahead, only updated while the heading is settled (a walk that doubles back keeps the old one). */
  private pathYaw: number | null = null;
  private walkedAt = -Infinity;

  constructor(private readonly S: GazeSkill, private readonly T: GazeParams, private readonly rng: () => number) {}

  /** Engaging this tick (`want`), held for engageHoldSec so a fight never flicks the eyes away between shots. */
  engaged(now: number, want: boolean): boolean {
    if (want) this.engagedUntil = now + this.T.engageHoldSec;
    const on = now < this.engagedUntil;
    if (on) { this.mode = 'engage'; this.glance = null; }
    return on;
  }

  /**
   * Is enemy `e` a threat to me right now: hit me within threatSec, or armed, close and looking straight at me.
   * `hurtBy`/`hurtAt`: my last hit (Memory).
   */
  threat(now: number, me: PlayerState, e: PlayerState, hurtBy: number | null, hurtAt: number): boolean {
    if (hurtBy === e.id && now - hurtAt < this.T.threatSec) return true;
    if (e.equipped === 'fists' || this.T.aimedAtDeg <= 0) return false;
    const dx = me.pos.x - e.pos.x, dz = me.pos.z - e.pos.z;
    if (dx * dx + dz * dz > this.T.aimedAtM * this.T.aimedAtM) return false;
    return Math.abs(wrapAngle(e.yaw - yawOf({ x: dx, z: dz }))) <= this.T.aimedAtDeg * DEG;
  }

  /**
   * The calm view target. `walk`: the way I'm walking (null: standing). `enemies`: in sight now. `lastKnown`: where
   * an enemy I know about was last seen (null: none). `hurtFrom`: where an unseen attacker who just hit me was.
   */
  calm(now: number, dt: number, eye: Vec3, cur: Angles, walk: Vec3 | null, enemies: readonly PlayerState[], lastKnown: Vec3 | null, hurtFrom: Vec3 | null): Angles {
    const S = this.S, rng = this.rng;
    const len = (base: number) => base * (0.6 + 0.8 * rng());
    // Fresh sightings get a short first look (the nearest one, if several turn up together).
    let fresh: PlayerState | null = null, freshD = Infinity;
    for (const e of enemies) {
      const last = this.seen.get(e.id);
      const dx = e.pos.x - eye.x, dz = e.pos.z - eye.z, d = dx * dx + dz * dz;
      if ((last === undefined || now - last > this.T.resightSec) && d <= this.T.firstLookM * this.T.firstLookM && d < freshD) { fresh = e; freshD = d; }
      this.seen.set(e.id, now);
    }
    const g0 = this.glance;
    if (g0 && (now >= g0.until || ((g0.mode === 'first' || g0.mode === 'check') && !enemies.some((e) => e.id === g0.id)))) this.glance = null;
    if (hurtFrom && this.glance?.mode !== 'hurt') {
      this.glance = { mode: 'hurt', at: hurtFrom, yaw: 0, until: now + len(S.glanceSec) * 1.5 };
    } else if (fresh && this.glance?.mode !== 'first' && this.glance?.mode !== 'hurt') {
      this.glance = { mode: 'first', id: fresh.id, until: now + len(S.firstLookSec) };
      this.nextGlanceAt = Math.max(this.nextGlanceAt, this.glance.until + 1 / Math.max(S.glanceRate, 0.05) * 0.5);
    } else if (!this.glance && now >= this.nextGlanceAt) {
      if (now > 0 && S.glanceRate > 0) {
        const near = nearest(enemies, eye);
        if (rng() < S.threatShare && (near || lastKnown)) {
          this.glance = near ? { mode: 'check', id: near.id, until: now + len(S.glanceSec) } : { mode: 'around', at: lastKnown, yaw: 0, until: now + len(S.glanceSec) };
        } else {
          const base = walk ? yawOf(walk) : cur.yaw;
          const side = rng() < 0.5 ? -1 : 1;
          this.glance = { mode: 'around', at: null, yaw: base + side * (AROUND_MIN + (AROUND_MAX - AROUND_MIN) * rng()), until: now + len(S.glanceSec) };
        }
      }
      this.nextGlanceAt = now + (0.5 + rng()) / Math.max(S.glanceRate, 1e-3);
    }
    this.wander(dt);
    const k = 1 - dm.exp(-dt / PATH_TAU), h = this.heading;
    if (walk) this.walkedAt = now;
    if (walk) this.heading = { x: h.x + (walk.x - h.x) * k, z: h.z + (walk.z - h.z) * k };
    const g = this.glance;
    if (g) {
      this.mode = g.mode;
      if ('id' in g) {
        const id = g.id, e = enemies.find((x) => x.id === id)!;
        return lookAt(eye, { x: e.pos.x, y: e.pos.y + 1.2, z: e.pos.z });
      }
      return g.at ? lookAt(eye, g.at) : { yaw: g.yaw, pitch: REST_PITCH };
    }
    const hd = this.heading;
    if (Math.hypot(hd.x, hd.z) > 0.5) this.pathYaw = yawOf({ x: hd.x, z: hd.z });
    const ahead = now - this.walkedAt < PAUSE_SEC && this.pathYaw !== null;
    this.mode = ahead ? 'path' : 'rest';
    // Standing (or no settled way ahead yet): the view stays where it is, only the pitch settles.
    let yaw = ahead ? this.pathYaw! + this.drift.yaw : cur.yaw;
    if (Math.abs(wrapAngle(yaw - cur.yaw)) < DEADBAND) yaw = cur.yaw;
    return { yaw, pitch: REST_PITCH + this.drift.pitch };
  }

  /** Short line for the spectator brain panel. */
  note(): string {
    switch (this.mode) {
      case 'engage': return 'Eyes on the enemy (engaging)';
      case 'first': return 'Glancing at someone who just showed up';
      case 'check': return 'Checking on an enemy in sight';
      case 'hurt': return 'Looking where that shot came from';
      case 'around': return 'Looking around';
      case 'path': return 'Looking where I\'m going';
      default: return 'Resting the view';
    }
  }

  /** Slow OU drift of the calm view around the path (driftDeg SD on yaw, a third of it on pitch). */
  private wander(dt: number) {
    const sd = this.S.driftDeg * DEG, k = DRIFT_HZ * dt, s = sd * Math.sqrt(2 * k);
    this.drift = { yaw: this.drift.yaw * (1 - k) + s * gauss(this.rng), pitch: this.drift.pitch * (1 - k) + (s / 3) * gauss(this.rng) };
  }

  reset() { this.glance = null; this.engagedUntil = -Infinity; this.mode = 'rest'; }
}

function nearest(es: readonly PlayerState[], p: Vec3): PlayerState | null {
  let b: PlayerState | null = null, bd = Infinity;
  for (const e of es) {
    const dx = e.pos.x - p.x, dz = e.pos.z - p.z, d = dx * dx + dz * dz;
    if (d < bd) { b = e; bd = d; }
  }
  return b;
}
