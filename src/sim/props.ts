import RAPIER from '@dimforge/rapier3d-compat';
import { CHARGE, GRENADE, MAP, PLAYER, ROCKET, WEAPONS } from './constants';
import type { CenterIsland, CosmeticDef, IslandLayout, StaticBox } from './map';
import type { Physics } from './physics';
import { boxesOverlap, generatorZone, islandNoBuildZones, type NoBuildZone, potionZone } from './propZones';
import type { MatchEvent, PieceState, PlayerState, Vec3, WeaponKind } from './types';
import { add, dist2D, forward, right, rotateY, scale, v3 } from './vec';

/**
 * Tier A gameplay props: crates, oil drums, pallets, IBC tanks, cable reels and tyres as real rigid bodies, owned by
 * the authoritative sim. Players stand and jump on them (the character controller sees a fixed mirror collider in the
 * query world, see Physics.setPropPose), push them by walking into them (slower for heavy kinds), and shots and
 * explosions knock them around. They float or sink in the water and go back to their spawn after a while.
 *
 * Rules safety: props are never building pieces (seal.ts and support.ts only ever look at pieces), they are not
 * ground for building or support (Physics.probeDown skips them), and any prop that ends up in a bunker interior,
 * a doorway or a no-build zone is put back at its spawn (or pushed out while someone stands on its spawn).
 *
 * Determinism: a separate Rapier world with gravity, stepped once per sim tick at DT, seeded placement, no
 * Math.random; every operation happens in tick order, so replays reproduce the same poses.
 *
 * Hazards hook (not wired yet): a hazard (e.g. an explosive barrel) can become a pushable body by being added
 * as one more PropSpawn with its own kind entry in PROP_KINDS; PropSim only needs kind, rest pose and mass.
 */
export type PropKind = 'crate' | 'drum' | 'pallet' | 'ibc' | 'reel' | 'tire';
export const PROP_KIND_LIST: PropKind[] = ['crate', 'drum', 'pallet', 'ibc', 'reel', 'tire'];

type Shape = { box: Vec3 } | { cyl: { r: number; h: number } };
/**
 * `shape`: collider in the body frame (cylinders stand along body Y; a reel lies on its side through its spawn
 * rotation). `ext`: rough half-extents for placement and buoyancy. `push`: fraction of the pusher's speed it moves
 * at. `floats`: buoyant (sealed drums, wood, empty IBCs, rubber); otherwise sinks slowly.
 */
export const PROP_KINDS: Record<PropKind, { shape: Shape; ext: Vec3; mass: number; push: number; floats: boolean; roll?: boolean }> = {
  crate: { shape: { box: v3(0.45, 0.45, 0.45) }, ext: v3(0.45, 0.45, 0.45), mass: 40, push: 0.6, floats: true },
  drum: { shape: { cyl: { r: 0.3, h: 0.45 } }, ext: v3(0.3, 0.45, 0.3), mass: 60, push: 0.6, floats: true },
  pallet: { shape: { box: v3(0.6, 0.075, 0.5) }, ext: v3(0.6, 0.075, 0.5), mass: 20, push: 0.8, floats: true },
  ibc: { shape: { box: v3(0.6, 0.58, 0.5) }, ext: v3(0.6, 0.58, 0.5), mass: 120, push: 0.3, floats: true },
  reel: { shape: { cyl: { r: 0.6, h: 0.35 } }, ext: v3(0.35, 0.6, 0.6), mass: 150, push: 0.35, floats: false, roll: true },
  tire: { shape: { cyl: { r: 0.5, h: 0.18 } }, ext: v3(0.5, 0.18, 0.5), mass: 50, push: 0.6, floats: true },
};

/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];
/** A prop's spawn: body centre and rotation (`rot` includes a reel's 90° roll onto its side). */
export type PropSpawn = { id: number; kind: PropKind; pos: Vec3; rot: Quat; island: number };
/** A displaced prop's pose in a snapshot (props at their spawn are left out). */
export type PropPose = { id: number; p: [number, number, number]; q: Quat };

