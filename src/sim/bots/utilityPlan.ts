import * as dm from '../dmath';
import { DT, FLASH, PLAYER, SMOKE } from '../constants';
import { hash01 } from '../gunplay';
import type { Difficulty, PlayerState, UtilityKind, Vec3 } from '../types';
import { inSmoke, isBlind } from '../utility';
import { add, dist2D, norm, scale, v3 } from '../vec';
import { lookAt, type Angles } from './aim';
import { islandAt } from './nav';
import type { BotView } from './view';
import type { UtilParams } from './utilParams';

/**
 * Smoke grenades and flashbangs for bots (sim/utility.ts), like a strong human uses them:
 * - smoke to cover a retreat / a heal with someone on me, a bridge crossing under fire, or a seal attempt at a rival's
 *   bunker they were just seen at;
 * - a flashbang before pushing a fight or a rival who just ducked behind cover / into their bunker;
 * and reacting to them: no fighting into someone else's smoke (flank round it), and backing off (or holding) while blinded.
 * Every roll is a hash of (bot, time window, kind), not the bot's rng, so carrying them never shifts its other choices.
 */
/** What the bot's brain knows that the plan needs (bot.ts fills it in). */
export type UtilSituation = {
  view: BotView; me: PlayerState; difficulty: Difficulty; P: UtilParams;
  goal: string; enemy: PlayerState | null; enemyDist: number;
  /** The rival I'm after (last sighting, if recent), and their bunker's centre (sealing / attacking). */
  target: { id: number; pos: Vec3; t: number } | null; rivalBunker: Vec3 | null;
  /** Backing off / healing with someone on me. */
  retreating: boolean;
  /** Last time I threw one, and when an enemy last hurt me. */
  lastAt: number; lastHurtAt: number;
};
export type UtilThrow = { kind: UtilityKind; at: Vec3; why: string };

const roll = (s: UtilSituation, kind: number, p: number) =>
  p >= 1 || (p > 0 && hash01(s.me.id * 977 + kind, Math.floor(s.view.now / s.P.rollSec), 0x5f1a5) < p);
const has = (me: PlayerState, k: UtilityKind) => (k === 'smoke' ? me.inv.smokes ?? 0 : me.inv.flashes ?? 0) > 0;
/** A teammate near a spot (don't flash my own team). */
const allyNear = (view: BotView, at: Vec3, r: number) => !!view.allies?.some((a) => a.alive && dist2D(a.pos, at) < r);
/** A cloud already covers this spot. */
const smoked = (view: BotView, at: Vec3) => !!view.smokes && inSmoke(view.smokes, v3(at.x, at.y + 1.6, at.z), view.now);

/** Which utility to throw where right now, or null. Pure: no state is changed. */
export function planUtility(s: UtilSituation): UtilThrow | null {
  const { view, me, P, difficulty: d } = s, now = view.now;
  if (!me.alive || view.blind || now - s.lastAt < P.gapSec || me.busyUntil > now) return null;
  const foePos = s.enemy?.pos ?? (s.target && now - s.target.t <= P.seenSec ? s.target.pos : null);
  // 1. Smoke a retreat / heal: a cloud a few metres toward them, between us.
  if (has(me, 'smoke') && s.retreating && (s.enemy && s.enemyDist < P.retreatM || now - s.lastHurtAt < 1.5) && !smoked(view, me.pos) && roll(s, 1, P.smokeRetreat[d])) {
    const toward = foePos ? norm(v3(foePos.x - me.pos.x, 0, foePos.z - me.pos.z)) : v3();
    return { kind: 'smoke', at: add(me.pos, scale(toward, 3)), why: 'smoke to cover my retreat' };
  }
  // 2. Smoke a crossing: out on a bridge/deck (or bridging) with an enemy around.
  const cv = view.center?.island;
  const onDeck = islandAt(view.map, me.pos) < 0 && Math.abs(me.vel.y) < 0.05 && (!cv || dist2D(me.pos, cv.center) > cv.radius);
  if (has(me, 'smoke') && foePos && (onDeck || s.goal === 'bridge') && dist2D(foePos, me.pos) < 45 && roll(s, 2, P.smokeCross[d])) {
    const toward = norm(v3(foePos.x - me.pos.x, 0, foePos.z - me.pos.z));
    const at = add(me.pos, scale(toward, 6));
    if (!smoked(view, at)) return { kind: 'smoke', at, why: 'smoke to cover the crossing' };
  }
  // 3. Smoke a seal attempt: at their bunker with them seen around (the cloud between me and where they shoot from).
  if (has(me, 'smoke') && foePos && s.rivalBunker && (s.goal === 'seal' || s.goal === 'attack') && dist2D(me.pos, s.rivalBunker) < 14 &&
      roll(s, 3, P.smokeCross[d])) {
    const at = v3((me.pos.x + foePos.x) / 2, me.pos.y, (me.pos.z + foePos.z) / 2);
    if (dist2D(at, me.pos) > 2.5 && !smoked(view, at)) return { kind: 'smoke', at, why: 'smoke to cover the seal' };
  }
  // 4. Flash before a push: a fight at mid range, or a rival who just ducked out of sight (behind cover, into a bunker).
  if (has(me, 'flash') && foePos && !s.retreating && s.goal !== 'shop' && s.goal !== 'bank') {
    const dd = dist2D(foePos, me.pos);
    const ducked = !s.enemy && !!s.target && now - s.target.t <= P.seenSec;
    if (dd >= P.flashMin && dd <= P.flashMax && (ducked || !!s.enemy) && !allyNear(view, foePos, 8) && roll(s, 4, P.flashPush[d]))
      return { kind: 'flash', at: foePos, why: ducked ? 'flash where they ducked out, then push' : 'flash them, then push' };
  }
  return null;
}

