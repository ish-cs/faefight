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
    { x: -12.8, z: 9.6, rx: 3.4, rz: 2.5 },
    { x: 12.8, z: 9.6, rx: 3.4, rz: 2.5 },
    { x: -16.2, z: 4.6, rx: 1.4, rz: 1.1 },
    { x: 16.2, z: 4.6, rx: 1.4, rz: 1.1 },
  ],
  puddles: [
    { x: -4.2, z: -6.5, rx: 1.3, rz: 0.7 },
    { x: 7.5, z: -1.5, rx: 0.9, rz: 0.55 },
    { x: -9.5, z: 3.2, rx: 1.1, rz: 0.6 },
    { x: 3.5, z: -15.5, rx: 1.5, rz: 0.8 },
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
  clutter: Clutter[];
  /** riprap along the front wall: x ranges (units of hw) */
  riprap: [number, number][];
};

export const BACKDROP_DECOR: BackdropDecor = {
  grass: [
    { x: -0.95, z: 3, rx: 3.6, rz: 2.2 },
    { x: -0.6, z: 2.4, rx: 3.0, rz: 1.6 },
    { x: 0.98, z: 3.5, rx: 3.4, rz: 2.4 },
    { x: -0.15, z: 2.2, rx: 2.8, rz: 1.5 },
    { x: 0.62, z: 4.2, rx: 2.4, rz: 1.4 },
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
  riprap: [[-1, -0.55], [0.6, 1]],
};
