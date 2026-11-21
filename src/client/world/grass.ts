import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, cos, dot, float, max, mix, normalize, positionLocal, sin, smoothstep, step, time, transformNormalToView, uniform, vec2, vec3 } from 'three/tsl';
import type { IslandLayout } from '../../sim/map';
import type { Quality } from './sky';
import { BACKDROP_DECOR, type Ellipse, ISLAND_DECOR } from './decor';
import { makeRng } from './textures';

/**
 * GPU grass: one instanced-blade mesh per grass bed. Each blade is a 7-vertex tapered strip; the vertex shader
 * places it from per-instance data, sways it in a travelling wind wave, bends it away from nearby players and thins
 * it with camera distance (instances are sorted by a random rank, so lowering density just drops the tail — both in
 * the shader per blade and per bed via `instanceCount`). Purely visual, no collision. Off on the low preset.
 */
const MAX_PER_M2 = 200;
const PRESET: Record<Quality, { on: boolean; density: number; far: number }> = {
  low: { on: true, density: 0.15, far: 18 },
  high: { on: true, density: 0.6, far: 34 },
  ultra: { on: true, density: 1, far: 42 },
};
export const MAX_PUSHERS = 8;

type Bed = { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; n: number; center: THREE.Vector3; radius: number };

function bladeGeometry(): THREE.BufferGeometry {
  // x = side (-0.5..0.5, tapered in the shader), y = t along the blade (0 root .. 1 tip)
  const pos = [-0.5, 0, 0, 0.5, 0, 0, -0.5, 0.38, 0, 0.5, 0.38, 0, -0.5, 0.72, 0, 0.5, 0.72, 0, 0, 1, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6]);
  return g;
}

/** island-local (x, z) → world, the islands' frame (three.js Y rotation by facingYaw). */
export function islandToWorld(isl: IslandLayout, x: number, z: number) {
  const c = Math.cos(isl.bunker.facingYaw), s = Math.sin(isl.bunker.facingYaw);
  return { x: isl.center.x + x * c + z * s, z: isl.center.z - x * s + z * c };
}

/** Noisy ellipse membership with a soft edge: 0 outside, 1 well inside. */
function ellipseK(e: Ellipse, x: number, z: number, ph: number) {
  const dx = (x - e.x) / e.rx, dz = (z - e.z) / e.rz;
  const a = Math.atan2(dz, dx);
  const r = 1 + 0.2 * Math.sin(a * 3 + ph) + 0.09 * Math.sin(a * 7 + ph * 2);
  const d = Math.hypot(dx, dz) / r;
  return Math.min(1, Math.max(0, (1 - d) / 0.25));
}

export class Grass {
  readonly root = new THREE.Group();
  /** feet positions (xyz) + 1 when active; parked far away otherwise */
  readonly pushers = Array.from({ length: MAX_PUSHERS }, () => uniform(new THREE.Vector4(1e6, -100, 1e6, 0)));
  private beds: Bed[] = [];
  private quality: Quality = 'high';
  private far = uniform(30);
  /** Frame-time governor's multiplier on the preset's blade density (1 = full). */
  densityScale = 1;
  private material = this.buildMaterial();

  constructor() { this.root.name = 'grass'; }

  /** blades waiting to be bucketed into spatial cells: [x, y, z, yaw, h, w, rank, rnd] */
  private pending: number[][] = [];
  private rankRng = makeRng(4242);

