import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, float, positionLocal, smoothstep } from 'three/tsl';
import type { Quality } from './sky';
import { stressOffsets } from './stress';
import { makeRng } from './textures';

/**
 * Instanced small-detail scatter (pebbles, rubble, litter, shells, seaweed, footprints…): one InstancedMesh per
 * kind for the whole map. Each instance shrinks to nothing between 70 % and 100 % of the kind's cull distance
 * (vertex shader, from a per-instance centre), and the preset sets how many instances draw (instances are
 * shuffled, so a lower count thins everywhere evenly). Purely visual, never collides.
 */
export type ScatterKind = {
  geo: THREE.BufferGeometry;
  material: THREE.MeshStandardNodeMaterial;
  /** metres from the camera where an instance has fully shrunk away */
  far: number;
  density: Record<Quality, number>;
  cast?: boolean;
};

type Item = { m: THREE.Matrix4; c: THREE.Color; p: THREE.Vector3 };

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

export class Scatter {
  readonly root = new THREE.Group();
  private kinds = new Map<string, ScatterKind & { items: Item[]; mesh?: THREE.InstancedMesh }>();
  private quality: Quality = 'high';

  constructor() { this.root.name = 'scatter'; }

  define(key: string, k: ScatterKind) {
    if (this.kinds.has(key)) throw new Error(`[world/scatter] kind "${key}" defined twice`);
    this.kinds.set(key, { ...k, items: [] });
  }

  has(key: string) { return this.kinds.has(key); }

  /** Place one instance: world position, yaw, scale (uniform or xyz), small tilt, tint. */
  add(key: string, x: number, y: number, z: number, yaw = 0, s: number | [number, number, number] = 1, tilt: [number, number] = [0, 0], color: THREE.ColorRepresentation = 0xffffff) {
    const k = this.kinds.get(key);
    if (!k) throw new Error(`[world/scatter] unknown kind "${key}"`);
    const sc = typeof s === 'number' ? _s.set(s, s, s) : _s.set(s[0], s[1], s[2]);
    for (const [ox, oz] of stressOffsets()) {
      const m = new THREE.Matrix4().compose(_p.set(x + ox, y, z + oz), _q.setFromEuler(_e.set(tilt[0], yaw, tilt[1], 'YXZ')), sc);
      k.items.push({ m, c: new THREE.Color(color), p: new THREE.Vector3(x + ox, y, z + oz) });
    }
  }

  build() {
    const rng = makeRng(8128);
    let total = 0;
    for (const [key, k] of this.kinds) {
      if (k.items.length === 0) continue;
      // deterministic shuffle → truncating `count` thins uniformly
      for (let i = k.items.length - 1; i > 0; i--) { const j = Math.floor(rng.rnd() * (i + 1)); [k.items[i], k.items[j]] = [k.items[j], k.items[i]]; }
      const geo = k.geo.clone();
      if (!geo.getAttribute('color')) {
        const n = geo.getAttribute('position').count;
        geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      }
      // centre + cull distance per instance, so every kind on the same base material shares one pipeline
      const centers = new Float32Array(k.items.length * 4);
      k.items.forEach((it, i) => centers.set([it.p.x, it.p.y, it.p.z, k.far], i * 4));
      geo.setAttribute('scCenter', new THREE.InstancedBufferAttribute(centers, 4));
      const mat = this.materialFor(k.material);
      const mesh = new THREE.InstancedMesh(geo, mat, k.items.length);
      k.items.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, it.c); });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = `scatter:${key}`;
      mesh.castShadow = !!k.cast;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // spans the whole map; per-instance distance shrink does the culling
      this.root.add(mesh);
      k.mesh = mesh;
      total += k.items.length;
    }
    this.applyQuality();
    console.info(`[world/scatter] ${total} instances in ${this.root.children.length} kinds`);
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
      if (!k.mesh) continue;
      const n = Math.round(k.items.length * k.density[this.quality]);
      k.mesh.count = n;
      k.mesh.visible = n > 0;
    }
  }

  /** instances drawn per kind (debug) */
  stats() {
    return Object.fromEntries([...this.kinds].map(([key, k]) => [key, k.mesh?.count ?? 0]));
  }
}
