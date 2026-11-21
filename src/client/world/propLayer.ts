import * as THREE from 'three/webgpu';
import { type Placement, PROP_SPEC, type PropType } from './clusters';
import { ChunkedInstances } from './chunked';
import { mat, merge, StaticBatch } from './geo';
import { registerDistanceCull, releaseLods, SMALL_CASTER_LAYER } from './lod';
import { propModel } from './propModels';
import type { Quality } from './sky';

/**
 * Draws clusters.ts placements. Draw calls cost far more than triangles here (~15 µs CPU each, × camera + every
 * shadow cascade), so almost every prop is baked into the caller's merged StaticBatch: it shares the existing
 * per-material dressing meshes and adds no draw calls. Density follows the quality preset at map build
 * (`buildTier`; a tier never sits on a higher one, so thinning never leaves anything floating). Types flagged
 * PROP_SPEC.inst (hundreds of tiny non-casting pieces) become one InstancedMesh per (type, material) whose `count`
 * also follows live preset changes. Purely visual: no colliders, never in the camera/aim collidables.
 *
 * Perf agent's world/chunked.ts: swap the InstancedMesh in build() for `new ChunkedInstances({ name, levels:
 * [{ parts: propModel(type), maxDist }], small: true, chunk: 48 })` + add/build/setTierLimit.
 */
export const TIER_LIMIT: Record<Quality, number> = { low: 0, high: 1, ultra: 2 };
/** dock clusters beyond this (high-preset metres, scaled per preset by lod.ts) are not drawn */
const CLUSTER_CULL = 150;
const _c = new THREE.Color();

const _n = new THREE.Matrix3();
/**
 * Copy of a merge-form model geometry (position/normal/uv/color, non-indexed) moved by `m`, colours × `tint`: one
 * typed-array pass, no BufferGeometry clone/applyMatrix4 (thousands of props are baked at map load).
 */
