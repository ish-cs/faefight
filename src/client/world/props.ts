import * as THREE from 'three/webgpu';
import { boxUV, mat, StaticBatch, strut } from './geo';
import { CONTAINER_COLORS, mats } from './materials';
import { makeRng, signTex } from './textures';

type Rng = ReturnType<typeof makeRng>;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r: number, h: number, s = 12) => new THREE.CylinderGeometry(r, r, h, s);
/** base * local */
const at = (B: THREE.Matrix4, L: THREE.Matrix4) => B.clone().multiply(L);

// ---------------------------------------------------------------- harbor backdrop props

/** 20 ft container (6.06 × 2.59 × 2.44), base at local origin, long axis along X, doors at +X. */
export function container(b: StaticBatch, B: THREE.Matrix4, col: number) {
  const M = mats();
  const L = 6.06, H = 2.59, D = 2.44;
  b.add(M.corr, boxUV(L - 0.1, H - 0.12, D - 0.06, 7.8), at(B, mat(0, H / 2, 0)), col);
  const c = new THREE.Color(col).multiplyScalar(0.55);
  // frame rails + corner posts
  for (const y of [0.06, H - 0.06]) for (const z of [-D / 2 + 0.05, D / 2 - 0.05]) b.add(M.paint, box(L, 0.12, 0.1), at(B, mat(0, y, z)), c);
  for (const x of [-L / 2 + 0.06, L / 2 - 0.06]) for (const z of [-D / 2 + 0.06, D / 2 - 0.06]) b.add(M.paint, box(0.13, H, 0.13), at(B, mat(x, H / 2, z)), c);
  // door locking bars
  for (const z of [-0.85, -0.35, 0.35, 0.85]) b.add(M.galv, cyl(0.025, H - 0.3, 6), at(B, mat(L / 2 + 0.03, H / 2, z)), 0x9aa0a4, false);
}

export function containerStack(b: StaticBatch, B: THREE.Matrix4, heights: number[], rng: Rng, spacing = 2.6) {
  heights.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      const col = CONTAINER_COLORS[Math.floor(rng.rnd() * CONTAINER_COLORS.length)];
      container(b, at(B, mat(rng.rr(-0.06, 0.06), k * 2.59, i * spacing, 0, rng.rr(-0.012, 0.012), 0)), col);
    }
  });
}

const frondGeo = (() => {
  const N = 14, L = 3.6, positions: number[] = [], uvs: number[] = [], idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, s = t * L, up = s * 0.55 - s * s * 0.17, hw = 0.75;
    for (let j = 0; j < 3; j++) {
      const u = j / 2, xw = (u - 0.5) * 2 * hw;
      positions.push(s, up - Math.abs(xw) * 0.28, xw); uvs.push(u, t);
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < 2; j++) { const a = i * 3 + j; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
})();

export function palm(b: StaticBatch, B: THREE.Matrix4, rng: Rng, h = 9, lean = 2) {
  const M = mats();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(V(lean * t * t, t * h, 0)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = new THREE.TubeGeometry(curve, 16, 0.17, 8);
  const pos = tube.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / h, c = curve.getPoint(Math.min(1, Math.max(0, t))), k = 1.25 - 0.45 * t;
    pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * k, pos.getY(i), c.z + (pos.getZ(i) - c.z) * k);
  }
  tube.computeVertexNormals();
  const uv = tube.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * h * 0.6, uv.getY(i) * 2); // bark rings along the trunk
  b.add(M.bark, tube, B);
  const top = curve.getPoint(1);
  const n = 13;
  for (let k = 0; k < n; k++) {
    const s = rng.rr(0.85, 1.1);
    b.add(M.frond, frondGeo, at(B, mat(top.x, top.y, top.z, 0, (k / n) * Math.PI * 2 + rng.rr(-0.2, 0.2), rng.rr(-0.35, 0.25), s, s, s, 'YZX')),
      new THREE.Color().setHSL(0.22 + rng.rr(-0.03, 0.03), 0.5, rng.rr(0.45, 0.6)));
  }
  for (let k = 0; k < 4; k++) b.add(M.matte, new THREE.SphereGeometry(0.13, 8, 6), at(B, mat(top.x + rng.rr(-0.2, 0.2), top.y - 0.25, top.z + rng.rr(-0.2, 0.2))), 0x4b3a1f);
}

