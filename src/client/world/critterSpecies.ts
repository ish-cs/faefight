/**
 * Wildlife species as data: where each lives, how many (per quality preset), how it moves and what scares it.
 * Behaviour comes from critterSim.ts, meshes from critterMeshes.ts (keyed by `name`), sounds from audio/sfx.ts.
 */
import type { Habitat } from './critterHabitats';

export type SpeciesDef = {
  name: string;
  habitat: Habitat[];
  /** ground: walks its patch · wall: climbs a vertical panel · perch: sits on a point, flies · water: swims at depth */
  mode: 'ground' | 'wall' | 'perch' | 'water';
  cap: { low: number; high: number; ultra: number };
  /** spawn radius around the camera (m) */
  spawnR: number;
  /** agents per anchor (flocks > 1) */
  perAnchor: number;
  /** rough body length (m): culling sphere, and ≥ 0.3 = big enough that it must not pop in on screen */
  size: number;
  /** flee radius from a player, a shot (shooter; impact = 0.6×), an explosion (m); 0 = ignores it */
  fear: [number, number, number];
  walk: number; run: number;
  /** longest single move (m) */
  hop: number;
  idle: [number, number]; move: [number, number];
  flee: 'hide' | 'run' | 'fly' | 'none';
  fleeDist: number;
  /** leg cycles per (m/s) of speed */
  stepRate: number;
  /** idle pose oscillation rate (sniff / peck / push-ups / preen), 0 = still */
  idlePose?: number;
  /** spawns hidden and comes out (holes, burrows): fine to spawn on screen */
  emerges?: boolean;
  sidestep?: boolean;
  /** long rests (naps), pose = 1 */
  rest?: { chance: number; time: [number, number] };
  /** barks at players within this many metres */
  bark?: number;
  freezeOnLook?: boolean;
  /** perched birds fly out and plunge into the water */
  fishes?: boolean;
  /** water: leaps out of the water */
  jumps?: boolean;
  /** stands in the shallows */
  wades?: boolean;
  sound?: string; soundChance: number; fleeSound?: string;
};

const g = (d: Partial<SpeciesDef> & Pick<SpeciesDef, 'name' | 'habitat' | 'cap' | 'size' | 'fear' | 'walk' | 'run'>): SpeciesDef => ({
  mode: 'ground', spawnR: 30, perAnchor: 1, hop: 2, idle: [0.6, 2.5], move: [0.4, 1.5], flee: 'run', fleeDist: 6, stepRate: 3, soundChance: 0, ...d,
});

