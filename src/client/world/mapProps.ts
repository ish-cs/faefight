import * as THREE from 'three/webgpu';
import { boxUV, mat, StaticBatch } from './geo';
import { mats } from './materials';
import { addNpcSpot } from '../characters/npcSpots';
import { bollard, container, generatorProp, palm } from './props';
import { makeRng } from './textures';

// Map-template props: center-island stations, built-in cover art, Container Yard backdrop pieces and the
// breakable cosmetic models. Station builders work in the prop's local frame: origin at the collider's
// base centre, front (the side players use) toward +Z, everything inside ±half extents.

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r: number, h: number, s = 12) => new THREE.CylinderGeometry(r, r, h, s);
const at = (B: THREE.Matrix4, L: THREE.Matrix4) => B.clone().multiply(L);

/** Team-neutral liveries for the built-in container cover (no team hues: greys, umber, beige, slate). */
export const COVER_COLORS = [0x8a5a40, 0xa59c88, 0x4f5864, 0x6f6a5a, 0x7b7f82, 0x5c4e45];

// ---------------------------------------------------------------- center stations

/** Gold generator (1.2 × 1.4 × 1.2): the home generator in black + gold livery with glowing bullion on the lid. */
export function goldGenProp(b: StaticBatch, B: THREE.Matrix4, h: THREE.Vector3) {
  const M = mats();
  generatorProp(b, B, h, 0x2f3338, 0xc9a227);
  const W = h.x * 2, D = h.z * 2;
  for (const y of [0.32, 0.92]) b.add(M.paint, box(W - 0.04, 0.05, D - 0.08), at(B, mat(0, y, 0)), 0xd4a21f);
  // bullion pyramid on the lid (top ≤ 1.36 < 1.4)
  const bar = box(0.2, 0.06, 0.09);
  for (const [x, y, z] of [[0.12, 1.25, -0.08], [0.34, 1.25, -0.08], [0.12, 1.25, 0.03], [0.34, 1.25, 0.03], [0.23, 1.31, -0.025]]) {
    b.add(M.lit, bar, at(B, mat(x, y, z)), 0xffb21f);
  }
}

/** Supply generator (1.4 × 1.2 × 1.4): pallet of sandbags, steel plates and a supply crate, ready-lamp post. */
export function supplyProp(b: StaticBatch, B: THREE.Matrix4, h: THREE.Vector3) {
  const M = mats();
  const W = h.x * 2, D = h.z * 2;
  b.add(M.wood, boxUV(W, 0.14, D, 1.5), at(B, mat(0, 0.07, 0)), 0xb59670);
  for (const x of [-W / 2 + 0.06, 0, W / 2 - 0.06]) b.add(M.wood, boxUV(0.1, 0.1, D, 1.5), at(B, mat(x, 0.05, 0)), 0x8a6a48);
  // sandbags: two layers of three at the back
  const bag = new THREE.SphereGeometry(1, 12, 8);
  for (let layer = 0; layer < 2; layer++) for (const z of [-0.45, -0.14]) {
    for (const x of layer ? [-0.215, 0.215] : [-0.43, 0, 0.43]) {
      b.add(M.matte, bag, at(B, mat(x, 0.22 + layer * 0.15, z, 0, x * 0.1, 0, 0.21, 0.08, 0.14)), 0x9c8358);
    }
  }
  b.add(M.dark, box(0.03, 0.02, 0.62), at(B, mat(-0.2, 0.46, -0.3)), 0x3a3a38);
  // steel plates (front-right) + olive supply crate (front-left)
  for (let k = 0; k < 3; k++) b.add(M.steel, boxUV(0.56, 0.035, 0.5, 1.2), at(B, mat(0.36, 0.16 + k * 0.04, 0.34, 0, 0.04 * k, 0)), 0x9aa2a8);
  b.add(M.paint, box(0.55, 0.42, 0.45), at(B, mat(-0.36, 0.35, 0.36)), 0x4d5a36);
  for (const x of [-0.56, -0.16]) b.add(M.dark, box(0.04, 0.43, 0.46), at(B, mat(x, 0.35, 0.36)), 0x2a2e22);
  b.add(M.paint, box(0.3, 0.12, 0.005), at(B, mat(-0.36, 0.4, 0.586)), 0xe8e2c8);
  // ready-lamp post at the back corner (top ≤ 1.2)
  b.add(M.galv, cyl(0.035, 1.05, 8), at(B, mat(W / 2 - 0.08, 0.6, -D / 2 + 0.08)));
  b.add(M.lit, cyl(0.06, 0.1, 12), at(B, mat(W / 2 - 0.08, 1.14, -D / 2 + 0.08)), 0x4dff7a);
}

