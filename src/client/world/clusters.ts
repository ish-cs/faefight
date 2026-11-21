import { PROP_KINDS } from '../../sim/props';
import { CENTER, MAP } from '../../sim/constants';
import { COSMETIC, type IslandLayout, type MapDef } from '../../sim/map';
import { BACKDROP_DECOR, ISLAND_DECOR } from './decor';

/** Dressing clearance (m) around a hazard's centre (barrel/propane/crate footprint + room to walk up to it). */
const HAZARD_CLEAR = 1.6;

/**
 * Dense, purposeful dock dressing: PURE placement (no THREE), deterministic per seed. Clusters with a job (work
 * area, storage corner, trash corner, site office, fishing gear, aggregate bays, timber/rebar, IBC/drum/reel yards,
 * forklift spot) fill the harbor backdrop quays; quay-edge gear (bitts, cleats, ladders, rope loops, life rings, hung
 * tyre fenders, crane rails, back fence) lines them; low (< 0.35 m) clutter + decals dress the playable rims.
 * propModels.ts builds one model per PropType using the dimensions in PROP_SPEC; propLayer.ts draws them.
 *
 * Frames: quay placements are backdrop-local (x across the quay, z metres from the backdrop frame origin, so
 * z0 = quay edge; y above the deck); island placements are island-local (same frame as islands.ts `L`; y above the
 * island ground). Yaw = three.js Y rotation.
 */
export type PropType =
  | 'pallet' | 'crate' | 'fishCrate' | 'drum' | 'cone' | 'tyre' | 'sack' | 'bin' | 'bag' | 'ibc' | 'reel' | 'barrier'
  | 'lobsterPot' | 'buoy' | 'toolbox' | 'jerrycan' | 'bucket' | 'cleat' | 'bitt' | 'lifeRing' | 'manhole' | 'stone'
  | 'coil' | 'fence' | 'gate' | 'rail' | 'block' | 'workbench' | 'genset' | 'compressor' | 'weldCart' | 'dumpster'
  | 'portacabin' | 'vending' | 'bench' | 'bicycle' | 'signBoard' | 'netPile' | 'tarpPile' | 'timber' | 'rebar'
  | 'forklift' | 'gravelHeap' | 'sandPile' | 'ladder' | 'ladderLow' | 'ropeLoop' | 'tyreFender' | 'decal';

/**
 * Footprint half extents (x, z) and height at scale 1. `stack`: flat top other items may sit on.
 * `inst`: drawn as instances (numerous); otherwise baked. `cast`: shadow caster — only big props: every caster's
 * triangles are drawn again in each shadow cascade, which measured as the props' main GPU cost.
 */
export type PropSpec = { hx: number; hz: number; h: number; stack?: boolean; inst: boolean; cast: boolean };
export const PROP_SPEC: Record<PropType, PropSpec> = {
  pallet: { hx: 0.6, hz: 0.5, h: 0.144, stack: true, inst: false, cast: false },
  crate: { hx: 0.4, hz: 0.4, h: 0.8, stack: true, inst: false, cast: true },
  fishCrate: { hx: 0.3, hz: 0.2, h: 0.3, stack: true, inst: false, cast: false },
  drum: { hx: 0.3, hz: 0.3, h: 0.88, inst: false, cast: false },
  cone: { hx: 0.21, hz: 0.21, h: 0.7, inst: false, cast: false },
  tyre: { hx: 0.5, hz: 0.5, h: 0.36, stack: true, inst: false, cast: false },
  sack: { hx: 0.32, hz: 0.22, h: 0.24, stack: true, inst: false, cast: false },
  bin: { hx: 0.3, hz: 0.37, h: 1.05, inst: false, cast: false },
  bag: { hx: 0.3, hz: 0.3, h: 0.42, inst: false, cast: false },
  ibc: { hx: 0.6, hz: 0.5, h: 1.16, stack: true, inst: false, cast: true },
  reel: { hx: 0.35, hz: 0.6, h: 1.2, inst: false, cast: true },
  barrier: { hx: 0.6, hz: 0.23, h: 0.8, inst: false, cast: false },
  lobsterPot: { hx: 0.3, hz: 0.4, h: 0.36, stack: true, inst: false, cast: false },
  buoy: { hx: 0.3, hz: 0.3, h: 0.62, inst: false, cast: false },
  toolbox: { hx: 0.25, hz: 0.11, h: 0.25, inst: false, cast: false },
  jerrycan: { hx: 0.17, hz: 0.09, h: 0.45, inst: false, cast: false },
  bucket: { hx: 0.15, hz: 0.15, h: 0.3, inst: false, cast: false },
  cleat: { hx: 0.2, hz: 0.07, h: 0.12, inst: false, cast: false },
  bitt: { hx: 0.45, hz: 0.2, h: 0.55, inst: false, cast: false },
  lifeRing: { hx: 0.3, hz: 0.12, h: 1.4, inst: false, cast: false },
  manhole: { hx: 0.35, hz: 0.35, h: 0.03, inst: false, cast: false },
  stone: { hx: 0.15, hz: 0.15, h: 0.1, inst: true, cast: false },
  coil: { hx: 0.35, hz: 0.35, h: 0.15, inst: false, cast: false },
  fence: { hx: 1.25, hz: 0.05, h: 2.1, inst: false, cast: false },
  gate: { hx: 1.5, hz: 0.05, h: 2.1, inst: false, cast: false },
  rail: { hx: 2, hz: 0.05, h: 0.02, inst: false, cast: false },
  block: { hx: 0.8, hz: 0.4, h: 0.8, stack: true, inst: false, cast: true },
  workbench: { hx: 1, hz: 0.4, h: 0.92, stack: true, inst: false, cast: true },
  genset: { hx: 0.8, hz: 0.45, h: 1.2, inst: false, cast: true },
  compressor: { hx: 0.6, hz: 0.35, h: 0.8, inst: false, cast: false },
  weldCart: { hx: 0.3, hz: 0.25, h: 1.5, inst: false, cast: false },
  dumpster: { hx: 0.9, hz: 0.6, h: 1.25, inst: false, cast: true },
  portacabin: { hx: 3, hz: 1.75, h: 2.75, inst: false, cast: true },
  vending: { hx: 0.45, hz: 0.4, h: 1.85, inst: false, cast: true },
  bench: { hx: 0.9, hz: 0.3, h: 0.85, inst: false, cast: false },
  bicycle: { hx: 0.85, hz: 0.3, h: 1.0, inst: false, cast: false },
  signBoard: { hx: 0.9, hz: 0.15, h: 2.2, inst: false, cast: true },
  netPile: { hx: 0.9, hz: 0.7, h: 0.5, inst: false, cast: false },
  tarpPile: { hx: 1.3, hz: 1.1, h: 1.25, inst: false, cast: true },
  timber: { hx: 1.9, hz: 0.65, h: 1.0, inst: false, cast: true },
  rebar: { hx: 3, hz: 0.45, h: 0.5, stack: true, inst: false, cast: false },
  forklift: { hx: 0.65, hz: 1.6, h: 2.2, inst: false, cast: true },
  gravelHeap: { hx: 3.2, hz: 3.2, h: 2.0, inst: false, cast: true },
  sandPile: { hx: 2.6, hz: 2.6, h: 1.5, inst: false, cast: true },
  ladder: { hx: 0.3, hz: 0.15, h: 1, inst: false, cast: false },
  ladderLow: { hx: 0.3, hz: 0.15, h: 0.3, inst: false, cast: false },
  ropeLoop: { hx: 0.4, hz: 0.4, h: 0.4, inst: false, cast: false },
  tyreFender: { hx: 0.5, hz: 0.15, h: 1, inst: false, cast: false },
  decal: { hx: 0.5, hz: 0.5, h: 0.006, inst: false, cast: false },
};

/** Decal atlas cells (propModels.ts draws the atlas). */
export const DECAL = { oil: 0, oil2: 1, tyreMarks: 2, crack: 3, patch: 4, rust: 5, arrow: 6, bay: 7 } as const;
/** Sign-board atlas rows (propModels.ts). */
export const SIGN_TEXTS = ['SITE OFFICE', 'AUTHORISED PERSONNEL ONLY', 'SPEED LIMIT 10', 'HARD HAT AREA'] as const;

