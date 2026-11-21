import { BUILD, CHARGE, GRENADE, PLAYER, ROCKET, TRAP } from './constants';
import { applyPlayerDamage, type CombatCtx } from './combat';
import { boxesOverlap } from './building';
import type { Physics } from './physics';
import type { MatchEvent, PlayerState, TrapNet, TrapRequest, Vec3 } from './types';
import { add, dist, dist2D, forward, right, scale, v3, yawOf } from './vec';

/**
 * Spike traps: a steel plate a player sets on a floor or a wall (bought at the home shop, placed from the
 * hotbar like a piece). Sim-authoritative and deterministic (no randomness).
 *
 * - Floor: anyone hostile standing on the plate (feet within a short height of it) sets it off. Wall: anyone
 *   hostile within TRAP.zone m in front of the face, at its height. The spikes spring out: TRAP.dmg to every
 *   hostile in the zone (kill credit to the owner, feed "X via spike trap"), a small push, then it re-arms
 *   after TRAP.rearmSec. A fresh trap arms TRAP.armSec after placing.
 * - Never hurts its owner (`friendly`: the one line to extend for teams).
 * - Not solid: nothing collides with it, but bullets, fists and blasts damage it (TRAP.hp); it breaks at 0.
 *   One on a piece breaks with that piece.
 * - At most TRAP.maxPerPlayer standing per owner; TRAP.minGap apart.
 */
export type TrapState = TrapNet & { /** Piece it is set on (breaks with it), null on the world. */ on: number | null };

/** Same side: never hurt by this owner's traps. Teams: also `|| (team(owner) !== undefined && team(owner) === team(p))`. */
export const friendly = (owner: number, p: Pick<PlayerState, 'id'>): boolean => p.id === owner;

const ev = (t: number, data: Record<string, unknown>): MatchEvent => ({ t, type: 'trap', data });
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rv = (v: Vec3): Vec3 => v3(r2(v.x), r2(v.y), r2(v.z));

/** Explosion events (combat) that hurt traps: radius of each kind. */
const BLAST_R: Record<string, number> = { grenade: GRENADE.radius, rocket: ROCKET.radius, charge: CHARGE.radius + 1, barrel: 5, propane: 4.6 };

/** Local frame of a trap: a = across (right), b = out of a wall / along the plate (forward), y = up. */
function local(t: Pick<TrapNet, 'pos' | 'rotY'>, at: Vec3): { a: number; b: number; y: number } {
  const dx = at.x - t.pos.x, dz = at.z - t.pos.z;
  const r = right(t.rotY), f = forward(t.rotY);
  return { a: dx * r.x + dz * r.z, b: dx * f.x + dz * f.z, y: at.y - t.pos.y };
}

/** Is this player (feet at `feet`) where the spikes reach? */
export function inTrapZone(t: Pick<TrapNet, 'pos' | 'rotY' | 'wall'>, feet: Vec3): boolean {
  const l = local(t, feet);
  const r = PLAYER.radius, h = TRAP.half;
  if (Math.abs(l.a) > h + r) return false;
  if (t.wall) {
    // In front of the face (not behind the wall), body overlapping the plate's height.
    if (l.b < -0.05 || l.b > TRAP.zone + r) return false;
    return l.y <= h && l.y + PLAYER.height >= -h;
  }
  if (Math.abs(l.b) > h + r) return false;
  return l.y >= -0.25 && l.y <= TRAP.zone;
}

/** The plate as an oriented box (centre, half extents, turn): hit tests, no-build zones. */
export function trapBox(t: Pick<TrapNet, 'pos' | 'rotY' | 'wall'>): { center: Vec3; half: Vec3; rotY: number } {
  const h = TRAP.half, k = TRAP.thick / 2;
  if (t.wall) {
    const f = forward(t.rotY);
    return { center: v3(t.pos.x + f.x * k, t.pos.y, t.pos.z + f.z * k), half: v3(h, h, k), rotY: t.rotY };
  }
  return { center: v3(t.pos.x, t.pos.y + k, t.pos.z), half: v3(h, k, h), rotY: t.rotY };
}