/** Potion seller (0.6 × 1.8 × 0.6): robed NPC behind a narrow counter of glowing flasks, canopy overhead. */
export function potionProp(b: StaticBatch, B: THREE.Matrix4, h: THREE.Vector3) {
  const M = mats();
  const W = h.x * 2;
  addNpcSpot('potion', at(B, mat(0, 0, -0.12))); // animated keeper (characters/npcs.ts)
  // counter (front strip of the footprint, z 0.08..0.30)
  b.add(M.wood, boxUV(W, 0.92, 0.2, 1.5), at(B, mat(0, 0.46, h.z - 0.11)), 0x7a5634);
  b.add(M.wood, boxUV(W, 0.04, 0.22, 1.5), at(B, mat(0, 0.94, h.z - 0.11)), 0xa57c50);
  b.add(M.paint, box(W - 0.06, 0.16, 0.005), at(B, mat(0, 0.72, h.z - 0.005)), 0x6b2f86);
  const flask = new THREE.SphereGeometry(0.045, 10, 8), neck = cyl(0.014, 0.06, 6);
  [[-0.2, 0xa040ff], [-0.07, 0xff3d6e], [0.06, 0x38a8ff], [0.19, 0x4dff9a]].forEach(([x, col]) => {
    b.add(M.lit, flask, at(B, mat(x, 1.005, h.z - 0.1)), col);
    b.add(M.galv, neck, at(B, mat(x, 1.07, h.z - 0.1)), 0xd8d8d8);
  });
  // pole at the back + cantilevered canopy toward the front, overhead only (like the home shop)
  const pz = -h.z + 0.04;
  b.add(M.galv, cyl(0.035, 2.6, 8), at(B, mat(0, 1.3, pz)));
  b.add(M.galv, box(0.05, 0.05, 1.6), at(B, mat(0, 2.55, pz + 0.8)));
  b.add(M.awning, new THREE.PlaneGeometry(1.8, 1.6).rotateX(-Math.PI / 2 + 0.2), at(B, mat(0, 2.48, pz + 0.8)), 0xb08ae8, true);
  for (const sx of [-1, 1]) b.add(M.awning, new THREE.PlaneGeometry(1.6, 0.2).rotateY(Math.PI / 2), at(B, mat(sx * 0.9, 2.38, pz + 0.8)), 0xb08ae8, true);
  for (const sx of [-1, 1]) {
    b.add(M.dark, cyl(0.006, 0.25, 4), at(B, mat(sx * 0.75, 2.2, pz + 1.45)));
    b.add(M.lit, cyl(0.05, 0.12, 8), at(B, mat(sx * 0.75, 2.04, pz + 1.45)), 0xffb766);
  }
}

// ---------------------------------------------------------------- built-in cover

/** Precast concrete K-rail filling exactly its collider (local X long). Reflective chevrons on both faces. */
export function barrierProp(solid: StaticBatch, dress: StaticBatch, B: THREE.Matrix4, half: THREE.Vector3) {
  const M = mats();
  solid.add(M.concrete, boxUV(half.x * 2, half.y * 2, half.z * 2, 2), at(B, mat(0, 0, 0)), 0xd2ccbe);
  for (const sz of [-1, 1]) {
    const F = at(B, mat(0, 0, sz * (half.z + 0.004), 0, sz > 0 ? 0 : Math.PI, 0));
    dress.add(M.dark, new THREE.PlaneGeometry(half.x * 2 - 0.1, 0.06), at(F, mat(0, -half.y + 0.32, 0)), 0x6a665e, false);
    for (let k = 0; k < 4; k++) {
      dress.add(M.paint, new THREE.PlaneGeometry(0.42, 0.16), at(F, mat(-0.75 + k * 0.5, half.y - 0.22, 0)), k % 2 ? 0xf2efe6 : 0xc8382c, false);
    }
  }
  // recessed lifting slots + forklift pockets (flat paint)
  for (const sx of [-1, 1]) dress.add(M.dark, new THREE.PlaneGeometry(0.2, 0.12).rotateX(-Math.PI / 2), at(B, mat(sx * 0.55, half.y + 0.003, 0)), 0x3a3834, false);
}