export type S3 = [number, number, number];
export type Placement = {
  type: PropType;
  x: number; y: number; z: number;
  yaw: number;
  s: S3;
  /** multiplies the model's tintable parts (0xffffff = as modelled) */
  tint: number;
  /** quality tier: 0 = every preset, 1 = high + ultra, 2 = ultra only */
  tier: number;
  /** index (into the same output array) of the item this one sits on */
  on?: number;
  /** decal atlas cell / sign row */
  cell?: number;
  /** small lean (rad) about local X / Z */
  tilt?: [number, number];
  /** outside the playable disc (island edge gear on/under the quay wall) */
  edge?: boolean;
};

// ---------------------------------------------------------------- rng + geometry helpers

/** Same Park–Miller generator as textures.ts makeRng (kept here so placement stays THREE-free). */
export function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const rr = (a: number, b: number) => a + (b - a) * rnd();
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  return { rnd, rr, pick };
}
type Rng = ReturnType<typeof rng>;

/** Axis-aligned rect (centre + half extents) in the placement frame. */
export type Rect = { x: number; z: number; hx: number; hz: number };
const overlaps = (a: Rect, b: Rect, m = 0) => Math.abs(a.x - b.x) < a.hx + b.hx + m && Math.abs(a.z - b.z) < a.hz + b.hz + m;

/** Round footprints: yaw does not change their extent. */
const ROUND = new Set<PropType>(['gravelHeap', 'sandPile', 'drum', 'tyre', 'coil', 'buoy', 'bucket', 'manhole', 'bag', 'stone']);

/** Placement footprint (yaw-rotated half extents → AABB). */
export function footprint(p: Placement): Rect {
  const sp = PROP_SPEC[p.type];
  if (ROUND.has(p.type)) return { x: p.x, z: p.z, hx: sp.hx * p.s[0], hz: sp.hz * p.s[2] };
  const c = Math.abs(Math.cos(p.yaw)), s = Math.abs(Math.sin(p.yaw));
  const hx = sp.hx * p.s[0], hz = sp.hz * p.s[2];
  return { x: p.x, z: p.z, hx: hx * c + hz * s, hz: hx * s + hz * c };
}

export const topOf = (p: Placement) => p.y + PROP_SPEC[p.type].h * p.s[1];

/**
 * Builds one cluster in its own frame (origin = anchor, yaw 0); `commit` rotates/translates it into the output.
 * `put` returns the item's index within the cluster; `on` stacks onto an earlier item (y = its top).
 */
class Kit {
  items: Placement[] = [];
  constructor(readonly r: Rng) {}
  put(type: PropType, x: number, z: number, o: { yaw?: number; s?: number | S3; tint?: number; tier?: number; on?: number; cell?: number; tilt?: [number, number]; y?: number } = {}) {
    const s: S3 = typeof o.s === 'number' ? [o.s, o.s, o.s] : o.s ?? [1, 1, 1];
    const y = o.on !== undefined ? topOf(this.items[o.on]) : o.y ?? (type === 'decal' ? 0.006 : 0);
    this.items.push({ type, x, y, z, yaw: o.yaw ?? 0, s, tint: o.tint ?? 0xffffff, tier: o.tier ?? 0, on: o.on, cell: o.cell, tilt: o.tilt });
    return this.items.length - 1;
  }
  /** A column of `n` identical items; returns the indices bottom → top. Upper levels may be a higher tier. */
  stack(type: PropType, x: number, z: number, n: number, o: { yaw?: number; tint?: () => number; tier?: number; jitter?: number; on?: number } = {}) {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const j = o.jitter ?? 0;
      out.push(this.put(type, x + this.r.rr(-j, j), z + this.r.rr(-j, j), {
        yaw: (o.yaw ?? 0) + this.r.rr(-0.06, 0.06), tint: o.tint?.() ?? 0xffffff, tier: Math.max(o.tier ?? 0, k >= 2 ? 1 : 0),
        on: k === 0 ? o.on : out[k - 1],
      }));
    }
    return out;
  }
}

const WOOD = [0xe0cca8, 0xd2b890, 0xc8ab84, 0xb99c74, 0xe8d8b8];
// No red: red drums are the explosive hazards (hazards.ts).
const DRUM = [0x1f5fa8, 0x6b6448, 0x2f6b3a, 0xd8a020, 0x46505a, 0x1f5fa8];
const PLASTIC_BIN = [0x2f6b3a, 0x3a3f44, 0x1f4e79, 0x6b6e70];
const FISH = [0x2f7fc0, 0xd84a2a, 0x3a9a5a, 0xd8d8d0];
const NET = [0x2f6a58, 0x3a5a8a, 0xc8642a, 0x2a2a2a];
const CONES = [0xf0601c, 0xe85a18];
const ROPE = [0xd8b030, 0xb7a27a, 0x2f5fa0, 0x3a3a3a];
const TARP = [0x2a5a9a, 0x3d6b3a, 0x8a3a2a, 0x5a6066];

// ---------------------------------------------------------------- cluster recipes (cluster frame, front = -Z)

type Recipe = { hx: number; hz: number; build: (k: Kit) => void };