export const PROPS = {
  /** Bodies are kept at least this far apart from blocking things when placed (m). */
  clear: 0.6,
  /** Displaced, untouched this long and nobody near: back to spawn (s). */
  idleRespawnSec: 40,
  /** In the water this long: back to spawn (s). */
  wetRespawnSec: 15,
  /** Nobody within this of the prop or its spawn for an idle respawn (m). */
  idleClearM: 10,
  /** Bunker no-prop square: half size around the bunker centre (interior + walls + doorway apron), m. */
  bunkerHalf: MAP.bunker.interior / 2 + MAP.bunker.wall + 0.7,
  /** Explosion velocity change at the centre (m/s), and the mass where it starts to shrink. */
  blastDv: 9,
  blastRefMass: 60,
  /** Bullet impulse per point of damage (N·s). */
  shotImpulse: 0.6,
  /** Pose tolerance before a prop counts as displaced (m, quaternion 1-|dot|). */
  posEps: 0.03,
  rotEps: 2e-4,
  /** Clearance from PlacementWorld.avoid points (hazards), m. */
  avoidM: 1.5,
};

const quatYaw = (yaw: number): Quat => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const ROLL: Quat = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
export const spawnRot = (kind: PropKind, yaw: number): Quat => (PROP_KINDS[kind].roll ? qmul(quatYaw(yaw), ROLL) : quatYaw(yaw));

export function propColliderDesc(kind: PropKind): RAPIER.ColliderDesc {
  const s = PROP_KINDS[kind].shape;
  return 'box' in s ? RAPIER.ColliderDesc.cuboid(s.box.x, s.box.y, s.box.z) : RAPIER.ColliderDesc.cylinder(s.cyl.h, s.cyl.r);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Island clusters: (fwd, side) island-local candidates, first valid one wins; side is mirrored per island by seed. */
type Cluster = { kinds: PropKind[]; spots: [number, number][] };
const ISLAND_CLUSTERS: Cluster[] = [
  // a crate with another stacked on it (the second kind sits on top of the first)
  { kinds: ['crate', 'crate'], spots: [[-1, 13.5], [1.5, 12.5], [0, 10]] },
  { kinds: ['drum'], spots: [[3, -10.5], [1.5, -12.5], [-7, -6]] },
  { kinds: ['ibc'], spots: [[-2, 5], [-2, -5], [11, 3]] },
];
/** One extra per island, by island index. */
const EXTRAS: { kind: PropKind; spots: [number, number][] }[] = [
  { kind: 'pallet', spots: [[-9, 13], [9.5, 9]] },
  { kind: 'tire', spots: [[4, 12], [4, -12]] },
  { kind: 'reel', spots: [[-8, 15], [-8, -15]] },
  { kind: 'ibc', spots: [[11, 3], [11, -3]] },
];
/**
 * Edge/corner set dressing that doubles as light cover: pallet stacks, tyre stacks, a crate on a pallet, drums.
 * Rim band first (radius ~18–20, harbor), then a tighter fallback for the smaller Container Yard islands (R 19).
 * Spots are (fwd, side): local x = side, local z = -fwd (the bunker sits at local +Z).
 */
const EDGE_CLUSTERS: Cluster[] = [
  { kinds: ['pallet', 'pallet'], spots: [[12, -15], [12, 15], [5, -19], [9, -12]] },
  { kinds: ['tire', 'tire'], spots: [[-15, -11], [-16.5, 11], [-12, -9.5]] },
  { kinds: ['pallet', 'crate'], spots: [[14, 14], [18, -8], [11, 11]] },
  { kinds: ['drum'], spots: [[6, 18], [8, -18], [5, 14.5]] },
  { kinds: ['drum'], spots: [[-3, 19], [-4, -19], [-3, 15.5]] },
  { kinds: ['crate'], spots: [[17, -10], [17, 10], [13.5, -8]] },
];
const CENTER_SPOTS: { kind: PropKind; rad: number; deg: number }[] = [
  { kind: 'crate', rad: 4.5, deg: 30 }, { kind: 'drum', rad: 4.5, deg: 150 }, { kind: 'crate', rad: 4.5, deg: 270 },
  { kind: 'pallet', rad: 7.8, deg: 75 }, { kind: 'tire', rad: 7.8, deg: 200 }, { kind: 'drum', rad: 7.6, deg: 320 }, { kind: 'drum', rad: 8, deg: 330 },
];

/**
 * Main walking lanes (island-local x, z polylines + width): the gravel paths the client draws
 * (client/world/decor.ts ISLAND_DECOR.gravelPaths; a test keeps the two in sync). Props stay off them.
 */
export const ISLAND_LANES: { pts: [number, number][]; w: number }[] = [
  { pts: [[-2.2, 12.6], [-5, 8], [-9, 5], [-13, 4.2], [-17, 1]], w: 1.1 },
  { pts: [[2.2, 12.6], [5, 8.5], [9.5, 5.5], [14, 4], [17, -1]], w: 1.1 },
  { pts: [[0, 12.4], [0, 8], [0.5, 2], [0, -3]], w: 0.9 },
  { pts: [[-17, -8], [-12, -12], [-6, -14], [0, -15], [6, -14], [12, -12], [17, -8]], w: 0.8 },
];

/** Distance (m) from an island-local point to the nearest lane centreline minus its half-width. */
export function laneGap(lx: number, lz: number): number {
  let best = Infinity;
  for (const l of ISLAND_LANES) for (let i = 0; i + 1 < l.pts.length; i++) {
    const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((lx - ax) * dx + (lz - az) * dz) / L2));
    best = Math.min(best, Math.hypot(lx - ax - dx * t, lz - az - dz * t) - l.w / 2);
  }
  return best;
}