  build(map: IslandLayout[], backdrop: (isl: IslandLayout) => { hw: number; z0: number; top: number }, maskOf: (isl: IslandLayout) => { data: ImageData; size: number; R: number }) {
    const t0 = performance.now();
    for (const isl of map) {
      const rng = makeRng(777 + isl.index * 131);
      const m = maskOf(isl);
      const maskAt = (x: number, z: number, ch: number) => {
        const px = Math.floor(((x + m.R) / (2 * m.R)) * m.size), pz = Math.floor(((z + m.R) / (2 * m.R)) * m.size);
        if (px < 0 || pz < 0 || px >= m.size || pz >= m.size) return 0;
        return m.data.data[(pz * m.size + px) * 4 + ch] / 255;
      };
      // island beds: scatter where the surface mask says grass (G channel), same pixels the ground shader uses
      for (const e of ISLAND_DECOR.grassBeds) this.addBed(isl, rng, e, isl.groundY, (x, z) => maskAt(x, z, 1));
      const bd = backdrop(isl);
      for (const b of BACKDROP_DECOR.grass) {
        const e = { x: b.x * bd.hw, z: bd.z0 + b.z, rx: b.rx, rz: b.rz };
        const ph = rng.rr(0, 6);
        this.addBed(isl, rng, e, bd.top, (x, z) => ellipseK(e, x, z, ph));
      }
      // tall clumps: listed spots, bunker corners, around the props (not in front of their interaction side)
      const R = isl.radius, bz = R - 7, bh = 2.55;
      const toLocal = (p: { x: number; z: number }) => {
        const dx = p.x - isl.center.x, dz = p.z - isl.center.z, c = Math.cos(isl.bunker.facingYaw), sn = Math.sin(isl.bunker.facingYaw);
        return [dx * c - dz * sn, dx * sn + dz * c] as [number, number];
      };
      const spots: [number, number][] = [...ISLAND_DECOR.tallGrass, [-bh, bz + bh], [bh, bz + bh], [-bh - 0.1, bz - bh + 0.4], [bh + 0.1, bz - bh + 0.4]];
      for (const pr of [isl.generator, isl.vault, isl.shop]) {
        const [lx, lz] = toLocal(pr);
        spots.push([lx + rng.rr(-1.1, -0.8), lz + rng.rr(0.6, 0.9)], [lx + rng.rr(0.8, 1.1), lz + rng.rr(0.6, 0.9)]);
      }
      for (const [x, z] of spots) this.addClump(isl, rng, x, z, isl.groundY, rng.rr(0.8, 1.2));
      for (let k = 0; k < 14; k++) this.addClump(isl, rng, rng.rr(-bd.hw + 2, bd.hw - 2), bd.z0 + rng.rr(0.6, 1.4), bd.top, rng.rr(0.7, 1.1));
      // weeds in the slab joints (every 4.5 m) and hairline cracks: small tufts, avoiding the bunker footprint
      for (let k = 0; k < 280; k++) {
        const along = rng.rr(-R, R), line = -R + 4.5 * Math.floor(rng.rr(1, (2 * R) / 4.5));
        const [x, z] = rng.rnd() < 0.5 ? [line, along] : [along, line];
        if (Math.hypot(x, z) > R - 1.2) continue;
        if (Math.abs(x) < 3 && Math.abs(z - bz) < 3) continue;
        if (maskAt(x, z, 1) > 0.3) continue;
        this.addTuft(isl, rng, x, z, isl.groundY);
      }
    }
    const beds = this.flush();
    this.applyQuality();
    console.info(`[world/grass] ${beds.blades} blades in ${beds.cells} cells (${Math.round(performance.now() - t0)} ms)`);
  }

  private blade(isl: IslandLayout, x: number, z: number, y: number, yaw: number, h: number, w: number, rnd: number) {
    const p = islandToWorld(isl, x, z);
    this.pending.push([p.x, y, p.z, yaw, h, w, this.rankRng.rnd(), rnd]);
  }

  private addBed(isl: IslandLayout, rng: ReturnType<typeof makeRng>, e: Ellipse, y: number, cover: (x: number, z: number) => number) {
    const area = 4 * e.rx * e.rz * 1.5; // bbox incl. wobble margin
    const tries = Math.ceil(area * MAX_PER_M2);
    for (let i = 0; i < tries; i++) {
      const x = e.x + rng.rr(-1.25, 1.25) * e.rx, z = e.z + rng.rr(-1.25, 1.25) * e.rz;
      const k = cover(x, z);
      if (k <= 0.02 || rng.rnd() > k) continue;
      const tuft = rng.rnd();
      const h = (0.12 + 0.24 * rng.rnd() * rng.rnd() + 0.12 * k) * (tuft < 0.06 ? 1.7 : 1);
      this.blade(isl, x, z, y, rng.rr(0, Math.PI * 2), h, rng.rr(0.035, 0.06), rng.rnd());
    }
  }

