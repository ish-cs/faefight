import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NO_SHADOW, registerDistanceCull, shrinkMaterial, TINY_CASTER_LAYER } from './lod';
import { chunkCoord } from './lodMath';
import { stressMatrices } from './stress';

const ATTRS = ['position', 'normal', 'uv', 'color', 'pc'] as const;

/**
 * Normalise a geometry for merging: non-indexed, exactly position/normal/uv/color, transformed by `m`.
 * `col` fills the vertex colour (used as a per-part tint; materials multiply it with their map).
 * An indexed source also keeps an indexed twin (`userData.indexed`, same attributes) so StaticBatch can emit heavy
 * meshes indexed without re-welding vertices (mergeVertices on millions of vertices cost seconds of load).
 */
export function part(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, col: THREE.ColorRepresentation = 0xffffff): THREE.BufferGeometry {
  const g = normalise(geo.index ? geo.toNonIndexed() : geo.clone(), m, col);
  if (geo.index) g.userData.indexed = normalise(geo.clone(), m, col);
  return g;
}

/**
 * StaticBatch's part: an indexed source with normals keeps only its indexed form, flattened at build time if the
 * merged mesh stays non-indexed (two full copies of every part, one always thrown away, were a few hundred MB of
 * short-lived buffers while the map loads). Without normals the flat and smooth forms differ: part() as before.
 */
function batchPart(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, col: THREE.ColorRepresentation): THREE.BufferGeometry {
  return geo.index && geo.getAttribute('normal') ? normalise(geo.clone(), m, col) : part(geo, m, col);
}

/** A part's indexed form, if it has one. */
const twinOf = (p: THREE.BufferGeometry): THREE.BufferGeometry | undefined => p.index ? p : p.userData.indexed as THREE.BufferGeometry | undefined;
/** A part in merge form (non-indexed). */
const flatOf = (p: THREE.BufferGeometry): THREE.BufferGeometry => {
  if (!p.index) return p;
  const f = p.toNonIndexed();
  p.dispose();
  return f;
};

function normalise(g: THREE.BufferGeometry, m: THREE.Matrix4 | null, col: THREE.ColorRepresentation): THREE.BufferGeometry {
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.getAttribute('color')) {
    const c = new THREE.Color(col);
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  }
  for (const k of Object.keys(g.attributes)) if (!(ATTRS as readonly string[]).includes(k)) g.deleteAttribute(k);
  g.morphAttributes = {};
  g.clearGroups();
  g.userData = {};
  if (m) g.applyMatrix4(m);
  // part centre per vertex: lets a chunk's material shrink each part to its centre with distance (lod.ts)
  g.computeBoundingSphere();
  const c = g.boundingSphere!.center, pc = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pc[i * 3] = c.x; pc[i * 3 + 1] = c.y; pc[i * 3 + 2] = c.z; }
  g.setAttribute('pc', new THREE.Float32BufferAttribute(pc, 3));
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error('[world/geo] merge: no parts');
  const out = mergeGeometries(parts, false);
  if (!out) throw new Error('[world/geo] mergeGeometries failed (attribute mismatch)');
  for (const p of parts) p.dispose();
  return out;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
/** Compose a matrix from position, Euler rotation (YXZ-free default XYZ) and scale. */
export function mat(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, order: THREE.EulerOrder = 'XYZ') {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, order)), _s.set(sx, sy, sz));
}
export const T = (x: number, y: number, z: number) => _m.clone().makeTranslation(x, y, z);

/** BoxGeometry whose UVs are in metres / `tile` so tiled textures keep a constant texel density. */
export function boxUV(w: number, h: number, d: number, tile = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const span: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, (uv.getX(i) * span[f][0]) / tile, (uv.getY(i) * span[f][1]) / tile);
  }
  return g;
}

/** Cylinder between two points. */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * Chunked static batches. Draw calls are what costs on WebGPU here (~10 µs of CPU each, camera + every cascade),
 * not triangles, so a material is only split when it is heavy: under `minTris` it stays one mesh. Heavy bins are
 * split by part size: small/medium parts into a grid (frustum + distance culled), large parts stay whole.
 */
