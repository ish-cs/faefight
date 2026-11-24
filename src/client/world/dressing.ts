import * as THREE from 'three/webgpu';
import { abs, attribute, float, instanceIndex, mix, positionGeometry, positionLocal, sin, smoothstep, step, time, vec3 } from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import { BACKDROP_DECOR, type Clutter, type Ellipse, ISLAND_DECOR } from './decor';
import { mat, StaticBatch } from './geo';
import { timeDisplaced } from './velocity';
import { mats } from './materials';
import { makeRng } from './textures';

type Rng = ReturnType<typeof makeRng>;
const at = (B: THREE.Matrix4, L: THREE.Matrix4) => B.clone().multiply(L);

/** Lumpy boulder (unit size), a few variants shared by every rock. */
const boulders = Array.from({ length: 4 }, (_, v) => {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.getAttribute('position');
  const ph = v * 1.7;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let k = 1 + 0.22 * Math.sin(x * 2.3 + ph) * Math.cos(z * 2.9 - ph) + 0.1 * Math.sin(y * 5.1 + x * 3.7 + ph * 2);
    k *= y < -0.3 ? 0.85 : 1; // flatter underside
    p.setXYZ(i, x * k, y * k * 0.72, z * k);
  }
  g.computeVertexNormals();
  return g;
});

/** Low-poly pebble variants (20 tris) — dozens per bed, so keep them cheap. */
const pebbleGeos = Array.from({ length: 4 }, (_, v) => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.25 * Math.sin(x * 3.1 + v * 2.3) * Math.cos(z * 2.7 + v);
    p.setXYZ(i, x * k * (1 + 0.2 * (v % 2)), y * k * 0.55, z * k);
  }
  g.computeVertexNormals();
  return g;
});

/** Scatter pebbles in a band around an ellipse (local frame `B`, ground at y = 0). */
function pebbleFringe(b: StaticBatch, B: THREE.Matrix4, e: Ellipse, rng: Rng, n: number, r0 = 0.92, r1 = 1.28) {
  for (let i = 0; i < n; i++) {
    const a = rng.rr(0, Math.PI * 2), r = rng.rr(r0, r1);
    const s = rng.rr(0.018, 0.045) * (rng.rnd() < 0.08 ? 1.8 : 1);
    b.add(mats().gravel, pebbleGeos[i % 4], at(B, mat(e.x + Math.cos(a) * e.rx * r, s * 0.2, e.z + Math.sin(a) * e.rz * r, 0, rng.rr(0, 6), 0, s, s, s)),
      new THREE.Color().setHSL(0.08, 0.04, rng.rr(0.55, 1)), false, true);
  }
}

/** Flat noisy-outline gravel patch lying on a surface at local y = 0. */
function gravelPatch(b: StaticBatch, B: THREE.Matrix4, e: Ellipse, rng: Rng) {
  const ph = rng.rr(0, 6), pts: THREE.Vector2[] = [];
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    const r = 1 + 0.18 * Math.sin(a * 3 + ph) + 0.08 * Math.sin(a * 7 + ph * 2) + rng.rr(-0.03, 0.03);
    pts.push(new THREE.Vector2(e.x + Math.cos(a) * e.rx * r, -(e.z + Math.sin(a) * e.rz * r)));
  }
  b.add(mats().gravel, new THREE.ShapeGeometry(new THREE.Shape(pts)).rotateX(-Math.PI / 2), at(B, mat(0, 0.012, 0)), 0xffffff, false, true);
  pebbleFringe(b, B, e, rng, Math.round((e.rx + e.rz) * 9), 0.95, 1.2);
}

function rock(b: StaticBatch, B: THREE.Matrix4, rng: Rng, s: number) {
  const g = boulders[Math.floor(rng.rnd() * boulders.length)];
  b.add(mats().rock, g, at(B, mat(0, 0, 0, rng.rr(-0.3, 0.3), rng.rr(0, 6), rng.rr(-0.3, 0.3), s * rng.rr(0.8, 1.3), s * rng.rr(0.6, 1), s * rng.rr(0.8, 1.3))), new THREE.Color().setHSL(0.08, 0.1, rng.rr(0.65, 0.95)), true, true);
}

