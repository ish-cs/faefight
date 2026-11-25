import { PIECES, PLAYER } from '../../sim/constants';
import { bunkerWallBoxes, COSMETIC, harborCraneBoxes, type Box, type CosmeticDef, type CosmeticKind, type MapDef } from '../../sim/map';
import { PROP_HALF } from '../../sim/physics';
import type { PieceState, PlayerState, Vec3 } from '../../sim/types';
import { rotateY, v3 } from '../../sim/vec';
import { type Ellipse, ISLAND_DECOR } from './decor';

/**
 * What a bullet or blast struck in the world (not players, not built pieces: those have their own fx), worked out
 * from the map data alone so every client agrees without any extra network state: shots and explosions already
 * carry their end points.
 */
export type WorldSurface = 'concrete' | 'quay' | 'asphalt' | 'metal' | 'container' | 'wood' | 'bark' | 'sand' | 'gravel' | 'grass' | 'water';

/** Decal atlas cells (impacts.ts draws them; 4×2). */
export const MARK = { chip: 0, dent: 1, paint: 2, splinter: 3, bark: 4, divot: 5, scorch: 6, crater: 7 } as const;
export type MarkKind = keyof typeof MARK;

/** Bullet mark per surface; water leaves none (a splash instead). */
export const SURFACE_MARK: Record<WorldSurface, MarkKind | null> = {
  concrete: 'chip', quay: 'chip', asphalt: 'chip', metal: 'dent', container: 'paint', wood: 'splinter', bark: 'bark',
  sand: 'divot', gravel: 'divot', grass: 'divot', water: null,
};

/** Impact particle style per surface. */
export type Burst = 'dust' | 'sparks' | 'splinters' | 'sand' | 'splash';
export const SURFACE_BURST: Record<WorldSurface, Burst> = {
  concrete: 'dust', quay: 'dust', asphalt: 'dust', metal: 'sparks', container: 'sparks', wood: 'splinters', bark: 'splinters',
  sand: 'sand', gravel: 'sand', grass: 'sand', water: 'splash',
};

/**
 * Who a mark belongs to, so it goes when that thing goes: a built piece's id (>= 0), the static world (-1), or a
 * namespaced pier section / cosmetic prop / hazard / gameplay prop id (all negative, disjoint).
 */
export const OWNER_WORLD = -1;
const NS = 1 << 26;
export const ownDock = (id: number) => -(NS + id);
export const ownCosmetic = (id: number) => -(2 * NS + id);
export const ownHazard = (id: number) => -(3 * NS + id);
export const ownProp = (id: number) => -(4 * NS + id);
export const isPropOwner = (o: number) => o <= -4 * NS;
export const propOfOwner = (o: number) => -o - 4 * NS;

/** `owner`: what the mark sits on (default: the static world). */
export type SurfaceHit = { surface: WorldSurface; point: Vec3; normal: Vec3; owner?: number };
type SurfBox = Box & { surface: WorldSurface; owner: number; dock?: number };

const COSMETIC_SURFACE: Record<CosmeticKind, WorldSurface> = { palm: 'bark', crate: 'wood', fence: 'wood', barrel: 'metal', lamp: 'metal', bollard: 'metal' };

/** What a shot's end is classified against. */
export type ShotView = {
  pieces: readonly PieceState[]; players: readonly PlayerState[]; waterY: number;
  gone?: readonly PieceState[]; solid?: ((p: Vec3) => SurfaceHit | null) | null;
};

/** World → box-local (inverse of the sim's rotateY). */
const toLocal = (p: Vec3, b: Box) => rotateY(v3(p.x - b.center.x, p.y - b.center.y, p.z - b.center.z), -b.rotY);

function inEllipse(e: Ellipse, x: number, z: number) {
  return ((x - e.x) / e.rx) ** 2 + ((z - e.z) / e.rz) ** 2 <= 1;
}

function nearPath(pts: [number, number][], w: number, x: number, z: number) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) <= w / 2) return true;
  }
  return false;
}