export const STATIC_CHUNKS = {
  /** a bin (material × shadow flags) lighter than this stays one mesh */
  minTris: 40_000,
  /** small parts: shrink away between 70 % and 100 % of `cull` (no pop), chunk hidden past it */
  small: { maxR: 0.6, grid: 48, cull: 90, splitTris: 25_000, maxChunks: 4 },
  /** medium parts: chunked for frustum culling only (no impostors yet, so never distance-culled) */
  medium: { maxR: 4, grid: 160, cull: Infinity, splitTris: 60_000, maxChunks: 3 },
  /** a grid cell lighter than this isn't worth its own draw: it joins the bin's leftover mesh */
  minChunkTris: 16_000,
};

/** merged static meshes with at least this many vertices get an index (StaticBatch.build) */
export const STATIC_INDEX_MIN_VERTS = 30_000;

const trisOf = (parts: THREE.BufferGeometry[]) => parts.reduce((a, g) => a + (g.index ? g.index.count : g.getAttribute('position').count) / 3, 0);

type Bin = { material: THREE.Material; cast: boolean; receive: boolean; parts: THREE.BufferGeometry[] };

/**
 * Collects static parts per material (+ shadow flags) and emits merged meshes. With `{ chunked: true }` (static
 * world dressing) the parts are also split by size class and spatial chunk: one merged mesh per (material, size,
 * chunk), so the camera and every shadow cascade frustum-cull whole chunks, small parts are distance-culled
 * (lod.ts) and cast into the near shadow cascades only. Without it: one mesh per material (moving groups, boats).
 */
export class StaticBatch {
  private bins = new Map<string, Bin>();
  /** Debug stress scene: extra shifted copies of every part (decorative batches only, see stress.ts). */
  private copies: THREE.Matrix4[] = [];

  constructor(opts: { stress?: boolean } = {}) {
    if (opts.stress) this.copies = stressMatrices();
  }

  add(material: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4 | null = null, col: THREE.ColorRepresentation = 0xffffff, cast = true, receive = true) {
    if (NO_SHADOW.has(material)) cast = false;
    const key = `${material.uuid}:${+cast}${+receive}`;
    let bin = this.bins.get(key);
    if (!bin) { bin = { material, cast, receive, parts: [] }; this.bins.set(key, bin); }
    bin.parts.push(batchPart(geo, m, col));
    for (const T of this.copies) bin.parts.push(batchPart(geo, m ? T.clone().multiply(m) : T, col));
  }