export const SPECIES_DEFS: SpeciesDef[] = [
  // quays
  g({ name: 'rat', habitat: ['quay', 'pallet'], cap: { low: 8, high: 16, ultra: 24 }, size: 0.25, fear: [5, 14, 25], walk: 2.6, run: 5.5, hop: 1.8, idle: [0.4, 1.8], move: [0.25, 0.9], flee: 'hide', fleeDist: 4, stepRate: 2.2, idlePose: 2.3, emerges: true, sound: 'squeak', soundChance: 0.08, fleeSound: 'squeak' }),
  g({ name: 'pigeon', habitat: ['quay'], cap: { low: 6, high: 16, ultra: 24 }, perAnchor: 6, size: 0.3, spawnR: 40, fear: [4, 18, 30], walk: 0.5, run: 2, hop: 0.8, idle: [0.5, 2], flee: 'fly', stepRate: 3, idlePose: 3.2, sound: 'coo', soundChance: 0.05 }),
  g({ name: 'cat', habitat: ['quay', 'nap'], cap: { low: 1, high: 2, ultra: 3 }, size: 0.5, spawnR: 55, fear: [3.5, 20, 30], walk: 0.9, run: 5, hop: 5, idle: [2, 6], move: [3, 8], fleeDist: 9, stepRate: 1.6, rest: { chance: 0.5, time: [15, 40] }, sound: 'meow', soundChance: 0.05, fleeSound: 'meow' }),
  g({ name: 'dog', habitat: ['quay'], cap: { low: 1, high: 2, ultra: 2 }, size: 0.8, spawnR: 55, fear: [0, 25, 35], walk: 1.9, run: 6, hop: 6, idle: [2, 6], move: [2, 5], fleeDist: 10, stepRate: 1.4, bark: 10, rest: { chance: 0.2, time: [8, 20] }, fleeSound: 'bark', soundChance: 0 }),
  g({ name: 'crow', habitat: ['perch'], mode: 'perch', cap: { low: 2, high: 4, ultra: 6 }, size: 0.4, spawnR: 60, fear: [6, 20, 35], walk: 0, run: 0, idle: [5, 15], flee: 'fly', idlePose: 0.6, sound: 'caw', soundChance: 0.3 }),
  // beaches + rocks + shallows
  g({ name: 'crab', habitat: ['beach', 'rocks'], cap: { low: 6, high: 12, ultra: 18 }, size: 0.15, fear: [3, 10, 20], walk: 0.6, run: 2.2, hop: 1.1, idle: [0.6, 3], move: [0.5, 2], flee: 'hide', fleeDist: 1.6, stepRate: 6, idlePose: 0.7, emerges: true, sidestep: true }),
  g({ name: 'hermit', habitat: ['beach', 'rocks'], cap: { low: 2, high: 6, ultra: 8 }, size: 0.08, fear: [2, 8, 16], walk: 0.12, run: 0.2, hop: 0.4, idle: [1, 4], move: [1, 3], flee: 'hide', fleeDist: 0.2, stepRate: 12, emerges: true }),
  g({ name: 'turtle', habitat: ['beach'], cap: { low: 1, high: 1, ultra: 2 }, size: 0.9, spawnR: 45, fear: [3, 12, 20], walk: 0.12, run: 0.35, hop: 1, idle: [3, 8], move: [3, 8], fleeDist: 1.5, stepRate: 4, rest: { chance: 0.4, time: [10, 30] } }),
  g({ name: 'starfish', habitat: ['rocks'], cap: { low: 4, high: 8, ultra: 12 }, perAnchor: 2, size: 0.15, fear: [0, 0, 0], walk: 0.01, run: 0.01, hop: 0.05, idle: [20, 60], move: [5, 10], flee: 'none' }),
  g({ name: 'heron', habitat: ['shallows'], cap: { low: 1, high: 2, ultra: 3 }, size: 0.9, spawnR: 55, fear: [7, 20, 35], walk: 0.35, run: 1, hop: 0.8, idle: [2, 6], move: [1, 3], flee: 'fly', stepRate: 1.3, idlePose: 0.4, wades: true, sound: 'croak', soundChance: 0.1 }),
  // water
  g({ name: 'pelican', habitat: ['piling'], mode: 'perch', cap: { low: 1, high: 2, ultra: 3 }, size: 1.1, spawnR: 75, fear: [6, 20, 35], walk: 0, run: 0, idle: [6, 18], flee: 'fly', fishes: true, idlePose: 0.3, sound: 'croak', soundChance: 0.15 }),
  g({ name: 'cormorant', habitat: ['piling', 'perch'], mode: 'perch', cap: { low: 1, high: 3, ultra: 5 }, size: 0.8, spawnR: 75, fear: [6, 20, 35], walk: 0, run: 0, idle: [6, 18], flee: 'fly', fishes: true, idlePose: 0.5 }),
  g({ name: 'jelly', habitat: ['shallows', 'water'], mode: 'water', cap: { low: 3, high: 8, ultra: 12 }, perAnchor: 2, size: 0.3, spawnR: 30, fear: [0, 0, 0], walk: 0.12, run: 0.12, hop: 1.2, idle: [1, 3], move: [3, 6], flee: 'none', stepRate: 4, emerges: true }),
  g({ name: 'fish', habitat: ['water'], mode: 'water', cap: { low: 1, high: 3, ultra: 4 }, size: 0.35, spawnR: 45, fear: [0, 6, 12], walk: 0.5, run: 2, hop: 2, idle: [2, 7], move: [1, 2], flee: 'hide', fleeDist: 3, stepRate: 6, jumps: true, emerges: true, sound: 'splash', soundChance: 0 }),
  // palms + containers + walls
  g({ name: 'parrot', habitat: ['palm'], mode: 'perch', cap: { low: 2, high: 6, ultra: 8 }, perAnchor: 3, size: 0.35, spawnR: 60, fear: [6, 22, 35], walk: 0, run: 0, idle: [3, 10], flee: 'fly', idlePose: 0.8, sound: 'squawk', soundChance: 0.35, fleeSound: 'squawk' }),
  g({ name: 'lizard', habitat: ['wall'], mode: 'wall', cap: { low: 3, high: 8, ultra: 12 }, size: 0.2, spawnR: 24, fear: [3, 10, 20], walk: 2.2, run: 4, hop: 1.5, idle: [1, 4], move: [0.3, 0.8], flee: 'hide', fleeDist: 2, stepRate: 4, idlePose: 0.5, emerges: true, freezeOnLook: true }),
  g({ name: 'gecko', habitat: ['wall'], mode: 'wall', cap: { low: 2, high: 6, ultra: 8 }, size: 0.12, spawnR: 20, fear: [3, 10, 20], walk: 2.8, run: 5, hop: 1.2, idle: [0.6, 3], move: [0.2, 0.6], flee: 'hide', fleeDist: 2, stepRate: 5, emerges: true, freezeOnLook: true }),
  g({ name: 'iguana', habitat: ['containerTop', 'quay'], cap: { low: 1, high: 2, ultra: 3 }, size: 0.9, spawnR: 40, fear: [3, 14, 25], walk: 0.4, run: 2.5, hop: 1.2, idle: [4, 12], move: [1, 3], fleeDist: 3, stepRate: 2, rest: { chance: 0.6, time: [10, 30] } }),
];

