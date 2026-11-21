import * as THREE from 'three/webgpu';
import { type ImpostorAtlas, impostorQuad, impostors } from './impostor';
import { lods, type LodTarget, simplifyGeometry, SMALL_CASTER_LAYER } from './lod';
import { chunkCoord, chunkKey, distToSphere, selectLod } from './lodMath';

/**
 * Chunked instancing with LOD: the instances of one prop type are split into a spatial grid (default 16 m); each
 * chunk × level × part is its own InstancedMesh with a tight bounding sphere, so three's frustum culling (camera
 * and every shadow cascade) skips whole chunks, and each chunk picks its LOD level from its distance to the camera.
 * Replaces "one InstancedMesh for the whole map" (which can never be culled). See docs/perf.md.
 */

export type LodPart = { geometry: THREE.BufferGeometry; material: THREE.Material; cast?: boolean; receive?: boolean };
export type LodLevelSpec = {
  /** null = nothing drawn at this level (culled) */
  parts: LodPart[] | null;
  /** metres (high preset) where this level hands over to the next; the last level's maxDist is the cull distance */
  maxDist: number;
  /** auto-generate this level's parts by simplifying level 0 to this vertex ratio (0.05–1) */
  simplify?: number;
  /** billboard impostor of level 0 (baked at load, impostor.ts): views around the model, atlas cell px */
  impostor?: { views?: number; cell?: number };
};
export type ChunkedSpec = {
  name: string;
  levels: LodLevelSpec[];
  /** small props: shadows from the near cascades only */
  small?: boolean;
  /** grid size in metres (default 16) */
  chunk?: number;
};

type Chunk = {
  idx: number[]; // instance ids, sorted by tier
  levels: THREE.Group[]; // one group per level (meshes per part)
  meshes: THREE.InstancedMesh[][]; // [level][part]
  imp: THREE.Mesh | null; // impostor quads (one per instance), if the spec has an impostor level
  center: THREE.Vector3;
  radius: number;
  current: number;
  tierCount: number[]; // instances with tier <= t, per t
};

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const HIDDEN_MAT = new THREE.MeshBasicNodeMaterial({ visible: false });

export class ChunkedInstances implements LodTarget {
  readonly root = new THREE.Group();
  readonly lodEvery = 2;
  private mats: THREE.Matrix4[] = [];
  private cols: (THREE.Color | null)[] = [];
  private tiers: number[] = [];
  private hidden = new Set<number>();
  private chunks: Chunk[] = [];
  private where: { chunk: Chunk; slot: number }[] = [];
  private levelParts: (LodPart[] | null)[] = [];
  private thresholds: number[] = [];
  private tierLimit = Infinity;
  private built = false;
  private atlas: ImpostorAtlas | null = null;

  constructor(readonly spec: ChunkedSpec) {
    if (spec.levels.length === 0) throw new Error(`[world/chunked] ${spec.name}: no levels`);
    this.root.name = `chunked:${spec.name}`;
  }

  /** Add one instance (world matrix, optional tint, quality tier: 0 always drawn, higher thinned first). */
  add(matrix: THREE.Matrix4, color?: THREE.ColorRepresentation, tier = 0): number {
    if (this.built) throw new Error(`[world/chunked] ${this.spec.name}: add() after build()`);
    this.mats.push(matrix.clone());
    this.cols.push(color === undefined ? null : new THREE.Color(color));
    this.tiers.push(tier);
    return this.mats.length - 1;
  }

  get size() { return this.mats.length; }

  build(): THREE.Group {
    if (this.built) return this.root;
    this.built = true;
    const spec = this.spec, size = spec.chunk ?? 16;
    // resolve parts per level (auto-simplified from level 0 when asked)
    // auto-simplified levels start as level 0's geometry and swap in the simplified mesh when it's ready (async,
    // off the load's critical path)
    const base = spec.levels[0].parts;
    const pending: { li: number; pi: number; ratio: number }[] = [];
    this.levelParts = spec.levels.map((l, li) => {
      if (l.impostor) {
        if (!base) throw new Error(`[world/chunked] ${spec.name}: impostor needs level 0 parts`);
        this.atlas = impostors.request(base, l.impostor.views ?? 8, l.impostor.cell ?? 128);
        return null;
      }
      if (l.simplify === undefined) return l.parts;
      if (!base) throw new Error(`[world/chunked] ${spec.name}: simplify needs level 0 parts`);
      base.forEach((_, pi) => pending.push({ li, pi, ratio: l.simplify! }));
      return base.map((p) => ({ ...p }));
    });
    this.thresholds = spec.levels.map((l) => l.maxDist);
    // model radius (largest part) for chunk bounds
    let modelR = 0;
    for (const parts of this.levelParts) for (const p of parts ?? []) {
      if (!p.geometry.boundingSphere) p.geometry.computeBoundingSphere();
      const s = p.geometry.boundingSphere!;
      modelR = Math.max(modelR, s.center.length() + s.radius);
    }
    const groups = new Map<number, number[]>();
    this.mats.forEach((m, i) => {
      _p.setFromMatrixPosition(m);
      const k = chunkKey(chunkCoord(_p.x, size), chunkCoord(_p.z, size));
      let a = groups.get(k);
      if (!a) groups.set(k, (a = []));
      a.push(i);
    });
    this.where = new Array(this.mats.length);
    for (const idx of groups.values()) {
      idx.sort((a, b) => this.tiers[a] - this.tiers[b]);
      const box = new THREE.Box3();
      for (const i of idx) box.expandByPoint(_p.setFromMatrixPosition(this.mats[i]));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      let maxScale = 1;
      for (const i of idx) maxScale = Math.max(maxScale, this.mats[i].getMaxScaleOnAxis());
      const chunk: Chunk = { idx, levels: [], meshes: [], imp: null, center: sphere.center, radius: sphere.radius + modelR * maxScale, current: -1, tierCount: [] };
      idx.forEach((id, slot) => { this.where[id] = { chunk, slot }; });
      const maxTier = this.tiers[idx[idx.length - 1]];
      for (let t = 0; t <= maxTier; t++) chunk.tierCount[t] = idx.filter((i) => this.tiers[i] <= t).length;
      this.levelParts.forEach((parts, li) => {
        const g = new THREE.Group();
        g.name = `${this.root.name}:L${li}`;
        g.visible = false;
        const meshes = (parts ?? []).map((p) => {
          const m = new THREE.InstancedMesh(p.geometry, p.material, idx.length);
          idx.forEach((id, slot) => {
            m.setMatrixAt(slot, this.hidden.has(id) ? ZERO : this.mats[id]);
            const c = this.cols[id];
            if (c) m.setColorAt(slot, c);
          });
          m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
          m.computeBoundingSphere();
          m.castShadow = !!p.cast;
          m.receiveShadow = p.receive ?? true;
          if (spec.small) m.layers.set(SMALL_CASTER_LAYER);
          m.name = `${this.root.name}:${p.material.name || 'mat'}:L${li}`;
          g.add(m);
          return m;
        });
        if (spec.levels[li].impostor) g.add((chunk.imp = this.impostorMesh(chunk)));
        chunk.levels.push(g);
        chunk.meshes.push(meshes);
        this.root.add(g);
      });
      this.chunks.push(chunk);
    }
    this.applyTier();
    lods.register(this);
    for (const { li, pi, ratio } of pending) {
      void simplifyGeometry(base![pi].geometry, ratio).then((g) => {
        this.levelParts[li]![pi].geometry = g;
        for (const c of this.chunks) { const m = c.meshes[li][pi]; m.geometry = g; m.computeBoundingSphere(); }
      });
    }
    return this.root;
  }