/** Ship-to-shore gantry crane. Legs straddle local origin; boom reaches toward local -Z by `out` metres. */
export function crane(b: StaticBatch, B: THREE.Matrix4, out = 30) {
  const M = mats();
  const red = 0xc9461f, white = 0xe9e6de;
  const LH = 28, gx = 8, gz = 8;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.add(M.paint, box(1.1, LH, 1.1), at(B, mat(sx * gx, LH / 2, sz * gz)), red);
    b.add(M.dark, box(1.6, 1.0, 2.2), at(B, mat(sx * gx, 0.5, sz * gz)), 0xffffff); // bogie
  }
  for (const sx of [-1, 1]) {
    b.add(M.paint, box(1.2, 1.4, 2 * gz + 1.2), at(B, mat(sx * gx, LH, 0)), red);
    b.add(M.paint, box(1, 1, 2 * gz), at(B, mat(sx * gx, 10, 0)), red);
    b.add(M.paint, box(0.5, Math.hypot(2 * gz, LH - 12), 0.5), at(B, mat(sx * gx, (LH + 10) / 2, 0, Math.atan2(2 * gz, LH - 12))), red);
  }
  for (const sz of [-1, 1]) b.add(M.paint, box(2 * gx + 1, 1.4, 1.1), at(B, mat(0, LH, sz * gz)), red);
  const back = 18, len = out + gz + back;
  b.add(M.paint, box(3, 2.2, len), at(B, mat(0, LH + 3, (back - out - gz) / 2 + 0)), white);
  b.add(M.paint, box(8, 4.5, 7), at(B, mat(0, LH + 1.8, gz + 4)), white); // machinery house (landward)
  b.add(M.paint, box(4, 2.5, 3.5), at(B, mat(-2.5, LH + 0.3, -gz - 1)), white); // cab
  b.add(M.dark, box(3.6, 0.8, 0.05), at(B, mat(-2.5, LH + 0.6, -gz - 2.78)), 0x99bbcc);
  for (const sx of [-1, 1]) b.add(M.paint, box(0.7, 14, 0.7), at(B, mat(sx * 2, LH + 10, 0, 0, 0, -sx * 0.12)), red);
  const apex = V(0, LH + 16.5, 0);
  for (const end of [V(0, LH + 4, -out * 0.95), V(0, LH + 4, -out * 0.5), V(0, LH + 4, gz + 10)]) b.add(M.dark, strut(apex, end, 0.12, 6), B);
  // trolley + spreader hanging over the water
  b.add(M.paint, box(3.4, 1.4, 3), at(B, mat(0, LH + 1.4, -out * 0.7)), 0xd9d6cc);
  for (const sx of [-1, 1]) b.add(M.dark, strut(V(sx * 0.8, LH + 1, -out * 0.7), V(sx * 0.8, LH - 9, -out * 0.7), 0.04, 4), B);
  b.add(M.paint, box(2.6, 0.4, 6), at(B, mat(0, LH - 9.2, -out * 0.7, 0, Math.PI / 2, 0)), 0xe8b81c);
}