const RECIPES = {
  /** Toolbench, genset, compressor, welding bottles, hose, fuel. */
  workArea: { hx: 3.1, hz: 2.3, build: (k) => {
    const wb = k.put('workbench', 0, 1.5);
    k.put('toolbox', k.r.rr(-0.6, 0.6), 1.5, { on: wb, tint: k.r.pick([0xc0302a, 0x2a5aa8]), yaw: k.r.rr(-0.2, 0.2) });
    k.put('genset', -2.1, 1.3, { yaw: k.r.rr(-0.1, 0.1), tint: k.r.pick([0xd9a521, 0x3a7a3a, 0xe0e0d8]) });
    k.put('decal', -2.1, 0.4, { cell: DECAL.oil, s: [2.2, 1, 1.6], yaw: k.r.rr(0, 6) });
    k.put('compressor', 2.2, -0.2, { yaw: k.r.rr(-0.5, 0.5), tint: k.r.pick([0xc0302a, 0x2a5aa8, 0xe8b81c]) });
    k.put('weldCart', 1.4, 1.5, { yaw: k.r.rr(-0.3, 0.3) });
    k.put('coil', -0.4, -0.9, { tint: k.r.pick(ROPE), yaw: k.r.rr(0, 6) });
    k.put('drum', -2.5, -1.2, { tint: k.r.pick(DRUM), yaw: k.r.rr(0, 6) });
    k.put('jerrycan', -1.8, -1.6, { tint: k.r.pick([0xc0302a, 0x3a6a2a]), yaw: k.r.rr(0, 6) });
    k.put('bucket', 0.7, -1.4, { tint: k.r.pick([0x2a2a2a, 0xe0e0d8, 0xd8a020]), tier: 1 });
    k.put('cone', -2.9, -2.0, { tint: k.r.pick(CONES), tier: 1 });
    k.put('cone', 2.9, -2.0, { tint: k.r.pick(CONES), tier: 1 });
  } },
  /** Stacked crates, a tarped pile, sacks on a pallet, fish/ice crates, a pallet stack. */
  storage: { hx: 3.3, hz: 2.6, build: (k) => {
    for (const [x, z] of [[-2.4, 1.7], [-1.5, 1.7], [-2.4, 0.8]] as const) k.stack('crate', x, z, 1 + Math.floor(k.r.rnd() * 3), { tint: () => k.r.pick(WOOD) });
    k.put('tarpPile', 1.7, 1.2, { tint: k.r.pick(TARP), yaw: k.r.rr(-0.1, 0.1) });
    const p = k.put('pallet', 1.6, -1.2, { tint: k.r.pick(WOOD) });
    for (const [dx, dz] of [[-0.28, -0.22], [0.28, -0.22], [-0.28, 0.22], [0.28, 0.22]] as const) {
      const s = k.put('sack', 1.6 + dx, -1.2 + dz, { on: p, tint: k.r.pick([0xc4a874, 0xe0d8c8, 0xb8a080]), yaw: k.r.rr(-0.2, 0.2) });
      if (dx < 0 && dz < 0) k.put('sack', 1.6 + dx + 0.05, -1.2 + dz + 0.05, { on: s, tint: 0xd0c0a0, yaw: 0.4, tier: 1 });
    }
    for (const x of [-0.75, -0.1]) k.stack('fishCrate', x, -1.6, 1 + Math.floor(k.r.rnd() * 4), { tint: () => k.r.pick(FISH) });
    k.stack('pallet', -2.5, -1.5, 2 + Math.floor(k.r.rnd() * 5), { tint: () => k.r.pick(WOOD), yaw: Math.PI / 2 });
  } },
  /** Dumpster, wheelie bins, bin bags. */
  trash: { hx: 2.5, hz: 1.5, build: (k) => {
    k.put('dumpster', 0.6, 0.6, { tint: k.r.pick([0x2f6b3a, 0x1f4e79, 0x5a6066]), yaw: k.r.rr(-0.06, 0.06) });
    k.put('bin', -1.7, 0.9, { tint: k.r.pick(PLASTIC_BIN), yaw: k.r.rr(-0.2, 0.2) });
    k.put('bin', -1.05, 0.95, { tint: k.r.pick(PLASTIC_BIN), yaw: k.r.rr(-0.2, 0.2) });
    for (let i = 0; i < 4; i++) k.put('bag', k.r.rr(-1.9, 1.9), k.r.rr(-1.1, -0.4), { tint: k.r.pick([0x1a1a1c, 0x22262a, 0x3a5a3a]), yaw: k.r.rr(0, 6), s: k.r.rr(0.8, 1.1), tier: i < 2 ? 0 : 1 });
    k.put('decal', 0.2, -0.3, { cell: DECAL.oil2, s: [2.4, 1, 1.4], yaw: k.r.rr(0, 6) });
  } },
  /** Portacabin site office with a vending machine, bench, bikes, a sign and a bin. */
  office: { hx: 4.4, hz: 2.7, build: (k) => {
    k.put('portacabin', 0, 0.8, { tint: k.r.pick([0xe8e6de, 0x3a6a9a, 0x2f6b3a]) });
    k.put('vending', 3.75, 1.4, { tint: k.r.pick([0xb8202a, 0x1f5fa8]) });
    k.put('bench', -1.4, -1.9, { yaw: 0 });
    k.put('bicycle', -3.8, 0.2, { yaw: Math.PI / 2, tint: k.r.pick([0x1f5fa8, 0xb8202a, 0x2a2a2a]), tilt: [0, 0.18] });
    k.put('bicycle', -3.8, 1.5, { yaw: Math.PI / 2, tint: k.r.pick([0x2f6b3a, 0xd8d8d0]), tilt: [0, 0.18], tier: 1 });
    k.put('signBoard', 2.4, -2.3, { cell: Math.floor(k.r.rnd() * SIGN_TEXTS.length) });
    k.put('bin', 3.8, 0.2, { tint: k.r.pick(PLASTIC_BIN) });
    k.put('decal', 0, -1.6, { cell: DECAL.bay, s: [3, 1, 1.2] });
  } },
  /** Lobster pots, a net pile, buoys, fish crates, rope. */
  fishing: { hx: 2.9, hz: 2.0, build: (k) => {
    for (let i = 0; i < 3; i++) k.stack('lobsterPot', -2.3 + i * 0.66, -1.4, 1 + Math.floor(k.r.rnd() * 3), { tint: () => k.r.pick(NET) });
    for (let i = 0; i < 2; i++) k.stack('lobsterPot', -2.3 + i * 0.66, -0.5, 1 + Math.floor(k.r.rnd() * 2), { tint: () => k.r.pick(NET), tier: 1 });
    k.put('netPile', 1.4, 0.8, { tint: k.r.pick(NET), yaw: k.r.rr(0, 6) });
    for (let i = 0; i < 3; i++) k.put('buoy', 1.2 + i * 0.62, -1.3, { tint: k.r.pick([0xe8601c, 0xe8e2d0, 0xe0b020]), tier: i === 2 ? 1 : 0 });
    k.stack('fishCrate', -0.2, 1.4, 1 + Math.floor(k.r.rnd() * 3), { tint: () => k.r.pick(FISH) });
    k.put('coil', -1.4, 1.2, { tint: k.r.pick(ROPE), yaw: k.r.rr(0, 6) });
  } },
  /** Concrete-block bays with a gravel heap and a sand pile, stones spilled at the base. */
  aggregate: { hx: 7.2, hz: 4.4, build: (k) => {
    for (let i = 0; i < 9; i++) {
      const b = k.put('block', -6.4 + i * 1.6, 3.9, { tint: 0xd8d2c4, yaw: k.r.rr(-0.02, 0.02) });
      if (i % 2 === 0 || k.r.rnd() < 0.4) k.put('block', -6.4 + i * 1.6 + k.r.rr(-0.04, 0.04), 3.9, { on: b, tint: 0xccc6b8, tier: 1 });
    }
    for (const z of [2.3, 0.7]) k.put('block', 0.3, z, { yaw: Math.PI / 2, tint: 0xd0cabc });
    const heaps: [PropType, number, number, number][] = [['gravelHeap', -3.4, 0.2, k.r.pick([0x9a9690, 0xb0aaa0, 0x8a8278])], ['sandPile', 3.9, 0.6, k.r.pick([0xe0c898, 0xd0b480])]];
    for (const [t, x, z, tint] of heaps) {
      const sx = k.r.rr(0.85, 1.05), sy = k.r.rr(0.8, 1.05);
      k.put(t, x, z, { s: [sx, sy, sx], yaw: k.r.rr(0, 6), tint });
      const R = PROP_SPEC[t].hx * sx;
      const n = Math.round(R * 7);
      for (let j = 0; j < n; j++) {
        const a = k.r.rr(0, Math.PI * 2), r = R * k.r.rr(0.98, 1.18);
        const sz = k.r.rr(0.4, 1.4);
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (Math.abs(px) > 7.0 || pz > 3.3 || pz < -4.2 || Math.abs(px - 0.3) < 0.5) continue; // inside the bay, off the walls
        k.put('stone', px, pz, { s: [sz, sz * k.r.rr(0.7, 1.1), sz], yaw: k.r.rr(0, 6), tint: tint === 0 ? 0xffffff : tint, tier: j % 3 === 0 ? 0 : j % 3 });
      }
    }
    k.put('cone', -6.9, -4.1, { tint: k.r.pick(CONES) });
    k.put('cone', 6.9, -4.1, { tint: k.r.pick(CONES), tier: 1 });
  } },
  /** Timber stack and rebar bundles on sleepers, a cable reel. */
  timber: { hx: 3.3, hz: 1.7, build: (k) => {
    k.put('timber', -1.1, 0.8, { yaw: k.r.rr(-0.03, 0.03), tint: k.r.pick(WOOD) });
    const r0 = k.put('rebar', 0, -0.9, { tint: k.r.pick([0x7a4a2a, 0x6a3a22]) });
    if (k.r.rnd() < 0.6) k.put('rebar', k.r.rr(-0.2, 0.2), -0.9, { on: r0, tint: 0x70442a, yaw: k.r.rr(-0.03, 0.03), tier: 1 });
    k.put('reel', 2.4, 0.9, { yaw: k.r.rr(-0.2, 0.2), tint: k.r.pick(WOOD) });
  } },
  /** Cable reels in a row. */
  reels: { hx: 2.2, hz: 1.2, build: (k) => {
    for (let i = 0; i < 3; i++) k.put('reel', -1.4 + i * 1.4, k.r.rr(-0.3, 0.3), { yaw: k.r.rr(-0.25, 0.25), tint: k.r.pick(WOOD), tier: i === 2 ? 1 : 0 });
  } },
  /** IBC totes 2 × 2, partly double-stacked. */
  ibc: { hx: 1.9, hz: 1.4, build: (k) => {
    for (const [x, z] of [[-0.65, -0.55], [0.65, -0.55], [-0.65, 0.55], [0.65, 0.55]] as const) {
      const b = k.put('ibc', x, z, { tint: k.r.pick([0xe8e6dc, 0xd8d4c4, 0xe0dcc8]), yaw: k.r.rr(-0.03, 0.03) });
      if (z > 0 && k.r.rnd() < 0.6) k.put('ibc', x, z, { on: b, tint: 0xe4e0d4, tier: 1 });
    }
    k.put('decal', 0, -1.1, { cell: DECAL.oil, s: [1.8, 1, 1.2], yaw: k.r.rr(0, 6) });
  } },
  /** Two pallets of oil drums. */
  drums: { hx: 1.6, hz: 1.4, build: (k) => {
    for (const x of [-0.7, 0.7]) {
      const p = k.put('pallet', x, 0, { tint: k.r.pick(WOOD), yaw: Math.PI / 2 });
      const n = 2 + Math.floor(k.r.rnd() * 3);
      const spots = [[-0.25, -0.3], [0.25, -0.3], [-0.25, 0.3], [0.25, 0.3]];
      for (let i = 0; i < n; i++) k.put('drum', x + spots[i][0], spots[i][1], { on: p, tint: k.r.pick(DRUM), yaw: k.r.rr(0, 6), tier: i < 2 ? 0 : 1 });
    }
    k.put('decal', 0, -0.9, { cell: DECAL.oil2, s: [2, 1, 1.2], yaw: k.r.rr(0, 6) });
  } },
  /** Water-filled plastic barriers with cones at the ends. */
  barrierLine: { hx: 4.3, hz: 0.5, build: (k) => {
    for (let i = 0; i < 6; i++) k.put('barrier', -3.1 + i * 1.24, 0, { tint: i % 2 ? 0xe8e4dc : 0xc8281e, yaw: k.r.rr(-0.04, 0.04), tier: i >= 4 ? 1 : 0 });
    k.put('cone', -4.1, 0, { tint: k.r.pick(CONES) });
    k.put('cone', 4.1, 0, { tint: k.r.pick(CONES), tier: 1 });
  } },
  /** Parked forklift with tyre marks and a cone. */
  forklift: { hx: 1.3, hz: 2.4, build: (k) => {
    k.put('forklift', 0, 0.4, { yaw: Math.PI, tint: k.r.pick([0xe8a01c, 0xd8c020, 0xc84a1c]) });
    k.put('decal', 0.1, -0.4, { cell: DECAL.tyreMarks, s: [1.4, 1, 3.4] });
    k.put('cone', 1.0, -2.1, { tint: k.r.pick(CONES), tier: 1 });
  } },
  /** A bench looking out over the water, with a bin. */
  bench: { hx: 1.4, hz: 0.6, build: (k) => {
    k.put('bench', -0.3, 0, {});
    k.put('bin', 1.05, 0.1, { tint: k.r.pick(PLASTIC_BIN), tier: 1 });
  } },
  palletStack: { hx: 1.6, hz: 0.8, build: (k) => {
    k.stack('pallet', -0.75, 0, 2 + Math.floor(k.r.rnd() * 7), { tint: () => k.r.pick(WOOD) });
    k.stack('pallet', 0.75, 0, 1 + Math.floor(k.r.rnd() * 4), { tint: () => k.r.pick(WOOD) });
  } },
  crateStack: { hx: 1.3, hz: 0.9, build: (k) => {
    for (const [x, z] of [[-0.45, -0.42], [0.45, -0.42], [-0.45, 0.42], [0.45, 0.42]] as const) k.stack('crate', x, z, 1 + Math.floor(k.r.rnd() * 3), { tint: () => k.r.pick(WOOD) });
  } },
  tyreStack: { hx: 1.7, hz: 0.7, build: (k) => {
    for (const x of [-1.1, 0, 1.1]) k.stack('tyre', x, 0, 1 + Math.floor(k.r.rnd() * 4), { jitter: 0.03 });
  } },
} satisfies Record<string, Recipe>;
export type ClusterKind = keyof typeof RECIPES;