/** Riprap cluster at the foot of a quay wall: boulders half in the water, `B` at water level, local +Z = outward. */
function riprap(b: StaticBatch, B: THREE.Matrix4, rng: Rng, span: number) {
  const n = Math.max(3, Math.round(span * 1.4));
  for (let i = 0; i < n; i++) {
    const s = rng.rr(0.45, 1.1);
    rock(b, at(B, mat(rng.rr(-span / 2, span / 2), MAP.waterY + rng.rr(-0.35, 0.15) * s, rng.rr(0.3, 1.9))), rng, s);
  }
}

// ---------------------------------------------------------------- clutter

function clutter(b: StaticBatch, B: THREE.Matrix4, c: Clutter, rng: Rng) {
  const M = mats();
  const T = at(B, mat(0, 0, 0, 0, c.yaw ?? rng.rr(0, 6), 0, c.s ?? 1, c.s ?? 1, c.s ?? 1));
  switch (c.kind) {
    case 'ropeCoil': {
      for (let k = 0; k < 4; k++) b.add(M.burlap, new THREE.TorusGeometry(0.3 - k * 0.012, 0.035, 6, 20).rotateX(Math.PI / 2), at(T, mat(rng.rr(-0.02, 0.02), 0.035 + k * 0.06, rng.rr(-0.02, 0.02))), 0xb7a27a);
      b.add(M.burlap, new THREE.CylinderGeometry(0.03, 0.03, 0.8, 5).rotateZ(Math.PI / 2), at(T, mat(0.6, 0.03, 0.15, 0, 0.4, 0)), 0xb7a27a, false);
      break;
    }
    case 'tyre':
      b.add(M.rubber, new THREE.TorusGeometry(0.36, 0.13, 8, 18).rotateX(Math.PI / 2), at(T, mat(0, 0.13, 0)), 0xffffff);
      break;
    case 'buoy':
      b.add(M.paint, new THREE.SphereGeometry(0.32, 14, 10), at(T, mat(0, 0.32, 0)), rng.rnd() < 0.5 ? 0xd8501f : 0xe8e2d0);
      b.add(M.dark, new THREE.TorusGeometry(0.08, 0.02, 5, 10), at(T, mat(0, 0.66, 0)));
      break;
    case 'net': {
      const g = new THREE.SphereGeometry(0.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * (0.45 + 0.25 * Math.sin(p.getX(i) * 7 + p.getZ(i) * 5)));
      g.computeVertexNormals();
      b.add(M.burlap, g, at(T, mat(0, 0, 0, 0, 0, 0, 1.3, 1, 1)), 0x3f6a58);
      for (let k = 0; k < 4; k++) b.add(M.paint, new THREE.SphereGeometry(0.07, 8, 6), at(T, mat(rng.rr(-0.6, 0.6), 0.22, rng.rr(-0.4, 0.4))), 0xe0a020);
      break;
    }
    case 'crate':
      b.add(M.wood, new THREE.BoxGeometry(1, 0.8, 0.8), at(T, mat(0, 0.4, 0)), 0xd8c8a8);
      b.add(M.wood, new THREE.BoxGeometry(0.7, 0.55, 0.6), at(T, mat(0.1, 1.08, 0.05, 0, 0.3, 0)), 0xc8b898);
      break;
    case 'cone':
      b.add(M.paint, new THREE.ConeGeometry(0.17, 0.62, 12), at(T, mat(0, 0.33, 0)), 0xf0601c);
      b.add(M.matte, new THREE.CylinderGeometry(0.115, 0.135, 0.08, 12), at(T, mat(0, 0.28, 0)), 0xf2f2f0, false);
      b.add(M.rubber, new THREE.BoxGeometry(0.42, 0.04, 0.42), at(T, mat(0, 0.02, 0)), 0xffffff);
      break;
    case 'pebbles':
      for (let k = 0; k < 14; k++) {
        const s = rng.rr(0.03, 0.09);
        b.add(M.rock, pebbleGeos[k % 4], at(T, mat(rng.rr(-0.7, 0.7), s * 0.3, rng.rr(-0.6, 0.6), 0, rng.rr(0, 6), 0, s, s, s)), new THREE.Color().setHSL(0.08, 0.08, rng.rr(0.6, 1.1)), false, true);
      }
      break;
    case 'shrub': {
      const cols = [0x2d5a22, 0x3a6a2a, 0x24491c];
      for (let k = 0; k < 6; k++) {
        const s = rng.rr(0.25, 0.45);
        b.add(M.leaf, boulders[k % 4], at(T, mat(rng.rr(-0.35, 0.35), s * 0.55, rng.rr(-0.35, 0.35), 0, rng.rr(0, 6), 0, s * 1.2, s, s * 1.2)), cols[k % 3]);
      }
      break;
    }
    case 'flowers': {
      const petals = [0xf2d23a, 0xe85a8a, 0xf4f0e8, 0xe0702a];
      for (let k = 0; k < 18; k++) {
        const x = rng.rr(-0.6, 0.6), z = rng.rr(-0.5, 0.5), h = rng.rr(0.18, 0.34);
        b.add(M.matte, new THREE.CylinderGeometry(0.006, 0.008, h, 3), at(T, mat(x, h / 2, z)), 0x3c6a24, false);
        b.add(M.matte, new THREE.IcosahedronGeometry(0.035, 0), at(T, mat(x, h, z, 0, 0, 0, 1, 0.5, 1)), petals[k % 4], false);
      }
      break;
    }
    case 'litter': break; // painted into the ground overlay
  }
}