/** Container stack filling exactly a static cover box (1 or 2 high, long axis = whichever half is 3.03). */
export function containerCover(dress: StaticBatch, center: THREE.Vector3, half: THREE.Vector3, rotY: number, seed: number) {
  const levels = Math.max(1, Math.round(half.y / 1.295));
  const longZ = half.z > half.x;
  const base = new THREE.Matrix4().compose(V(center.x, center.y - half.y, center.z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), rotY + (longZ ? Math.PI / 2 : 0)), V(1, 1, 1));
  const rng = makeRng(seed);
  for (let k = 0; k < levels; k++) {
    const ci = (seed + k * 3) % COVER_COLORS.length; // neighbouring stacks and levels never share a livery
    const flip = rng.rnd() < 0.5 ? Math.PI : 0;
    container(dress, at(base, mat(0, k * 2.59, 0, 0, flip, 0)), COVER_COLORS[ci]);
  }
}

// ---------------------------------------------------------------- Container Yard backdrop

/** Cheap far-field container: body + top/bottom frame (36 tris). Base at origin, long axis X. */
export function containerLite(b: StaticBatch, B: THREE.Matrix4, col: number) {
  const M = mats();
  b.add(M.corr, boxUV(6.0, 2.47, 2.38, 7.8), at(B, mat(0, 1.295, 0)), col);
  const c = new THREE.Color(col).multiplyScalar(0.55);
  for (const y of [0.06, 2.53]) b.add(M.paint, box(6.06, 0.12, 2.44), at(B, mat(0, y, 0)), c);
}

/** Refrigerated container: white box with the machinery grille and a lit display on the -X end. */
export function reefer(b: StaticBatch, B: THREE.Matrix4) {
  const M = mats();
  container(b, B, 0xdedcd4);
  b.add(M.dark, box(0.06, 2.1, 2.0), at(B, mat(-3.04, 1.3, 0)), 0x2a2d30);
  for (let k = 0; k < 6; k++) b.add(M.galv, box(0.02, 0.05, 1.8), at(B, mat(-3.08, 0.6 + k * 0.14, 0.05)), 0x8a9096, false);
  b.add(M.lit, box(0.02, 0.12, 0.22), at(B, mat(-3.08, 1.85, -0.6)), 0x49ff7a);
  b.add(M.dark, cyl(0.02, 0.9, 5), at(B, mat(-3.1, 1.6, 0.9, 0.3, 0, 0)), 0x111111); // power cable
}

/** Rubber-tyred gantry straddling a container block: legs at ±span/2 (local X), ±depth/2 (local Z). */
export function rtg(b: StaticBatch, B: THREE.Matrix4, span = 22, depth = 12, height = 18) {
  const M = mats();
  const leg = 0xd9b21f, white = 0xe9e6de;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(M.paint, box(0.9, height, 0.9), at(B, mat((sx * span) / 2, height / 2, (sz * depth) / 2)), leg);
      for (const wz of [-0.7, 0.7]) b.add(M.rubber, cyl(0.6, 0.5, 12).rotateZ(Math.PI / 2), at(B, mat((sx * span) / 2, 0.6, (sz * depth) / 2 + wz)));
    }
    b.add(M.paint, box(1.2, 1.4, depth + 2.4), at(B, mat((sx * span) / 2, 1.2, 0)), leg); // sill beam
    b.add(M.paint, box(1.1, 1.0, depth), at(B, mat((sx * span) / 2, height * 0.55, 0)), leg);
  }
  for (const sz of [-1, 1]) b.add(M.paint, box(span + 1.6, 1.6, 1.2), at(B, mat(0, height + 0.5, (sz * depth) / 2)), leg);
  b.add(M.paint, box(4.2, 2.0, depth + 1.2), at(B, mat(span * 0.18, height + 2.1, 0)), white); // trolley
  b.add(M.paint, box(2.0, 2.2, 2.0), at(B, mat(span * 0.18 - 1.2, height - 1.4, depth / 2 - 1.5)), white); // cab
  b.add(M.dark, box(1.9, 0.9, 0.04), at(B, mat(span * 0.18 - 1.2, height - 1.0, depth / 2 - 0.48)), 0x88aabb);
  b.add(M.paint, box(2.6, 0.4, 6.4), at(B, mat(span * 0.18, height - 6, 0)), 0xe8b81c); // spreader
  for (const sz of [-1, 1]) b.add(M.dark, cyl(0.04, 6, 4), at(B, mat(span * 0.18, height - 3, sz * 1.8)));
}