/** Rotate a cluster-frame point by yaw (three.js Y rotation) and translate. */
function xform(x: number, z: number, yaw: number, ax: number, az: number) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: ax + x * c + z * s, z: az - x * s + z * c };
}

function commit(out: Placement[], k: Kit, ax: number, az: number, yaw: number) {
  const base = out.length;
  for (const it of k.items) {
    const p = xform(it.x, it.z, yaw, ax, az);
    out.push({ ...it, x: p.x, z: p.z, yaw: it.yaw + yaw, on: it.on === undefined ? undefined : it.on + base });
  }
}

/** Cluster AABB after rotation by yaw (multiples of π/2 only). */
function clusterRect(r: Recipe, ax: number, az: number, yaw: number): Rect {
  const q = Math.round(yaw / (Math.PI / 2)) % 2 !== 0;
  return { x: ax, z: az, hx: q ? r.hz : r.hx, hz: q ? r.hx : r.hz };
}

// ---------------------------------------------------------------- harbor backdrop quays

/** Rects on the backdrop quay that vehicles (vehicles.ts) own: x in units of hw, z metres from the quay edge. */
export const VEHICLE_BAYS = [
  { x0: 0.62, x1: 0.95, z0: 40, z1: 52 },
  { x0: -0.95, x1: -0.6, z0: 36, z1: 48 },
  { x0: 0.1, x1: 0.45, z0: 48, z1: 62 },
  { x0: -0.2, x1: 0.05, z0: 64, z1: 74 },
] as const;

/** Moored-boat gangway centres (x in units of hw) from vehicles.ts: edge gear keeps ±1 m clear. */
export const GANGWAYS = [-0.5, 0.25] as const;

export type QuayFrame = { hw: number; z0: number; template: 'harbor' | 'yard' };

const rectFrom = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: Math.abs(x1 - x0) / 2, hz: Math.abs(z1 - z0) / 2 });
const disc = (x: number, z: number, r: number): Rect => ({ x, z, hx: r, hz: r });

/**
 * Everything already standing on a backdrop quay (islands.ts buildBackdrop / buildYardBackdrop + BACKDROP_DECOR),
 * approximated by rects, plus the vehicle bays and grass verges. Clusters must not overlap any of these.
 */
