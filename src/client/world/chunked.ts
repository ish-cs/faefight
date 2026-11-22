import * as THREE from 'three/webgpu';
import { type ImpostorAtlas, impostorQuad, impostors } from './impostor';
import { lods, type LodTarget, lodScale, simplifyGeometry, SMALL_CASTER_LAYER, TINY_CASTER_LAYER } from './lod';
import { batchIndirectIndex, cameraPosition, float, int, ivec2, positionLocal, smoothstep, texture, textureLoad } from 'three/tsl';
import { chunkCoord, chunkKey, distToSphere, LOD_HYSTERESIS, selectLod } from './lodMath';

/**
 * Chunked instancing with LOD: the instances of one prop type are split into a spatial grid (default 16 m) and each
 * chunk picks its LOD level from its distance to the camera. Drawing is batched: one BatchedMesh per level × part
 * holds every chunk's instances (a chunk's level switch toggles its instances' visibility), and BatchedMesh culls
 * per instance against the camera and every shadow cascade. One impostor mesh holds every chunk's quads. So a prop
 * type costs one draw per part (+1 impostor) per pass however many chunks are in view (was one per chunk × part).
 * See docs/perf.md.
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
  /** prop-sized (≤ ~1.2 m: crates, barrels, bollards): shadows from the first cascade only, like the gameplay props */
  tiny?: boolean;
  /** grid size in metres (default 16) */
  chunk?: number;
};