/** Island dressing: riprap at the wall foot (outside the disc) + low clutter from ISLAND_DECOR. `L` = island frame. */
export function dressIsland(b: StaticBatch, L: THREE.Matrix4, isl: IslandLayout) {
  const rng = makeRng(5150 + isl.index * 37);
  for (const a of ISLAND_DECOR.riprap) {
    // frame at the wall foot facing outward (+Z)
    const F = at(L, mat(Math.sin(a) * isl.radius, 0, Math.cos(a) * isl.radius, 0, a, 0));
    riprap(b, F, rng, rng.rr(3, 6));
  }
  for (const c of ISLAND_DECOR.clutter) clutter(b, at(L, mat(c.x, isl.groundY, c.z)), c, rng);
  // pebbles where the concrete meets sand / gravel
  const G = at(L, mat(0, isl.groundY, 0));
  for (const e of ISLAND_DECOR.sandBeds) pebbleFringe(b, G, e, rng, Math.round((e.rx + e.rz) * 9), 0.9, 1.12);
  for (const e of ISLAND_DECOR.gravel) pebbleFringe(b, G, e, rng, Math.round((e.rx + e.rz) * 3), 0.95, 1.08);
}

/** Backdrop quay dressing; `at` maps backdrop-local (x, y, z) to world (same frame as islands.ts buildBackdrop). */
export function dressBackdrop(b: StaticBatch, atF: (x: number, y: number, z: number, ry?: number) => THREE.Matrix4, hw: number, z0: number, top: number, rng: Rng) {
  for (const [x0, x1] of BACKDROP_DECOR.riprap) {
    const span = (x1 - x0) * hw, cx = ((x0 + x1) / 2) * hw;
    riprap(b, atF(cx, 0, z0, Math.PI), rng, span);
  }
  for (const c of BACKDROP_DECOR.clutter) clutter(b, atF(c.x * hw, top, z0 + c.z), c, rng);
  const G = atF(0, top, 0);
  for (const e of BACKDROP_DECOR.gravel) gravelPatch(b, G, { x: e.x * hw, z: z0 + e.z, rx: e.rx, rz: e.rz }, rng);
}