export function quayObstacles({ hw, z0, template }: QuayFrame): Rect[] {
  const o: Rect[] = VEHICLE_BAYS.map((b) => rectFrom(b.x0 * hw, b.x1 * hw, z0 + b.z0, z0 + b.z1));
  // vehicles.ts extras: E container truck under the crane, F flagpoles + windsock
  if (template === 'harbor') o.push(rectFrom(0.4 * hw, 0.7 * hw, z0 + 7, z0 + 11.5));
  else o.push(rectFrom(-0.78 * hw, -0.46 * hw, z0 + 7, z0 + 11.5));
  o.push(rectFrom(-0.99 * hw, -0.93 * hw, z0 + 2, z0 + 12));
  const stackX = (x: number, z: number, n: number) => o.push(rectFrom(x - 1.3, x + (n - 1) * 2.6 + 1.3, z - 3.15, z + 3.15)); // rotated π/2: stacks step +x
  const stackZ = (x: number, z: number, n: number) => o.push(rectFrom(x - 3.15, x + 3.15, z - 1.3, z + (n - 1) * 2.6 + 1.3));
  const legs = (cx: number, cz: number) => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) o.push({ x: cx + sx * 8, z: cz + sz * 8, hx: 1.1, hz: 1.4 }); };
  if (template === 'harbor') {
    legs(hw * 0.55, z0 + 9);
    o.push({ x: -hw * 0.38, z: z0 + 24, hx: 15.6, hz: 9.6 }); // warehouse
    for (const dx of [-9, 0, 9]) o.push({ x: -hw * 0.38 + dx, z: z0 + 13.2, hx: 3.2, hz: 1.8 }); // roller-door aprons
    stackX(hw * 0.08, z0 + 8, 3);
    stackZ(hw * 0.2, z0 + 18, 4);
    stackX(hw * 0.85, z0 + 30, 3);
    stackZ(-hw * 0.88, z0 + 10, 3);
    o.push({ x: -hw * 0.05, z: z0 + 3.5, hx: 3.3, hz: 1.6 });
    for (const x of [-hw * 0.7, hw * 0.25]) o.push(disc(x, z0 + 4, 0.6));
    for (const [x, z] of [[-hw * 0.95, 3], [-hw * 0.6, 2.2], [hw * 0.98, 3.5], [-hw * 0.15, 2]]) o.push(disc(x, z0 + z, 1.2));
    o.push(rectFrom(hw * 0.38 - 0.4, hw * 0.38 + 1, z0 + 2.3, z0 + 3.4), rectFrom(-hw * 0.3 - 0.4, -hw * 0.3 + 1, z0 + 3.9, z0 + 5.4));
    for (const [x, z] of [[-hw * 0.45, 4], [-hw * 0.42, 5.4], [hw * 0.02, 13]]) o.push({ x, z: z0 + z, hx: 0.8, hz: 0.7 });
    const D = BACKDROP_DECOR;
    for (const p of D.pallets) o.push({ x: p.x * hw, z: z0 + p.z, hx: 0.9, hz: 0.9 });
    for (const t of D.tarps) o.push({ x: t.x * hw, z: z0 + t.z, hx: 1.5, hz: 1.4 });
    for (const c of D.crabPots) o.push(disc(c.x * hw, z0 + c.z, 0.6));
    for (const c of D.chains) o.push(disc(c.x * hw, z0 + c.z, 1.6));
    for (const s of D.signs) o.push({ x: s.x * hw, z: z0 + s.z, hx: 0.9, hz: 0.4 });
    for (const c of D.clutter) o.push(disc(c.x * hw, z0 + c.z, 1.0));
    for (const g of D.grass) o.push({ x: g.x * hw, z: z0 + g.z, hx: g.rx, hz: g.rz });
  } else {
    legs(-hw * 0.62, z0 + 9);
    const bx = hw * 0.45;
    for (const sx of [-1, 1]) {
      o.push(rectFrom(sx * bx - 6.5, sx * bx + 6.5, z0 + 13.6, z0 + 24.2));
      o.push(rectFrom(sx * bx - 10.6, sx * bx + 10.6, z0 + 11.8, z0 + 26.1)); // RTG
      o.push(rectFrom(sx * bx - 12.9, sx * bx + 12.9, z0 + 32.6, z0 + 46.8));
    }
    o.push(rectFrom(-16.1, 16.1, z0 + 48.6, z0 + 59.2));
    o.push(rectFrom(-hw * 0.1 - 4.5, -hw * 0.1 + 3.2, z0 + 5.6, z0 + 13.6)); // reefers + power rack
    o.push(rectFrom(hw * 0.12 - 3.2, hw * 0.12 + 3.2, z0 + 2.6, z0 + 8.9));
    o.push({ x: hw * 0.05, z: z0 + 66, hx: 15.6, hz: 9.6 });
    for (const dx of [-9, 0, 9]) o.push({ x: hw * 0.05 + dx, z: z0 + 55.2, hx: 3.2, hz: 1.8 });
    for (const [x, z] of [[-hw * 0.82, 4], [hw * 0.82, 4], [-hw * 0.2, 26], [hw * 0.7, 26]]) o.push(disc(x, z0 + z, 0.6));
    o.push(rectFrom(hw * 0.3 - 0.4, hw * 0.3 + 1, z0 + 2.3, z0 + 3.4));
    for (const z of [5.2, 6.6]) o.push({ x: hw * 0.36, z: z0 + z, hx: 0.8, hz: 0.7 });
  }
  // street lamps along the quay front (harbor: BACKDROP_DECOR.lamps at z0 + 2.6)
  if (template === 'harbor') for (const x of BACKDROP_DECOR.lamps) o.push(disc(x * hw, z0 + 2.6, 0.5));
  return o;
}

/** x span of the crane rails (harbor): from past the container stack to the quay end. */
export function craneRailSpan(hw: number) {
  return { x0: Math.max(hw * 0.2 + 3.5, hw * 0.55 - 14), x1: hw - 0.6 };
}

/** Quay-edge gear and line items (edge strip z0 .. z0 + 2, rails, back fence). Deterministic. */
function quayEdge(out: Placement[], f: QuayFrame, r: Rng) {
  const { hw, z0, template } = f;
  const harbor = template === 'harbor';
  const beach = (x: number) => harbor && BACKDROP_DECOR.beaches.some(([a, b]) => x > a * hw - 1 && x < b * hw + 1);
  // vehicles.ts gangways cross the edge strip at each moored boat's centre x
  const gangway = (x: number) => GANGWAYS.some((g) => Math.abs(g * hw - x) < 1.0);
  const busy = (x: number) => gangway(x) || (harbor ? BACKDROP_DECOR.signs.some((s) => Math.abs(s.x * hw - x) < 1.2) || BACKDROP_DECOR.chains.some((c) => Math.abs(c.x * hw - x) < 1.8) : false);
  const P = (type: PropType, x: number, z: number, o: Partial<Placement> = {}) => {
    out.push({ type, x, y: 0, z, yaw: 0, s: [1, 1, 1], tint: 0xffffff, tier: 0, ...o });
  };
  // bollards every 7 m from -hw + 3 (islands.ts backdropQuay): rope loops on some, bitts and cleats between
  for (let x = -hw + 3, i = 0; x < hw - 1; x += 7, i++) {
    if (!busy(x) && r.rnd() < 0.55) P('ropeLoop', x, z0 + 0.6, { yaw: r.rr(0, 6), tint: r.pick(ROPE), tier: i % 3 === 2 ? 1 : 0 });
    const xb = x + 3.5;
    if (xb < hw - 1.2 && !busy(xb)) {
      if (i % 2 === 0) P('bitt', xb, z0 + 0.62, { tier: 0 });
      else P('cleat', xb, z0 + 0.45, { tier: 1 });
    }
  }
  // iron ladders down the wall every ~16 m (not over the beach), with a life ring post near each
  for (let x = -hw + 6 + r.rr(0, 4); x < hw - 3; x += r.rr(14, 19)) {
    if (beach(x) || busy(x) || Math.abs(((x + hw - 3) % 7 + 7) % 7) < 1 || Math.abs(((x + hw - 3) % 7 + 7) % 7) > 6) continue;
    P('ladder', x, z0, { yaw: 0, edge: true });
    const xr = x + (r.rnd() < 0.5 ? -1.3 : 1.3);
    if (!busy(xr) && (!harbor || !BACKDROP_DECOR.lamps.some((l) => Math.abs(l * hw - xr) < 1))) P('lifeRing', xr, z0 + 1.55, { tint: r.pick([0xe8501c, 0xe8601c]) });
  }
  // tyre fenders hung on chains between the rubber fenders (rubber fenders every 4.5 m from -hw + 2)
  for (let x = -hw + 4.25, i = 0; x < hw - 1; x += 4.5, i++) {
    if (i % 2 || beach(x) || gangway(x)) continue;
    P('tyreFender', x, z0 - 0.16, { edge: true, tier: i % 4 === 0 ? 0 : 1 });
  }
  // crane rails set into the deck (harbor: under the crane legs at z0 + 1 and z0 + 17)
  if (harbor) {
    const { x0, x1 } = craneRailSpan(hw);
    for (const z of [z0 + 1.05, z0 + 17]) for (let x = x0 + 2; x + 2 <= x1 + 0.01; x += 4) P('rail', x, z);
  }
  // chain-link fence along the back with a gate
  const zf = z0 + 77.5;
  const segs = Math.floor((2 * hw - 2) / 2.5);
  const gate = Math.floor(segs * r.rr(0.3, 0.7));
  for (let k = 0; k < segs; k++) {
    const x = -hw + 1 + 1.25 + k * 2.5;
    if (k === gate) { P('gate', x + 0.25, zf, { tint: 0xe8b81c }); k++; continue; }
    P('fence', x, zf, { tier: 0 });
  }
}

/** Where each cluster kind may go: z band (metres from the quay edge) and how many per quay (scaled by width). */
const QUAY_PLAN: { kind: ClusterKind; band: [number, number]; n: number; turn?: boolean }[] = [
  { kind: 'fishing', band: [2.4, 9], n: 1 },
  { kind: 'bench', band: [2.3, 4], n: 1 },
  { kind: 'office', band: [34, 74], n: 1 },
  { kind: 'aggregate', band: [36, 76], n: 2 },
  { kind: 'workArea', band: [6, 40], n: 1 },
  { kind: 'workArea', band: [36, 74], n: 1 },
  { kind: 'storage', band: [8, 70], n: 2 },
  { kind: 'storage', band: [30, 74], n: 3 },
  { kind: 'trash', band: [10, 74], n: 3 },
  { kind: 'timber', band: [20, 74], n: 2, turn: true },
  { kind: 'ibc', band: [6, 74], n: 2 },
  { kind: 'drums', band: [4, 74], n: 3 },
  { kind: 'reels', band: [20, 74], n: 1, turn: true },
  { kind: 'barrierLine', band: [4, 74], n: 2 },
  { kind: 'forklift', band: [6, 60], n: 1 },
  { kind: 'fishing', band: [2.4, 12], n: 1 },
  { kind: 'tyreStack', band: [20, 74], n: 2 },
  { kind: 'palletStack', band: [4, 74], n: 8, turn: true },
  { kind: 'crateStack', band: [4, 74], n: 7 },
  { kind: 'reels', band: [30, 74], n: 1 },
  { kind: 'ibc', band: [30, 74], n: 1 },
  { kind: 'bench', band: [2.3, 6], n: 1 },
];