export function warehouse(b: StaticBatch, B: THREE.Matrix4, sign: string) {
  const M = mats();
  const W = 30, H = 10, D = 18;
  b.add(M.corr, boxUV(W, H, D, 7.8), at(B, mat(0, H / 2, 0)), 0xb9c3c8);
  for (const s of [-1, 1]) {
    const pitch = 0.22, run = D / 2 / Math.cos(pitch) + 0.6;
    b.add(M.corr, boxUV(W + 0.8, 0.25, run, 7.8), at(B, mat(0, H + (Math.tan(pitch) * D) / 4, (s * D) / 4, s * pitch)), 0x8c9196);
  }
  const gable = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, Math.tan(0.22) * D / 2)]));
  const guv = gable.getAttribute('uv');
  for (let i = 0; i < guv.count; i++) guv.setXY(i, guv.getX(i) / 7.8, guv.getY(i) / 7.8);
  for (const s of [-1, 1]) b.add(M.corr, gable, at(B, mat((s * W) / 2, H, 0, 0, (s * Math.PI) / 2, 0)), 0xb9c3c8);
  // roller doors on the water side (-Z), dock bumpers, gutter
  for (const dx of [-9, 0, 9]) {
    b.add(M.corr, boxUV(5.5, 5.5, 0.12, 3).rotateZ(Math.PI / 2), at(B, mat(dx, 2.75, -D / 2 - 0.07)), 0x7f878c);
    b.add(M.dark, box(5.9, 0.25, 0.3), at(B, mat(dx, 5.6, -D / 2 - 0.15)), 0xffffff);
    for (const sx of [-1, 1]) b.add(M.paint, box(0.15, 5.5, 0.18), at(B, mat(dx + sx * 2.85, 2.75, -D / 2 - 0.09)), 0xe8b81c);
  }
  b.add(M.galv, box(W + 0.8, 0.2, 0.25), at(B, mat(0, H - 0.05, -D / 2 - 0.4)));
  // sign: own material (unique texture)
  const signMat = new THREE.MeshStandardNodeMaterial({ map: signTex(sign), roughness: 0.7, vertexColors: true });
  signMat.name = `sign:${sign}`;
  b.add(signMat, new THREE.PlaneGeometry(16, 2).rotateY(Math.PI), at(B, mat(0, H - 1.6, -D / 2 - 0.08)), 0xffffff, false);
}

export function lightMast(b: StaticBatch, B: THREE.Matrix4) {
  const M = mats();
  b.add(M.galv, cyl(0.18, 18, 8), at(B, mat(0, 9, 0)));
  b.add(M.dark, box(1.8, 0.6, 0.4), at(B, mat(0, 18.2, 0)));
  b.add(M.paint, box(1.6, 0.4, 0.05), at(B, mat(0, 18.1, -0.22)), 0xfff6d8);
}

export function bollard(b: StaticBatch, B: THREE.Matrix4) {
  const M = mats();
  b.add(M.dark, new THREE.CylinderGeometry(0.16, 0.2, 0.42, 12), at(B, mat(0, 0.21, 0)));
  const head = new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(M.dark, head, at(B, mat(0, 0.38, 0, 0, 0, 0, 1, 0.55, 1)));
}

export function drums(b: StaticBatch, B: THREE.Matrix4, n: number, rng: Rng) {
  const M = mats();
  const cols = [0x1f5fa8, 0xb23a26, 0x2f6b3a];
  for (let i = 0; i < n; i++) b.add(M.paint, cyl(0.29, 0.88, 14), at(B, mat((i % 2) * 0.62, 0.44, -Math.floor(i / 2) * 0.62)), cols[Math.floor(rng.rnd() * 3)]);
}

export function pallet(b: StaticBatch, B: THREE.Matrix4) {
  const M = mats();
  b.add(M.wood, boxUV(1.2, 0.14, 1.0, 1.5), at(B, mat(0, 0.07, 0)));
  b.add(M.matte, box(1.1, 0.7, 0.9), at(B, mat(0, 0.5, 0)), 0xa88a5c);
  b.add(M.dark, box(1.12, 0.03, 0.06), at(B, mat(0, 0.6, 0)), 0x444444);
}

// ---------------------------------------------------------------- gameplay props (exact collider footprints)
// Each builder works in the prop's local frame: origin at the collider's base centre, -Z = forward (toward
// the enemy), +Z = toward the island's own centre. Everything stays inside ±half extents.