  /** Tall grass clump: 20–36 long blades leaning outward from a tight base. */
  private addClump(isl: IslandLayout, rng: ReturnType<typeof makeRng>, cx: number, cz: number, y: number, s: number) {
    const n = Math.round(rng.rr(20, 36) * s);
    for (let i = 0; i < n; i++) {
      const a = rng.rr(0, Math.PI * 2), r = Math.sqrt(rng.rnd()) * 0.22 * s;
      this.blade(isl, cx + Math.cos(a) * r, cz + Math.sin(a) * r, y, rng.rr(0, Math.PI * 2), rng.rr(0.4, 0.95) * s, rng.rr(0.03, 0.05), rng.rr(0.3, 1));
    }
  }

  /** Crack weed: a few short blades. */
  private addTuft(isl: IslandLayout, rng: ReturnType<typeof makeRng>, cx: number, cz: number, y: number) {
    const n = Math.round(rng.rr(5, 12));
    for (let i = 0; i < n; i++) {
      const a = rng.rr(0, Math.PI * 2), r = rng.rr(0, 0.07);
      this.blade(isl, cx + Math.cos(a) * r, cz + Math.sin(a) * r, y, rng.rr(0, Math.PI * 2), rng.rr(0.05, 0.17), rng.rr(0.025, 0.04), rng.rr(0.55, 0.95));
    }
  }

  /** Bucket pending blades into 16 m world cells → one instanced mesh per cell (culled + thinned per cell). */
  private flush() {
    const CELL = 16;
    const cells = new Map<string, number[][]>();
    for (const b of this.pending) {
      const key = `${Math.floor(b[0] / CELL)},${Math.floor(b[2] / CELL)}`;
      let c = cells.get(key);
      if (!c) { c = []; cells.set(key, c); }
      c.push(b);
    }
    let blades = 0;
    for (const list of cells.values()) {
      if (list.length < 8) continue;
      blades += list.length;
      this.pushMesh(list);
    }
    this.pending = [];
    return { blades, cells: this.beds.length };
  }

  private pushMesh(blades: number[][]) {
    blades.sort((a, b) => a[6] - b[6]); // by rank → density cuts drop the tail
    const A = new Float32Array(blades.length * 4), B = new Float32Array(blades.length * 4);
    const box = new THREE.Box3();
    blades.forEach((b, i) => {
      A.set([b[0], b[1], b[2], b[3]], i * 4);
      B.set([b[4], b[5], b[6], b[7]], i * 4);
      box.expandByPoint(new THREE.Vector3(b[0], b[1], b[2]));
    });
    const geo = new THREE.InstancedBufferGeometry();
    const base = bladeGeometry();
    geo.setIndex(base.index);
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('bladeA', new THREE.InstancedBufferAttribute(A, 4));
    geo.setAttribute('bladeB', new THREE.InstancedBufferAttribute(B, 4));
    geo.instanceCount = blades.length;
    box.max.y += 1; box.expandByScalar(0.8);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    geo.boundingSphere = sphere;
    geo.boundingBox = box;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'grass:cell';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.root.add(mesh);
    this.beds.push({ mesh, geo, n: blades.length, center: sphere.center.clone(), radius: sphere.radius });
  }