/** `avoid`: other things props keep ≥ PROPS.avoidM from (e.g. MapDef.hazards positions, once that lands). */
export type PlacementWorld = { islands: IslandLayout[]; center: CenterIsland; statics: StaticBox[]; cosmetics: CosmeticDef[]; seed: number; avoid?: Vec3[] };

/** Zones props keep out of: no-build zones of every island and the center stations. */
export function propZones(def: Pick<PlacementWorld, 'islands' | 'center'>): NoBuildZone[] {
  const c = def.center;
  const face = (p: Vec3) => Math.atan2(p.x - c.center.x, p.z - c.center.z);
  return [
    ...def.islands.flatMap(islandNoBuildZones),
    generatorZone(c.goldGen, face(c.goldGen)), generatorZone(c.supplyGen, face(c.supplyGen)), potionZone(c.potionShop),
  ];
}

/** Inside some bunker's no-prop square (interior, walls, doorways and their aprons)? */
export function inBunkerArea(islands: IslandLayout[], p: Vec3, pad = 0): boolean {
  for (const isl of islands) {
    if (p.y > isl.groundY + MAP.bunker.height + 1) continue;
    const l = rotateY(v3(p.x - isl.bunker.center.x, 0, p.z - isl.bunker.center.z), -isl.bunker.facingYaw);
    const h = PROPS.bunkerHalf + pad;
    if (Math.abs(l.x) < h && Math.abs(l.z) < h) return true;
  }
  return false;
}

/** Why a prop of `kind` at `pos` (body centre, yaw) is not allowed, or null. */
export function propBlockedBy(w: Pick<PlacementWorld, 'islands' | 'center' | 'statics' | 'cosmetics' | 'avoid'>, kind: PropKind, pos: Vec3, yaw: number, zones = propZones(w)): string | null {
  const e = PROP_KINDS[kind].ext, r = Math.hypot(e.x, e.z);
  const islandOf = [...w.islands.map((i) => ({ c: i.center, R: i.radius })), { c: w.center.center, R: w.center.radius }]
    .find((i) => dist2D(i.c, pos) < i.R);
  if (!islandOf || dist2D(islandOf.c, pos) > islandOf.R - r - 1) return 'edge';
  if (inBunkerArea(w.islands, pos, r)) return 'bunker';
  for (const isl of w.islands) {
    if (dist2D(isl.center, pos) >= isl.radius) continue;
    const l = rotateY(v3(pos.x - isl.center.x, 0, pos.z - isl.center.z), -isl.bunker.facingYaw);
    if (laneGap(l.x, l.z) < r + 0.3) return 'lane';
    // bunker doorway approach lanes: 2.5 m clear straight out of every door
    for (const d of isl.bunker.doorways) {
      const f = forward(d.yaw), q = v3(pos.x - d.center.x, 0, pos.z - d.center.z);
      const along = q.x * f.x + q.z * f.z, across = Math.abs(q.x * f.z - q.z * f.x);
      if (Math.abs(along) < 3.2 + r && across < d.width / 2 + 0.6 + r) return 'doorway';
    }
  }
  const half = v3(e.x + PROPS.clear, e.y, e.z + PROPS.clear);
  for (const z of zones) if (boxesOverlap(pos, half, yaw, z)) return `zone:${z.reason}`;
  for (const s of w.statics) if (boxesOverlap(pos, half, yaw, { center: s.center, half: s.half, rotY: s.rotY, reason: 'static' })) return 'static';
  for (const c of w.cosmetics) if (dist2D(c.pos, pos) < r + 1.1) return `cosmetic:${c.kind}`;
  if (dist2D(w.center.shieldWell, pos) < r + 2.2) return 'well';
  for (const a of w.avoid ?? []) if (dist2D(a, pos) < r + PROPS.avoidM) return 'avoid';
  return null;
}

