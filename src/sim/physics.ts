import RAPIER from '@dimforge/rapier3d-compat';
import { HEAD, PIECES, PLAYER } from './constants';
import { islandNoBuildZones, potionZone, type NoBuildZone } from './building';
import { bunkerWallBoxes, type IslandLayout } from './map';
import { defaultPotionShops } from './potions';
import type { PieceState, Vec3 } from './types';
import { v3 } from './vec';

export type HitTarget = { type: 'player'; id: number } | { type: 'piece'; id: number } | { type: 'world' };
/** `part`: for player hits, whether the ray went through the head sphere (HEAD) or just the body. */
export type RayHit = { dist: number; point: Vec3; hit: HitTarget; part?: 'head' | 'body' };

/** Distance along a unit ray to a sphere, or null if it misses. */
export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const q = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - q;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : q <= 0 ? 0 : null;
}

let initPromise: Promise<void> | null = null;
const ensureInit = () => (initPromise ??= RAPIER.init());

const ISLAND_DEPTH = 12;
const CAPSULE_HALF = (PLAYER.height - 2 * PLAYER.radius) / 2;
const quatY = (r: number) => ({ x: 0, y: Math.sin(r / 2), z: 0, w: Math.cos(r / 2) });

/** Station props (generator, vault, shop NPC) as solid boxes: half extents. */
export const PROP_HALF = { generator: v3(0.6, 0.7, 0.6), vault: v3(0.6, 1.0, 0.5), shop: v3(0.3, 0.9, 0.3) };

