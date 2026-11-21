import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { stressMatrices } from './stress';

const ATTRS = ['position', 'normal', 'uv', 'color'] as const;

/**
 * Normalise a geometry for merging: non-indexed, exactly position/normal/uv/color, transformed by `m`.
 * `col` fills the vertex colour (used as a per-part tint; materials multiply it with their map).
 */
export function part(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, col: THREE.ColorRepresentation = 0xffffff): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
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
  if (m) g.applyMatrix4(m);
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
 * Collects static parts per material and emits one merged mesh per material. All world props
 * (backdrop, island dressing, palms) go through this so the static world costs ~1 draw call per material.
 */
export class StaticBatch {
  private bins = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private flags = new Map<THREE.Material, { cast: boolean; receive: boolean }>();
  /** Debug stress scene: extra shifted copies of every part (decorative batches only, see stress.ts). */
  private copies: THREE.Matrix4[] = [];

  constructor(opts: { stress?: boolean } = {}) {
    if (opts.stress) this.copies = stressMatrices();
  }

  add(material: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4 | null = null, col: THREE.ColorRepresentation = 0xffffff, cast = true, receive = true) {
    let bin = this.bins.get(material);
    if (!bin) { bin = []; this.bins.set(material, bin); this.flags.set(material, { cast, receive }); }
    bin.push(part(geo, m, col));
    for (const T of this.copies) bin.push(part(geo, m ? T.clone().multiply(m) : T, col));
  }

  build(parent: THREE.Object3D, name: string): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [material, parts] of this.bins) {
      const mesh = new THREE.Mesh(merge(parts), material);
      const f = this.flags.get(material)!;
      mesh.castShadow = f.cast; mesh.receiveShadow = f.receive;
      mesh.name = `${name}:${material.name || 'mat'}`;
      parent.add(mesh);
      out.push(mesh);
    }
    this.bins.clear();
    return out;
  }

  /** Merged geometry per material without creating meshes (instanced props build their own). */
  take(): { material: THREE.Material; geometry: THREE.BufferGeometry; cast: boolean; receive: boolean }[] {
    const out = [...this.bins].map(([material, parts]) => ({ material, geometry: merge(parts), ...this.flags.get(material)! }));
    this.bins.clear();
    return out;
  }
}