  private buildMaterial() {
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
    m.name = 'grass';
    const A = attribute('bladeA', 'vec4'), B = attribute('bladeB', 'vec4');
    const root = A.xyz, yaw = A.w, h0 = B.x, w = B.y, rank = B.z, rnd = B.w;
    const t = positionLocal.y, side = positionLocal.x;
    // distance thinning: keep a shrinking fraction of blades with distance; blades at the cut shrink smoothly
    const dist = root.xz.sub(cameraPosition.xz).length();
    const keep = float(1).sub(smoothstep(this.far.mul(0.25), this.far, dist)).pow(1.4);
    const h = h0.mul(smoothstep(0, 0.12, keep.sub(rank)));
    // wind: a travelling gust wave plus per-blade flutter
    const wind = normalize(vec2(1, 0.45));
    const phase = dot(root.xz, wind).mul(0.32).sub(time.mul(1.6));
    const sway = sin(phase).mul(0.5).add(0.55).mul(0.22).add(sin(time.mul(3.3).add(rnd.mul(40))).mul(0.05));
    const lean = vec2(cos(rnd.mul(17)), sin(rnd.mul(17))).mul(rnd.mul(0.25).add(0.05));
    let off = wind.mul(sway).add(lean);
    // players push blades aside and flatten them
    let flat: THREE.Node<'float'> = float(0);
    for (const p of this.pushers) {
      const d = root.xz.sub(p.xz);
      const L = max(d.length(), 0.001);
      const k = float(1).sub(smoothstep(0.25, 0.85, L)).mul(p.w).mul(step(root.y.sub(p.y).abs(), float(1.2)));
      off = off.add(d.div(L).mul(k.mul(0.9)));
      flat = max(flat, k);
    }
    const bendT = t.mul(t);
    const across = vec2(cos(yaw), sin(yaw).negate()).mul(side.mul(w).mul(float(1).sub(t.mul(0.88))));
    const hh = h.mul(float(1).sub(flat.mul(0.55)));
    const p = vec3(root.x.add(across.x).add(off.x.mul(bendT).mul(hh)), root.y.add(t.mul(hh)), root.z.add(across.y).add(off.y.mul(bendT).mul(hh)));
    m.positionNode = p;
    // soft "up" normals: grass reads as a lit mass rather than lots of dark back faces
    m.normalNode = transformNormalToView(vec3(0, 1, 0));
    // colour: dark root → sunlit tip, per-blade hue/dryness variation, a few flowers
    const dark = vec3(0.008, 0.016, 0.004), tipG = vec3(0.07, 0.105, 0.025), dry = vec3(0.2, 0.17, 0.07);
    let tip = mix(tipG, dry, smoothstep(0.78, 0.97, rnd));
    const v = sin(rnd.mul(91)).mul(0.5).add(0.5);
    tip = mix(tip.mul(vec3(0.7, 0.8, 0.6)), tip.mul(vec3(1.3, 1.15, 0.8)), v);
    // clumps: low-frequency darker / lusher patches across the bed
    const clump = sin(root.x.mul(1.7)).mul(sin(root.z.mul(1.3))).mul(0.5).add(0.5);
    tip = tip.mul(mix(float(0.7), float(1.15), clump));
    let col = mix(dark, tip, t.pow(0.7));
    const flower = step(0.975, rnd).mul(smoothstep(0.82, 0.92, t));
    const petal = mix(vec3(0.95, 0.85, 0.2), vec3(0.95, 0.95, 0.92), step(0.988, rnd));
    col = mix(col, petal, flower);
    m.colorNode = col;
    return m;
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality();
  }

  private applyQuality() {
    const p = PRESET[this.quality];
    this.root.visible = p.on;
    this.far.value = p.far;
  }

  /** Per frame: feet of nearby players for blade bending; bed culling + instance count by distance. */
  update(cam: THREE.Vector3, feet: THREE.Vector3[]) {
    if (!this.root.visible) return;
    const p = PRESET[this.quality];
    for (let i = 0; i < MAX_PUSHERS; i++) {
      const f = feet[i];
      if (f) this.pushers[i].value.set(f.x, f.y, f.z, 1);
      else this.pushers[i].value.set(1e6, -100, 1e6, 0);
    }
    for (const b of this.beds) {
      const d = Math.max(0, Math.hypot(b.center.x - cam.x, b.center.z - cam.z) - b.radius);
      const keep = d >= p.far ? 0 : Math.pow(1 - Math.max(0, (d - p.far * 0.25) / (p.far * 0.75)), 1.4);
      const n = Math.ceil(b.n * Math.min(p.density * this.densityScale, keep + 0.05));
      b.mesh.visible = n > 0 && keep > 0;
      b.geo.instanceCount = Math.min(b.n, n);
    }
  }
}