/** Shader-driven swarms (no CPU agents): members orbit an anchor; caps = members drawn per preset. */
export type SwarmDef = {
  name: string; habitat: Habitat[]; perAnchor: number; cap: { low: number; high: number; ultra: number };
  spawnR: number;
  /** orbit radii (m): horizontal, vertical; orbit speed (rad/s); wing beat (Hz, 0 = none) */
  rx: number; ry: number; speed: number; beat: number;
  /** swims below the live sea level */
  water?: boolean;
  sound?: string;
};

export const SWARM_DEFS: SwarmDef[] = [
  { name: 'fly', habitat: ['trash'], perAnchor: 14, cap: { low: 30, high: 90, ultra: 140 }, spawnR: 22, rx: 0.45, ry: 0.3, speed: 2.6, beat: 0, sound: 'buzz' },
  { name: 'butterfly', habitat: ['grass', 'flowers'], perAnchor: 3, cap: { low: 6, high: 24, ultra: 32 }, spawnR: 35, rx: 1.6, ry: 0.45, speed: 0.55, beat: 7 },
  { name: 'dragonfly', habitat: ['puddle', 'shallows'], perAnchor: 2, cap: { low: 4, high: 12, ultra: 16 }, spawnR: 35, rx: 1.4, ry: 0.25, speed: 0.9, beat: 0 },
  { name: 'bee', habitat: ['flowers'], perAnchor: 5, cap: { low: 0, high: 25, ultra: 40 }, spawnR: 22, rx: 0.8, ry: 0.25, speed: 1.4, beat: 0, sound: 'buzz' },
  { name: 'school', habitat: ['water'], perAnchor: 12, cap: { low: 24, high: 72, ultra: 120 }, spawnR: 35, rx: 1.6, ry: 0.15, speed: 0.7, beat: 0, water: true },
];
