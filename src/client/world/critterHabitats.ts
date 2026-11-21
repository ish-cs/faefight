/**
 * Where the wildlife lives, in world space, derived from the map (pure data: no three.js, unit-testable).
 * Positions follow the art: island decor (decor.ts, island-local), the harbor backdrop quays (islands.ts
 * backdropFrame / buildBackdrop / buildBeach), container cover (MapDef.statics) and cosmetic props.
 */
import type { MapDef } from '../../sim/map';
import { BACKDROP_DECOR, ISLAND_DECOR } from './decor';

/** Vertical wall panel: bottom-left corner = the anchor's (x, y, z), horizontal unit (ux, uz), outward normal (nx, nz), w × h m. */
export type WallFrame = { ux: number; uz: number; nx: number; nz: number; w: number; h: number };
/**
 * A place a critter lives: a round patch (x, y, z, radius r) it wanders, facing `yaw` when it rests. `wall` = a
 * vertical panel instead (climbers). `water` = y is relative to the live sea level (it rises in sudden death).
 */
export type Anchor = {
  x: number; y: number; z: number; r: number; yaw: number; wall?: WallFrame; water?: boolean;
  /** set by buildHabitats: the anchor stands on walkable map ground (`Habitats.ground`), so walkers there must stay on it */
  grounded?: boolean;
};

export const HABITATS = [
  'quay', 'pallet', 'beach', 'rocks', 'shallows', 'water', 'perch', 'piling', 'palm', 'wall', 'containerTop',
  'trash', 'grass', 'flowers', 'puddle',
] as const;
export type Habitat = (typeof HABITATS)[number];
export type Habitats = Record<Habitat, Anchor[]> & {
  /** solid ground (islands, center island, backdrop quays + beach): birds only dive outside, fish stay outside */
  land: (x: number, z: number) => boolean;
  /**
   * Walkable ground height at (x, z) — island and center-island decks, the backdrop quays, the dry harbor beach —
   * or null over water / past a quay edge. Mirrors the map art (islands.ts, detail.ts buildBeach).
   */
  ground: (x: number, z: number) => number | null;
};

/** islands.ts CHANNEL / backdropFrame (kept in sync by hand; the backdrop is drawn there). */
const CHANNEL = 14;
export function backdropFrameOf(isl: { center: { x: number; z: number }; radius: number; groundY: number }, n: number) {
  const ring = Math.hypot(isl.center.x, isl.center.z);
  const z0 = isl.radius + CHANNEL;
  const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8));
  return { z0, hw, top: isl.groundY + 0.2 };
}

/** Flat sun direction (sky.ts SUN_DIR: azimuth 58°): walls facing it are sunny, the opposite side of things is shade. */
export const SUN_FLAT = { x: Math.sin((58 * Math.PI) / 180), z: Math.cos((58 * Math.PI) / 180) };

/** Harbor beach surface height (detail.ts buildBeach) at t = 0 (water edge) .. 1 (wall foot), ignoring the ripples. */
export const beachY = (t: number) => -1.3 + 2.4 * Math.pow(t, 0.8);

/** Optional extra perches from the art (gull perches: bollards, lamp heads, roof ridges). */
export type PerchIn = { x: number; y: number; z: number; yaw: number };