export class Physics {
  private world: RAPIER.World;
  private cc: RAPIER.KinematicCharacterController;
  private entities = new Map<number, HitTarget>();
  private pieces = new Map<number, RAPIER.Collider>();
  private pieceKinds = new Map<number, PieceState['kind']>();
  private players = new Map<number, RAPIER.Collider>();
  private dirty = true;
  /** No-build zones by group ('islands', 'potion'), see building.ts. */
  private zones = new Map<string, NoBuildZone[]>();

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.cc = this.world.createCharacterController(0.02);
    this.cc.enableAutostep(0.35, 0.2, false);
    this.cc.enableSnapToGround(0.3);
    this.cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
  }

  static async create(map: IslandLayout[]): Promise<Physics> {
    await ensureInit();
    const ph = new Physics();
    ph.setNoBuildZones('islands', map.flatMap(islandNoBuildZones));
    ph.setPotionShops(defaultPotionShops().map((s) => s.pos));
    for (const isl of map) {
      const desc = RAPIER.ColliderDesc.cylinder(ISLAND_DEPTH / 2, isl.radius)
        .setTranslation(isl.center.x, isl.groundY - ISLAND_DEPTH / 2, isl.center.z);
      ph.track(ph.world.createCollider(desc), { type: 'world' });
      for (const b of bunkerWallBoxes(isl.bunker)) ph.addStaticBox(b.center, b.half, b.rotY);
      for (const key of ['generator', 'vault', 'shop'] as const) {
        const p = isl[key], h = PROP_HALF[key];
        ph.addStaticBox(v3(p.x, p.y + h.y, p.z), h, isl.bunker.facingYaw);
      }
    }
    return ph;
  }

  private track(c: RAPIER.Collider, t: HitTarget) {
    this.entities.set(c.handle, t);
    this.dirty = true;
    return c;
  }

  private sync() {
    if (!this.dirty) return;
    this.world.step();
    this.dirty = false;
  }

  setNoBuildZones(group: string, zones: NoBuildZone[]): void {
    this.zones.set(group, zones);
  }

  /** Potion sellers move with the map (and tests/e2e): keep their no-build zones in step. */
  setPotionShops(positions: Vec3[]): void {
    this.setNoBuildZones('potion', positions.map((p) => potionZone(p)));
  }

  noBuildZones(): NoBuildZone[] {
    return [...this.zones.values()].flat();
  }

  addStaticBox(center: Vec3, half: Vec3, rotY: number) {
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setRotation(quatY(rotY));
    this.track(this.world.createCollider(desc), { type: 'world' });
  }

  addPiece(p: PieceState): void {
    const s = PIECES[p.kind];
    let desc: RAPIER.ColliderDesc;
    if (p.kind === 'ramp') {
      const w = s.w / 2, d = s.d / 2;
      const pts = new Float32Array([-w, 0, -d, w, 0, -d, -w, 0, d, w, 0, d, -w, s.h, d, w, s.h, d]);
      const hull = RAPIER.ColliderDesc.convexHull(pts);
      if (!hull) throw new Error('Physics.addPiece: ramp convex hull failed');
      desc = hull.setTranslation(p.pos.x, p.pos.y, p.pos.z);
    } else {
      desc = RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(p.pos.x, p.pos.y + s.h / 2, p.pos.z);
    }
    desc.setRotation(quatY(p.rotY));
    this.pieces.set(p.id, this.track(this.world.createCollider(desc), { type: 'piece', id: p.id }));
    this.pieceKinds.set(p.id, p.kind);
  }

  removePiece(id: number): void {
    const c = this.pieces.get(id);
    if (!c) return;
    this.entities.delete(c.handle);
    this.world.removeCollider(c, false);
    this.pieces.delete(id);
    this.pieceKinds.delete(id);
    this.dirty = true;
  }

  pieceKind(id: number): PieceState['kind'] | undefined {
    return this.pieceKinds.get(id);
  }

  addPlayer(id: number, pos: Vec3): void {
    const desc = RAPIER.ColliderDesc.capsule(CAPSULE_HALF, PLAYER.radius)
      .setTranslation(pos.x, pos.y + PLAYER.height / 2, pos.z);
    this.players.set(id, this.track(this.world.createCollider(desc), { type: 'player', id }));
  }

  removePlayer(id: number): void {
    const c = this.players.get(id);
    if (!c) return;
    this.entities.delete(c.handle);
    this.world.removeCollider(c, false);
    this.players.delete(id);
    this.dirty = true;
  }

  /** Teleport a player (feet position). */
  setPlayerPos(id: number, pos: Vec3): void {
    const c = this.mustPlayer(id);
    c.setTranslation({ x: pos.x, y: pos.y + PLAYER.height / 2, z: pos.z });
    this.dirty = true;
  }

  /** Move a player by `desired` (already includes gravity), sliding along obstacles. Returns feet position. */
  movePlayer(id: number, desired: Vec3): { pos: Vec3; grounded: boolean } {
    this.sync();
    const c = this.mustPlayer(id);
    this.cc.computeColliderMovement(c, desired);
    const m = this.cc.computedMovement();
    const t = c.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    c.setTranslation(next);
    this.dirty = true;
    return { pos: v3(next.x, next.y - PLAYER.height / 2, next.z), grounded: this.cc.computedGrounded() };
  }

  /** Like movePlayer, but leaves the collider where it was (client render-time extrapolation). */
  peekMovePlayer(id: number, desired: Vec3): { pos: Vec3; grounded: boolean } {
    this.sync();
    const c = this.mustPlayer(id);
    this.cc.computeColliderMovement(c, desired);
    const m = this.cc.computedMovement();
    const t = c.translation();
    return { pos: v3(t.x + m.x, t.y + m.y - PLAYER.height / 2, t.z + m.z), grounded: this.cc.computedGrounded() };
  }

  hasPlayer(id: number): boolean {
    return this.players.has(id);
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number, ignorePlayer?: number): RayHit | null {
    this.sync();
    const ray = new RAPIER.Ray(origin, dir);
    const exclude = ignorePlayer !== undefined ? this.players.get(ignorePlayer) : undefined;
    const h = this.world.castRay(ray, maxDist, true, undefined, undefined, exclude);
    if (!h) return null;
    const t = h.timeOfImpact;
    const hit = this.entities.get(h.collider.handle) ?? { type: 'world' as const };
    const out: RayHit = { dist: t, point: v3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t), hit };
    if (hit.type === 'player') {
      // The head sphere sits inside the capsule's top: the capsule is always hit first, so it's a headshot
      // when the same ray also passes through the head just behind that entry point.
      const c = h.collider.translation();
      const head = raySphere(origin, dir, v3(c.x, c.y - PLAYER.height / 2 + HEAD.y, c.z), HEAD.r);
      out.part = head !== null && head - t < HEAD.r * 2 ? 'head' : 'body';
    }
    return out;
  }

  /** Like raycast, but players are ignored (only the world and pieces): lag compensation tests them itself. */
  raycastStatic(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
    this.sync();
    const h = this.world.castRay(new RAPIER.Ray(origin, dir), maxDist, true, undefined, undefined, undefined, undefined,
      (c) => this.entities.get(c.handle)?.type !== 'player');
    if (!h) return null;
    const t = h.timeOfImpact;
    return { dist: t, point: v3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t), hit: this.entities.get(h.collider.handle) ?? { type: 'world' } };
  }

  /** Top surface y under (x, z) ignoring players, or null over open water. */
  isGroundAt(x: number, z: number): number | null {
    return this.surfaceBelow(x, 60, z, 120);
  }

  /** First non-player surface hit going straight down from (x, yFrom, z) within maxDrop, or null. */
  surfaceBelow(x: number, yFrom: number, z: number, maxDrop: number): number | null {
    return this.probeDown(x, yFrom, z, maxDrop)?.y ?? null;
  }

  /** Like surfaceBelow, but also reports what was hit. */
  probeDown(x: number, yFrom: number, z: number, maxDrop: number, ignorePiece?: number): { y: number; hit: HitTarget } | null {
    this.sync();
    const ray = new RAPIER.Ray({ x, y: yFrom, z }, { x: 0, y: -1, z: 0 });
    const own = ignorePiece !== undefined ? this.pieces.get(ignorePiece) : undefined;
    const h = this.world.castRay(ray, maxDrop, false, undefined, undefined, own, undefined,
      (c) => this.entities.get(c.handle)?.type !== 'player');
    if (!h) return null;
    return { y: yFrom - h.timeOfImpact, hit: this.entities.get(h.collider.handle) ?? { type: 'world' } };
  }

  /** Everything overlapping an oriented box. */
  overlapsBox(center: Vec3, half: Vec3, rotY: number): HitTarget[] {
    this.sync();
    const out: HitTarget[] = [];
    this.world.intersectionsWithShape(center, quatY(rotY), new RAPIER.Cuboid(half.x, half.y, half.z), (c) => {
      out.push(this.entities.get(c.handle) ?? { type: 'world' });
      return true;
    });
    return out;
  }

  private mustPlayer(id: number) {
    const c = this.players.get(id);
    if (!c) throw new Error(`Physics: no player ${id}`);
    return c;
  }
}