/** Generator: 1.2 × 1.4 × 1.2. Yellow diesel set on a skid, louvres, control panel with green glow. */
export function generatorProp(b: StaticBatch, B: THREE.Matrix4, h: THREE.Vector3) {
  const M = mats();
  const W = h.x * 2, H = h.y * 2, D = h.z * 2;
  b.add(M.dark, box(W, 0.1, D), at(B, mat(0, 0.05, 0)), 0x555555);
  b.add(M.paint, box(W - 0.06, 1.0, D - 0.1), at(B, mat(0, 0.6, 0)), 0xd9a521);
  b.add(M.paint, box(W - 0.02, 0.06, D - 0.06), at(B, mat(0, 1.13, 0)), 0xc49419); // lid
  for (const sx of [-1, 1]) for (let k = 0; k < 7; k++) b.add(M.dark, box(0.02, 0.04, D - 0.4), at(B, mat(sx * (W / 2 - 0.02), 0.32 + k * 0.1, 0)), 0x2a2a2a);
  // radiator grille at the back (-Z)
  b.add(M.dark, box(W - 0.3, 0.7, 0.03), at(B, mat(0, 0.62, -D / 2 + 0.035)), 0x333333);
  // control panel facing +Z
  b.add(M.dark, box(0.7, 0.45, 0.04), at(B, mat(0, 0.75, D / 2 - 0.03)), 0x2b2f33);
  b.add(M.glow, box(0.6, 0.06, 0.02), at(B, mat(0, 0.9, D / 2 - 0.005)));
  for (const x of [-0.2, 0, 0.2]) b.add(M.glow, cyl(0.03, 0.02, 10).rotateX(Math.PI / 2), at(B, mat(x, 0.66, D / 2 - 0.005)));
  // exhaust + fuel cap + lifting eye on the lid
  b.add(M.galv, cyl(0.06, 0.24, 10), at(B, mat(-0.3, 1.27, -0.25)), 0x8a8a8a);
  b.add(M.dark, cyl(0.075, 0.05, 10), at(B, mat(-0.3, 1.38, -0.25)));
  b.add(M.dark, cyl(0.07, 0.06, 10), at(B, mat(0.3, 1.19, 0.2)));
  b.add(M.galv, new THREE.TorusGeometry(0.07, 0.015, 6, 12), at(B, mat(0, 1.24, 0)));
  // cash tray glowing on top
  b.add(M.paint, box(0.36, 0.06, 0.24), at(B, mat(0.25, 1.19, -0.15)), 0x6fae6a);
}

/** Vault: 1.2 × 2.0 × 1.0 safe with a round door + spoked wheel facing +Z. */
export function vaultProp(b: StaticBatch, B: THREE.Matrix4, h: THREE.Vector3) {
  const M = mats();
  const W = h.x * 2, H = h.y * 2, D = h.z * 2;
  b.add(M.dark, box(W, 0.1, D), at(B, mat(0, 0.05, 0)), 0x3a3a3a);
  b.add(M.steel, boxUV(W - 0.04, H - 0.12, D - 0.12, 1.2), at(B, mat(0, H / 2 + 0.04, -0.02)), 0x8c949c);
  for (const sx of [-1, 1]) for (const sy of [0, 1]) b.add(M.dark, box(0.06, 0.06, D - 0.1), at(B, mat(sx * (W / 2 - 0.03), 0.13 + sy * (H - 0.2), -0.02)));
  const fz = D / 2 - 0.08;
  b.add(M.galv, cyl(0.47, 0.05, 32).rotateX(Math.PI / 2), at(B, mat(0, 1.05, fz + 0.025)), 0xb8bec4);
  b.add(M.dark, new THREE.TorusGeometry(0.47, 0.025, 8, 32), at(B, mat(0, 1.05, fz + 0.03)));
  b.add(M.galv, new THREE.TorusGeometry(0.2, 0.025, 8, 24), at(B, mat(0, 1.05, fz + 0.075)), 0xd0d4d8);
  for (let k = 0; k < 3; k++) b.add(M.galv, box(0.4, 0.03, 0.02), at(B, mat(0, 1.05, fz + 0.075, 0, 0, (k * Math.PI) / 3)), 0xd0d4d8);
  b.add(M.paint, cyl(0.06, 0.04, 16).rotateX(Math.PI / 2), at(B, mat(0, 1.05, fz + 0.075)), 0xc9a227);
  for (const y of [0.75, 1.35]) b.add(M.dark, cyl(0.04, 0.16, 8), at(B, mat(W / 2 - 0.1, y, fz + 0.02)));
  // bolts around the door
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    b.add(M.dark, cyl(0.018, 0.02, 6).rotateX(Math.PI / 2), at(B, mat(Math.cos(a) * 0.53, 1.05 + Math.sin(a) * 0.53, fz + 0.01)));
  }
}