  /** One impostor quad per instance of the chunk: per-instance centre + yaw, tint + scale (0 = hidden). */
  private impostorMesh(chunk: Chunk): THREE.Mesh {
    const n = chunk.idx.length, quad = impostorQuad();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.index);
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const C = new Float32Array(n * 4), T = new Float32Array(n * 4);
    chunk.idx.forEach((id, slot) => {
      this.mats[id].decompose(_p, _q, _s);
      _e.setFromQuaternion(_q, 'YXZ');
      const c = this.cols[id];
      C.set([_p.x, _p.y, _p.z, _e.y], slot * 4);
      T.set([c?.r ?? 1, c?.g ?? 1, c?.b ?? 1, this.hidden.has(id) ? 0 : Math.max(_s.x, _s.y, _s.z)], slot * 4);
    });
    geo.setAttribute('impCenter', new THREE.InstancedBufferAttribute(C, 4));
    geo.setAttribute('impTint', new THREE.InstancedBufferAttribute(T, 4));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(chunk.center.clone(), chunk.radius);
    const atlas = this.atlas!;
    const mesh = new THREE.Mesh(geo, atlas.ready ? atlas.material : HIDDEN_MAT);
    mesh.name = `${this.root.name}:impostor`;
    mesh.castShadow = false;
    mesh.visible = atlas.ready;
    if (!atlas.ready) atlas.onReady.push(() => { mesh.material = atlas.material; mesh.visible = true; });
    return mesh;
  }

  /** Draw only instances with tier <= t (quality thinning, per chunk). */
  setTierLimit(t: number) {
    if (t === this.tierLimit) return;
    this.tierLimit = t;
    if (this.built) this.applyTier();
  }

  private applyTier() {
    for (const c of this.chunks) {
      const t = Math.min(this.tierLimit, c.tierCount.length - 1);
      const n = t < 0 ? 0 : c.tierCount[t];
      for (const ms of c.meshes) for (const m of ms) m.count = n;
      if (c.imp) (c.imp.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    }
  }

  /** Hide / show one instance (e.g. a broken prop). */
  setVisible(id: number, visible: boolean) {
    if (visible) this.hidden.delete(id); else this.hidden.add(id);
    const w = this.where[id];
    if (!w) return;
    for (const ms of w.chunk.meshes) for (const m of ms) {
      m.setMatrixAt(w.slot, visible ? this.mats[id] : ZERO);
      m.instanceMatrix.needsUpdate = true;
    }
    if (w.chunk.imp) {
      const a = w.chunk.imp.geometry.getAttribute('impTint') as THREE.InstancedBufferAttribute;
      a.setW(w.slot, visible ? this.mats[id].getMaxScaleOnAxis() : 0);
      a.needsUpdate = true;
    }
  }

  updateLod(cam: THREE.Vector3, scale: number) {
    for (const c of this.chunks) {
      const d = distToSphere(cam.x, cam.y, cam.z, c.center.x, c.center.y, c.center.z, c.radius);
      const l = lods.force >= 0 ? Math.min(lods.force, this.thresholds.length - 1) : selectLod(d, this.thresholds, c.current, scale);
      if (l === c.current) continue;
      c.current = l; // l === thresholds.length → beyond the last maxDist: culled
      c.levels.forEach((g, i) => { g.visible = i === l; });
    }
  }

  /** Visible chunks per level (debug). */
  stats() {
    const per = this.thresholds.map(() => 0);
    let culled = 0;
    for (const c of this.chunks) { if (c.current < per.length && c.current >= 0) per[c.current]++; else culled++; }
    return { chunks: this.chunks.length, perLevel: per, culled };
  }

  dispose() {
    lods.unregister(this);
    for (const c of this.chunks) { for (const ms of c.meshes) for (const m of ms) m.dispose(); c.imp?.geometry.dispose(); }
    this.root.removeFromParent();
  }
}
