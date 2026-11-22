import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, float, length, positionLocal, smoothstep, uv, vec3 } from 'three/tsl';
import type { Quality } from './sky';
import { STATIC_CHUNKS } from './geo';
import { lods, type LodTarget, SMALL_CASTER_LAYER } from './lod';
import { chunkCoord, chunkKey, distToSphere, LOD_HYSTERESIS } from './lodMath';
import { perfOff } from './perfFlags';
import { stressOffsets } from './stress';
import { makeRng } from './textures';

/** Scatter chunk grid (m): one InstancedMesh per kind × chunk, frustum- and distance-culled as a whole. */
const CHUNK = 48;

/**
 * Instanced small-detail scatter (pebbles, rubble, litter, shells, seaweed, footprints…): one InstancedMesh per
 * kind × 16 m chunk (frustum culled per chunk, hidden past the kind's cull distance, near shadow cascades only). Each instance shrinks to nothing between 70 % and 100 % of the kind's cull distance
 * (vertex shader, from a per-instance centre), and the preset sets how many instances draw (instances are
 * shuffled, so a lower count thins everywhere evenly). Purely visual, never collides.
 */
export type ScatterKind = {
  geo: THREE.BufferGeometry;
  material: THREE.MeshStandardNodeMaterial;
  /** metres from the camera where an instance has fully shrunk away */
  far: number;
  density: Record<Quality, number>;
  /** real CSM shadow caster; only for kinds big enough to read at distance (tiny casters only cost shadow passes) */
  cast?: boolean;
  /**
   * Cheap contact/blob shadow: a soft dark disc under each instance, radius = this × the instance's horizontal scale
   * (metres in the kind's unit size). One extra instanced draw per kind; shrinks away with the instance.
   */
  blob?: number;
  /** overlay kind: gets a copy of every instance added to that kind (same transform, same thinning order) */
  follows?: string;
};

type Item = { m: THREE.Matrix4; c: THREE.Color; p: THREE.Vector3; yaw: number; sx: number; sz: number };

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

export class Scatter {
  readonly root = new THREE.Group();
  private kinds = new Map<string, ScatterKind & { items: Item[]; chunks: THREE.InstancedMesh[] }>();
  private cull: ScatterCull | null = null;
  private quality: Quality = 'high';

  constructor() { this.root.name = 'scatter'; }

  define(key: string, k: ScatterKind) {
    if (this.kinds.has(key)) throw new Error(`[world/scatter] kind "${key}" defined twice`);
    this.kinds.set(key, { ...k, items: [], chunks: [] });
  }

  has(key: string) { return this.kinds.has(key); }

  /** Place one instance: world position, yaw, scale (uniform or xyz), small tilt, tint. */
  add(key: string, x: number, y: number, z: number, yaw = 0, s: number | [number, number, number] = 1, tilt: [number, number] = [0, 0], color: THREE.ColorRepresentation = 0xffffff) {
    const k = this.kinds.get(key);
    if (!k) throw new Error(`[world/scatter] unknown kind "${key}"`);
    const sc = typeof s === 'number' ? _s.set(s, s, s) : _s.set(s[0], s[1], s[2]);
    for (const [ox, oz] of stressOffsets()) {
      const m = new THREE.Matrix4().compose(_p.set(x + ox, y, z + oz), _q.setFromEuler(_e.set(tilt[0], yaw, tilt[1], 'YXZ')), sc);
      const it = { m, c: new THREE.Color(color), p: new THREE.Vector3(x + ox, y, z + oz), yaw, sx: sc.x, sz: sc.z };
      k.items.push(it);
      for (const f of this.kinds.values()) if (f.follows === key) f.items.push({ ...it, c: new THREE.Color(0xffffff) });
    }
  }

