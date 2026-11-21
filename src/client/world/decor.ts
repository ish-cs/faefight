/**
 * Data-driven cosmetic dressing. Everything here is purely visual (no colliders) and is placed in island-local
 * metres (x = local X, z = local Z; -Z faces the enemy, +Z is the back where the bunker sits) or, for the backdrop,
 * relative to the backdrop quay (x across the quay in units of its half-width `hw`, z metres back from its edge).
 * A map system can swap these lists per island without touching the builders.
 */
export type Ellipse = { x: number; z: number; rx: number; rz: number };

export type ClutterKind = 'ropeCoil' | 'tyre' | 'buoy' | 'net' | 'crate' | 'pebbles' | 'litter' | 'cone' | 'shrub' | 'flowers';
export type Clutter = { kind: ClutterKind; x: number; z: number; yaw?: number; s?: number };

export type IslandDecor = {
  sandBeds: Ellipse[];
  grassBeds: Ellipse[];
  /** crushed-stone patches and paths (drawn under sand, so sand beds get a gravel fringe) */
  gravel: Ellipse[];
  /** gravel paths: polylines (island-local points) with a width in metres */
  gravelPaths: { pts: [number, number][]; w: number }[];
  /** tall-grass clump spots (besides the automatic ones around props, bunker corners and the rim) */
  tallGrass: [number, number][];
  /** shallow standing water (glossy, reflective) */
  puddles: Ellipse[];
  oilStains: Ellipse[];
  /** small flat-ish clutter; must stay low (< 0.35 m) so it never reads as cover */
  clutter: Clutter[];
  /** angles (rad, island-local) of riprap boulder clusters at the quay-wall foot, outside the disc */
  riprap: number[];
};

export const ISLAND_DECOR: IslandDecor = {
  sandBeds: [
    { x: -13, z: 9, rx: 4.8, rz: 3.6 },
    { x: 13, z: 9, rx: 4.8, rz: 3.6 },
    { x: 0, z: 5.2, rx: 3.2, rz: 1.5 },
  ],
  grassBeds: [
    { x: -12.8, z: 9.6, rx: 4.2, rz: 3.1 },
    { x: 12.8, z: 9.6, rx: 4.2, rz: 3.1 },
    { x: -16.4, z: 4.2, rx: 2.2, rz: 1.8 },
    { x: 16.4, z: 4.2, rx: 2.2, rz: 1.8 },
    // flank verges inside the rim
    { x: -19, z: -2, rx: 1.4, rz: 5.2 },
    { x: 19, z: -1, rx: 1.4, rz: 5.4 },
    { x: -16.5, z: -11, rx: 2.4, rz: 1.6 },
    { x: 16.8, z: -10.5, rx: 2.2, rz: 1.5 },
    // back corners around the bunker apron
    { x: -6.5, z: 18.4, rx: 2.6, rz: 1.4 },
    { x: 6.5, z: 18.4, rx: 2.6, rz: 1.4 },
    { x: 0, z: 20, rx: 1.8, rz: 0.8 },
    // small tufts in the front corners and by the vault
    { x: -11, z: -16.5, rx: 1.6, rz: 1.1 },
    { x: 11.5, z: -16, rx: 1.5, rz: 1.1 },
    { x: -2.6, z: -11.2, rx: 0.9, rz: 0.6 },
  ],
  gravel: [
    { x: -13, z: 9, rx: 6.4, rz: 5 },
    { x: 13, z: 9, rx: 6.4, rz: 5 },
    { x: -7.5, z: 13, rx: 3.4, rz: 2 },
    { x: 7.8, z: 13.2, rx: 3.2, rz: 2 },
    { x: 0, z: 5.2, rx: 4.6, rz: 2.4 },
    { x: -18, z: -3, rx: 2.4, rz: 7 },
    { x: 18, z: -2, rx: 2.4, rz: 7 },
    { x: -12, z: -15, rx: 3, rz: 2.2 },
    { x: 12, z: -15, rx: 3, rz: 2.2 },
    { x: 0, z: 18.5, rx: 6.5, rz: 2.2 },
  ],
  gravelPaths: [
    { pts: [[-2.2, 12.6], [-5, 8], [-9, 5], [-13, 4.2], [-17, 1]], w: 1.1 },
    { pts: [[2.2, 12.6], [5, 8.5], [9.5, 5.5], [14, 4], [17, -1]], w: 1.1 },
    { pts: [[0, 12.4], [0, 8], [0.5, 2], [0, -3]], w: 0.9 },
    { pts: [[-17, -8], [-12, -12], [-6, -14], [0, -15], [6, -14], [12, -12], [17, -8]], w: 0.8 },
  ],
  tallGrass: [[-19.6, 6], [19.6, 6], [-20.2, -6], [20.2, -5], [-14, 14], [14, 14], [-9, 18.5], [9, 18.5], [-15, -14], [15, -13.5]],
  puddles: [
    { x: -4.2, z: -6.5, rx: 1.3, rz: 0.7 },
    { x: 7.5, z: -1.5, rx: 0.9, rz: 0.55 },
    { x: -9.5, z: 3.2, rx: 1.1, rz: 0.6 },
    { x: 3.5, z: -15.5, rx: 1.5, rz: 0.8 },
    { x: -14.5, z: -4, rx: 0.8, rz: 0.5 },
    { x: 12.5, z: 1.5, rx: 1, rz: 0.6 },
    { x: -1.5, z: 9.4, rx: 0.7, rz: 0.45 },
    { x: 9.5, z: -13, rx: 0.9, rz: 0.5 },
    { x: -6, z: 15.6, rx: 0.8, rz: 0.4 },
  ],
  oilStains: [
    { x: -2.5, z: -3, rx: 0.9, rz: 0.6 },
    { x: 5, z: 3.5, rx: 0.6, rz: 0.5 },
    { x: -7, z: -11, rx: 1.1, rz: 0.7 },
    { x: 9, z: -9, rx: 0.7, rz: 0.5 },
  ],
  clutter: [
    { kind: 'ropeCoil', x: -19.6, z: -6, yaw: 0.4 },
    { kind: 'ropeCoil', x: 19.4, z: -3, yaw: 1.2 },
    { kind: 'tyre', x: -18.9, z: 2.5, yaw: 0.2 },
    { kind: 'pebbles', x: -11.5, z: 7.4 },
    { kind: 'pebbles', x: 14.3, z: 11.2 },
    { kind: 'pebbles', x: 0.8, z: 5.6 },
    { kind: 'litter', x: -5, z: -9 },
    { kind: 'litter', x: 6.5, z: -12 },
    { kind: 'litter', x: -10, z: -2 },
    { kind: 'litter', x: 11, z: 1 },
    { kind: 'flowers', x: -13.6, z: 10.2 },
    { kind: 'flowers', x: 12.1, z: 8.9 },
  ],
  riprap: [-2.6, -1.9, -1.1, 1.0, 1.8, 2.7],
};

