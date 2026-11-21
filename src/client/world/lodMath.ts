/**
 * Pure LOD / chunk math (no three.js): level selection with hysteresis, spatial chunk keys, XZ distance to a
 * chunk's bounds. Unit-tested in tests/client/lod.test.ts; lod.ts and chunked.ts build on it.
 */

export type QualityName = 'low' | 'high' | 'ultra';

/** Every LOD distance is multiplied by this per preset (and by the governor's bias, 0.6–1). */
export const LOD_QUALITY_SCALE: Record<QualityName, number> = { low: 0.65, high: 1, ultra: 1.35 };

/** A switch to a coarser level waits until 12 % past the threshold, back to a finer one until 12 % inside it. */
export const LOD_HYSTERESIS = 0.12;

/**
 * Level for an object `dist` metres away. `thresholds[i]` (ascending) is where level i hands over to i + 1, so
 * there are thresholds.length + 1 levels. `current` < 0 = no previous level (pick without hysteresis).
 */
export function selectLod(dist: number, thresholds: readonly number[], current: number, scale = 1, hysteresis = LOD_HYSTERESIS): number {
  const n = thresholds.length;
  if (current < 0 || current > n) {
    let l = 0;
    while (l < n && dist > thresholds[l] * scale) l++;
    return l;
  }
  let l = current;
  while (l < n && dist > thresholds[l] * scale * (1 + hysteresis)) l++;
  while (l > 0 && dist < thresholds[l - 1] * scale * (1 - hysteresis)) l--;
  return l;
}

/** Integer chunk coordinate of `v` metres on a grid of `size` metres. */
export function chunkCoord(v: number, size: number): number {
  return Math.floor(v / size);
}

/** Stable key for chunk (cx, cz); exact for |c| < 32768. */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

/** Group points into chunks: key → indices (in input order). */
export function groupByChunk(points: readonly { x: number; z: number }[], size: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  points.forEach((p, i) => {
    const k = chunkKey(chunkCoord(p.x, size), chunkCoord(p.z, size));
    let a = out.get(k);
    if (!a) out.set(k, (a = []));
    a.push(i);
  });
  return out;
}

/** Horizontal distance from (px, pz) to an XZ box (0 inside). */
export function distToBoxXZ(px: number, pz: number, minX: number, minZ: number, maxX: number, maxZ: number): number {
  const dx = Math.max(minX - px, 0, px - maxX);
  const dz = Math.max(minZ - pz, 0, pz - maxZ);
  return Math.hypot(dx, dz);
}

/** Distance from a point to the nearest surface of a sphere (0 inside). */
export function distToSphere(px: number, py: number, pz: number, cx: number, cy: number, cz: number, r: number): number {
  return Math.max(0, Math.hypot(px - cx, py - cy, pz - cz) - r);
}

/**
 * Round-robin slice for amortised updates: which of `n` items to refresh on `frame` when each item is refreshed
 * every `every` frames. Returns [start, end) indices.
 */
export function updateSlice(n: number, frame: number, every: number): [number, number] {
  if (every <= 1 || n === 0) return [0, n];
  const per = Math.ceil(n / every);
  const k = frame % every;
  return [Math.min(n, k * per), Math.min(n, (k + 1) * per)];
}