  build() {
    let total = 0;
    for (const k of this.kinds.values()) { for (const m of k.chunks) { m.removeFromParent(); m.geometry.dispose(); } k.chunks = []; }
    for (const [key, k] of this.kinds) {
      if (k.items.length === 0) continue;
      // per-kind seed: equal-length kinds (an overlay and the kind it follows) get the same permutation
      const rng = makeRng(8128 + k.items.length);
      // deterministic shuffle → truncating `count` thins uniformly
      for (let i = k.items.length - 1; i > 0; i--) { const j = Math.floor(rng.rnd() * (i + 1)); [k.items[i], k.items[j]] = [k.items[j], k.items[i]]; }
      const geo = k.geo.clone();
      if (!geo.getAttribute('color')) {
        const n = geo.getAttribute('position').count;
        geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      }
      const mat = this.materialFor(k.material);
      const byChunk = new Map<number, Item[]>();
      // light kinds stay one mesh (a draw call costs more than their triangles)
      const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
      const split = tris * k.items.length >= STATIC_CHUNKS.minTris;
      for (const it of k.items) { // shuffled order is kept inside each chunk → `count` still thins evenly
        const ck = split ? chunkKey(chunkCoord(it.p.x, CHUNK), chunkCoord(it.p.z, CHUNK)) : 0;
        let a = byChunk.get(ck);
        if (!a) byChunk.set(ck, (a = []));
        a.push(it);
      }
      for (const [ck, items] of byChunk) {
        const g = geo.clone();
        // centre + cull distance per instance, so every kind on the same base material shares one pipeline
        const centers = new Float32Array(items.length * 4);
        items.forEach((it, i) => centers.set([it.p.x, it.p.y, it.p.z, k.far], i * 4));
        g.setAttribute('scCenter', new THREE.InstancedBufferAttribute(centers, 4));
        const mesh = new THREE.InstancedMesh(g, mat, items.length);
        items.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, it.c); });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.name = `scatter:${key}@${ck}`;
        mesh.castShadow = !!k.cast;
        mesh.receiveShadow = true;
        mesh.layers.set(SMALL_CASTER_LAYER);
        mesh.userData.full = items.length;
        mesh.userData.far = k.far;
        this.root.add(mesh);
        k.chunks.push(mesh);
        if (k.blob && !perfOff('noblob')) { // contact blobs for this chunk: same items, culled and thinned with it
          const b = this.buildBlobs(key, k.blob, items, centers);
          b.computeBoundingSphere();
          b.userData.full = items.length;
          b.userData.far = k.far;
          k.chunks.push(b);
        }
      }
      total += k.items.length;
    }
    if (this.cull) lods.unregister(this.cull);
    this.cull = lods.register(new ScatterCull([...this.kinds.values()].flatMap((k) => k.chunks)));
    this.applyQuality();
    console.info(`[world/scatter] ${total} instances in ${this.root.children.length} kinds`);
  }

  private blobGeo: THREE.BufferGeometry | null = null;
  private blobMat: THREE.MeshBasicNodeMaterial | null = null;
  /** Soft dark discs under one kind's instances, same order (so the quality `count` keeps them paired). */
  private buildBlobs(key: string, radius: number, items: Item[], centers: Float32Array) {
    if (!this.blobGeo) {
      this.blobGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2).translate(0, 0.006, 0);
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      m.name = 'scatterBlob';
      const c4 = attribute('scCenter', 'vec4');
      const d = c4.xyz.xz.sub(cameraPosition.xz).length();
      const keep = float(1).sub(smoothstep(c4.w.mul(0.7), c4.w, d));
      m.positionNode = c4.xyz.add(positionLocal.sub(c4.xyz).mul(keep));
      const r = length(uv().sub(0.5).mul(2));
      const a = float(1).sub(smoothstep(0.15, 1, r));
      m.colorNode = vec3(0.02, 0.025, 0.03);
      m.opacityNode = a.mul(a).mul(0.5);
      this.blobMat = m;
    }
    const geo = this.blobGeo.clone();
    geo.setAttribute('scCenter', new THREE.InstancedBufferAttribute(centers, 4));
    const mesh = new THREE.InstancedMesh(geo, this.blobMat!, items.length);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), mm = new THREE.Matrix4();
    // blob centre at the item's base (the kind's origin sits on the ground), so the shrink centre (item centre) matches
    items.forEach((it, i) => mesh.setMatrixAt(i, mm.compose(it.p, q.setFromAxisAngle(up, it.yaw), sc.set(radius * it.sx, 1, radius * it.sz))));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = `scatter:${key}:blob`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.root.add(mesh);
    return mesh;
  }

  private shared = new Map<THREE.Material, THREE.MeshStandardNodeMaterial>();
  /** One distance-shrinking clone per base material. */
  private materialFor(base: THREE.MeshStandardNodeMaterial) {
    let m = this.shared.get(base);
    if (m) return m;
    m = base.clone() as THREE.MeshStandardNodeMaterial;
    m.name = `scatter:${base.name}`;
    const c4 = attribute('scCenter', 'vec4');
    const c = c4.xyz;
    const d = c.xz.sub(cameraPosition.xz).length();
    const keep = float(1).sub(smoothstep(c4.w.mul(0.7), c4.w, d));
    m.positionNode = c.add(positionLocal.sub(c).mul(keep));
    this.shared.set(base, m);
    return m;
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality();
  }

  private applyQuality() {
    for (const k of this.kinds.values()) {
      for (const m of k.chunks) {
        m.count = Math.round((m.userData.full as number) * k.density[this.quality]);
        m.userData.empty = m.count === 0;
        if (m.count === 0) m.visible = false;
      }
    }
    this.cull?.reset();
  }

  /** instances drawn per kind (debug) */
  stats() {
    return Object.fromEntries([...this.kinds].map(([key, k]) => [key, k.chunks.reduce((a, m) => a + m.count, 0)]));
  }
}

/**
 * Hides a scatter chunk once its nearest point is past the kind's shrink distance (the vertex shader has already
 * shrunk every instance to nothing there, so this never pops). Not preset-scaled: the shader distance isn't either.
 */
class ScatterCull implements LodTarget {
  readonly lodEvery = 3;
  private spheres: THREE.Sphere[];
  constructor(private meshes: THREE.InstancedMesh[]) {
    this.spheres = meshes.map((m) => m.boundingSphere!.clone());
  }
  reset() { for (const m of this.meshes) m.userData.shown = undefined; }
  updateLod(cam: THREE.Vector3) {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i], s = this.spheres[i];
      if (m.userData.empty) continue;
      const far = m.userData.far as number;
      const d = distToSphere(cam.x, cam.y, cam.z, s.center.x, s.center.y, s.center.z, s.radius);
      const shown = m.userData.shown !== false;
      const v = shown ? d < far * (1 + LOD_HYSTERESIS) : d < far;
      if (v !== m.userData.shown) { m.userData.shown = v; m.visible = v; }
    }
  }
}