function transformed(src: THREE.BufferGeometry, m: THREE.Matrix4, tint: THREE.Color | null) {
  const P = src.getAttribute('position').array as Float32Array, N = src.getAttribute('normal').array as Float32Array;
  const U = src.getAttribute('uv').array as Float32Array, C = src.getAttribute('color').array as Float32Array;
  const e = m.elements, n = _n.getNormalMatrix(m).elements;
  const p = new Float32Array(P.length), nn = new Float32Array(N.length), c = new Float32Array(C.length);
  const tr = tint?.r ?? 1, tg = tint?.g ?? 1, tb = tint?.b ?? 1;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    p[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    p[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    p[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const a = N[i], b = N[i + 1], d = N[i + 2];
    const nx = n[0] * a + n[3] * b + n[6] * d, ny = n[1] * a + n[4] * b + n[7] * d, nz = n[2] * a + n[5] * b + n[8] * d;
    const l = 1 / (Math.hypot(nx, ny, nz) || 1);
    nn[i] = nx * l; nn[i + 1] = ny * l; nn[i + 2] = nz * l;
    c[i] = C[i] * tr; c[i + 1] = C[i + 1] * tg; c[i + 2] = C[i + 2] * tb;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U.slice(), 2));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

type Inst ={ m: THREE.Matrix4; tint: number; tier: number };

export class PropLayer {
  readonly root = new THREE.Group();
  private pending = new Map<PropType, Inst[]>();
  /** instanced types: chunked (48 m grid: draws cost more than triangles, frustum + distance culled per chunk, near-cascade shadows only) */
  private layers: { layer: ChunkedInstances; type: PropType; n: number }[] = [];
  private quality: Quality = 'high';
  private counts = { baked: 0, instanced: 0, skipped: 0 };
  /** CPU time spent placing/baking (load-time budget) */
  private ms = 0;
  /** non-casting baked props (PROP_SPEC.cast false): their own merged meshes, drawn in the main pass only */
  private quiet = new StaticBatch();
  /**
   * casting baked props: their own chunked batch (not the island dressing's: their triangles pushed those bins over
   * the chunk-split threshold), near shadow cascades only, culled past CLUSTER_CULL m
   */
  private baked = new StaticBatch();
  /** highest quality tier baked by the next place() calls (set from the preset before a map build) */
  buildTier = 2;

  constructor() { this.root.name = 'dockProps'; }

  /** Queue one placement; `frame` maps the placement frame (y = 0 on the ground) to world. */
  place(p: Placement, frame: THREE.Matrix4, bake: StaticBatch) {
    const t0 = performance.now();
    this.bakeOne(p, frame, bake);
    this.ms += performance.now() - t0;
  }

  private bakeOne(p: Placement, frame: THREE.Matrix4, bake: StaticBatch) {
    const m = frame.clone().multiply(mat(p.x, p.y, p.z, p.tilt?.[0] ?? 0, p.yaw, p.tilt?.[1] ?? 0, p.s[0], p.s[1], p.s[2], 'YXZ'));
    if (PROP_SPEC[p.type].inst) {
      // instanced: kept at every tier, thinned live by applyQuality
      let list = this.pending.get(p.type);
      if (!list) { list = []; this.pending.set(p.type, list); }
      list.push({ m, tint: p.tint, tier: p.tier });
      return;
    }
    if (p.tier > this.buildTier) { this.counts.skipped++; return; }
    this.counts.baked++;
    _c.set(p.tint);
    void bake; // kept for the call sites' signature; clusters bake into their own batch
    const into = PROP_SPEC[p.type].cast ? this.baked : this.quiet;
    for (const part of propModel(p.type, p.cell ?? 0)) into.addRaw(part.material, transformed(part.geometry, m, part.tint ? _c : null), part.cast, true);
  }

  /** Build the instanced meshes (call once after every place()). */
  build() {
    const t0 = performance.now();
    for (const mesh of this.quiet.build(this.root, 'dockQuiet', { chunked: true })) mesh.castShadow = false;
    for (const mesh of this.baked.build(this.root, 'dock', { chunked: true })) {
      mesh.layers.set(SMALL_CASTER_LAYER);
      if (mesh.userData.lod) continue; // small-part chunks already distance-cull themselves
      mesh.geometry.computeBoundingSphere();
      const sp = mesh.geometry.boundingSphere!;
      // map-wide leftovers (radius ≥ the cull distance) stay drawn; real chunks cull with distance
      if (sp.radius < CLUSTER_CULL) mesh.userData.lod = registerDistanceCull(mesh, CLUSTER_CULL, { center: sp.center, radius: sp.radius });
    }
    this.ms += performance.now() - t0;
    for (const [type, list] of this.pending) {
      list.sort((a, b) => a.tier - b.tier); // stable: within a tier, placement order (stack bottoms first)
      // one geometry per material: instanced parts all take the instance tint
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      let cast = false;
      for (const part of propModel(type)) {
        cast ||= part.cast;
        const xs = byMat.get(part.material) ?? [];
        xs.push(part.geometry.clone());
        byMat.set(part.material, xs);
      }
      const parts = [...byMat].map(([material, geos]) => ({ material, geometry: geos.length === 1 ? geos[0] : merge(geos), cast, receive: true }));
      // tiny ground pieces: full detail near, gone past 60 m (they shrink below a pixel well before that)
      // tiny ground pieces (stones): no shadows, few big chunks (draws cost more than their triangles)
      const layer = new ChunkedInstances({ name: `props:${type}`, levels: [{ parts: parts.map((x) => ({ ...x, cast: false })), maxDist: 60 }], small: true, chunk: 128 });
      for (const it of list) layer.add(it.m, _c.set(it.tint), it.tier);
      this.root.add(layer.build());
      this.layers.push({ layer, type, n: list.length });
      this.counts.instanced += list.length;
    }
    this.pending.clear();
    this.applyQuality();
    console.info(`[world/props] ${this.counts.baked} baked + ${this.counts.instanced} instanced (${this.layers.length} chunked layers) dock props, ${this.counts.skipped} above tier ${this.buildTier}; placed in ${Math.round(this.ms)} ms`);
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality();
  }

  private applyQuality() {
    for (const { layer } of this.layers) layer.setTierLimit(TIER_LIMIT[this.quality]);
  }

  /** Drop everything (map change). Model geometry stays cached in propModels. */
  clear() {
    for (const { layer } of this.layers) layer.dispose();
    this.layers = [];
    this.pending.clear();
    releaseLods(this.root);
    for (const o of [...this.root.children]) { if (o instanceof THREE.Mesh) o.geometry.dispose(); o.removeFromParent(); }
    this.quiet = new StaticBatch();
    this.baked = new StaticBatch();
    this.counts = { baked: 0, instanced: 0, skipped: 0 };
    this.ms = 0;
  }

  /** debug: instances drawn per mesh + totals */
  stats() {
    return { ...this.counts, layers: this.layers.length, instanced: Object.fromEntries(this.layers.map(({ type, n }) => [type, n])) };
  }
}