// ---------------------------------------------------------------- animated: boats + gulls

/** A few small boats at anchor in the outer harbor, gently pitching/rolling. */
export class Boats {
  readonly root = new THREE.Group();
  private boats: { g: THREE.Group; ph: number; y: number }[] = [];
  constructor(map: IslandLayout[]) {
    this.root.name = 'boats';
    const rng = makeRng(9091);
    const ring = Math.hypot(map[0].center.x, map[0].center.z);
    const M = mats();
    const N = 6;
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5) / N) * Math.PI * 2 + rng.rr(-0.2, 0.2);
      const d = ring + rng.rr(140, 300);
      const b = new StaticBatch();
      const L = rng.rr(7, 13), W = L * 0.32;
      const hull = new THREE.CylinderGeometry(W / 2, W / 2.6, L, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
      const hullCol = [0xe8e6e0, 0x1f4e79, 0xb23a26, 0x2a7f86][i % 4];
      b.add(M.paint, hull.rotateX(Math.PI), mat(0, 0.35, 0, 0, 0, 0, 1, 0.7, 1), hullCol);
      b.add(M.wood, new THREE.BoxGeometry(W * 0.9, 0.08, L * 0.92), mat(0, 0.36, 0), 0xc8b090);
      b.add(M.paint, new THREE.BoxGeometry(W * 0.7, 1.1, L * 0.3), mat(0, 0.95, -L * 0.08), 0xf0eee8);
      b.add(M.dark, new THREE.BoxGeometry(W * 0.72, 0.3, L * 0.02), mat(0, 1.2, -L * 0.23), 0x6a8090);
      if (i % 2 === 0) b.add(M.galv, new THREE.CylinderGeometry(0.06, 0.08, L * 0.8, 6), mat(0, L * 0.4 + 0.4, L * 0.12));
      const g = new THREE.Group();
      b.build(g, `boat${i}`);
      for (const c of g.children) (c as THREE.Mesh).castShadow = false;
      g.position.set(Math.cos(a) * d, MAP.waterY, Math.sin(a) * d);
      g.rotation.y = rng.rr(0, 6);
      this.root.add(g);
      this.boats.push({ g, ph: rng.rr(0, 6), y: MAP.waterY });
    }
  }
  update(t: number, waterY: number) {
    for (const b of this.boats) {
      b.g.position.y = waterY + Math.sin(t * 0.9 + b.ph) * 0.12;
      b.g.rotation.x = Math.sin(t * 0.7 + b.ph) * 0.03;
      b.g.rotation.z = Math.sin(t * 0.55 + b.ph * 1.3) * 0.05;
    }
  }
}