type Chunk = {
  idx: number[]; // instance ids, sorted by tier
  /** per level: is it shown for this chunk */
  on: boolean[];
  /** [level][part][slot] → instance id in that level × part's batch */
  ids: number[][][];
  /** first impostor instance of this chunk (its slots are contiguous), -1 = none */
  impFirst: number;
  center: THREE.Vector3;
  radius: number;
  current: number;
  tierCount: number[]; // instances with tier <= t, per t
};

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
  /** [level][part] batch (null for parts-less / impostor levels) */
  private batches: (THREE.BatchedMesh | null)[][] = [];
  private imp: THREE.Mesh | null = null;
  private impLevel = -1;
  private where: { chunk: Chunk; slot: number }[] = [];
  private levelParts: (LodPart[] | null)[] = [];
  private thresholds: number[] = [];
  private tierLimit = Infinity;
  private built = false;
  private atlas: ImpostorAtlas | null = null;
  /** level 0 ↔ impostor cross-fade distance (0 = hard switch per chunk) */
  private fade = 0;

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
        // impostor right after the full model: per-instance shader cross-fade at level 0's maxDist
        if (li === 1) this.fade = spec.levels[0].maxDist;
        this.atlas = impostors.request(base, l.impostor.views ?? 8, l.impostor.cell ?? 128, this.fade);
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
    const n = this.mats.length;
    // one batch per level × part, every chunk's instances in it
    this.batches = this.levelParts.map((parts, li) => (parts ?? []).map((p) => {
      const g = p.geometry;
      const m = new THREE.BatchedMesh(n, g.getAttribute('position').count, g.index ? g.index.count : 0, p.material);
      m.addGeometry(g);
      if (this.fade && li === 0) m.material = batchedShrink(p.material, this.fade, m, 0.85); // per-instance shrink-out
      m.castShadow = !!p.cast;
      m.receiveShadow = p.receive ?? true;
      m.frustumCulled = false; // spans the map: perObjectFrustumCulled culls each instance per pass
      m.sortObjects = false;
      if (spec.tiny) m.layers.set(TINY_CASTER_LAYER);
      else if (spec.small) m.layers.set(SMALL_CASTER_LAYER);
      m.name = `${this.root.name}:${p.material.name || 'mat'}:L${li}`;
      this.root.add(m);
      return m;
    }));
    this.where = new Array(n);
    const impOrder: number[] = [];
    for (const idx of groups.values()) {
      idx.sort((a, b) => this.tiers[a] - this.tiers[b]);
      const box = new THREE.Box3();
      for (const i of idx) box.expandByPoint(_p.setFromMatrixPosition(this.mats[i]));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      let maxScale = 1;
      for (const i of idx) maxScale = Math.max(maxScale, this.mats[i].getMaxScaleOnAxis());
      const chunk: Chunk = { idx, on: this.levelParts.map(() => false), ids: [], impFirst: -1, center: sphere.center, radius: sphere.radius + modelR * maxScale, current: -1, tierCount: [] };
      idx.forEach((id, slot) => { this.where[id] = { chunk, slot }; });
      const maxTier = this.tiers[idx[idx.length - 1]];
      for (let t = 0; t <= maxTier; t++) chunk.tierCount[t] = idx.filter((i) => this.tiers[i] <= t).length;
      chunk.ids = this.batches.map((parts) => parts.map((m) => idx.map((id) => {
        const bid = m!.addInstance(0);
        m!.setMatrixAt(bid, this.mats[id]);
        const c = this.cols[id];
        if (c) m!.setColorAt(bid, c);
        m!.setVisibleAt(bid, false);
        return bid;
      })));
      if (spec.levels.some((l) => l.impostor)) { chunk.impFirst = impOrder.length; impOrder.push(...idx); }
      this.chunks.push(chunk);
    }
    const impLevel = spec.levels.findIndex((l) => l.impostor);
    if (impLevel >= 0) { this.impLevel = impLevel; this.imp = this.impostorMesh(impOrder); this.root.add(this.imp); }
    this.applyTier();
    lods.register(this);
    for (const { li, pi, ratio } of pending) {
      void simplifyGeometry(base![pi].geometry, ratio).then((g) => {
        this.levelParts[li]![pi].geometry = g;
        this.batches[li][pi]?.setGeometryAt(0, g);
      });
    }
    return this.root;
  }

  /** One impostor quad per instance (all chunks, in chunk order): per-instance centre + yaw, tint + scale (0 = hidden). */
  private impostorMesh(order: number[]): THREE.Mesh {
    const n = order.length, quad = impostorQuad();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.index);
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const C = new Float32Array(n * 4), T = new Float32Array(n * 4);
    order.forEach((id, slot) => {
      this.mats[id].decompose(_p, _q, _s);
      _e.setFromQuaternion(_q, 'YXZ');
      const c = this.cols[id];
      C.set([_p.x, _p.y, _p.z, _e.y], slot * 4);
      T.set([c?.r ?? 1, c?.g ?? 1, c?.b ?? 1, 0], slot * 4); // shown per chunk by the LOD (w = scale)
    });
    geo.setAttribute('impCenter', new THREE.InstancedBufferAttribute(C, 4));
    geo.setAttribute('impTint', new THREE.InstancedBufferAttribute(T, 4));
    geo.instanceCount = n;
    const box = new THREE.Box3();
    for (const id of order) box.expandByPoint(_p.setFromMatrixPosition(this.mats[id]));
    geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    geo.boundingSphere.radius += 30;
    const atlas = this.atlas!;
    const mesh = new THREE.Mesh(geo, atlas.ready ? atlas.material : HIDDEN_MAT);
    mesh.name = `${this.root.name}:impostor`;
    mesh.castShadow = false;
    mesh.visible = atlas.ready;
    if (!atlas.ready) atlas.onReady.push(() => { mesh.material = atlas.material; mesh.visible = true; });
    return mesh;
  }

  /** Instance `slot` of chunk `c` is drawn at level `li` (level on, not hidden, inside the tier limit). */
  private shown(c: Chunk, li: number, slot: number) {
    const t = Math.min(this.tierLimit, c.tierCount.length - 1);
    return c.on[li] && slot < (t < 0 ? 0 : c.tierCount[t]) && !this.hidden.has(c.idx[slot]);
  }

  /** Push a chunk's visibility (one level, or all) to the batches and the impostor quads. */
  private sync(c: Chunk, level = -1) {
    for (let li = 0; li < this.batches.length; li++) {
      if (level >= 0 && li !== level) continue;
      const parts = this.batches[li];
      for (let pi = 0; pi < parts.length; pi++) {
        const m = parts[pi]!, ids = c.ids[li][pi];
        for (let slot = 0; slot < ids.length; slot++) m.setVisibleAt(ids[slot], this.shown(c, li, slot));
      }
      if (li === this.impLevel && this.imp && c.impFirst >= 0) {
        const a = this.imp.geometry.getAttribute('impTint') as THREE.InstancedBufferAttribute;
        for (let slot = 0; slot < c.idx.length; slot++) a.setW(c.impFirst + slot, this.shown(c, li, slot) ? this.mats[c.idx[slot]].getMaxScaleOnAxis() : 0);
        a.needsUpdate = true;
      }
    }
  }

  /** Draw only instances with tier <= t (quality thinning, per chunk). */
  setTierLimit(t: number) {
    if (t === this.tierLimit) return;
    this.tierLimit = t;
    if (this.built) this.applyTier();
  }

  private applyTier() {
    for (const c of this.chunks) this.sync(c);
  }

  /** Hide / show one instance (e.g. a broken prop). */
  setVisible(id: number, visible: boolean) {
    if (visible) this.hidden.delete(id); else this.hidden.add(id);
    const w = this.where[id];
    if (w) this.sync(w.chunk);
  }

  updateLod(cam: THREE.Vector3, scale: number) {
    if (this.fade && lods.force < 0) { this.updateFade(cam, scale); return; }
    for (const c of this.chunks) {
      const d = distToSphere(cam.x, cam.y, cam.z, c.center.x, c.center.y, c.center.z, c.radius);
      const l = lods.force >= 0 ? Math.min(lods.force, this.thresholds.length - 1) : selectLod(d, this.thresholds, c.current, scale);
      if (l === c.current) continue;
      c.current = l; // l === thresholds.length → beyond the last maxDist: culled
      c.on = c.on.map((_, i) => i === l);
      this.sync(c);
    }
  }

  /**
   * Cross-fade mode (full model → impostor): a chunk shows the full model while any of it is inside the fade
   * distance, the impostors while any of it is past the start of the band, both inside it (the shaders shrink /
   * grow each instance), nothing past the last level's distance.
   */
  private updateFade(cam: THREE.Vector3, scale: number) {
    const F = this.fade * scale, last = this.thresholds[this.thresholds.length - 1] * scale, h = 1 + LOD_HYSTERESIS;
    for (const c of this.chunks) {
      const dmin = distToSphere(cam.x, cam.y, cam.z, c.center.x, c.center.y, c.center.z, c.radius);
      const dmax = cam.distanceTo(c.center) + c.radius;
      const showFull = dmin < F * h, showImp = dmax > F * 0.85 / h && dmin < last;
      const key = (showFull ? 1 : 0) | (showImp ? 2 : 0);
      if (key === c.current) continue;
      c.current = key;
      c.on = c.on.map((_, i) => (i === 0 ? showFull : i === 1 ? showImp : false));
      this.sync(c);
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
    for (const parts of this.batches) for (const m of parts) m?.dispose();
    this.imp?.geometry.dispose();
    this.root.removeFromParent();
  }
}

/**
 * Batched twin of lod.ts shrinkMaterial (per-instance shrink-out toward the instance's own origin across the
 * cross-fade band): a BatchedMesh has no per-instance attributes, so the instance origin comes from the batch's own
 * matrices texture (column 3 of the instance matrix, the same texel layout three's BatchNode reads).
 */
function batchedShrink(base: THREE.Material, far: number, mesh: THREE.BatchedMesh, from: number): THREE.Material {
  const n = base.clone() as THREE.NodeMaterial;
  n.name = `${base.name}~far`;
  const tex = (mesh as unknown as { _matricesTexture: THREE.DataTexture })._matricesTexture;
  const size = int(tex.image.width); // fixed when the batch is created (max instance count)
  const j = int(batchIndirectIndex).mul(4);
  const c = textureLoad(texture(tex), ivec2(j.mod(size).add(3), j.div(size))).xyz;
  const d = c.xz.sub(cameraPosition.xz).length();
  const f = lodScale.mul(far);
  const keep = float(1).sub(smoothstep(f.mul(from), f, d));
  const p = ((base as THREE.NodeMaterial).positionNode ?? positionLocal) as THREE.Node<'vec3'>;
  n.positionNode = c.add(p.sub(c).mul(keep));
  return n;
}
