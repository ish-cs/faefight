import { MAP } from '../../sim/constants';
import type { IslandLayout, MapDef } from '../../sim/map';
import { PROP_HALF, CENTER_PROP_HALF } from '../../sim/physics';
import { ISLAND_DECOR } from './decor';

/**
 * Placement of client-only cosmetic debris (tier B: bottles, cans, small boxes, cones, plank bits, small buoys).
 * Pure + deterministic per map seed, so every client starts from the same layout (they may drift apart later:
 * the debris never touches gameplay). Positions are world space, resting on the ground (y = ground top).
 */
export type DebrisKind = 'bottle' | 'can' | 'box' | 'cone' | 'plank' | 'buoy';
export const DEBRIS_KINDS: DebrisKind[] = ['bottle', 'can', 'box', 'cone', 'plank', 'buoy'];

/** Collider + mass per kind. Shapes are centred on the body origin; `rest` = origin height above the ground. */
export const DEBRIS_SPEC: Record<DebrisKind, {
  shape: 'cyl' | 'box' | 'cone' | 'ball'; half: [number, number, number]; mass: number;
  /** water: > 1 floats (buoyancy / weight at full submersion), < 1 sinks slowly */
  float: number; rest: number;
}> = {
  bottle: { shape: 'cyl', half: [0.035, 0.13, 0.035], mass: 0.35, float: 1.6, rest: 0.13 },
  can: { shape: 'cyl', half: [0.033, 0.06, 0.033], mass: 0.05, float: 2.5, rest: 0.06 },
  box: { shape: 'box', half: [0.22, 0.17, 0.2], mass: 1.5, float: 1.8, rest: 0.17 },
  cone: { shape: 'cone', half: [0.17, 0.25, 0.17], mass: 1.2, float: 0.6, rest: 0.25 },
  plank: { shape: 'box', half: [0.55, 0.025, 0.07], mass: 1.8, float: 2.2, rest: 0.025 },
  buoy: { shape: 'ball', half: [0.16, 0.16, 0.16], mass: 0.8, float: 4, rest: 0.16 },
};

export type DebrisSpawn = { kind: DebrisKind; x: number; y: number; z: number; yaw: number; tint: number };

/** Mulberry32: tiny, seedable, identical everywhere. */
export function rng32(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, rr: (a0: number, b0: number) => a0 + (b0 - a0) * next(), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] };
}

/** island-local → world (three.js Y rotation by facingYaw) */
export function toWorld(isl: IslandLayout, x: number, z: number) {
  const c = Math.cos(isl.bunker.facingYaw), s = Math.sin(isl.bunker.facingYaw);
  return { x: isl.center.x + x * c + z * s, z: isl.center.z - x * s + z * c };
}
/** world → island-local */
export function toLocal(isl: IslandLayout, x: number, z: number) {
  const c = Math.cos(isl.bunker.facingYaw), s = Math.sin(isl.bunker.facingYaw);
  const dx = x - isl.center.x, dz = z - isl.center.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** Inside an oriented XZ box grown by `pad`. */
function inBox(x: number, z: number, cx: number, cz: number, hx: number, hz: number, rotY: number, pad: number) {
  const c = Math.cos(rotY), s = Math.sin(rotY), dx = x - cx, dz = z - cz;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) < hx + pad && Math.abs(lz) < hz + pad;
}

/** Clearance (m) kept around station props: the building agent's no-build ZONE_CLEARANCE plus the debris' own size. */
export const STATION_CLEAR = 0.75 + 0.5;
/** Clearance around bunker doorways (either side of the wall) and over the bunker footprint. */
export const DOOR_CLEAR = 2.2;

/**
 * Why a world point on a player island may NOT hold debris (null = fine): bunker footprint/interior and doorways,
 * station zones (generator, vault, shop), gravel paths, built-in cover, the rim.
 */
export function blockedOnIsland(def: MapDef, isl: IslandLayout, x: number, z: number): string | null {
  const l = toLocal(isl, x, z);
  if (Math.hypot(l.x, l.z) > isl.radius - 1.2) return 'rim';
  const b = isl.bunker, half = MAP.bunker.interior / 2 + MAP.bunker.wall;
  if (inBox(x, z, b.center.x, b.center.z, half, half, b.facingYaw, 0.8)) return 'bunker';
  for (const d of b.doorways) if (Math.hypot(x - d.center.x, z - d.center.z) < DOOR_CLEAR + d.width / 2) return 'doorway';
  for (const key of ['generator', 'vault', 'shop'] as const) {
    const p = isl[key], h = PROP_HALF[key];
    if (inBox(x, z, p.x, p.z, h.x, h.z, b.facingYaw, STATION_CLEAR)) return key;
  }
  for (const path of ISLAND_DECOR.gravelPaths) {
    for (let i = 0; i + 1 < path.pts.length; i++) {
      const [ax, az] = path.pts[i], [bx, bz] = path.pts[i + 1];
      if (segDist(l.x, l.z, ax, az, bx, bz) < path.w / 2 + 0.25) return 'path';
    }
  }
  for (const s of def.statics) if (inBox(x, z, s.center.x, s.center.z, s.half.x, s.half.z, s.rotY, 0.4)) return 'cover';
  for (const h of def.hazards ?? []) if (Math.hypot(x - h.pos.x, z - h.pos.z) < 1.2) return 'hazard';
  return null;
}