// ---------------------------------------------------------------- breakable cosmetics (instanced models)
// Each builds one model with its base centre at the origin into `b` (taken per material afterwards).

/** Oil drum: body takes the per-instance colour, rims a little darker. */
export function barrelModel(b: StaticBatch) {
  const M = mats();
  b.add(M.paint, cyl(0.3, 0.9, 16), mat(0, 0.45, 0));
  for (const y of [0.3, 0.6]) b.add(M.paint, cyl(0.308, 0.03, 16), mat(0, y, 0), 0x9a9a9a);
  b.add(M.paint, cyl(0.29, 0.015, 16), mat(0, 0.905, 0), 0x777777);
  b.add(M.paint, cyl(0.04, 0.03, 8), mat(0.15, 0.92, 0.05), 0x555555);
}

/** Slatted wooden crate (0.75 × 0.7 × 0.6). */
export function crateModel(b: StaticBatch) {
  const M = mats();
  b.add(M.wood, boxUV(0.72, 0.66, 0.56, 0.8), mat(0, 0.35, 0), 0xc9a676);
  for (const y of [0.04, 0.66]) for (const z of [-0.29, 0.29]) b.add(M.wood, boxUV(0.76, 0.08, 0.04, 0.8), mat(0, y, z), 0x8f6e47);
  for (const x of [-0.36, 0.36]) for (const z of [-0.29, 0.29]) b.add(M.wood, boxUV(0.06, 0.7, 0.05, 0.8), mat(x, 0.35, z), 0x8f6e47);
  for (const z of [-0.29, 0.29]) b.add(M.wood, boxUV(0.9, 0.07, 0.03, 0.8), mat(0, 0.35, z, 0, 0, 0.72), 0x8f6e47);
}

/** Temporary chain-link fence panel, 2 m along local X, concrete feet. */
export function fenceModel(b: StaticBatch) {
  const M = mats();
  for (const x of [-1, 1]) {
    b.add(M.paint, cyl(0.025, 1.12, 6), mat(x * 0.98, 0.62, 0), 0xa4abb0);
    b.add(M.paint, box(0.22, 0.12, 0.5), mat(x * 0.98, 0.06, 0), 0x8d8a82);
  }
  for (const y of [0.14, 1.16]) b.add(M.paint, cyl(0.018, 1.96, 6).rotateZ(Math.PI / 2), mat(0, y, 0), 0xa4abb0);
  const panel = new THREE.PlaneGeometry(1.94, 1.0);
  const u = panel.getAttribute('uv');
  for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i) * 1.94 * 2.5, u.getY(i) * 1.0 * 2.5);
  b.add(M.chain, panel, mat(0, 0.65, 0));
}

/** Quay street lamp (≈5 m): tapered pole, arm, lit head. */
export function lampModel(b: StaticBatch) {
  const M = mats();
  b.add(M.paint, new THREE.CylinderGeometry(0.06, 0.1, 4.8, 8), mat(0, 2.4, 0), 0x3c4a52);
  b.add(M.paint, new THREE.CylinderGeometry(0.16, 0.2, 0.35, 8), mat(0, 0.175, 0), 0x3c4a52);
  b.add(M.paint, cyl(0.04, 0.9, 6).rotateZ(Math.PI / 2), mat(0.42, 4.75, 0), 0x3c4a52);
  b.add(M.paint, box(0.5, 0.14, 0.26), mat(0.82, 4.72, 0), 0x2f3a40);
  b.add(M.lamp, box(0.42, 0.03, 0.2), mat(0.82, 4.64, 0), 0xfff4d6);
}

/** Palm tree (≈8 m), the backdrop palm with a fixed seed. */
export function palmModel(b: StaticBatch) {
  palm(b, new THREE.Matrix4(), makeRng(4711), 8, 1.4, mats().bark); // coconuts on bark: one draw call fewer
}

export function bollardModel(b: StaticBatch) {
  bollard(b, new THREE.Matrix4());
}
