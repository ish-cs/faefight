import { validatePlacement, type Placement } from '../sim/building';
import { BUILD, MAP, PIECES } from '../sim/constants';
import type { IslandLayout } from '../sim/map';
import type { Physics } from '../sim/physics';
import type { BuildRequest, PieceKind, PieceState, Vec3 } from '../sim/types';
import { add, dist2D, forward, rotateY, v3, yawOf } from '../sim/vec';

/**
 * Client-side build aiming: where the crosshair points (clamped to reach) plus a snap assist that
 * offers "intelligent" spots near the aim (bridge continuation, shore start, wall gaps, flush ends,
 * stacking, enemy doorway plugs, ramps onto pieces). Everything is validated against the local
 * collision world (the predictor's copy) with the sim's own validatePlacement, so the ghost colour is
 * known every frame; the request sent is the exact resolved spot, which the sim re-validates.
 */

export type SnapTag = 'aim' | 'bridge' | 'shore' | 'gap' | 'beside' | 'stack' | 'door' | 'ramp';

export type Candidate = {
  tag: SnapTag;
  /** Query position for validatePlacement (y = a little above the expected rest height). */
  pos: Vec3;
  rotY: number;
  /** Points the aim ray is measured against (new piece centre, the joint...). */
  pts: Vec3[];
  /** What it attaches to (drawn as a link line), if anything. */
  anchor: Vec3 | null;
  /** How useful this kind of spot is (higher wins). */
  useful: number;
  /** The aim ray must pass within this distance (m) of one of pts. */
  radius: number;
  key: string;
  /** Piece this candidate sits on top of (stack): pointing straight at that top wins outright. */
  onTopOf?: number;
};

export type Ray = { eye: Vec3; dir: Vec3 };

export type AimOutcome = {
  kind: PieceKind;
  tag: SnapTag;
  /** Where the ghost goes: the validated rest position when ok, else the query spot. */
  ghost: Vec3;
  rotY: number;
  ok: boolean;
  /** Short reason when not ok ("too far", "needs support", "blocked"). */
  reason: string | null;
  anchor: Vec3 | null;
  /** What to send to the sim (exact resolved spot, free = no re-snapping) when ok. */
  req: BuildRequest | null;
};

export type AimInput = {
  physics: Physics;
  kind: PieceKind;
  ray: Ray;
  /** Local player's feet (predicted). */
  player: Vec3;
  /** View yaw. */
  yaw: number;
  /** Z/X rotation offset. */
  buildRot: number;
  /** Alt held: exact aim point and rotation, no grid and no assist. */
  free: boolean;
  humanId: number;
  pieces: readonly PieceState[];
  islands: readonly IslandLayout[];
  myIsland: number;
};

/** Client keeps a margin under the sim's reach: the sim checks against our (slightly older) server position. */
export const CLIENT_REACH = BUILD.reach - 0.4;
const GRID = BUILD.gridStep;
const ROT_STEP = (BUILD.rotStepDeg * Math.PI) / 180;
/** Hysteresis: the raw point must move this far past a cell boundary before the ghost changes cell. */
const GRID_HYST = 0.12;
const ROT_HYST = (4 * Math.PI) / 180;
/** Ghost distance when looking at the sky (nothing to aim at). */
const FALLBACK_AHEAD = 3.5;
const MAX_VALIDATIONS = 6;
const WALLS = new Set<PieceKind>(['wood', 'metal', 'steel']);
const LINE = new Set<PieceKind>(['wood', 'metal', 'steel', 'sandbags', 'container']);

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (n: number) => Math.round(n * 100) / 100;
const keyOf = (tag: SnapTag, p: Vec3, rotY: number) => `${tag}|${r2(p.x)}|${r2(p.y)}|${r2(p.z)}|${Math.round(wrap(rotY) * 100)}`;

/** Grid snap with hysteresis: keep `prev` until `raw` is more than half a cell + hyst away from it. */
export function snapAxis(raw: number, prev: number | null, step = GRID, hyst = GRID_HYST): number {
  if (prev !== null && Math.abs(raw - prev) <= step / 2 + hyst) return prev;
  return Math.round(raw / step) * step;
}

/** Angle snap (radians) with hysteresis, wrap-aware. */
export function snapAngle(raw: number, prev: number | null, step = ROT_STEP, hyst = ROT_HYST): number {
  if (prev !== null && Math.abs(wrap(raw - prev)) <= step / 2 + hyst) return prev;
  return Math.round(raw / step) * step;
}