  /** Push a geometry already in merge form (non-indexed; exactly position/normal/uv/color; final space). No copy. */
  addRaw(material: THREE.Material, geo: THREE.BufferGeometry, cast = true, receive = true) {
    const key = `${material.uuid}:${+cast}${+receive}`;
    let bin = this.bins.get(key);
    if (!bin) { bin = { material, cast, receive, parts: [] }; this.bins.set(key, bin); }
    if (!geo.getAttribute('pc')) { // part centre per vertex (see part()), so raw parts merge with normal ones
      geo.computeBoundingSphere();
      const c = geo.boundingSphere!.center, n = geo.getAttribute('position').count, pc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pc[i * 3] = c.x; pc[i * 3 + 1] = c.y; pc[i * 3 + 2] = c.z; }
      geo.setAttribute('pc', new THREE.Float32BufferAttribute(pc, 3));
    }
    bin.parts.push(geo);
  }

  build(parent: THREE.Object3D, name: string, opts: { chunked?: boolean } = {}): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const emit = (bin: Bin, parts: THREE.BufferGeometry[], suffix: string) => {
      // heavy static meshes are drawn by the camera and every shadow cascade: emit them indexed (from the parts'
      // indexed twins) so shared corners are shaded once per pass, not once per triangle
      const twins = trisOf(parts) * 3 >= STATIC_INDEX_MIN_VERTS && parts.every((p) => twinOf(p)) ? parts.map((p) => twinOf(p)!) : null;
      const geo = twins ? merge(twins) : merge(parts.map(flatOf));
      if (twins) for (const p of parts) p.dispose();
      const mesh = new THREE.Mesh(geo, bin.material);
      mesh.castShadow = bin.cast; mesh.receiveShadow = bin.receive;
      mesh.name = `${name}:${bin.material.name || 'mat'}${suffix}`;
      parent.add(mesh);
      out.push(mesh);
      return mesh;
    };
    for (const bin of this.bins.values()) {
      if (!opts.chunked || trisOf(bin.parts) < STATIC_CHUNKS.minTris) { emit(bin, bin.parts, ''); continue; }
      const byClass = { small: [] as THREE.BufferGeometry[], medium: [] as THREE.BufferGeometry[], large: [] as THREE.BufferGeometry[] };
      for (const g of bin.parts) {
        g.computeBoundingSphere();
        const r = g.boundingSphere!.radius;
        byClass[r < STATIC_CHUNKS.small.maxR ? 'small' : r < STATIC_CHUNKS.medium.maxR ? 'medium' : 'large'].push(g);
      }
      // only heavy classes get split; everything else of this bin stays one mesh
      const rest = byClass.large;
      for (const cls of ['small', 'medium'] as const) {
        const parts = byClass[cls];
        const C = STATIC_CHUNKS[cls];
        if (trisOf(parts) < C.splitTris) { rest.push(...parts); continue; }
        // draw budget: coarsen the grid until this bin's class fits in maxChunks meshes (dense content would
        // otherwise fan out into hundreds of draws, each × camera + shadow cascades)
        let groups = new Map<string, THREE.BufferGeometry[]>();
        for (let grid = C.grid; ; grid *= 2) {
          groups = new Map();
          for (const g of parts) {
            const c = g.boundingSphere!.center;
            const k = `${chunkCoord(c.x, grid)},${chunkCoord(c.z, grid)}`;
            let e = groups.get(k);
            if (!e) groups.set(k, (e = []));
            e.push(g);
          }
          let heavy = 0;
          for (const e of groups.values()) if (trisOf(e) >= STATIC_CHUNKS.minChunkTris) heavy++;
          if (heavy <= C.maxChunks || grid > 4096) break;
        }
        const leftover: THREE.BufferGeometry[] = [];
        for (const [k, e] of groups) {
          if (trisOf(e) < STATIC_CHUNKS.minChunkTris) { leftover.push(...e); continue; }
          const mesh = emit(bin, e, `@${cls}:${k}`);
          if (cls === 'medium') continue;
          mesh.geometry.computeBoundingSphere();
          const sp = mesh.geometry.boundingSphere!;
          mesh.layers.set(TINY_CASTER_LAYER); // small parts (< 0.6 m) cast into the first cascade only
          mesh.material = shrinkMaterial(bin.material, C.cull);
          mesh.userData.lod = registerDistanceCull(mesh, C.cull, { center: sp.center, radius: sp.radius });
        }
        if (!leftover.length) continue;
        if (cls === 'medium') { rest.push(...leftover); continue; }
        // sparse small parts: one map-wide mesh, still shrinking away with distance in the shader
        const mesh = emit(bin, leftover, '@small:sparse');
        mesh.layers.set(TINY_CASTER_LAYER);
        mesh.material = shrinkMaterial(bin.material, C.cull);
      }
      if (rest.length) emit(bin, rest, '@rest');
    }
    this.bins.clear();
    return out;
  }

  /** Merged geometry per material without creating meshes (instanced props build their own). */
  take(): { material: THREE.Material; geometry: THREE.BufferGeometry; cast: boolean; receive: boolean }[] {
    const out = [...this.bins.values()].map((b) => ({ material: b.material, geometry: merge(b.parts.map(flatOf)), cast: b.cast, receive: b.receive }));
    this.bins.clear();
    return out;
  }
}