/** Ground material at island-local (x, z) of a harbor island (same beds the ground shader paints). */
export function harborGround(x: number, z: number): WorldSurface {
  const d = ISLAND_DECOR;
  if (d.grassBeds.some((e) => inEllipse(e, x, z))) return 'grass';
  if (d.sandBeds.some((e) => inEllipse(e, x, z))) return 'sand';
  if (d.gravel.some((e) => inEllipse(e, x, z)) || d.gravelPaths.some((p) => nearPath(p.pts, p.w, x, z))) return 'gravel';
  return 'concrete';
}

/** Precomputed solid map geometry with its surfaces. Build once per map. */
export class SurfaceMap {
  readonly boxes: SurfBox[] = [];

  constructor(readonly def: MapDef) {
    const harbor = def.template === 'harbor';
    for (const s of def.statics) this.boxes.push({ ...s, surface: s.look === 'container' ? 'container' : 'concrete', owner: OWNER_WORLD });
    for (const isl of def.islands) {
      for (const b of bunkerWallBoxes(isl.bunker, false)) this.boxes.push({ ...b, surface: 'concrete', owner: OWNER_WORLD });
      for (const key of ['generator', 'vault', 'shop'] as const) {
        const p = isl[key], h = PROP_HALF[key];
        this.boxes.push({ center: v3(p.x, p.y + h.y, p.z), half: h, rotY: isl.bunker.facingYaw, surface: key === 'shop' ? 'wood' : 'metal', owner: OWNER_WORLD });
      }
    }
    if (harbor) for (const b of harborCraneBoxes(def.islands)) this.boxes.push({ ...b, surface: 'metal', owner: OWNER_WORLD });
    // Pier decks: planks, owned by their section (marks go when it breaks; a broken section is skipped).
    for (const d of def.docks ?? []) this.boxes.push({ center: d.center, half: d.half, rotY: d.rotY, surface: 'wood', owner: ownDock(d.id), dock: d.id });
  }

  /** Solid world boxes that appear mid-match (sudden-death doorway barriers): marks land on them from now on. */
  addSolid(boxes: readonly Box[], surface: WorldSurface): void {
    for (const b of boxes) this.boxes.push({ ...b, surface, owner: OWNER_WORLD });
  }

  /** Pier sections that are broken (snapshot `docks`): no longer solid for marks. */
  brokenDocks: ReadonlySet<number> = new Set();

  /** Ground surface of the island under (x, z), or null when not over an island top. */
  groundAt(x: number, z: number): { surface: WorldSurface; y: number } | null {
    for (const isl of this.def.islands) {
      const dx = x - isl.center.x, dz = z - isl.center.z;
      if (Math.hypot(dx, dz) > isl.radius) continue;
      if (this.def.template !== 'harbor') return { surface: 'asphalt', y: isl.groundY };
      const l = rotateY(v3(dx, 0, dz), -isl.bunker.facingYaw);
      return { surface: harborGround(l.x, l.z), y: isl.groundY };
    }
    const c = this.def.center;
    if (Math.hypot(x - c.center.x, z - c.center.z) <= c.radius) return { surface: this.def.template === 'harbor' ? 'concrete' : 'asphalt', y: c.groundY };
    return null;
  }

  /** The solid box containing p (with a little slack), and the face normal p sits on. */
  boxAt(p: Vec3, slack = 0.08): { box: SurfBox; normal: Vec3 } | null {
    for (const b of this.boxes) {
      if (b.dock !== undefined && this.brokenDocks.has(b.dock)) continue;
      const l = toLocal(p, b);
      const ex = Math.abs(l.x) - b.half.x, ey = Math.abs(l.y) - b.half.y, ez = Math.abs(l.z) - b.half.z;
      if (ex > slack || ey > slack || ez > slack) continue;
      // The face the point is closest to (largest signed distance) is the one it hit.
      const n = ex >= ey && ex >= ez ? v3(Math.sign(l.x), 0, 0) : ey >= ez ? v3(0, Math.sign(l.y), 0) : v3(0, 0, Math.sign(l.z));
      return { box: b, normal: rotateY(n, b.rotY) };
    }
    return null;
  }