/** Shopkeeper (0.6 × 1.8 × 0.6 collider) + a cantilevered awning on a pole inside the collider, overhead only. */
export function shopProp(b: StaticBatch, B: THREE.Matrix4, h: THREE.Vector3) {
  const M = mats();
  const skin = 0x8d5a3b, shirt = 0xe9e4d6, pants = 0x3b4252, apron = 0x2f6f73;
  const limb = (a: THREE.Vector3, c: THREE.Vector3, r: number, col: number) => {
    const d = c.clone().sub(a);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, d.length()), 4, 10);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()));
    g.translate((a.x + c.x) / 2, (a.y + c.y) / 2, (a.z + c.z) / 2);
    b.add(M.matte, g, B, col);
  };
  for (const s of [-1, 1]) {
    limb(V(s * 0.1, 0.92, 0), V(s * 0.11, 0.5, 0.01), 0.075, pants);
    limb(V(s * 0.11, 0.5, 0.01), V(s * 0.11, 0.1, 0), 0.06, pants);
    b.add(M.dark, box(0.11, 0.09, 0.24), at(B, mat(s * 0.11, 0.045, 0.04)), 0x3a2e26);
  }
  b.add(M.matte, new THREE.CapsuleGeometry(0.15, 0.32, 6, 14), at(B, mat(0, 1.2, 0, 0, 0, 0, 1.25, 1, 0.8)), shirt);
  b.add(M.matte, new THREE.CapsuleGeometry(0.155, 0.36, 6, 14), at(B, mat(0, 1.1, 0.012, 0, 0, 0, 1.22, 1, 0.82)), apron);
  limb(V(0, 1.42, 0), V(0, 1.5, 0), 0.05, skin);
  b.add(M.matte, new THREE.SphereGeometry(0.105, 18, 14), at(B, mat(0, 1.6, 0.01, 0, 0, 0, 1, 1.12, 1.06)), skin);
  b.add(M.matte, new THREE.SphereGeometry(0.115, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), at(B, mat(0, 1.63, 0.01)), 0x222222);
  b.add(M.matte, box(0.17, 0.015, 0.1), at(B, mat(0, 1.65, 0.13)), 0x222222);
  for (const s of [-1, 1]) {
    limb(V(s * 0.2, 1.4, 0), V(s * 0.24, 1.12, 0.06), 0.055, shirt);
    limb(V(s * 0.24, 1.12, 0.06), V(s * 0.12, 1.05, 0.24), 0.045, skin);
  }
  // pole (inside the collider, behind the keeper) + cantilevered striped awning toward +Z
  const pz = -h.z + 0.05;
  b.add(M.galv, cyl(0.035, 2.75, 8), at(B, mat(0, 1.375, pz)));
  b.add(M.galv, box(0.05, 0.05, 1.9), at(B, mat(0, 2.7, pz + 0.95)));
  b.add(M.galv, strut(V(0, 2.0, pz), V(0, 2.68, pz + 1.3), 0.02, 6), B);
  b.add(M.awning, new THREE.PlaneGeometry(2.4, 2.0).rotateX(-Math.PI / 2 + 0.22), at(B, mat(0, 2.62, pz + 0.95)), 0xffffff, true);
  for (const sx of [-1, 1]) b.add(M.awning, new THREE.PlaneGeometry(2.0, 0.22).rotateY(Math.PI / 2), at(B, mat(sx * 1.2, 2.5, pz + 0.95)), 0xffffff, true);
}
