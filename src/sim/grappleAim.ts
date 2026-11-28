import { GRAPPLE, PLAYER } from './constants';
import type { HitTarget, Physics, RayHit } from './physics';
import { isAlly } from './teams';
import type { PlayerState, Vec3 } from './types';
import { v3 } from './vec';

/**
 * Where a grappling hook fired along an aim ray will bite (grapple.ts fireGrapple, the client's aim marker and the
 * bots' castHook all call this one rule, so the marker never lies and replays agree). Soft magnetism, in order:
 *
 * 1. Lock-on: an enemy the hook could take (alive, not an ally, not spawn protected or sealed in) whose chest is in
 *    reach, within LOCK_TAN (about 6°) and LOCK_R m of the ray, and in clear line of sight: the nearest to the ray wins.
 * 2. The ray's own hit (a player it hits is taken as before). On the world, a hit on a face just under a ledge top
 *    (the top within SNAP_UP m above, with HEAD m of headroom over it) moves up onto the top, IN m in from the face
 *    (something you can stand on: a deck, a container, a roof, a cliff; a thin wall's top is no ledge),
 *    so the pull lands you on it.
 * 3. Nothing usable on the ray (sky, water, too close): up to DROP_RAYS rays a little lower (about DROP_STEP rad each,
 *    the "just over the edge" aim), each with the ledge rule.
 *
 * The reach rule holds: every point is within `range` of the eye (the map's grappleRange).
 */
export type AimWorld = {
  range: number;
  waterY: number;
  /** The hook's ray from the eye (players included, firing slits block). */
  cast(origin: Vec3, dir: Vec3, maxDist: number, shooter: number): RayHit | null;
  /** True when nothing solid (players aside) sits between a and b. */
  clear(a: Vec3, b: Vec3): boolean;
  /** First non-player surface straight down from (x, yFrom, z) within maxDrop (a start inside a collider hits at once). */
  down(x: number, yFrom: number, z: number, maxDrop: number): { y: number; hit: HitTarget } | null;
  /** Where player q stands as the shooter saw them (lag compensation); default their position now. */
  seen?(q: PlayerState): Vec3 | null;
};

export type AimTarget =
  | { kind: 'player'; id: number; point: Vec3; dist: number; locked: boolean }
  | { kind: 'world'; point: Vec3; dist: number; pc?: number; ledge: boolean };

export const AIM = { LOCK_TAN: 0.105, LOCK_R: 1.4, SNAP_UP: 2.2, HEAD: 1.9, IN: 0.4, DROP_RAYS: 3, DROP_STEP: 0.045 };

const chestOf = (feet: Vec3): Vec3 => v3(feet.x, feet.y + PLAYER.height * 0.6, feet.z);

/** Why the hook can't take q now (null = it can). Mirrors grapple.ts unyankable plus the teammate rule. */
function untakable(me: PlayerState, q: PlayerState, now: number): boolean {
  return !q.alive || q.spawnProtected || q.invulnUntil > now || q.breakoutUntil !== null || isAlly(me, q);
}

export function grappleAim(w: AimWorld, me: PlayerState, eye: Vec3, dir: Vec3, players: Iterable<PlayerState>, now: number): AimTarget | null {
  // 1. Lock-on.
  let best: { q: PlayerState; c: Vec3; along: number; tan: number } | null = null;
  for (const q of players) {
    if (q.id === me.id || untakable(me, q, now)) continue;
    const feet = w.seen ? w.seen(q) : q.pos;
    if (!feet) continue;
    const c = chestOf(feet);
    const vx = c.x - eye.x, vy = c.y - eye.y, vz = c.z - eye.z;
    const along = vx * dir.x + vy * dir.y + vz * dir.z;
    if (along < GRAPPLE.minDist || Math.hypot(vx, vy, vz) > w.range) continue;
    const perp = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - along * along));
    const tan = perp / along;
    if (perp > AIM.LOCK_R || tan > AIM.LOCK_TAN || (best && tan >= best.tan)) continue;
    if (!w.clear(eye, c)) continue;
    best = { q, c, along, tan };
  }
  if (best) return { kind: 'player', id: best.q.id, point: best.c, dist: Math.hypot(best.c.x - eye.x, best.c.y - eye.y, best.c.z - eye.z), locked: true };
  // 2. The ray itself, then 3. a few rays a little lower.
  for (let k = 0; k <= AIM.DROP_RAYS; k++) {
    let d = dir;
    if (k > 0) {
      const dy = dir.y - AIM.DROP_STEP * k, l = Math.hypot(dir.x, dy, dir.z);
      d = v3(dir.x / l, dy / l, dir.z / l);
    }
    const hit = w.cast(eye, d, w.range, me.id);
    if (!hit) continue;
    if (hit.hit.type === 'player') {
      if (k === 0) return { kind: 'player', id: hit.hit.id, point: hit.point, dist: hit.dist, locked: false };
      continue;
    }
    if (hit.dist < GRAPPLE.minDist || hit.point.y <= w.waterY + 0.05) continue;
    return ledge(w, eye, d, hit);
  }
  return null;
}

/** A face hit just under a ledge top moves up onto the top (see grappleAim); anything else stays where it hit. */
function ledge(w: AimWorld, eye: Vec3, d: Vec3, hit: RayHit): AimTarget {
  const pc = hit.hit.type === 'piece' ? hit.hit.id : undefined;
  const plain: AimTarget = { kind: 'world', point: hit.point, dist: hit.dist, ledge: false, ...(pc !== undefined ? { pc } : {}) };
  const h = Math.hypot(d.x, d.z);
  if (h < 0.3) return plain; // looking steeply up or down: no face to climb
  // Probe IN m past the face: a top there you can stand on (a thin wall's top is too narrow: the probe misses it).
  const x = hit.point.x + (d.x / h) * AIM.IN, z = hit.point.z + (d.z / h) * AIM.IN;
  const top = w.down(x, hit.point.y + AIM.SNAP_UP + AIM.HEAD, z, AIM.SNAP_UP + AIM.HEAD + 0.3);
  // A top above the hit (not the surface we hit from above), low enough, and nothing over it within HEAD.
  if (!top || top.y < hit.point.y + 0.2 || top.y > hit.point.y + AIM.SNAP_UP) return plain;
  const point = v3(x, top.y, z);
  const dist = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
  if (dist > w.range) return plain;
  return { kind: 'world', point, dist, ledge: true, ...(top.hit.type === 'piece' ? { pc: top.hit.id } : {}) };
}

/** An AimWorld over a physics world as it stands (no lag compensation): the client's marker on the predictor's world. */
export function physicsAimWorld(physics: Physics, range: number, waterY: number): AimWorld {
  return {
    range, waterY,
    cast: (o, d, max, shooter) => physics.raycast(o, d, max, shooter, false),
    clear: (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l = Math.hypot(dx, dy, dz);
      return l < 1e-6 || physics.raycastStatic(a, { x: dx / l, y: dy / l, z: dz / l }, l, false) === null;
    },
    down: (x, y, z, maxDrop) => physics.probeDown(x, y, z, maxDrop, undefined, true),
  };
}