/**
 * Seeded placement for a whole map: ~4 props per player island (a stacked crate pair, a drum, an IBC, one extra)
 * and three on the center island, each on the first valid candidate spot. Ids start at 1, in placement order.
 */
export function placeProps(w: PlacementWorld): PropSpawn[] {
  const out: PropSpawn[] = [];
  const zones = propZones(w);
  const rng = mulberry32((w.seed * 7919) ^ 0x51ed27);
  const taken: { pos: Vec3; r: number }[] = [];
  const free = (pos: Vec3, r: number) => taken.every((t) => dist2D(t.pos, pos) > t.r + r + 0.8);
  const push = (kind: PropKind, pos: Vec3, yaw: number, island: number) => {
    out.push({ id: out.length + 1, kind, pos, rot: spawnRot(kind, yaw), island });
  };
  for (const isl of w.islands) {
    const g = isl.groundY, yaw0 = isl.bunker.facingYaw;
    const inward = forward(yaw0), lat = right(yaw0);
    const at = (fwd: number, side: number) => add(add(isl.center, scale(inward, fwd)), scale(lat, side));
    const tryPlace = (kinds: PropKind[], spots: [number, number][]) => {
      const mirror = rng() < 0.5 ? -1 : 1;
      const yaw = yaw0 + rng() * Math.PI * 2;
      const jx = (rng() - 0.5) * 0.6, jz = (rng() - 0.5) * 0.6;
      for (const [f, s] of spots) {
        const p = at(f + jx, s * mirror + jz);
        const e0 = PROP_KINDS[kinds[0]].ext, r0 = Math.hypot(e0.x, e0.z);
        const base = v3(p.x, g + e0.y, p.z);
        if (!free(base, r0) || propBlockedBy(w, kinds[0], base, yaw, zones)) continue;
        let y = g;
        kinds.forEach((k, i) => {
          const e = PROP_KINDS[k].ext;
          push(k, v3(p.x, y + e.y + (i ? 0.01 : 0), p.z), yaw + i * 0.35, isl.index);
          y += 2 * e.y + 0.01;
        });
        taken.push({ pos: base, r: r0 });
        return;
      }
    };
    // stacked pairs on every other island keep an 8-player map near 40 bodies
    for (const c of ISLAND_CLUSTERS) tryPlace(isl.index % 2 ? c.kinds.slice(0, 1) : c.kinds, c.spots);
    const ex = EXTRAS[isl.index % EXTRAS.length];
    tryPlace([ex.kind], ex.spots);
    for (const c of EDGE_CLUSTERS) tryPlace(c.kinds, c.spots);
  }
  const c = w.center;
  for (const s of CENTER_SPOTS) {
    const a = (s.deg * Math.PI) / 180, e = PROP_KINDS[s.kind].ext;
    const pos = v3(c.center.x + Math.cos(a) * s.rad, c.groundY + e.y, c.center.z + Math.sin(a) * s.rad);
    const yaw = rng() * Math.PI * 2;
    if (propBlockedBy(w, s.kind, pos, yaw, zones) || !free(pos, Math.hypot(e.x, e.z))) continue;
    push(s.kind, pos, yaw, -1);
    taken.push({ pos, r: Math.hypot(e.x, e.z) });
  }
  return out;
}

type Live = {
  spawn: PropSpawn;
  body: RAPIER.RigidBody;
  rest: { pos: Vec3; rot: Quat };
  /** Sim time it was last awake (moving), and when it went into the water (null = dry). */
  lastActive: number;
  wetSince: number | null;
};