/** Ramps rise along local +Z; turn them so the low end faces the player. */
export const baseRot = (kind: PieceKind) => (kind === 'ramp' ? Math.PI : 0);

/** Distance from point p to the ray (behind the eye counts as distance to the eye). */
export function rayDist(ray: Ray, p: Vec3): number {
  const dx = p.x - ray.eye.x, dy = p.y - ray.eye.y, dz = p.z - ray.eye.z;
  const t = dx * ray.dir.x + dy * ray.dir.y + dz * ray.dir.z;
  if (t <= 0) return Math.hypot(dx, dy, dz);
  return Math.hypot(dx - ray.dir.x * t, dy - ray.dir.y * t, dz - ray.dir.z * t);
}

/**
 * Snap-assist score (higher is better; -Infinity = not eligible). Usefulness, scaled by how close the
 * aim ray passes and how well the spot matches the view direction. The previous winner gets a wider
 * radius and a bonus (no flicker); when the previous winner was the raw aim, candidates must be
 * aimed at more precisely to take over.
 */
export function scoreCandidate(c: Candidate, ray: Ray, player: Vec3, yaw: number, prevKey: string | null): number {
  const f = forward(yaw);
  const hx = c.pos.x - player.x, hz = c.pos.z - player.z;
  const h = Math.hypot(hx, hz);
  const cos = h < 0.5 ? 1 : (hx * f.x + hz * f.z) / h;
  if (cos < 0.2) return -Infinity;
  const same = prevKey === c.key;
  const R = c.radius * (same ? 1.35 : prevKey === 'aim' ? 0.85 : 1);
  const d = Math.min(...c.pts.map((p) => rayDist(ray, p)));
  if (d > R) return -Infinity;
  return c.useful * (1 - 0.5 * (d / R)) * (0.6 + 0.4 * cos) + (same ? 0.2 : 0);
}

const overWater = (islands: readonly IslandLayout[], p: { x: number; z: number }) =>
  islands.every((i) => dist2D(p, i.center) > i.radius - 0.2);