/**
 * Cluster + edge + decal placements for one backdrop quay (backdrop-local; y above the deck).
 * Clusters land only where their whole rect clears `quayObstacles`, the edge strip and every other cluster.
 */
export function quayClusters(f: QuayFrame, seed: number): Placement[] {
  const r = rng(seed);
  const out: Placement[] = [];
  const { hw, z0 } = f;
  quayEdge(out, f, r);
  const blocked: Rect[] = [...quayObstacles(f), rectFrom(-hw, hw, z0 - 1, z0 + 2.0)];
  if (f.template === 'harbor') {
    const { x0, x1 } = craneRailSpan(hw);
    blocked.push(rectFrom(x0, x1, z0 + 16.5, z0 + 17.5));
  }
  blocked.push(rectFrom(-hw, hw, z0 + 76.5, z0 + 80)); // fence line
  const scale = Math.max(1, hw / 34);
  for (const plan of f.template === 'harbor' ? QUAY_PLAN : QUAY_PLAN.filter((p) => p.kind !== 'office' || true)) {
    const n = Math.max(1, Math.round(plan.n * scale));
    const rec = RECIPES[plan.kind];
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < 80; t++) {
        const yaw = plan.turn && r.rnd() < 0.5 ? Math.PI / 2 : r.rnd() < 0.25 && plan.band[0] > 5 ? Math.PI : 0;
        const rc = clusterRect(rec, 0, 0, yaw);
        const ax = r.rr(-hw + 1.5 + rc.hx, hw - 1.5 - rc.hx);
        const az = z0 + r.rr(plan.band[0] + rc.hz, Math.max(plan.band[0] + rc.hz, plan.band[1] - rc.hz));
        const cr = clusterRect(rec, ax, az, yaw);
        if (cr.z - cr.hz < z0 + 2.0 || cr.z + cr.hz > z0 + 76.5) continue;
        if (blocked.some((b) => overlaps(cr, b, 0.6))) continue;
        const k = new Kit(r);
        rec.build(k);
        commit(out, k, ax, az, yaw);
        blocked.push(cr);
        break;
      }
    }
  }
  // decals on open deck: oil stains, cracks, patch repairs, tyre marks, yard markings; manhole covers
  const free = (x: number, z: number, m: number) => !blocked.some((b) => overlaps({ x, z, hx: m, hz: m }, b, 0));
  const decals: [number, number, [number, number], number][] = [
    [DECAL.oil, 10, [1.2, 2.6], 0], [DECAL.oil2, 6, [1, 2], 0], [DECAL.crack, 16, [1.5, 3.5], 0], [DECAL.patch, 8, [1.4, 2.8], 1],
    [DECAL.tyreMarks, 8, [2.5, 5], 0], [DECAL.arrow, 5, [1.6, 2.2], 1], [DECAL.bay, 4, [3, 4], 1], [DECAL.rust, 4, [0.8, 1.5], 2],
  ];
  const n = Math.max(1, hw / 34);
  for (const [cell, count, [a, b], tier] of decals) {
    for (let i = 0; i < Math.round(count * n); i++) {
      const x = r.rr(-hw + 2, hw - 2), z = z0 + r.rr(2.5, 75), s = r.rr(a, b);
      if (!free(x, z, s * 0.3)) continue;
      const aspect = cell === DECAL.tyreMarks ? r.rr(2, 3) : cell === DECAL.crack ? r.rr(1.5, 2.5) : r.rr(0.7, 1.3);
      out.push({ type: 'decal', x, y: 0.006, z, yaw: cell === DECAL.arrow ? r.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) : r.rr(0, 6), s: [s, 1, s * aspect], tint: 0xffffff, tier, cell });
    }
  }
  for (let i = 0; i < Math.round(6 * n); i++) {
    const x = r.rr(-hw + 3, hw - 3), z = z0 + r.rr(4, 74);
    if (free(x, z, 0.6)) out.push({ type: 'manhole', x, y: 0, z, yaw: r.rr(0, 6), s: [1, 1, 1], tint: 0xffffff, tier: 0 });
  }
  return out;
}

// ---------------------------------------------------------------- playable islands (low clutter only)

/** Keep-out shapes in a placement frame: capsules (segment a→b, radius r) and rects. */
export type Zones = { caps: { ax: number; az: number; bx: number; bz: number; r: number }[]; rects: Rect[] };

function segDist(px: number, pz: number, c: Zones['caps'][number]) {
  const dx = c.bx - c.ax, dz = c.bz - c.az, l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - c.ax) * dx + (pz - c.az) * dz) / l2));
  return Math.hypot(px - c.ax - dx * t, pz - c.az - dz * t);
}

/** True if a footprint of half-size `m` at (x, z) stays out of every zone. */
export function zonesClear(z: Zones, x: number, zz: number, m: number) {
  if (z.caps.some((c) => segDist(x, zz, c) < c.r + m)) return false;
  return !z.rects.some((r) => overlaps({ x, z: zz, hx: m, hz: m }, r, 0));
}

/** World → island-local (inverse of islands.ts `L`: translate(center) · rotY(yaw)). */
export function toLocal(p: { x: number; z: number }, c: { x: number; z: number }, yaw: number) {
  const dx = p.x - c.x, dz = p.z - c.z, co = Math.cos(yaw), s = Math.sin(yaw);
  return { x: dx * co - dz * s, z: dx * s + dz * co };
}

/**
 * Everything low clutter must stay off on a player island (island-local): the bunker + apron, a corridor out of every
 * doorway (covers the hatched no-build zone), the generator / vault / shop NPC zones, built-in cover, every sim
 * cosmetic, the gravel paths and the decor clutter (harbor).
 */
