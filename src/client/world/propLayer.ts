import * as THREE from 'three/webgpu';
import { type Placement, PROP_SPEC, type PropType } from './clusters';
import { mat, merge, StaticBatch } from './geo';
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
  private meshes: { mesh: THREE.InstancedMesh; tiers: number[] }[] = [];
  private quality: Quality = 'high';
  private counts = { baked: 0, instanced: 0, skipped: 0 };
  /** CPU time spent placing/baking (load-time budget) */
  private ms = 0;
  /** non-casting baked props (PROP_SPEC.cast false): their own merged meshes, drawn in the main pass only */
  private quiet = new StaticBatch();
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
    const into = PROP_SPEC[p.type].cast ? bake : this.quiet;
    for (const part of propModel(p.type, p.cell ?? 0)) into.addRaw(part.material, transformed(part.geometry, m, part.tint ? _c : null), part.cast, true);
  }

  /** Build the instanced meshes (call once after every place()). */
  build() {
    const t0 = performance.now();
    for (const mesh of this.quiet.build(this.root, 'dockQuiet')) mesh.castShadow = false;
    this.ms += performance.now() - t0;
    for (const [type, list] of this.pending) {
      list.sort((a, b) => a.tier - b.tier); // stable: within a tier, placement order (stack bottoms first)
      const tiers = list.map((i) => i.tier);
      // one geometry per material: instanced parts all take the instance tint
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      let cast = false;
      for (const part of propModel(type)) {
        cast ||= part.cast;
        const xs = byMat.get(part.material) ?? [];
        xs.push(part.geometry.clone());
        byMat.set(part.material, xs);
      }
      for (const [material, geos] of byMat) {
        const geo = geos.length === 1 ? geos[0] : merge(geos);
        const mesh = new THREE.InstancedMesh(geo, material, list.length);
        list.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, _c.set(it.tint)); });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        mesh.name = `props:${type}:${material.name || 'mat'}`;
        mesh.computeBoundingSphere();
        this.root.add(mesh);
        this.meshes.push({ mesh, tiers });
      }
      this.counts.instanced += list.length;
    }
    this.pending.clear();
    this.applyQuality();
    console.info(`[world/props] ${this.counts.baked} baked + ${this.counts.instanced} instanced (${this.meshes.length} meshes) dock props, ${this.counts.skipped} above tier ${this.buildTier}; placed in ${Math.round(this.ms)} ms`);
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality();
  }

  private applyQuality() {
    const lim = TIER_LIMIT[this.quality];
    for (const { mesh, tiers } of this.meshes) {
      let n = 0;
      while (n < tiers.length && tiers[n] <= lim) n++;
      mesh.count = n;
      mesh.visible = n > 0;
    }
  }

  /** Drop everything (map change). Model geometry stays cached in propModels. */
  clear() {
    for (const { mesh } of this.meshes) { mesh.geometry.dispose(); mesh.dispose(); mesh.removeFromParent(); }
    this.meshes = [];
    this.pending.clear();
    for (const o of [...this.root.children]) { if (o instanceof THREE.Mesh) o.geometry.dispose(); o.removeFromParent(); }
    this.quiet = new StaticBatch();
    this.counts = { baked: 0, instanced: 0, skipped: 0 };
    this.ms = 0;
  }

  /** debug: instances drawn per mesh + totals */
  stats() {
    return { ...this.counts, meshes: this.meshes.length, drawn: Object.fromEntries(this.meshes.map(({ mesh }) => [mesh.name, mesh.count])) };
  }
}