/** Where gulls sit: harbor bollards, warehouse ridges, light masts, island rim bollards (world space). */
export function gullPerches(map: IslandLayout[], backdrop: (isl: IslandLayout) => { hw: number; z0: number; top: number }) {
  const out: { p: THREE.Vector3; yaw: number; roof: boolean; stay?: boolean }[] = [];
  const rng = makeRng(4477);
  for (const isl of map) {
    const c = Math.cos(isl.bunker.facingYaw), s = Math.sin(isl.bunker.facingYaw);
    const W = (x: number, y: number, z: number) => new THREE.Vector3(isl.center.x + x * c + z * s, y, isl.center.z - x * s + z * c);
    const { hw, z0, top } = backdrop(isl);
    const yaw = isl.bunker.facingYaw;
    // quay bollards (islands.ts buildBackdrop: x = -hw + 3 + 7k at z0 + 0.6, head ≈ 0.5 m)
    for (let x = -hw + 3, k = 0; x < hw - 1; x += 7, k++) if (k % 3 === 1) out.push({ p: W(x, top + 0.46, z0 + 0.6), yaw: yaw + Math.PI + rng.rr(-0.8, 0.8), roof: false });
    // warehouse ridge (30 m long at x = -0.38 hw, z0 + 24; ridge ≈ 12 m)
    for (let k = 0; k < 4; k++) out.push({ p: W(-hw * 0.38 + rng.rr(-13, 13), top + 10 + Math.tan(0.22) * 9 + 0.12, z0 + 24), yaw: yaw + rng.rr(-0.4, 0.4) + (k % 2) * Math.PI, roof: true });
    // light-mast heads
    out.push({ p: W(-hw * 0.7, top + 18.5, z0 + 4), yaw: yaw + Math.PI, roof: true });
    // island rim bollards (islands.ts: 14 around the coping at R - 0.45)
    for (const k of [2, 9]) {
      const a = ((k + 0.5) / 14) * Math.PI * 2;
      out.push({ p: W(Math.sin(a) * (isl.radius - 0.45), isl.groundY + 0.46, Math.cos(a) * (isl.radius - 0.45)), yaw: a + rng.rr(-0.5, 0.5), roof: false, stay: k === 2 });
    }
  }
  return out;
}

type Gull = {
  cx: number; cz: number; r: number; y: number; w: number; ph: number;
  /** sitters: perched forever (head-bob only); landers: circle, glide down to the perch, sit, take off */
  perch?: { p: THREE.Vector3; yaw: number }; mode: 'fly' | 'sit' | 'land'; period: number; off: number;
  last: THREE.Vector3; yaw: number;
};

/**
 * Gulls: flocks circling over the harbor and channels, a few cycling between circling and landing on bollards /
 * roofs, and some just sitting. One instanced mesh (~80 birds); wings flap in the vertex shader scaled by a
 * per-instance flap amount (0 = folded), transforms are a handful of matrices on the CPU.
 */