export function islandZones(def: MapDef, isl: IslandLayout): Zones {
  const yaw = isl.bunker.facingYaw;
  const L = (p: { x: number; z: number }) => toLocal(p, isl.center, yaw);
  const caps: Zones['caps'] = [], rects: Rect[] = [];
  const b = L(isl.bunker.center);
  rects.push({ x: b.x, z: b.z, hx: 4.7, hz: 4.7 });
  for (const d of isl.bunker.doorways) {
    const a = L(d.center);
    const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
    const e = L({ x: d.center.x + fx * 6, z: d.center.z + fz * 6 });
    caps.push({ ax: a.x, az: a.z, bx: e.x, bz: e.z, r: d.width / 2 + 0.9 });
  }
  // main walking lanes: from each doorway straight out to the rim
  for (const d of isl.bunker.doorways) {
    const a = L(d.center), fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw);
    const e = L({ x: d.center.x + fx * 40, z: d.center.z + fz * 40 });
    const len = Math.hypot(e.x - a.x, e.z - a.z), t = Math.min(1, (isl.radius * 2) / len);
    caps.push({ ax: a.x, az: a.z, bx: a.x + (e.x - a.x) * t, bz: a.z + (e.z - a.z) * t, r: 1.4 });
  }
  for (const k of ['generator', 'vault', 'shop'] as const) { const p = L(isl[k]); caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: 2.6 }); }
  { const sp = L(isl.spawn); caps.push({ ax: sp.x, az: sp.z, bx: sp.x, bz: sp.z, r: 1.5 }); }
  for (const s of def.statics) if (s.island === isl.index) {
    const p = L(s.center), q = Math.abs(Math.sin(s.rotY - yaw)) > 0.7;
    rects.push({ x: p.x, z: p.z, hx: (q ? s.half.z : s.half.x) + 0.7, hz: (q ? s.half.x : s.half.z) + 0.7 });
  }
  for (const c of def.cosmetics) {
    if (Math.hypot(c.pos.x - isl.center.x, c.pos.z - isl.center.z) > isl.radius + 2) continue;
    const p = L(c.pos);
    caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: COSMETIC[c.kind].r + 0.5 });
  }
  if (def.template === 'harbor') {
    for (const path of ISLAND_DECOR.gravelPaths) for (let i = 0; i + 1 < path.pts.length; i++) {
      const [ax, az] = path.pts[i], [bx, bz] = path.pts[i + 1];
      caps.push({ ax, az, bx, bz, r: path.w / 2 + 0.4 });
    }
    for (const c of ISLAND_DECOR.clutter) caps.push({ ax: c.x, az: c.z, bx: c.x, bz: c.z, r: 1.0 });
  }
  // sim tier-A gameplay props (crates, drums, pallets…) at their spawns, plus room to push them around
  for (const pr of def.props ?? []) if (pr.island === isl.index) {
    const p = L(pr.pos), e = PROP_KINDS[pr.kind].ext;
    caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: Math.hypot(e.x, e.z) + 0.9 });
  }
  // pier landings (sim MapDef.docks): keep the walk from the island onto the pier clear
  for (const d of def.docks ?? []) if (d.island === isl.index && d.row === 0) {
    const p = L(d.center), q = L({ x: d.center.x + (isl.center.x - d.center.x) * 0.25, z: d.center.z + (isl.center.z - d.center.z) * 0.25 });
    caps.push({ ax: p.x, az: p.z, bx: q.x, bz: q.z, r: d.half.x + 1 });
  }
  // explosive barrels / propane / supply crates (sim hazards): keep dressing off them
  for (const h of def.hazards ?? []) if (h.island === isl.index) { const p = L(h.pos); caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: HAZARD_CLEAR }); }
  return { caps, rects };
}

/** Center island zones (center-local = world minus its centre, no rotation). */
export function centerZones(def: MapDef): Zones {
  const c = def.center.center;
  const L = (p: { x: number; z: number }) => ({ x: p.x - c.x, z: p.z - c.z });
  const caps: Zones['caps'] = [], rects: Rect[] = [];
  for (const k of ['goldGen', 'supplyGen', 'potionShop'] as const) { const p = L(def.center[k]); caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: 2.6 }); }
  caps.push({ ax: 0, az: 0, bx: 0, bz: 0, r: CENTER.wellRadius + 1.2 });
  for (const s of def.statics) if (s.island === -1) { const p = L(s.center); const m = Math.max(s.half.x, s.half.z) + 0.7; rects.push({ x: p.x, z: p.z, hx: m, hz: m }); }
  for (const cm of def.cosmetics) {
    if (Math.hypot(cm.pos.x - c.x, cm.pos.z - c.z) > def.center.radius + 2) continue;
    const p = L(cm.pos);
    caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: COSMETIC[cm.kind].r + 0.5 });
  }
  for (const pr of def.props ?? []) if (pr.island === -1) {
    const p = L(pr.pos), e = PROP_KINDS[pr.kind].ext;
    caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: Math.hypot(e.x, e.z) + 0.9 });
  }
  for (const h of def.hazards ?? []) if (h.island === -1) { const p = L(h.pos); caps.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, r: HAZARD_CLEAR }); }
  return { caps, rects };
}

/** Island dressing is visual only (no sim collider): light cover at most, never taller than this. */
export const ISLAND_MAX_H = 1.2;

/**
 * Island sets (cluster frame: x along the rim / bunker wall, +z toward the rim or away from the bunker). Big pushable
 * items (crates, drums, pallets-as-props, IBCs, reels, tyres) are sim tier-A props (src/sim/props.ts): not here.
 */
const ISLAND_SETS: ((k: Kit) => void)[] = [
  (k) => { // tarped pile with rope and a bag
    k.put('tarpPile', 0, 0.15, { tint: k.r.pick(TARP), s: [0.75, 0.9, 0.65], yaw: k.r.rr(-0.1, 0.1) });
    k.put('coil', 1.45, -0.2, { tint: k.r.pick(ROPE), yaw: k.r.rr(0, 6) });
    k.put('bag', -1.35, -0.35, { tint: k.r.pick([0x1a1a1c, 0x3a5a3a]), yaw: k.r.rr(0, 6), tier: 1 });
  },
  (k) => { // work corner: bench with a toolbox, a genset, hose and bucket
    const wb = k.put('workbench', 0, 0.35, {});
    k.put('toolbox', k.r.rr(-0.5, 0.5), 0.35, { on: wb, tint: k.r.pick([0xc0302a, 0x2a5aa8]), yaw: k.r.rr(-0.2, 0.2) });
    k.put('genset', -1.95, 0.25, { tint: k.r.pick([0xd9a521, 0x3a7a3a, 0xe0e0d8]), s: [0.85, 0.95, 0.85] });
    k.put('coil', 1.45, -0.35, { tint: 0xd8b030, yaw: k.r.rr(0, 6) });
    k.put('bucket', 0.4, -0.55, { tint: k.r.pick([0x2a2a2a, 0xe0e0d8]), tier: 1 });
    k.put('decal', -1.9, -0.3, { cell: DECAL.oil, s: [1.6, 1, 1.2], yaw: k.r.rr(0, 6) });
  },
  (k) => { // trash corner
    k.put('bin', -0.55, 0.25, { tint: k.r.pick(PLASTIC_BIN), yaw: k.r.rr(-0.2, 0.2) });
    k.put('bin', 0.12, 0.3, { tint: k.r.pick(PLASTIC_BIN), yaw: k.r.rr(-0.2, 0.2) });
    for (let i = 0; i < 3; i++) k.put('bag', -0.9 + i * 0.6 + k.r.rr(-0.1, 0.1), -0.45 + k.r.rr(-0.1, 0.1), { tint: k.r.pick([0x1a1a1c, 0x22262a, 0x3a5a3a]), yaw: k.r.rr(0, 6), s: k.r.rr(0.8, 1.05), tier: i === 2 ? 1 : 0 });
  },
  (k) => { // fishing gear: pots, a net pile, buoys
    for (const x of [-0.75, -0.1]) k.stack('lobsterPot', x, 0.25, 1 + Math.floor(k.r.rnd() * 3), { tint: () => k.r.pick(NET) });
    k.put('netPile', 1.3, 0.1, { tint: k.r.pick(NET), yaw: k.r.rr(0, 6), s: 0.85 });
    k.put('buoy', -0.6, -0.65, { tint: k.r.pick([0xe8601c, 0xe8e2d0, 0xe0b020]) });
    k.put('buoy', 0.05, -0.75, { tint: k.r.pick([0xe8601c, 0xe8e2d0]), tier: 1 });
  },
  (k) => { // sacks on a pallet + a low pallet stack
    const p = k.put('pallet', 0, 0, { tint: k.r.pick(WOOD) });
    for (const [dx, dz] of [[-0.28, -0.22], [0.28, -0.22], [-0.28, 0.22], [0.28, 0.22]] as const) {
      const sk = k.put('sack', dx, dz, { on: p, tint: k.r.pick([0xc4a874, 0xe0d8c8, 0xb8a080]), yaw: k.r.rr(-0.2, 0.2) });
      if (dx > 0 && dz > 0) k.put('sack', dx - 0.05, dz - 0.05, { on: sk, tint: 0xd0c0a0, yaw: 0.4, tier: 1 });
    }
    k.stack('pallet', 1.45, 0.05, 2 + Math.floor(k.r.rnd() * 3), { tint: () => k.r.pick(WOOD), yaw: Math.PI / 2 });
  },
  (k) => { // rope + buoys
    k.put('coil', -0.5, 0, { tint: k.r.pick(ROPE), yaw: k.r.rr(0, 6) });
    k.put('coil', 0.35, 0.2, { tint: k.r.pick(ROPE), yaw: k.r.rr(0, 6), tier: 1 });
    k.put('netPile', 1.1, 0.1, { tint: k.r.pick(NET), s: 0.7, yaw: k.r.rr(0, 6) });
    k.put('buoy', -1.2, 0.1, { tint: 0xe8601c });
  },
  (k) => { k.put('toolbox', 0, 0, { tint: k.r.pick([0xc0302a, 0x2a5aa8]), yaw: k.r.rr(0, 6) }); k.put('coil', 0.8, 0.2, { tint: 0xd8b030, yaw: k.r.rr(0, 6) }); k.put('bucket', -0.55, 0.1, { tint: 0xe0e0d8, tier: 1 }); },
  (k) => { k.put('fishCrate', 0, 0, { tint: k.r.pick(FISH), yaw: k.r.rr(-0.3, 0.3) }); k.put('fishCrate', 0.7, 0.05, { tint: k.r.pick(FISH), yaw: k.r.rr(-0.3, 0.3) }); k.put('sack', -0.7, 0, { tint: 0xc4a874, yaw: k.r.rr(0, 6), tier: 1 }); },
];