export type BackdropDecor = {
  /** grass verges on the backdrop quay (x in units of hw, z metres from the quay edge) */
  grass: Ellipse[];
  /** gravel patches on the asphalt yard */
  gravel: Ellipse[];
  clutter: Clutter[];
  /** riprap along the front wall: x ranges (units of hw) */
  riprap: [number, number][];
  /** small sand beaches with tide pools in front of the harbor wall: x ranges (units of hw) */
  beaches: [number, number][];
  pallets: { x: number; z: number; n: number; yaw?: number }[];
  tarps: { x: number; z: number; col: number; yaw?: number }[];
  crabPots: { x: number; z: number }[];
  chains: { x: number; z: number; n: number }[];
  signs: { x: number; z: number; text: string; bg: string }[];
  /** street lamps along the quay front (x in units of hw), with cables strung between them */
  lamps: number[];
};

export const BACKDROP_DECOR: BackdropDecor = {
  grass: [
    { x: -0.95, z: 3, rx: 3.6, rz: 2.2 },
    { x: -0.6, z: 2.4, rx: 3.0, rz: 1.6 },
    { x: 0.98, z: 3.5, rx: 3.4, rz: 2.4 },
    { x: -0.15, z: 2.2, rx: 2.8, rz: 1.5 },
    { x: 0.62, z: 4.2, rx: 2.4, rz: 1.4 },
  ],
  gravel: [
    { x: -0.78, z: 6.5, rx: 6, rz: 3.2 },
    { x: 0.5, z: 7.5, rx: 7, rz: 2 },
    { x: -0.05, z: 4, rx: 4, rz: 1.6 },
  ],
  clutter: [
    { kind: 'ropeCoil', x: -0.52, z: 1.6 },
    { kind: 'ropeCoil', x: 0.3, z: 1.5, yaw: 1 },
    { kind: 'net', x: -0.28, z: 2.4 },
    { kind: 'net', x: 0.45, z: 2.7, yaw: 2 },
    { kind: 'buoy', x: -0.33, z: 3.2 },
    { kind: 'buoy', x: -0.31, z: 3.7 },
    { kind: 'crate', x: 0.12, z: 4, yaw: 0.3 },
    { kind: 'crate', x: 0.14, z: 5.2, yaw: -0.2 },
    { kind: 'cone', x: -0.08, z: 1.3 },
    { kind: 'cone', x: 0.05, z: 1.25 },
    { kind: 'tyre', x: 0.7, z: 1.5 },
    { kind: 'shrub', x: -0.9, z: 4.5, s: 1.3 },
    { kind: 'shrub', x: 0.92, z: 5, s: 1.1 },
    { kind: 'shrub', x: -0.2, z: 3, s: 1 },
    { kind: 'flowers', x: -0.62, z: 2.6 },
    { kind: 'flowers', x: 0.95, z: 3 },
  ],
  riprap: [[-1, -0.55], [0.35, 0.55]],
  beaches: [[0.58, 0.98]],
  pallets: [{ x: -0.78, z: 6.2, n: 4 }, { x: -0.68, z: 4.8, n: 2, yaw: 0.3 }, { x: 0.22, z: 3.2, n: 5, yaw: -0.1 }, { x: 0.8, z: 9, n: 3 }, { x: -0.1, z: 13.4, n: 6 }],
  tarps: [{ x: -0.55, z: 8, col: 0x2a5a9a }, { x: 0.38, z: 6.5, col: 0x3d6b3a, yaw: 0.4 }, { x: -0.25, z: 12, col: 0x8a3a2a, yaw: -0.2 }],
  crabPots: [{ x: -0.36, z: 2.1 }, { x: -0.34, z: 2.9 }, { x: -0.37, z: 3.5 }, { x: 0.52, z: 2 }, { x: 0.55, z: 2.8 }],
  chains: [{ x: -0.8, z: 1.3, n: 30 }, { x: 0.1, z: 1.6, n: 24 }, { x: 0.68, z: 1.4, n: 36 }],
  signs: [
    { x: -0.62, z: 1.0, text: 'NO MOORING', bg: '#9a1c1c' },
    { x: 0.32, z: 1.0, text: 'DANGER · DEEP WATER', bg: '#b07d00' },
    { x: -0.18, z: 10, text: 'KEEP CLEAR · FORKLIFTS', bg: '#1d4a6e' },
  ],
  lamps: [-0.9, -0.62, -0.34, -0.16, 0.12, 0.4, 0.68, 0.94],
};