export class Gulls {
  /** flying gulls (perched ones are a child mesh with folded wings) */
  readonly mesh: THREE.InstancedMesh;
  private perched: THREE.InstancedMesh;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private birds: Gull[] = [];
  private flap: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private c = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(map: IslandLayout[], perches: { p: THREE.Vector3; yaw: number; roof: boolean; stay?: boolean }[]) {
    const g = new THREE.BufferGeometry();
    // diamond body, pyramid head + beak, two swept wings (x = span), tail fan; nose toward -Z
    const P = [
      0, 0.03, -0.26, 0, 0.03, 0.3, 0, 0.1, 0, 0, -0.05, 0, -0.075, 0.03, 0, 0.075, 0.03, 0, // 0-5 body
      0.05, 0.05, -0.06, 0.75, 0.08, 0.08, 0.05, 0.05, 0.12, // 6-8 right wing
      -0.05, 0.05, -0.06, -0.05, 0.05, 0.12, -0.75, 0.08, 0.08, // 9-11 left wing
      0, 0.14, -0.25, -0.045, 0.05, -0.22, 0.045, 0.05, -0.22, 0, 0.065, -0.4, 0, 0.09, -0.12, // 12-16 head
      0, 0.03, 0.2, 0.07, 0.04, 0.36, -0.07, 0.04, 0.36, // 17-19 tail
    ];
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex([
      0, 2, 5, 0, 4, 2, 0, 5, 3, 0, 3, 4, 1, 5, 2, 1, 2, 4, 1, 3, 5, 1, 4, 3,
      6, 7, 8, 9, 10, 11,
      12, 13, 15, 12, 15, 14, 12, 14, 16, 12, 16, 13, 13, 15, 14, 13, 14, 16,
      17, 18, 19,
    ]);
    g.computeVertexNormals();
    const rng = makeRng(3131);
    const ring = Math.hypot(map[0].center.x, map[0].center.z);
    const fresh = (): Omit<Gull, 'cx' | 'cz' | 'r' | 'y' | 'w' | 'ph' | 'mode'> => ({ period: 1, off: 0, last: new THREE.Vector3(), yaw: 0 });
    // flocks over each channel between islands + two big wheels over the middle
    const flocks: [number, number, number][] = map.map((isl, i) => {
      const nx = map[(i + 1) % map.length];
      return [(isl.center.x + nx.center.x) / 2, (isl.center.z + nx.center.z) / 2, 5];
    });
    flocks.push([0, 0, 8]);
    for (const [fx, fz, n] of flocks) for (let k = 0; k < n; k++) {
      this.birds.push({ cx: fx + rng.rr(-10, 10), cz: fz + rng.rr(-10, 10), r: rng.rr(10, 24), y: rng.rr(10, 24), w: rng.rr(0.16, 0.3) * (rng.rnd() < 0.5 ? -1 : 1), ph: rng.rr(0, 6), mode: 'fly', ...fresh() });
    }
    // a low flock over the water behind every island, hanging around the quay (seen from the island)
    for (const isl of map) {
      const sy = Math.sin(isl.bunker.facingYaw), cy = Math.cos(isl.bunker.facingYaw);
      const fx = isl.center.x + sy * (isl.radius + 7), fz = isl.center.z + cy * (isl.radius + 7);
      for (let k = 0; k < 4; k++) this.birds.push({ cx: fx + rng.rr(-4, 4), cz: fz + rng.rr(-4, 4), r: rng.rr(6, 13), y: rng.rr(6, 13), w: rng.rr(0.25, 0.4) * (k % 2 ? -1 : 1), ph: rng.rr(0, 6), mode: 'fly', ...fresh() });
    }
    // perched: roofs mostly just sit; bollard birds land and take off again on a loop
    perches.forEach((pc, i) => {
      const lander = !pc.stay && (!pc.roof || i % 5 === 0);
      this.birds.push({
        cx: pc.p.x + rng.rr(-14, 14), cz: pc.p.z + rng.rr(-14, 14), r: rng.rr(8, 14), y: pc.p.y + rng.rr(8, 16), w: rng.rr(0.25, 0.4) * (rng.rnd() < 0.5 ? -1 : 1), ph: rng.rr(0, 6),
        mode: lander ? 'land' : 'sit', perch: { p: pc.p, yaw: pc.yaw }, ...fresh(), period: rng.rr(40, 70), off: rng.rr(0, 70), yaw: pc.yaw,
      });
    });
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(this.birds.length), 1);
    this.flap.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('gullFlap', this.flap);

    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    m.name = 'gull';
    const span = abs(positionGeometry.x);
    const amt = attribute('gullFlap', 'float');
    // wing beat: fast, so last frame's pose goes into the motion vectors as well (velocity.ts)
    timeDisplaced(m, (t) => positionLocal.add(vec3(0, sin(t.mul(9).add(float(instanceIndex).mul(1.7))).mul(span).mul(0.55).mul(amt), 0)));
    // white body, grey mantle, black wingtips, yellow beak
    let col = mix(vec3(0.92, 0.92, 0.9), vec3(0.55, 0.58, 0.62), smoothstep(0.12, 0.25, span));
    col = mix(col, vec3(0.1, 0.1, 0.11), smoothstep(0.5, 0.68, span));
    m.colorNode = mix(col, vec3(0.9, 0.7, 0.15), step(positionGeometry.z, -0.33));
    this.mesh = new THREE.InstancedMesh(g, m, this.birds.length);
    this.mesh.name = 'gulls';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    // perched birds: same body, wings folded back along the flanks (wingtips over the tail)
    const gs = new THREE.BufferGeometry();
    const PS = P.slice();
    PS.splice(7 * 3, 3, 0.085, 0.085, 0.4);
    PS.splice(11 * 3, 3, -0.085, 0.085, 0.4);
    PS.splice(6 * 3, 3, 0.08, 0.07, -0.1);
    PS.splice(9 * 3, 3, -0.08, 0.07, -0.1);
    gs.setAttribute('position', new THREE.Float32BufferAttribute(PS, 3));
    gs.setIndex(g.getIndex());
    gs.computeVertexNormals();
    const ms = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    ms.name = 'gullPerched';
    const pz = positionGeometry.z, py = positionGeometry.y;
    let cs = mix(vec3(0.92, 0.92, 0.9), vec3(0.55, 0.58, 0.62), step(0.065, py).mul(step(-0.12, pz)).mul(step(0.03, abs(positionGeometry.x))));
    cs = mix(cs, vec3(0.1, 0.1, 0.11), step(0.3, pz).mul(step(0.06, py)));
    ms.colorNode = mix(cs, vec3(0.9, 0.7, 0.15), step(pz, -0.33));
    this.perched = new THREE.InstancedMesh(gs, ms, this.birds.length);
    this.perched.name = 'gulls:perched';
    this.perched.frustumCulled = false;
    this.perched.castShadow = true;
    this.mesh.add(this.perched);
    this.update(0);
  }

  private circle(b: Gull, t: number, out: THREE.Vector3) {
    const a = b.ph + t * b.w;
    return out.set(b.cx + Math.cos(a) * b.r, b.y + Math.sin(t * 0.4 + b.ph) * 1.2, b.cz + Math.sin(a) * b.r);
  }

  update(t: number) {
    this.birds.forEach((b, i) => {
      let flap = 1, bank = -Math.sign(b.w) * 0.35, sx = 1, pitch = 0;
      if (b.mode === 'sit' && b.perch) {
        this.v.copy(b.perch.p).setY(b.perch.p.y + 0.02);
        b.yaw = b.perch.yaw + Math.sin(t * 0.3 + b.ph) * 0.3 * Math.max(0, Math.sin(t * 0.13 + b.ph * 3)); // looks around
        flap = 0; bank = 0; sx = 0.16;
      } else if (b.mode === 'land' && b.perch) {
        const u = ((t + b.off) % b.period) / b.period;
        const C = this.circle(b, t, this.c);
        if (u < 0.4) this.v.copy(C);
        else if (u < 0.5) { // glide in
          const k = (u - 0.4) / 0.1, e = k * k * (3 - 2 * k);
          this.v.lerpVectors(C, b.perch.p, e);
          flap = k > 0.85 ? 1 : 0.15; bank = 0; pitch = -0.25 * (1 - e);
        } else if (u < 0.93) { // perched
          this.v.copy(b.perch.p).setY(b.perch.p.y + 0.02);
          flap = 0; bank = 0; sx = 0.16;
        } else { // take off
          const k = (u - 0.93) / 0.07, e = k * k * (3 - 2 * k);
          this.v.lerpVectors(b.perch.p, C, e);
          bank = 0; pitch = 0.3 * (1 - e);
        }
      } else this.circle(b, t, this.v);
      // heading from motion
      const dx = this.v.x - b.last.x, dz = this.v.z - b.last.z;
      if (dx * dx + dz * dz > 1e-6 && flap > 0) b.yaw = Math.atan2(-dx, -dz);
      else if (b.mode === 'land' && sx < 1 && b.perch) b.yaw = b.perch.yaw;
      b.last.copy(this.v);
      this.e.set(pitch, b.yaw, bank, 'YXZ');
      this.q.setFromEuler(this.e);
      const sitting = sx < 1;
      // perched: stockier (a sitting gull is short and round; the flight shape is long and flat)
      this.m.compose(this.v, this.q, sitting ? this.s.set(1.15, 1.9, 0.78) : this.s.set(1.1, 1.1, 1.1));
      this.mesh.setMatrixAt(i, sitting ? this.zero : this.m);
      this.perched.setMatrixAt(i, sitting ? this.m : this.zero);
      this.flap.setX(i, flap);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.perched.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }
}