/** Snap-assist candidates for placing `kind` near `player` (pure geometry; validation comes later). */
export function candidatesFor(
  kind: PieceKind, player: Vec3, yaw: number, pieces: readonly PieceState[], islands: readonly IslandLayout[], myIsland: number,
): Candidate[] {
  const s = PIECES[kind];
  const out = new Map<string, Candidate>();
  const push = (c: Omit<Candidate, 'key'>) => {
    if (dist2D(c.pos, player) > CLIENT_REACH) return;
    const key = keyOf(c.tag, c.pos, c.rotY);
    const prev = out.get(key);
    if (!prev || prev.useful < c.useful) out.set(key, { ...c, key });
  };
  const at = (p: PieceState, local: Vec3) => add(p.pos, rotateY(local, p.rotY));
  const near = pieces.filter((p) => dist2D(p.pos, player) < BUILD.reach + 6);

  for (const p of near) {
    const ps = PIECES[p.kind];
    const top = p.pos.y + ps.h;
    // Stack on top (not on/with scaffold or ramps).
    if (kind !== 'scaffold' && kind !== 'ramp' && p.kind !== 'scaffold' && p.kind !== 'ramp' && top - player.y < BUILD.reach - 0.5)
      push({ tag: 'stack', onTopOf: p.id, pos: v3(p.pos.x, top + 0.05, p.pos.z), rotY: p.rotY,
        pts: [v3(p.pos.x, top, p.pos.z), v3(p.pos.x, top + s.h / 2, p.pos.z)], anchor: v3(p.pos.x, top, p.pos.z), useful: 0.6, radius: 0.9 });
    // Flush beside a wall/sandbag end, in line; a gap between two in-line pieces is worth more.
    if (LINE.has(kind) && LINE.has(p.kind)) {
      for (const sign of [-1, 1]) {
        const off = ps.w / 2 + s.w / 2;
        const c = at(p, v3(sign * off, 0, 0));
        const joint = at(p, v3(sign * ps.w / 2, ps.h / 2, 0));
        const gap = near.some((q) => {
          if (q.id === p.id || !LINE.has(q.kind) || Math.abs(q.pos.y - p.pos.y) > 0.3) return false;
          if (Math.abs(Math.sin(q.rotY - p.rotY)) > 0.2) return false;
          const want = at(p, v3(sign * (ps.w / 2 + s.w + PIECES[q.kind].w / 2), 0, 0));
          return dist2D(q.pos, want) < 0.5;
        });
        push({ tag: gap ? 'gap' : 'beside', pos: v3(c.x, p.pos.y + 0.05, c.z), rotY: p.rotY,
          pts: [v3(c.x, p.pos.y + s.h / 2, c.z), joint], anchor: joint, useful: gap ? 1.2 : 0.65, radius: gap ? 1.6 : 1.1 });
      }
    }
    // Continue a scaffold bridge off either end (an end over open water is the useful one).
    if (kind === 'scaffold' && p.kind === 'scaffold') {
      for (const sign of [-1, 1]) {
        const c = at(p, v3(0, 0, sign * ps.d));
        const joint = at(p, v3(0, ps.h, sign * ps.d / 2));
        const tip = at(p, v3(0, 0, sign * (ps.d / 2 + 0.6)));
        push({ tag: 'bridge', pos: v3(c.x, p.pos.y, c.z), rotY: p.rotY, pts: [v3(c.x, p.pos.y + ps.h, c.z), joint], anchor: joint,
          useful: overWater(islands, tip) ? 1.3 : 0.8, radius: 2.2 });
      }
    }
    // A ramp up onto a sandbag row / container, on the face toward the player.
    if (kind === 'ramp' && (p.kind === 'sandbags' || p.kind === 'container')) {
      for (const nl of [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)]) {
        const n = rotateY(nl, p.rotY);
        if (n.x * (player.x - p.pos.x) + n.z * (player.z - p.pos.z) <= 0) continue;
        const half = nl.x !== 0 ? ps.w / 2 : ps.d / 2;
        const fc = add(p.pos, v3(n.x * half, 0, n.z * half));
        const c = add(fc, v3(n.x * (s.d / 2 + 0.02), 0, n.z * (s.d / 2 + 0.02)));
        push({ tag: 'ramp', pos: v3(c.x, p.pos.y + 0.05, c.z), rotY: yawOf(n), pts: [v3(c.x, p.pos.y + s.h / 2, c.z), v3(fc.x, top, fc.z)],
          anchor: v3(fc.x, top, fc.z), useful: 0.9, radius: 1.5 });
      }
    }
  }

  // Plug an enemy bunker doorway with a wall, flush against the outside of the doorway.
  if (WALLS.has(kind)) {
    for (const isl of islands) {
      if (isl.index === myIsland) continue;
      for (const door of isl.bunker.doorways) {
        if (dist2D(door.center, player) > BUILD.reach + 3) continue;
        const f = forward(door.yaw);
        const off = MAP.bunker.wall / 2 + s.d / 2 + 0.03;
        const c = v3(door.center.x + f.x * off, isl.groundY + 0.05, door.center.z + f.z * off);
        const mid = v3(door.center.x, isl.groundY + 1, door.center.z);
        push({ tag: 'door', pos: c, rotY: door.yaw, pts: [v3(c.x, isl.groundY + s.h / 2, c.z), mid], anchor: mid, useful: 1.4, radius: 2.2 });
      }
    }
  }

  // First bridge segment off the shore edge of the island we stand on, toward where we face.
  if (kind === 'scaffold') {
    const isl = islands.find((i) => dist2D(player, i.center) < i.radius + 0.5);
    if (isl) {
      const rot = snapAngle(yaw, null);
      const f = forward(rot);
      const rx = player.x - isl.center.x, rz = player.z - isl.center.z;
      const b = rx * f.x + rz * f.z, c = rx * rx + rz * rz - isl.radius * isl.radius;
      const disc = b * b - c;
      if (disc >= 0) {
        const t = -b + Math.sqrt(disc);
        if (t > 0 && t < BUILD.reach + 1) {
          const edge = v3(player.x + f.x * t, isl.groundY, player.z + f.z * t);
          const k = s.d / 2 - 0.35;
          const pos = v3(edge.x + f.x * k, isl.groundY + 0.05, edge.z + f.z * k);
          push({ tag: 'shore', pos, rotY: rot, pts: [v3(pos.x, isl.groundY, pos.z), edge], anchor: edge, useful: 1.1, radius: 2.4 });
        }
      }
    }
  }
  return [...out.values()];
}

const REASONS: Record<string, string> = {
  'too far': 'too far',
  'nothing to build on': 'needs support',
  'scaffold needs a support at the near end': 'needs support at the near end',
  blocked: 'blocked',
};

/** Stateful (hysteresis) aim resolver; one per local player. */
export class BuildAim {
  private prevKey: string | null = null;
  private gx: number | null = null;
  private gz: number | null = null;
  private grot: number | null = null;
  private lastKind: PieceKind | null = null;