export function buildHabitats(def: MapDef, perches: PerchIn[] = []): Habitats {
  const H = Object.fromEntries(HABITATS.map((h) => [h, [] as Anchor[]])) as unknown as Habitats;
  for (const p of perches) H.perch.push({ ...p, r: 0 });
  const harbor = def.template === 'harbor';
  const n = def.islands.length;
  const backs: { cx: number; cz: number; yaw: number; hw: number; z0: number }[] = [];
  const A = (x: number, y: number, z: number, r: number, yaw = 0, extra: Partial<Anchor> = {}): Anchor => ({ x, y, z, r, yaw, ...extra });

  const rim = (cx: number, cz: number, R: number, gy: number) => {
    // quay coping: rats and pigeons; the outer wall face: sunny panels for lizards; the foot: rocks + shallows
    const N = Math.round((2 * Math.PI * R) / 5);
    for (let k = 0; k < N; k++) {
      const a = ((k + 0.5) / N) * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a);
      H.quay.push(A(cx + nx * (R - 1.2), gy, cz + nz * (R - 1.2), 1.1, Math.atan2(-nz, nx)));
      const ux = -nz, uz = nx, w = (2 * Math.PI * R) / N;
      if (nx * SUN_FLAT.x + nz * SUN_FLAT.z > 0.3) {
        H.wall.push(A(cx + nx * (R + 0.03) - ux * w * 0.5, 0.7, cz + nz * (R + 0.03) - uz * w * 0.5, 0, 0, { wall: { ux, uz, nx, nz, w, h: gy - 1 } }));
      }
      if (k % 3 === 0) H.water.push(A(cx + nx * (R + 7), -0.6, cz + nz * (R + 7), 4, 0, { water: true }));
    }
  };

  for (const isl of def.islands) {
    const c = Math.cos(isl.bunker.facingYaw), s = Math.sin(isl.bunker.facingYaw), yaw = isl.bunker.facingYaw;
    const W = (x: number, y: number, z: number, r: number, ry = 0, extra: Partial<Anchor> = {}) =>
      A(isl.center.x + x * c + z * s, y, isl.center.z - x * s + z * c, r, yaw + ry, extra);
    const gy = isl.groundY, R = isl.radius;
    rim(isl.center.x, isl.center.z, R, gy);
    // riprap boulders at the quay-wall foot: rocks for starfish / hermit crabs, shallows for herons
    for (const a of ISLAND_DECOR.riprap) {
      H.rocks.push(W(Math.sin(a) * (R + 1.1), 0.35, Math.cos(a) * (R + 1.1), 0.8));
      H.shallows.push(W(Math.sin(a) * (R + 2.6), -0.15, Math.cos(a) * (R + 2.6), 1.2, 0, { water: true }));
    }
    if (harbor) {
      for (const e of ISLAND_DECOR.sandBeds) H.beach.push(W(e.x, gy + 0.02, e.z, Math.min(e.rx, e.rz) * 0.8));
      for (const e of ISLAND_DECOR.grassBeds) if (e.rx * e.rz > 3) H.grass.push(W(e.x, gy + 0.5, e.z, Math.min(e.rx, e.rz)));
      for (const e of ISLAND_DECOR.puddles) H.puddle.push(W(e.x, gy + 0.5, e.z, Math.max(e.rx, e.rz)));
    }
    for (const k of ISLAND_DECOR.clutter) {
      if (k.kind === 'litter') H.trash.push(W(k.x, gy + 0.3, k.z, 0.5));
      if (k.kind === 'flowers' && harbor) H.flowers.push(W(k.x, gy + 0.45, k.z, 1.2));
    }
    // dogs, pigeons: the open back half of the deck
    H.quay.push(W(-10, gy, 9, 4), W(10, gy, 9, 4), W(0, gy, -6, 3));

    const f = backdropFrameOf(isl, n);
    backs.push({ cx: isl.center.x, cz: isl.center.z, yaw, hw: f.hw, z0: f.z0 });
    if (!harbor) continue;
    const { hw, z0, top } = f;
    // the backdrop quay front: rats, pigeons, dogs
    for (let x = -hw + 4; x < hw - 3; x += 7) H.quay.push(W(x, top, z0 + 1.6, 1.5, Math.PI / 2));
    for (const p of BACKDROP_DECOR.pallets) {
      H.pallet.push(W(p.x * hw, top, z0 + p.z, 1.6));
      H.trash.push(W(p.x * hw + 1.1, top + 0.3, z0 + p.z - 1.1, 0.5));
    }
    H.trash.push(W(hw * 0.38, top + 1.1, z0 + 3, 0.8), W(-hw * 0.3, top + 1.1, z0 + 5, 0.8));
    // the beach in front of the quay wall: dry sand for crabs / turtles, the waterline for herons + jellyfish
    for (const [u0, u1] of BACKDROP_DECOR.beaches) {
      for (let u = u0 + 0.05; u < u1 - 0.03; u += 0.06) {
        for (const t of [0.6, 0.8]) H.beach.push(W(u * hw, beachY(t) + 0.03, z0 - 7.8 + t * 8, 1.4));
        H.shallows.push(W(u * hw, -0.12, z0 - 7.8 + 0.45 * 8, 1.2, 0, { water: true }));
        H.water.push(W(u * hw, -0.5, z0 - 11, 2.5, 0, { water: true }));
        H.rocks.push(W(u * hw, beachY(0.52) + 0.02, z0 - 7.8 + 0.52 * 8, 0.8));
      }
      H.puddle.push(W(((u0 + u1) / 2) * hw, 0.9, z0 - 6, 3.5));
    }
    for (const e of BACKDROP_DECOR.grass) H.grass.push(W(e.x * hw, top + 0.5, z0 + e.z, Math.max(e.rx, e.rz)));
    for (const k of BACKDROP_DECOR.clutter) if (k.kind === 'flowers' || k.kind === 'shrub') H.flowers.push(W(k.x * hw, top + 0.6, z0 + k.z, 1.2));
    // palms (islands.ts buildBackdrop): parrots in the crowns
    for (const [x, z] of [[-hw * 0.95, 3], [-hw * 0.6, 2.2], [hw * 0.98, 3.5], [-hw * 0.15, 2]]) H.palm.push(W(x, top + 8.6, z0 + z, 1.2));
    // mooring bollards along the quay front double as pilings for pelicans / cormorants
    for (let x = -hw + 3, k = 0; x < hw - 1; x += 7, k++) if (k % 2 === 0) H.piling.push(W(x, top + 0.5, z0 + 0.6, 0, Math.PI));
  }

  // center island
  {
    const cc = def.center;
    rim(cc.center.x, cc.center.z, cc.radius, cc.groundY);
    H.quay.push(A(cc.center.x, cc.groundY, cc.center.z, cc.radius * 0.5));
    // the open deck around the stalls: pigeons and gulls pick at scraps, so the neutral island isn't just rim rats
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4, r = cc.radius * 0.55;
      H.quay.push(A(cc.center.x + Math.cos(a) * r, cc.groundY, cc.center.z + Math.sin(a) * r, 2));
      if (k % 2 === 0) H.trash.push(A(cc.center.x + Math.cos(a) * r, cc.groundY + 0.3, cc.center.z + Math.sin(a) * r, 0.5));
    }
  }

  // container cover: rats skirt the bases, lizards bask on the sunny sides, iguanas on top
  for (const b of def.statics) {
    if (b.look !== 'container') continue;
    const c = Math.cos(b.rotY), s = Math.sin(b.rotY);
    const y0 = b.center.y - b.half.y;
    H.pallet.push(A(b.center.x, y0, b.center.z, Math.max(b.half.x, b.half.z) + 0.5));
    if (b.half.y > 0.8) H.containerTop.push(A(b.center.x, b.center.y + b.half.y, b.center.z, Math.min(b.half.x, b.half.z) * 0.7, b.rotY));
    const faces: [number, number, number][] = [[1, 0, b.half.x], [-1, 0, b.half.x], [0, 1, b.half.z], [0, -1, b.half.z]];
    for (const [lnx, lnz, off] of faces) {
      const nx = lnx * c + lnz * s, nz = -lnx * s + lnz * c;
      const along = lnx !== 0 ? b.half.z : b.half.x;
      const ux = -nz, uz = nx;
      const fx = b.center.x + nx * (off + 0.02), fz = b.center.z + nz * (off + 0.02);
      const sun = nx * SUN_FLAT.x + nz * SUN_FLAT.z;
      if (sun > 0.25 && b.half.y > 0.8) H.wall.push(A(fx - ux * along, y0 + 0.2, fz - uz * along, 0, 0, { wall: { ux, uz, nx, nz, w: along * 2, h: Math.min(2.4, b.half.y * 2 - 0.4) } }));
    }
  }
  for (const k of def.cosmetics) {
    if (k.kind === 'barrel' || k.kind === 'crate') H.trash.push(A(k.pos.x, k.pos.y + 1.1, k.pos.z, 0.55));
    if (k.kind === 'lamp') H.perch.push(A(k.pos.x, k.pos.y + 4.6, k.pos.z, 0, k.rotY));
    if (k.kind === 'bollard') H.piling.push(A(k.pos.x, k.pos.y + 0.5, k.pos.z, 0, k.rotY));
    if (k.kind === 'palm') H.palm.push(A(k.pos.x, k.pos.y + 6, k.pos.z, 1));
  }

  const discs = [...def.islands.map((i) => ({ x: i.center.x, z: i.center.z, r: i.radius, y: i.groundY })), { x: def.center.center.x, z: def.center.center.z, r: def.center.radius, y: def.center.groundY }];
  const tops = def.islands.map((i) => backdropFrameOf(i, n).top);
  H.land = (x, z) => {
    for (const d of discs) if ((x - d.x) ** 2 + (z - d.z) ** 2 < (d.r + 1) ** 2) return true;
    for (const b of backs) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const rx = x - b.cx, rz = z - b.cz;
      const lx = rx * c - rz * s, lz = rx * s + rz * c;
      if (lz > b.z0 - (harbor ? 9 : 1) && Math.abs(lx) < b.hw + 1) return true;
    }
    return false;
  };
  H.ground = (x, z) => {
    // decks: keep 0.35 m off the coping edge
    for (const d of discs) if ((x - d.x) ** 2 + (z - d.z) ** 2 < (d.r - 0.35) ** 2) return d.y;
    for (let i = 0; i < backs.length; i++) {
      const b = backs[i];
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const rx = x - b.cx, rz = z - b.cz;
      const lx = rx * c - rz * s, lz = rx * s + rz * c;
      if (Math.abs(lx) > b.hw - 0.35) continue;
      if (lz > b.z0 + 0.35 && lz < b.z0 + 80) return tops[i];
      if (!harbor) continue;
      // the harbor beach (detail.ts buildBeach): local t 0 = water edge .. 1 = wall foot; dry above y = 0.1
      for (const [u0, u1] of BACKDROP_DECOR.beaches) {
        const x0 = u0 * b.hw, x1 = u1 * b.hw, len = x1 - x0, mx = lx - (x0 + x1) / 2;
        const t = (lz - (b.z0 - 7.8)) / 8;
        if (Math.abs(mx) > len / 2 || t < 0 || t > 1) continue;
        const ends = Math.min(1, (len / 2 - Math.abs(mx)) / 2.5);
        const y = -1.3 + 2.4 * Math.pow(t, 0.8) * Math.max(0, ends);
        if (y > 0.1) return Math.min(1.1, y);
      }
    }
    return null;
  };
  // water anchors must be over water; mark anchors that stand on walkable ground
  H.water = H.water.filter((a) => !H.land(a.x, a.z));
  for (const h of HABITATS) for (const a of H[h]) {
    if (a.wall || a.water) continue;
    const g = H.ground(a.x, a.z);
    a.grounded = g !== null && Math.abs(g - a.y) < 0.5;
  }
  return H;
}
