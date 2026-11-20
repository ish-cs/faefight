import * as THREE from 'three/webgpu';
import { abs, float, instanceIndex, mix, positionGeometry, positionLocal, sin, smoothstep, time, vec3 } from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import { BACKDROP_DECOR, type Clutter, ISLAND_DECOR } from './decor';
import { mat, StaticBatch } from './geo';
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
        b.add(M.rock, boulders[k % 4], at(T, mat(rng.rr(-0.7, 0.7), s * 0.3, rng.rr(-0.6, 0.6), 0, rng.rr(0, 6), 0, s, s, s)), new THREE.Color().setHSL(0.08, 0.08, rng.rr(0.6, 1.1)), false, true);
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
}

/** Backdrop quay dressing; `at` maps backdrop-local (x, y, z) to world (same frame as islands.ts buildBackdrop). */
export function dressBackdrop(b: StaticBatch, atF: (x: number, y: number, z: number, ry?: number) => THREE.Matrix4, hw: number, z0: number, top: number, rng: Rng) {
  for (const [x0, x1] of BACKDROP_DECOR.riprap) {
    const span = (x1 - x0) * hw, cx = ((x0 + x1) / 2) * hw;
    riprap(b, atF(cx, 0, z0, Math.PI), rng, span);
  }
  for (const c of BACKDROP_DECOR.clutter) clutter(b, atF(c.x * hw, top, z0 + c.z), c, rng);
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

/** Gull flocks circling the harbor: one instanced mesh, wings flap in the vertex shader. */
export class Gulls {
  readonly mesh: THREE.InstancedMesh;
  private birds: { cx: number; cz: number; r: number; y: number; w: number; ph: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(map: IslandLayout[]) {
    const g = new THREE.BufferGeometry();
    // body + two swept wings (x = span), nose toward -Z
    const P = [
      0, 0, -0.35, 0.07, 0, 0.1, -0.07, 0, 0.1, 0, 0.06, 0.05, // body (two tris)
      0.06, 0, -0.05, 0.75, 0.06, 0.08, 0.06, 0, 0.12, // right wing
      -0.06, 0, -0.05, -0.06, 0, 0.12, -0.75, 0.06, 0.08, // left wing
    ];
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex([0, 1, 2, 0, 3, 1, 0, 2, 3, 4, 5, 6, 7, 8, 9]);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xe9e9e4, roughness: 0.8, side: THREE.DoubleSide });
    m.name = 'gull';
    const span = abs(positionGeometry.x);
    const flap = sin(time.mul(9).add(float(instanceIndex).mul(1.7))).mul(span).mul(0.55);
    m.positionNode = positionLocal.add(vec3(0, flap, 0));
    m.colorNode = mix(vec3(0.92, 0.92, 0.9), vec3(0.18, 0.18, 0.2), smoothstep(0.45, 0.7, span));
    const rng = makeRng(3131);
    const ring = Math.hypot(map[0].center.x, map[0].center.z);
    const flocks = 4;
    for (let f = 0; f < flocks; f++) {
      const a = (f / flocks) * Math.PI * 2 + 0.6;
      const cx = Math.cos(a) * ring * 1.1, cz = Math.sin(a) * ring * 1.1;
      for (let k = 0; k < 6; k++) this.birds.push({ cx: cx + rng.rr(-8, 8), cz: cz + rng.rr(-8, 8), r: rng.rr(14, 30), y: rng.rr(18, 34), w: rng.rr(0.18, 0.32) * (rng.rnd() < 0.5 ? -1 : 1), ph: rng.rr(0, 6) });
    }
    this.mesh = new THREE.InstancedMesh(g, m, this.birds.length);
    this.mesh.name = 'gulls';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  update(t: number) {
    this.birds.forEach((b, i) => {
      const a = b.ph + t * b.w;
      this.v.set(b.cx + Math.cos(a) * b.r, b.y + Math.sin(t * 0.4 + b.ph) * 1.5, b.cz + Math.sin(a) * b.r);
      // heading along the circle tangent, banked into the turn
      const yaw = Math.atan2(-(-Math.sin(a) * b.w), -(Math.cos(a) * b.w));
      this.e.set(0, yaw, -Math.sign(b.w) * 0.35, 'YXZ');
      this.q.setFromEuler(this.e);
      this.mesh.setMatrixAt(i, this.m.compose(this.v, this.q, this.s.setScalar(1.3)));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