const BLAST_R: Record<string, number> = { grenade: GRENADE.radius, charge: CHARGE.radius + 1, rocket: ROCKET.radius };
const SETTLE_STEPS = 90;

/**
 * The props' dynamics world: the same static colliders as the query world (copied from Physics), placed pieces,
 * players as kinematic capsules (props bump into them, never into gameplay), and one dynamic body per prop.
 */
export class PropSim {
  private world: RAPIER.World;
  private live: Live[] = [];
  private byHandle = new Map<number, Live>();
  private pieceCols = new Map<number, RAPIER.Collider>();
  private playerBodies = new Map<number, RAPIER.RigidBody>();
  private zones: NoBuildZone[];

  constructor(private readonly physics: Physics, private readonly islands: IslandLayout[], center: CenterIsland, spawns: PropSpawn[], dt: number) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = dt;
    this.zones = propZones({ islands, center });
    physics.forEachStaticCollider((shape, pos, rot) => {
      this.world.createCollider(new RAPIER.ColliderDesc(shape).setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    });
    for (const s of spawns) {
      const k = PROP_KINDS[s.kind];
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(s.pos.x, s.pos.y, s.pos.z)
        .setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] })
        .setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(true));
      const col = this.world.createCollider(propColliderDesc(s.kind).setMass(k.mass).setFriction(0.7).setRestitution(0.1), body);
      const l: Live = { spawn: s, body, rest: { pos: s.pos, rot: s.rot }, lastActive: 0, wetSince: null };
      this.live.push(l);
      this.byHandle.set(col.handle, l);
    }
    // Settle onto the ground once at match start: the rest pose is where each prop really lies.
    for (let i = 0; i < SETTLE_STEPS; i++) this.world.step();
    for (const l of this.live) {
      l.rest = this.poseOf(l.body);
      l.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      l.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      l.body.sleep();
      this.mirror(l);
    }
    physics.recordPushes = true;
  }

  get count() { return this.live.length; }

  private poseOf(b: RAPIER.RigidBody): { pos: Vec3; rot: Quat } {
    const t = b.translation(), r = b.rotation();
    return { pos: v3(t.x, t.y, t.z), rot: [r.x, r.y, r.z, r.w] };
  }

  private mirror(l: Live) {
    const t = l.body.translation(), r = l.body.rotation();
    this.physics.setPropPose(l.spawn.id, v3(t.x, t.y, t.z), r);
  }

  /** One sim tick, after players moved and explosives went off. `events`: this tick's events (shots, explosions). */
  tick(now: number, players: Iterable<PlayerState>, pieces: Map<number, PieceState>, events: MatchEvent[], waterY: number) {
    this.syncPieces(pieces);
    this.syncPlayers(players);
    for (const push of this.physics.takePushes()) this.push(push.prop, push.dir, push.speed, push.feetY);
    for (const e of events) {
      if (e.type === 'explosion') this.blast(e.data.pos as Vec3, BLAST_R[e.data.kind as string] ?? 3);
      else if (e.type === 'shot') this.shot(e.data.from as Vec3 | undefined, e.data.to as Vec3 | undefined, e.data.weapon as WeaponKind);
    }
    this.water(now, waterY);
    this.world.step();
    const alive = [...this.playerBodies.values()].map((b) => b.translation());
    for (const l of this.live) {
      if (!l.body.isSleeping()) l.lastActive = now;
      const t = l.body.translation();
      const pos = v3(t.x, t.y, t.z);
      const nearSpawn = alive.some((p) => dist2D(p, l.rest.pos) < 1.3 && Math.abs(p.y - l.rest.pos.y) < 2);
      const misplaced = inBunkerArea(this.islands, pos) || this.inZone(l, pos);
      const lost = t.y < waterY - 4 || t.y < -30 || (l.wetSince !== null && now - l.wetSince > PROPS.wetRespawnSec);
      const idle = this.displaced(l) && now - l.lastActive > PROPS.idleRespawnSec
        && !alive.some((p) => dist2D(p, pos) < PROPS.idleClearM || dist2D(p, l.rest.pos) < PROPS.idleClearM);
      const spawnDry = l.rest.pos.y - PROP_KINDS[l.spawn.kind].ext.y > waterY + 0.1;
      if ((misplaced || lost || idle) && !nearSpawn && spawnDry) this.respawn(l);
      else if (misplaced) this.eject(l, pos);
      this.mirror(l);
    }
  }

  private inZone(l: Live, pos: Vec3) {
    const e = PROP_KINDS[l.spawn.kind].ext;
    const half = v3(e.x, e.y, e.z);
    return this.zones.some((z) => boxesOverlap(pos, half, 0, z));
  }

  private displaced(l: Live): boolean {
    const p = this.poseOf(l.body);
    const d = Math.hypot(p.pos.x - l.rest.pos.x, p.pos.y - l.rest.pos.y, p.pos.z - l.rest.pos.z);
    const dot = Math.abs(p.rot[0] * l.rest.rot[0] + p.rot[1] * l.rest.rot[1] + p.rot[2] * l.rest.rot[2] + p.rot[3] * l.rest.rot[3]);
    return d > PROPS.posEps || 1 - dot > PROPS.rotEps;
  }

  private respawn(l: Live) {
    const { pos, rot } = l.rest;
    l.body.setTranslation(pos, false);
    l.body.setRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] }, false);
    l.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    l.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    l.body.sleep();
    l.wetSince = null;
  }

  /** Out of a bunker area / zone while its spawn is occupied: slide it outward, away from the bunker or zone centre. */
  private eject(l: Live, pos: Vec3) {
    let from: Vec3 | null = null;
    for (const isl of this.islands) if (dist2D(isl.bunker.center, pos) < PROPS.bunkerHalf * 1.5) from = isl.bunker.center;
    for (const z of this.zones) if (!from && dist2D(z.center, pos) < 4) from = z.center;
    if (!from) return;
    let dx = pos.x - from.x, dz = pos.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
    const v = l.body.linvel();
    l.body.setLinvel({ x: dx * 2.5, y: Math.max(v.y, 0.5), z: dz * 2.5 }, true);
  }

  private syncPieces(pieces: Map<number, PieceState>) {
    for (const [id, c] of this.pieceCols) if (!pieces.has(id)) { this.world.removeCollider(c, true); this.pieceCols.delete(id); }
    for (const id of pieces.keys()) {
      if (this.pieceCols.has(id)) continue;
      const src = this.physics.pieceCollider(id);
      if (!src) continue;
      const t = src.translation(), r = src.rotation();
      this.pieceCols.set(id, this.world.createCollider(new RAPIER.ColliderDesc(src.shape).setTranslation(t.x, t.y, t.z).setRotation(r)));
    }
  }

  private syncPlayers(players: Iterable<PlayerState>) {
    const seen = new Set<number>();
    for (const p of players) {
      if (!p.alive) continue;
      seen.add(p.id);
      const c = { x: p.pos.x, y: p.pos.y + PLAYER.height / 2, z: p.pos.z };
      let b = this.playerBodies.get(p.id);
      if (!b) {
        b = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(c.x, c.y, c.z));
        this.world.createCollider(RAPIER.ColliderDesc.capsule((PLAYER.height - 2 * PLAYER.radius) / 2, PLAYER.radius - 0.03), b);
        this.playerBodies.set(p.id, b);
        continue;
      }
      const t = b.translation();
      if (Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z) > 2) b.setTranslation(c, true); // teleport/respawn: no sweep
      else b.setNextKinematicTranslation(c);
    }
    for (const [id, b] of this.playerBodies) if (!seen.has(id)) { this.world.removeRigidBody(b); this.playerBodies.delete(id); }
  }

  /** A player walked into prop `id` along `dir` (unit, horizontal) at `speed` m/s: it slides at a fraction of that. */
  private push(id: number, dir: Vec3, speed: number, feetY: number) {
    const l = this.live[id - 1];
    if (!l) return;
    const k = PROP_KINDS[l.spawn.kind];
    const t = l.body.translation();
    if (t.y + k.ext.y * 0.6 < feetY + 0.3) return; // stepping onto / standing on it, not shoving it
    const v = l.body.linvel();
    const target = speed * k.push;
    const along = v.x * dir.x + v.z * dir.z;
    if (along >= target) return;
    const j = k.mass * (target - along);
    l.body.applyImpulse({ x: dir.x * j, y: 0, z: dir.z * j }, true);
  }

  private blast(pos: Vec3 | undefined, r: number) {
    if (!pos) return;
    for (const l of this.live) {
      const t = l.body.translation();
      const dx = t.x - pos.x, dy = t.y - pos.y, dz = t.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > r + 0.6) continue;
      const k = Math.max(0, 1 - Math.max(0, d - 0.3) / r);
      const m = PROP_KINDS[l.spawn.kind].mass;
      const dv = PROPS.blastDv * k * Math.min(1, Math.sqrt(PROPS.blastRefMass / m));
      let nx = dx, ny = dy + 0.8, nz = dz;
      const n = Math.hypot(nx, ny, nz) || 1;
      nx /= n; ny /= n; nz /= n;
      const j = m * dv;
      // slightly below the centre on the blast side: they tumble, not just slide
      l.body.applyImpulseAtPoint({ x: nx * j, y: ny * j, z: nz * j }, { x: t.x - nx * 0.15, y: t.y - 0.12, z: t.z - nz * 0.15 }, true);
    }
  }

  private shot(from: Vec3 | undefined, to: Vec3 | undefined, weapon: WeaponKind) {
    const w = WEAPONS[weapon];
    if (!from || !to || !w || weapon === 'fists') return;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.world.castRay(new RAPIER.Ray(from, dir), len + 0.3, true, undefined, undefined, undefined, undefined, (c) => this.byHandle.has(c.handle));
    if (!hit) return;
    const l = this.byHandle.get(hit.collider.handle)!;
    const p = { x: from.x + dir.x * hit.timeOfImpact, y: from.y + dir.y * hit.timeOfImpact, z: from.z + dir.z * hit.timeOfImpact };
    const j = w.dmg * w.pellets * PROPS.shotImpulse;
    l.body.applyImpulseAtPoint({ x: dir.x * j, y: dir.y * j, z: dir.z * j }, p, true);
  }

  /** Buoyancy + drag: floaters ride half submerged, the rest sink slowly. */
  private water(now: number, waterY: number) {
    for (const l of this.live) {
      const k = PROP_KINDS[l.spawn.kind];
      const t = l.body.translation();
      const hy = Math.max(k.ext.x, k.ext.y, k.ext.z) * 0.8;
      const frac = Math.min(1, Math.max(0, (waterY - (t.y - hy)) / (2 * hy)));
      if (frac <= 0) { l.wetSince = null; continue; }
      l.wetSince ??= now;
      const lift = (k.floats ? 1.9 : 0.4) * frac;
      const dt = this.world.timestep;
      l.body.applyImpulse({ x: 0, y: k.mass * 9.81 * lift * dt, z: 0 }, frac > 0.95 && k.floats);
      if (l.body.isSleeping()) continue;
      const v = l.body.linvel(), w = l.body.angvel();
      const drag = Math.max(0, 1 - 2.5 * frac * dt), spin = Math.max(0, 1 - 1.5 * frac * dt);
      l.body.setLinvel({ x: v.x * drag, y: v.y * drag, z: v.z * drag }, false);
      l.body.setAngvel({ x: w.x * spin, y: w.y * spin, z: w.z * spin }, false);
    }
  }

  /** Poses of every prop away from its rest pose, ascending id (the snapshot's `props`). */
  poses(): PropPose[] {
    const out: PropPose[] = [];
    for (const l of this.live) {
      if (!this.displaced(l)) continue;
      const p = this.poseOf(l.body);
      out.push({ id: l.spawn.id, p: [p.pos.x, p.pos.y, p.pos.z], q: p.rot });
    }
    return out;
  }

  /** Current pose of prop `id` (tests/debug). */
  pose(id: number): { pos: Vec3; rot: Quat } | null {
    const l = this.live[id - 1];
    return l ? this.poseOf(l.body) : null;
  }

  /** Rest pose (settled spawn) of prop `id`. */
  restPose(id: number) { return this.live[id - 1]?.rest ?? null; }

  /** Debug/tests: put prop `id` at `pos` (awake, still). */
  debugPlace(id: number, pos: Vec3) {
    const l = this.live[id - 1];
    if (!l) throw new Error(`PropSim.debugPlace: no prop ${id}`);
    l.body.setTranslation(pos, true);
    l.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    l.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    l.lastActive = -Infinity;
    this.mirror(l);
  }
}
