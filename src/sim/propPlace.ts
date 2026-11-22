import { MAP } from './constants';
import type { CenterIsland, CosmeticDef, IslandLayout, StaticBox } from './map';
import { boxesOverlap, generatorZone, islandNoBuildZones, type NoBuildZone, potionZone } from './propZones';
import type { Vec3 } from './types';
import * as dm from './dmath';
import { add, dist2D, forward, right, rotateY, scale, v3 } from './vec';

/**
 * Tier A gameplay props, the Rapier-free half: kinds, spawn placement and the zones props keep out of. MapDef
 * builds call placeProps (the menu bundle builds maps, so nothing here may import Rapier); the rigid-body sim is
 * PropSim in props.ts, which re-exports everything here.
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

const quatYaw = (yaw: number): Quat => [0, dm.sin(yaw / 2), 0, dm.cos(yaw / 2)];
function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const ROLL: Quat = [0, 0, dm.sin(Math.PI / 4), dm.cos(Math.PI / 4)];
export const spawnRot = (kind: PropKind, yaw: number): Quat => (PROP_KINDS[kind].roll ? qmul(quatYaw(yaw), ROLL) : quatYaw(yaw));


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
  { kind: 'pallet', rad: 7.8, deg: 100 }, { kind: 'tire', rad: 7.8, deg: 215 }, // clear of the center hazards (map.ts: 65/72/125/190/245/345°)
  { kind: 'drum', rad: 7.6, deg: 320 }, { kind: 'drum', rad: 8, deg: 330 },
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
  const face = (p: Vec3) => dm.atan2(p.x - c.center.x, p.z - c.center.z);
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
    const pos = v3(c.center.x + dm.cos(a) * s.rad, c.groundY + e.y, c.center.z + dm.sin(a) * s.rad);
    const yaw = rng() * Math.PI * 2;
    if (propBlockedBy(w, s.kind, pos, yaw, zones) || !free(pos, Math.hypot(e.x, e.z))) continue;
    push(s.kind, pos, yaw, -1);
    taken.push({ pos, r: Math.hypot(e.x, e.z) });
  }
  return out;
}