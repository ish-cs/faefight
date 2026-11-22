/**
 * Cached far shadow cascades (pure scheduling; sky.ts applies it). The world is static and the sun never moves,
 * so a far cascade's map stays valid until the camera has moved or turned enough that the cascade's box shifts.
 * Near cascades render every frame (players, pieces, debris); each far cascade re-renders only when
 *   - the camera moved / turned past a threshold since it was last drawn (and it's at least `minAge` frames old), or
 *   - it reached `maxAge` frames (so dynamic casters in the distance never lag by more than that),
 * and at most one far cascade per frame (the stalest due one), so their cost never stacks on one frame.
 * The shadow lookup matrix only updates when a cascade renders, so a held map stays consistent with its matrix.
 */
export const SHADOW_CACHE = {
  /** camera translation (m) that invalidates far cascades */
  moveM: 1.5,
  /** camera rotation (rad) that invalidates far cascades */
  turnRad: 0.06,
  minAge: 2,
  maxAge: 24,
};

export type CascadeCacheState = { age: number[]; dirty: boolean[] };

export function newCacheState(n: number): CascadeCacheState {
  return { age: new Array(n).fill(Infinity), dirty: new Array(n).fill(true) };
}

/**
 * Advance one frame. `near` = how many leading cascades always render; `moved` = the camera passed a threshold
 * since the last call that reported it (caller re-anchors then). Returns the far cascade to render this frame, or -1.
 */
export function cascadeToRefresh(s: CascadeCacheState, near: number, moved: boolean): number {
  let best = -1, bestAge = -1;
  for (let i = near; i < s.age.length; i++) {
    s.age[i]++;
    if (moved) s.dirty[i] = true;
    const due = s.age[i] >= SHADOW_CACHE.maxAge || (s.dirty[i] && s.age[i] >= SHADOW_CACHE.minAge);
    if (due && s.age[i] > bestAge) { best = i; bestAge = s.age[i]; }
  }
  if (best >= 0) { s.age[best] = 0; s.dirty[best] = false; }
  return best;
}

/**
 * Staggered near cascades: cascade 0 (closest, sharpest, fast casters up close) renders every frame; the other
 * near cascades every second frame (a caster 20–60 m away lags one frame, 8 ms at 120 Hz). Halves that cascade's
 * draws and triangles. Like the far cascades, its lookup matrix only moves when it renders.
 */
export function nearCascadeDue(i: number, frame: number): boolean {
  return i === 0 || frame % 2 === 0;
}