  /**
   * What the end of a shot hit, or null: a miss into the air (`to` at full range), a player, or a built piece
   * (pieceFx marks those), including one the same snapshot removed (`gone`: the shot that destroyed it). `solid`:
   * dynamic things the map doesn't know (gameplay props, hazards), whose hits carry their owner. `from` is the
   * shooter's eye.
   */
  classify(from: Vec3, to: Vec3, range: number, ctx: ShotView): SurfaceHit | null {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05 || len >= range - 0.05) return null;
    const back = v3(-dx / len, -dy / len, -dz / len);
    for (const pl of ctx.players) {
      if (!pl.alive) continue;
      if (Math.hypot(to.x - pl.pos.x, to.z - pl.pos.z) <= PLAYER.radius + 0.15 && to.y >= pl.pos.y - 0.1 && to.y <= pl.pos.y + PLAYER.height + 0.15) return null;
    }
    if (inPiece(to, ctx.pieces) || (ctx.gone && inPiece(to, ctx.gone))) return null;
    const dyn = ctx.solid?.(to);
    if (dyn) return dyn;
    const box = this.boxAt(to);
    if (box) return { surface: box.box.surface, point: to, normal: box.normal, owner: box.box.owner };
    const g = this.groundAt(to.x, to.z);
    if (g && Math.abs(to.y - g.y) < 0.15) return { surface: g.surface, point: v3(to.x, g.y, to.z), normal: v3(0, 1, 0) };
    if (to.y <= ctx.waterY + 0.25) return { surface: 'water', point: v3(to.x, ctx.waterY, to.z), normal: v3(0, 1, 0) };
    // The island's quay wall: just outside the rim, below the top.
    for (const isl of this.def.islands) {
      const ox = to.x - isl.center.x, oz = to.z - isl.center.z, d = Math.hypot(ox, oz);
      if (Math.abs(d - isl.radius) < 0.35 && to.y < isl.groundY + 0.05) return { surface: 'quay', point: to, normal: v3(ox / d, 0, oz / d) };
    }
    // Backdrop scenery (quays, warehouses, distant stacks): concrete, facing the shooter (flat ground faces up).
    const flat = Math.abs(back.y) > 0.5;
    return { surface: 'concrete', point: to, normal: flat ? v3(0, 1, 0) : back };
  }

  /**
   * Props a bullet passes through on its way (they have no colliders): the entry point on each one's trunk/body,
   * so palms and crates still splinter and mark. `broken` props are skipped.
   */
  propHits(from: Vec3, to: Vec3, broken: ReadonlySet<number>): SurfaceHit[] {
    const out: SurfaceHit[] = [];
    const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y;
    const a = dx * dx + dz * dz;
    if (a < 1e-9) return out;
    for (const d of this.def.cosmetics) {
      if (broken.has(d.id) || d.kind === 'fence') continue; // a thin rail: nothing to mark
      const hit = cylinderEntry(from, dx, dy, dz, a, d);
      if (hit) out.push(hit);
    }
    return out;
  }
}

function cylinderEntry(from: Vec3, dx: number, dy: number, dz: number, a: number, d: CosmeticDef): SurfaceHit | null {
  const c = COSMETIC[d.kind];
  // The visual palm trunk is thinner than the sim's hit cylinder: mark on the trunk.
  const r = d.kind === 'palm' ? 0.2 : c.r;
  const fx = from.x - d.pos.x, fz = from.z - d.pos.z;
  const b = 2 * (fx * dx + fz * dz), cc = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return null;
  const p = v3(from.x + dx * t, from.y + dy * t, from.z + dz * t);
  if (p.y < d.pos.y || p.y > d.pos.y + c.h) return null;
  const nx = p.x - d.pos.x, nz = p.z - d.pos.z, nl = Math.hypot(nx, nz) || 1;
  return { surface: COSMETIC_SURFACE[d.kind], point: p, normal: v3(nx / nl, 0, nz / nl), owner: ownCosmetic(d.id) };
}

function inPiece(to: Vec3, pieces: readonly PieceState[]): boolean {
  for (const pc of pieces) {
    const s = PIECES[pc.kind];
    const l = rotateY(v3(to.x - pc.pos.x, to.y - pc.pos.y - s.h / 2, to.z - pc.pos.z), -pc.rotY);
    if (Math.abs(l.x) <= s.w / 2 + 0.08 && Math.abs(l.y) <= s.h / 2 + 0.08 && Math.abs(l.z) <= s.d / 2 + 0.08) return true;
  }
  return false;
}