  reset() {
    this.prevKey = null; this.gx = null; this.gz = null; this.grot = null;
  }

  update(a: AimInput): AimOutcome {
    if (a.kind !== this.lastKind) { this.reset(); this.lastKind = a.kind; }
    const raw = this.rawSpot(a);
    if (!a.free) {
      const cands = candidatesFor(a.kind, a.player, a.yaw, a.pieces, a.islands, a.myIsland)
        .map((c) => ({ c, s: scoreCandidate(c, a.ray, a.player, a.yaw, this.prevKey) + (c.onTopOf !== undefined && c.onTopOf === raw.topOf ? 1 : 0) }))
        .filter((x) => x.s > -Infinity)
        .sort((x, y) => y.s - x.s);
      for (const { c } of cands.slice(0, MAX_VALIDATIONS)) {
        const r = this.validate(a, c.pos, c.rotY);
        if (!r.ok) continue;
        this.prevKey = c.key;
        return this.outcome(a, c.tag, c.pos, c.rotY, r, c.anchor);
      }
    }
    this.prevKey = 'aim';
    return this.outcome(a, 'aim', raw.pos, raw.rotY, this.validate(a, raw.pos, raw.rotY), null);
  }

  private validate(a: AimInput, pos: Vec3, rotY: number): Placement {
    return validatePlacement(a.physics, a.kind, pos, rotY, a.player);
  }

  private outcome(a: AimInput, tag: SnapTag, pos: Vec3, rotY: number, r: Placement, anchor: Vec3 | null): AimOutcome {
    if (!r.ok) return { kind: a.kind, tag, ghost: { ...pos }, rotY, ok: false, reason: REASONS[r.reason] ?? r.reason, anchor, req: null };
    return {
      kind: a.kind, tag, ghost: { ...r.pos }, rotY, ok: true, reason: null, anchor,
      req: { kind: a.kind, pos: v3(r.pos.x, pos.y, r.pos.z), rotY, free: true },
    };
  }

  /** Where the crosshair points: a hit within reach, else the feet-level plane, clamped to reach. */
  private rawSpot(a: AimInput): { pos: Vec3; rotY: number; topOf: number | null } {
    const { ray, player } = a;
    const s = PIECES[a.kind];
    const rotRaw = a.yaw + baseRot(a.kind) + a.buildRot;
    // Keep the piece clear of the player: its extent along the view direction plus the body.
    const rel = a.buildRot;
    const minD = Math.abs((s.d / 2) * Math.cos(rel)) + Math.abs((s.w / 2) * Math.sin(rel)) + 0.6;
    const hit = a.physics.raycast(ray.eye, ray.dir, 40, a.humanId);
    let p: Vec3;
    let topOf: number | null = null;
    if (hit && hit.hit.type !== 'player' && dist2D(hit.point, player) <= CLIENT_REACH && Math.abs(hit.point.y - player.y) < BUILD.reach - 0.5) {
      p = { ...hit.point };
      if (hit.hit.type === 'piece') {
        const id = hit.hit.id;
        const pc = a.pieces.find((q) => q.id === id);
        if (pc && hit.point.y >= pc.pos.y + PIECES[pc.kind].h - 0.05) topOf = id;
      }
    } else {
      const t = ray.dir.y < -1e-3 ? (player.y - ray.eye.y) / ray.dir.y : -1;
      const h = Math.hypot(ray.dir.x, ray.dir.z) || 1e-6;
      p = t > 0 ? v3(ray.eye.x + ray.dir.x * t, player.y, ray.eye.z + ray.dir.z * t)
        : v3(player.x + (ray.dir.x / h) * FALLBACK_AHEAD, player.y, player.z + (ray.dir.z / h) * FALLBACK_AHEAD);
    }
    let vx = p.x - player.x, vz = p.z - player.z;
    let L = Math.hypot(vx, vz);
    if (L < 1e-3) { const f = forward(a.yaw); vx = f.x; vz = f.z; L = 1; }
    const D = Math.min(CLIENT_REACH, Math.max(minD, L));
    if (D !== L) p = v3(player.x + (vx / L) * D, L > CLIENT_REACH ? player.y : p.y, player.z + (vz / L) * D);
    if (a.free) return { pos: p, rotY: rotRaw, topOf };
    this.gx = snapAxis(p.x, this.gx);
    this.gz = snapAxis(p.z, this.gz);
    this.grot = snapAngle(rotRaw, this.grot);
    return { pos: v3(this.gx, p.y, this.gz), rotY: this.grot, topOf };
  }
}