/**
 * Island dressing for one island (player or center), island-local: purposeful sets along the rim band
 * (R − 4 … R − 1) and beside the bunker (light visual cover, ≤ ISLAND_MAX_H), the open middle left free for
 * building; decals and manholes in the open; cleats on the coping; ladders and hung tyres outside the disc.
 * `bunker`: island-local bunker centre (player islands) for the bunker-side sets.
 */
export function islandClutter(R: number, zones: Zones, seed: number, o: { riprap?: number[]; bollardSlots?: number; bunker?: { x: number; z: number } } = {}): Placement[] {
  const r = rng(seed);
  const out: Placement[] = [];
  const taken: Rect[] = [];
  const tryPlace = (ax: number, az: number, yaw: number) => {
    const k = new Kit(r);
    r.pick(ISLAND_SETS)(k);
    const base = out.length;
    const keep: Placement[] = [];
    for (const it of k.items) {
      const p = xform(it.x, it.z, yaw, ax, az);
      const placed = { ...it, x: p.x, z: p.z, yaw: it.yaw + yaw };
      const fp = footprint(placed);
      const m = Math.max(fp.hx, fp.hz);
      const clear = it.type === 'decal' || (Math.hypot(p.x, p.z) + m <= R - 1.0 && zonesClear(zones, p.x, p.z, m)
        && (it.on !== undefined || !taken.some((t) => overlaps(fp, t, 0.25))));
      if (!clear) return false; // all or nothing (stacks)
      keep.push(placed);
    }
    for (const p of keep) {
      out.push({ ...p, on: p.on === undefined ? undefined : p.on + base });
      if (p.type !== 'decal') taken.push(footprint(p));
    }
    return true;
  };
  // beside the bunker: the four outer corners, sets running along the side walls, facing away from it
  if (o.bunker) {
    const b = o.bunker;
    for (const [dx, dz, yaw] of [[-6.3, 2.6, -Math.PI / 2], [6.3, 2.6, Math.PI / 2], [-6.3, -3.0, -Math.PI / 2], [6.3, -3.0, Math.PI / 2]] as const) {
      for (let t = 0; t < 4 && !tryPlace(b.x + dx, b.z + dz + r.rr(-0.4, 0.4), yaw); t++);
    }
  }
  // rim band
  const nSets = Math.round(R * 0.75);
  for (let i = 0; i < nSets; i++) {
    for (let t = 0; t < 4; t++) {
      const a = ((i + r.rr(0.1, 0.9)) / nSets) * Math.PI * 2;
      const rad = R - r.rr(2.0, 2.9);
      if (tryPlace(Math.sin(a) * rad, Math.cos(a) * rad, a)) break;
    }
  }
  for (const p of out) {
    const top = topOf(p);
    if (top > ISLAND_MAX_H) p.s = [p.s[0], p.s[1] * (ISLAND_MAX_H / top) * 0.98, p.s[2]];
  }
  // stacked items: re-seat on their (possibly squashed) support
  for (const p of out) if (p.on !== undefined) p.y = topOf(out[p.on]);
  // decals + manholes in the open
  const decal = (cell: number, n: number, a: number, b: number, tier: number) => {
    for (let i = 0; i < n; i++) {
      const ang = r.rr(0, Math.PI * 2), rad = Math.sqrt(r.rnd()) * (R - 2.5), s = r.rr(a, b);
      const x = Math.sin(ang) * rad, z = Math.cos(ang) * rad;
      if (!zonesClear(zones, x, z, s * 0.35)) continue;
      out.push({ type: 'decal', x, y: 0.006, z, yaw: r.rr(0, 6), s: [s, 1, s * (cell === DECAL.tyreMarks ? 2.4 : cell === DECAL.crack ? 2 : 1)], tint: 0xffffff, tier, cell });
    }
  };
  decal(DECAL.crack, Math.round(R * 0.5), 1.2, 2.6, 0);
  decal(DECAL.patch, Math.round(R * 0.2), 1.2, 2.2, 1);
  decal(DECAL.tyreMarks, Math.round(R * 0.15), 2, 3.5, 1);
  for (let i = 0; i < 2; i++) {
    const ang = r.rr(0, Math.PI * 2), rad = r.rr(4, R - 4), x = Math.sin(ang) * rad, z = Math.cos(ang) * rad;
    if (zonesClear(zones, x, z, 0.5)) out.push({ type: 'manhole', x, y: 0, z, yaw: r.rr(0, 6), s: [1, 1, 1], tint: 0xffffff, tier: 0 });
  }
  // cleats on the coping halfway between bollard slots; ladders + hung tyres on the wall (outside the disc)
  const slots = o.bollardSlots ?? 14;
  const rip = o.riprap ?? [];
  const nearRip = (a: number) => rip.some((x) => Math.abs(Math.atan2(Math.sin(a - x), Math.cos(a - x))) < 0.35);
  for (let kk = 0; kk < slots; kk += 2) {
    const a = (kk / slots) * Math.PI * 2, rr2 = R - 0.3;
    const x = Math.sin(a) * rr2, z = Math.cos(a) * rr2;
    if (zonesClear(zones, x, z, 0.25)) out.push({ type: 'cleat', x, y: 0, z, yaw: a + Math.PI / 2, s: [1, 1, 1], tint: 0xffffff, tier: 1 });
  }
  let ladders = 0;
  for (let t = 0; t < 24 && ladders < 2; t++) {
    const a = r.rr(0, Math.PI * 2);
    if (nearRip(a)) continue;
    const x = Math.sin(a) * R, z = Math.cos(a) * R;
    if (!zonesClear(zones, Math.sin(a) * (R - 0.6), Math.cos(a) * (R - 0.6), 0.4)) continue;
    out.push({ type: 'ladderLow', x, y: 0, z, yaw: a + Math.PI, s: [1, 1, 1], tint: 0xffffff, tier: 0, edge: true });
    ladders++;
  }
  for (let kk = 0; kk < slots; kk++) {
    const a = ((kk + 0.5) / slots) * Math.PI * 2 + 0.22;
    if (nearRip(a) || kk % 3) continue;
    out.push({ type: 'tyreFender', x: Math.sin(a) * (R + 0.16), y: 0, z: Math.cos(a) * (R + 0.16), yaw: a + Math.PI, s: [0.9, 0.9, 0.9], tint: 0xffffff, tier: 1, edge: true });
  }
  return out;
}

/** Where island-local clutter lives for this map (seeded by island index; center uses index -1). */
export function islandPlacements(def: MapDef, isl: IslandLayout) {
  const bunker = toLocal(isl.bunker.center, isl.center, isl.bunker.facingYaw);
  return islandClutter(isl.radius, islandZones(def, isl), 7001 + isl.index * 131, { riprap: def.template === 'harbor' ? ISLAND_DECOR.riprap : [], bollardSlots: def.template === 'harbor' ? 14 : 10, bunker });
}
export function centerPlacements(def: MapDef) {
  return islandClutter(def.center.radius, centerZones(def), 6007, { bollardSlots: 0 });
}

/** Quay frame for an island's backdrop (mirrors islands.ts backdropFrame). */
export function quayFrame(def: MapDef, isl: IslandLayout): QuayFrame & { top: number } {
  const n = def.islands.length;
  const ring = Math.hypot(isl.center.x, isl.center.z);
  const z0 = isl.radius + 14;
  const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8));
  return { hw, z0, top: isl.groundY + 0.2, template: def.template };
}

export const groundY = MAP.groundY;