export function blockedOnCenter(def: MapDef, x: number, z: number): string | null {
  const c = def.center;
  if (Math.hypot(x - c.center.x, z - c.center.z) > c.radius - 1.2) return 'rim';
  for (const key of ['goldGen', 'supplyGen', 'potionShop'] as const) {
    const p = c[key], h = CENTER_PROP_HALF[key];
    if (Math.hypot(x - p.x, z - p.z) < Math.max(h.x, h.z) + STATION_CLEAR + 0.3) return key;
  }
  if (Math.hypot(x - c.shieldWell.x, z - c.shieldWell.z) < 2.5) return 'well';
  for (const s of def.statics) if (inBox(x, z, s.center.x, s.center.z, s.half.x, s.half.z, s.rotY, 0.4)) return 'cover';
  for (const h of def.hazards ?? []) if (Math.hypot(x - h.pos.x, z - h.pos.z) < 1.2) return 'hazard';
  return null;
}

/** Litter clusters per island (island-local): corners and edges, away from the centre lanes. */
const ISLAND_SPOTS: [number, number][] = [[-9, -3], [10, 0], [-14, -9], [14, -10], [-4, 12.5], [5, 11.5], [-18, 3], [18, 5], [0, -19], [-11, 14], [11, 14], [-16, -3], [16, -5], [-6, -16], [6, -17]];
/** What each island litter cluster is mostly made of. */
const MIXES: DebrisKind[][] = [
  ['bottle', 'bottle', 'can', 'can', 'can', 'box'],
  ['cone', 'cone', 'plank', 'plank', 'can'],
  ['box', 'box', 'plank', 'bottle'],
  ['can', 'bottle', 'buoy', 'plank'],
];
const TINT: Record<DebrisKind, number[]> = {
  bottle: [0x2e6b34, 0x6b3b12, 0xc8d8d0],
  can: [0xb8202a, 0x1f5fa8, 0xd8d8d0, 0x2f8a3a],
  box: [0xb0905e, 0xa88a62, 0xc0a070],
  cone: [0xff6a1a, 0xf05a10],
  plank: [0xc8b48c, 0xa89070, 0x8a7458],
  buoy: [0xe0661c, 0xf2f2ea, 0xd23a2a],
};

/**
 * Backdrop quay frame for an island (mirrors islands.ts backdropFrame: island-local +Z, front edge z0, half-width hw,
 * deck at `top`). Kept here as plain numbers so this stays THREE-free.
 */
export function quayFrame(isl: IslandLayout, n: number) {
  const ring = Math.hypot(isl.center.x, isl.center.z);
  const z0 = isl.radius + 14;
  const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8));
  return { z0, hw, top: isl.groundY + 0.2 };
}

/** Deterministic debris layout for a map. `scale` thins the counts (quality presets pass < 1). */
export function placeDebris(def: MapDef, scale = 1): DebrisSpawn[] {
  const out: DebrisSpawn[] = [];
  const rnd = rng32(def.seed * 7919 + 17);
  const push = (kind: DebrisKind, x: number, y: number, z: number) =>
    out.push({ kind, x, y: y + DEBRIS_SPEC[kind].rest, z, yaw: rnd.rr(0, Math.PI * 2), tint: rnd.pick(TINT[kind]) });
  const n = def.islands.length;
  for (const isl of def.islands) {
    // island litter clusters
    ISLAND_SPOTS.forEach(([sx, sz], si) => {
      const mix = MIXES[(si + isl.index) % MIXES.length];
      const k = Math.round(rnd.rr(3, 7) * scale);
      for (let i = 0; i < k; i++) {
        const lx = sx + rnd.rr(-1.6, 1.6), lz = sz + rnd.rr(-1.6, 1.6);
        const w = toWorld(isl, lx, lz);
        if (blockedOnIsland(def, isl, w.x, w.z)) continue;
        push(rnd.pick(mix), w.x, isl.groundY, w.z);
      }
    });
    // backdrop quay: a dense strip along the front (cones by the edge, litter, boxes by the warehouse)
    const f = quayFrame(isl, n);
    const m = Math.round(70 * scale);
    for (let i = 0; i < m; i++) {
      const lx = rnd.rr(-f.hw + 3, f.hw - 3), lz = f.z0 + (rnd.next() < 0.7 ? rnd.rr(1.6, 7) : rnd.rr(11, 15));
      const w = toWorld(isl, lx, lz);
      const u = rnd.next();
      const kind: DebrisKind = u < 0.22 ? 'bottle' : u < 0.45 ? 'can' : u < 0.62 ? 'box' : u < 0.74 ? 'cone' : u < 0.9 ? 'plank' : 'buoy';
      push(kind, w.x, f.top, w.z);
    }
  }
  // center island: a sparse ring of junk
  const c = def.center;
  for (let i = 0; i < Math.round(24 * scale); i++) {
    const a = rnd.rr(0, Math.PI * 2), r = c.radius * Math.sqrt(rnd.rr(0.2, 0.85));
    const x = c.center.x + Math.cos(a) * r, z = c.center.z + Math.sin(a) * r;
    if (blockedOnCenter(def, x, z)) continue;
    push(rnd.pick(MIXES[i % MIXES.length]), x, c.groundY, z);
  }
  return out;
}