/**
 * Aim for a smoke/flash to come down at `to` (combat.throwUtility: throwSpeed along the aim plus 3 m/s up, gravity per
 * tick). Flattest arc that gets there (a flash goes off where it is when the fuse runs out; a smoke pops where it lands).
 */
export function utilAngles(eye: Vec3, to: Vec3, kind: UtilityKind): Angles | null {
  const speed = kind === 'smoke' ? SMOKE.throwSpeed : FLASH.throwSpeed;
  const d = dist2D(eye, to), dy = to.y - eye.y;
  const yaw = lookAt(eye, to).yaw;
  let prevBelow = false;
  for (let i = 0; i <= 200; i++) {
    const pitch = -1.0 + i * 0.012;
    const vx = speed * dm.cos(pitch), vy = speed * dm.sin(pitch) + 3;
    const t = d / vx;
    const y = vy * t - (PLAYER.gravity * t * (t + DT)) / 2;
    if (y >= dy && prevBelow) return { yaw, pitch };
    prevBelow = y < dy;
  }
  return null;
}

/**
 * Reacting to someone else's utility: while blinded, back off from where the enemy was (or hold still); otherwise
 * don't walk a fight into an enemy cloud (stop at its edge). Returns the walk direction to use (null = stand).
 */
export function utilReact(s: UtilSituation, dir: Vec3 | null): { dir: Vec3 | null; note: string } | null {
  const { view, me, P, difficulty: d } = s, now = view.now;
  if (view.blind && isBlind(me, now)) {
    const from = s.target?.pos ?? s.enemy?.pos;
    if (from && roll(s, 5, P.blindBack[d])) return { dir: norm(v3(me.pos.x - from.x, 0, me.pos.z - from.z)), note: 'blinded: backing off' };
    return { dir: null, note: 'blinded: holding still' };
  }
  if (dir && view.smokes && s.goal === 'fight' && roll(s, 6, P.avoidSmoke[d])) {
    const head = v3(me.pos.x, me.pos.y + 1.6, me.pos.z);
    const ahead = add(head, scale(dir, 1.5));
    if (inSmoke(view.smokes, head, now) || !inSmoke(view.smokes, ahead, now)) return null;
    // The cloud in my way: flank round its edge (the side my walk already leans to) instead of walking into it.
    const c = view.smokes.find((k) => k.owner !== me.id && !view.allies?.some((a) => a.id === k.owner) && inSmoke([k], ahead, now));
    if (!c) return null;
    const to = norm(v3(c.pos.x - me.pos.x, 0, c.pos.z - me.pos.z));
    const side = to.x * dir.z - to.z * dir.x >= 0 ? 1 : -1;
    return { dir: v3(-to.z * side, 0, to.x * side), note: 'flanking round their smoke, not into it' };
  }
  return null;
}