/** Where a trap's spikes are (aim point, blast distance): the middle of the plate face. */
export function trapCenter(t: Pick<TrapNet, 'pos' | 'rotY' | 'wall'>): Vec3 {
  return trapBox(t).center;
}

/** Distance along a unit ray to an oriented (Y-turned) box, or null (slab test in the box frame). */
function rayBox(o: Vec3, d: Vec3, c: Vec3, half: Vec3, rotY: number, maxDist: number): number | null {
  const r = right(rotY), f = forward(rotY);
  // Box frame axes: x = right, y = up, z = -forward (rotateY convention); the sign doesn't matter for a slab.
  const ox = (o.x - c.x) * r.x + (o.z - c.z) * r.z, oz = (o.x - c.x) * f.x + (o.z - c.z) * f.z, oy = o.y - c.y;
  const dx = d.x * r.x + d.z * r.z, dz = d.x * f.x + d.z * f.z, dy = d.y;
  let t0 = 0, t1 = maxDist;
  for (const [p, v, h] of [[ox, dx, half.x], [oy, dy, half.y], [oz, dz, half.z]]) {
    if (Math.abs(v) < 1e-9) { if (Math.abs(p) > h) return null; continue; }
    let a = (-h - p) / v, b = (h - p) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

export type TrapPlacement = { ok: true; pos: Vec3; rotY: number; wall: boolean; on: number | null } | { ok: false; reason: string };

/** How far above/out from the requested point we look for the surface, and how far through it. */
const PROBE = 0.4;
/** Corner probes may differ from the middle by this much (flat enough to sit on). */
const FLAT = 0.12;
const CORNER = 0.4;

/**
 * Where a trap would go for this request, or why it can't: in reach, on a flat enough floor or wall
 * (world or a piece), clear of stations and other traps. `traps`: the ones already standing.
 */
export function validateTrap(physics: Physics, req: TrapRequest, playerPos: Vec3, traps: readonly Pick<TrapNet, 'pos'>[]): TrapPlacement {
  if (dist2D(req.pos, playerPos) > BUILD.reach || Math.abs(req.pos.y - playerPos.y) > BUILD.reach) return { ok: false, reason: 'too far' };
  let pos: Vec3, on: number | null;
  if (!req.wall) {
    const sup = physics.probeDown(req.pos.x, req.pos.y + PROBE, req.pos.z, 2 * PROBE);
    if (!sup) return { ok: false, reason: 'nothing to set it on' };
    const r = right(req.rotY), f = forward(req.rotY);
    for (const [sa, sb] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = req.pos.x + (r.x * sa + f.x * sb) * CORNER, z = req.pos.z + (r.z * sa + f.z * sb) * CORNER;
      const c = physics.probeDown(x, sup.y + PROBE, z, 2 * PROBE);
      if (!c || Math.abs(c.y - sup.y) > FLAT) return { ok: false, reason: 'not flat' };
    }
    pos = v3(req.pos.x, sup.y, req.pos.z);
    on = sup.hit.type === 'piece' ? sup.hit.id : null;
    // Room above the plate (not inside a wall or under a low beam).
    const above = physics.overlapsBox(v3(pos.x, pos.y + 0.35, pos.z), v3(TRAP.half - 0.1, 0.25, TRAP.half - 0.1), req.rotY);
    if (above.some((h) => h.type !== 'player')) return { ok: false, reason: 'blocked' };
  } else {
    const n = forward(req.rotY), r = right(req.rotY);
    const cast = (p: Vec3) => physics.raycastStatic(add(p, scale(n, PROBE)), scale(n, -1), 2 * PROBE);
    const mid = cast(req.pos);
    if (!mid) return { ok: false, reason: 'no wall there' };
    for (const [sa, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const c = cast(v3(req.pos.x + r.x * sa * CORNER, req.pos.y + sy * CORNER, req.pos.z + r.z * sa * CORNER));
      if (!c || Math.abs(c.dist - mid.dist) > FLAT) return { ok: false, reason: 'not flat' };
    }
    pos = add(req.pos, scale(n, PROBE - mid.dist));
    on = mid.hit.type === 'piece' ? mid.hit.id : null;
    const front = physics.overlapsBox(add(pos, scale(n, 0.3)), v3(TRAP.half - 0.1, TRAP.half - 0.1, 0.2), req.rotY);
    if (front.some((h) => h.type !== 'player')) return { ok: false, reason: 'blocked' };
  }
  pos = rv(pos);
  const rotY = r3(req.rotY);
  const box = trapBox({ pos, rotY, wall: req.wall });
  const zone = physics.noBuildZones().find((z) => boxesOverlap(box.center, box.half, rotY, z));
  if (zone) return { ok: false, reason: zone.reason };
  if (traps.some((t) => dist(t.pos, pos) < TRAP.minGap)) return { ok: false, reason: 'too close to a trap' };
  return { ok: true, pos, rotY, wall: req.wall, on };
}

/** Rotation snap for floor traps (same grid as pieces). */
const ROT_STEP = (BUILD.rotStepDeg * Math.PI) / 180;

/**
 * Client aim helper: from the crosshair ray, the trap request to try (floor if the ray lands on a top
 * surface, else the wall it lands on, turned to face back along the ray). Null when nothing is in reach.
 */
export function trapAim(physics: Physics, eye: Vec3, dir: Vec3, yaw: number, maxDist: number): TrapRequest | null {
  const hit = physics.raycastStatic(eye, dir, maxDist);
  if (!hit) return null;
  const p = hit.point;
  const top = physics.probeDown(p.x, p.y + 0.05, p.z, 0.15);
  if (top && Math.abs(top.y - p.y) < 0.06) return { pos: v3(p.x, top.y, p.z), rotY: Math.round(yaw / ROT_STEP) * ROT_STEP, wall: false };
  const out = yawOf(v3(-dir.x, 0, -dir.z));
  // Face the wall square: the wall's own normal is found by two side probes.
  const r = right(out);
  const a = physics.raycastStatic(add(eye, scale(r, -0.15)), dir, maxDist + 1);
  const b = physics.raycastStatic(add(eye, scale(r, 0.15)), dir, maxDist + 1);
  let rotY = out;
  if (a && b) {
    const t = v3(b.point.x - a.point.x, 0, b.point.z - a.point.z);
    if (Math.hypot(t.x, t.z) > 0.05) {
      // Normal = tangent turned 90° (toward the eye).
      let nx = -t.z, nz = t.x;
      if (nx * -dir.x + nz * -dir.z < 0) { nx = -nx; nz = -nz; }
      rotY = yawOf(v3(nx, 0, nz));
    }
  }
  return { pos: v3(p.x, p.y, p.z), rotY, wall: true };
}

export class Traps {
  list: TrapState[] = [];

  /** Standing traps of one owner. */
  countOf(owner: number): number {
    let n = 0;
    for (const t of this.list) if (t.owner === owner) n++;
    return n;
  }

  /** Place one from `p`'s inventory. Returns the events (none when refused). */
  place(physics: Physics, p: PlayerState, req: TrapRequest, now: number, nextId: () => number): MatchEvent[] {
    if (!p.alive || p.inv.traps <= 0) return [];
    if (this.countOf(p.id) >= TRAP.maxPerPlayer) return [];
    const r = validateTrap(physics, req, p.pos, this.list);
    if (!r.ok) return [];
    const t: TrapState = { id: nextId(), owner: p.id, pos: r.pos, rotY: r.rotY, wall: r.wall, hp: TRAP.hp, fired: -1, arm: r3(now + TRAP.armSec), on: r.on };
    this.list.push(t);
    p.inv.traps -= 1;
    p.busyUntil = now + TRAP.placeSec;
    return [ev(now, { what: 'placed', id: t.id, pos: t.pos, rotY: t.rotY, wall: t.wall, by: p.id })];
  }

  /** Break traps whose piece is gone, then spring any armed one a hostile player is in. */
  tick(ctx: CombatCtx, now: number): MatchEvent[] {
    if (!this.list.length) return [];
    const out: MatchEvent[] = [];
    for (const t of [...this.list]) if (t.on !== null && !ctx.pieces.has(t.on)) out.push(...this.breakTrap(t, now, null));
    for (const t of this.list) {
      if (now < t.arm - 1e-9) continue;
      let sprung = false;
      for (const pl of ctx.players.values()) {
        if (!pl.alive || friendly(t.owner, pl) || now < pl.invulnUntil || !inTrapZone(t, pl.pos)) continue;
        if (!sprung) {
          sprung = true;
          t.fired = r3(now);
          t.arm = r3(now + TRAP.rearmSec);
          out.push(ev(now, { what: 'fired', id: t.id, pos: t.pos, owner: t.owner }));
        }
        const c = trapCenter(t);
        out.push(...applyPlayerDamage(ctx, pl, TRAP.dmg, t.owner, now, { pos: rv(v3(pl.pos.x, Math.max(pl.pos.y, c.y), pl.pos.z)), weapon: 'trap' }));
        if (pl.alive && ctx.onKnockback) {
          const n = t.wall ? forward(t.rotY) : v3(0, 1, 0);
          ctx.onKnockback(pl.id, v3(n.x * TRAP.knock, t.wall ? 0.8 : TRAP.knock, n.z * TRAP.knock));
        }
      }
    }
    return out;
  }

  /** First trap along a unit ray within maxDist. */
  ray(o: Vec3, d: Vec3, maxDist: number): { id: number; dist: number } | null {
    let best: { id: number; dist: number } | null = null;
    for (const t of this.list) {
      const b = trapBox(t);
      const k = rayBox(o, d, b.center, b.half, b.rotY, best ? best.dist : maxDist);
      if (k !== null && (!best || k < best.dist)) best = { id: t.id, dist: k };
    }
    return best;
  }

  /** Damage one; it breaks at 0 hp. */
  damage(id: number, amount: number, by: number | null, now: number): MatchEvent[] {
    const t = this.list.find((x) => x.id === id);
    if (!t) return [];
    t.hp -= amount;
    if (t.hp > 0) return [];
    return this.breakTrap(t, now, by);
  }

  /** This tick's grenade / rocket / charge / barrel blasts damage traps in reach. */
  onExplosions(events: readonly MatchEvent[], now: number): MatchEvent[] {
    if (!this.list.length) return [];
    const out: MatchEvent[] = [];
    for (const e of events) {
      if (e.type !== 'explosion') continue;
      const R = (e.data.radius as number | undefined) ?? BLAST_R[e.data.kind as string];
      const pos = e.data.pos as Vec3 | undefined;
      if (!R || !pos) continue;
      for (const t of [...this.list]) {
        const d = dist(trapCenter(t), pos);
        if (d < R) out.push(...this.damage(t.id, TRAP.blastDmg * (1 - d / R), (e.data.by as number | null) ?? null, now));
      }
    }
    return out;
  }

  private breakTrap(t: TrapState, now: number, by: number | null): MatchEvent[] {
    const i = this.list.indexOf(t);
    if (i < 0) return [];
    this.list.splice(i, 1);
    return [ev(now, { what: 'broken', id: t.id, pos: t.pos, rotY: t.rotY, wall: t.wall, owner: t.owner, by })];
  }

  /** Snapshot list (absent when there are none). */
  net(): TrapNet[] | undefined {
    if (!this.list.length) return undefined;
    return this.list.map((t) => ({ id: t.id, owner: t.owner, pos: t.pos, rotY: t.rotY, wall: t.wall, hp: Math.max(0, Math.ceil(t.hp)), fired: t.fired, arm: t.arm }));
  }
}
