import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponKind } from '../../sim/types';

/**
 * Procedural low-poly guns, built in metres in a "grip frame": origin where the right hand closes,
 * barrel along -Z, +Y up. Each gun is two meshes (metal + furniture) sharing module-level materials
 * and cached geometry, so 8 armed players cost 16 tiny draws.
 */

type Part = { geo: THREE.BufferGeometry; furn?: boolean };

const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, furn = false): Part => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return { geo: g, furn };
};
/** Cylinder along Z from z0 to z1. */
const tube = (r: number, z0: number, z1: number, x: number, y: number, furn = false, seg = 10): Part => {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(z1 - z0), seg).rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return { geo: g, furn };
};

const SPECS: Record<Exclude<WeaponKind, 'fists'>, { parts: () => Part[]; muzzle: [number, number, number] }> = {
  pistol: {
    muzzle: [0, 0.065, -0.2],
    parts: () => [
      box(0.032, 0.034, 0.19, 0, 0.066, -0.075), // slide
      box(0.028, 0.02, 0.15, 0, 0.042, -0.07), // frame
      box(0.03, 0.11, 0.045, 0, -0.005, 0.0, -0.25, true), // grip
      box(0.006, 0.02, 0.045, 0, 0.022, -0.035), // trigger guard
      tube(0.008, -0.17, -0.19, 0, 0.066),
    ],
  },
  smg: {
    muzzle: [0, 0.07, -0.34],
    parts: () => [
      box(0.048, 0.07, 0.3, 0, 0.065, -0.08), // receiver
      tube(0.013, -0.23, -0.33, 0, 0.075), // barrel
      tube(0.02, -0.23, -0.27, 0, 0.075, false, 8), // shroud
      box(0.03, 0.17, 0.042, 0, -0.035, -0.12, 0.12), // magazine
      box(0.032, 0.1, 0.042, 0, -0.01, 0.01, -0.3, true), // grip
      box(0.012, 0.012, 0.2, 0.0, 0.08, 0.16), // wire stock rail
      box(0.012, 0.07, 0.016, 0, 0.055, 0.26), // butt plate
      box(0.012, 0.03, 0.05, 0, 0.115, -0.12), // sight rail
    ],
  },
  shotgun: {
    muzzle: [0, 0.095, -0.66],
    parts: () => [
      box(0.05, 0.07, 0.2, 0, 0.065, -0.04), // receiver
      tube(0.017, -0.14, -0.65, 0, 0.095, false, 12), // barrel
      tube(0.014, -0.14, -0.58, 0, 0.06, false, 10), // tube magazine
      box(0.06, 0.05, 0.18, 0, 0.065, -0.33, 0, true), // pump
      box(0.034, 0.1, 0.045, 0, -0.005, 0.03, -0.35, true), // grip
      box(0.042, 0.09, 0.3, 0, 0.04, 0.2, 0.18, true), // stock
    ],
  },
  rifle: {
    muzzle: [0, 0.085, -0.7],
    parts: () => [
      box(0.05, 0.075, 0.36, 0, 0.07, -0.06), // receiver
      box(0.044, 0.02, 0.32, 0, 0.115, -0.07), // top cover
      tube(0.011, -0.42, -0.69, 0, 0.085), // barrel
      box(0.056, 0.06, 0.2, 0, 0.075, -0.33, 0, true), // handguard
      tube(0.007, -0.2, -0.52, 0, 0.12), // gas tube
      box(0.032, 0.15, 0.05, 0, -0.04, -0.13, 0.35), // curved-ish magazine
      box(0.03, 0.04, 0.05, 0, -0.12, -0.155, 0.6), // magazine tip
      box(0.032, 0.1, 0.042, 0, -0.005, 0.02, -0.3, true), // grip
      box(0.042, 0.085, 0.3, 0, 0.045, 0.24, 0.15, true), // stock
      box(0.008, 0.035, 0.01, 0, 0.13, -0.6), // front sight
    ],
  },
};

const metalMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c1e21, roughness: 0.38, metalness: 0.75 });
const furnMat: Record<string, THREE.MeshStandardNodeMaterial> = {
  pistol: new THREE.MeshStandardNodeMaterial({ color: 0x15161a, roughness: 0.7, metalness: 0.1 }),
  smg: new THREE.MeshStandardNodeMaterial({ color: 0x23252a, roughness: 0.75, metalness: 0.1 }),
  shotgun: new THREE.MeshStandardNodeMaterial({ color: 0x6b3d1e, roughness: 0.65, metalness: 0 }),
  rifle: new THREE.MeshStandardNodeMaterial({ color: 0x7a431c, roughness: 0.6, metalness: 0 }),
};
const geoCache = new Map<string, { metal: THREE.BufferGeometry; furn: THREE.BufferGeometry }>();

function geometriesFor(kind: Exclude<WeaponKind, 'fists'>) {
  let g = geoCache.get(kind);
  if (!g) {
    const parts = SPECS[kind].parts().map((p) => ({ ...p, geo: p.geo.toNonIndexed() }));
    const merge = (sel: Part[]) => {
      const m = mergeGeometries(sel.map((p) => p.geo), false);
      if (!m) throw new Error(`[weapons] could not merge ${kind} geometry`);
      return m;
    };
    g = { metal: merge(parts.filter((p) => !p.furn)), furn: merge(parts.filter((p) => p.furn)) };
    geoCache.set(kind, g);
  }
  return g;
}

/** A gun model in the grip frame, or null for fists. userData.muzzle = local muzzle point. */
export function buildWeapon(kind: WeaponKind): THREE.Group | null {
  if (kind === 'fists') return null;
  const g = geometriesFor(kind);
  const group = new THREE.Group();
  group.name = `weapon:${kind}`;
  const metal = new THREE.Mesh(g.metal, metalMat);
  const furn = new THREE.Mesh(g.furn, furnMat[kind]);
  for (const m of [metal, furn]) { m.castShadow = true; group.add(m); }
  group.userData.muzzle = new THREE.Vector3(...SPECS[kind].muzzle);
  return group;
}

// ---- muzzle flash: two crossed additive quads + a small core, shared by everyone ----
const flashGeo = (() => {
  const a = new THREE.PlaneGeometry(0.1, 0.24).rotateX(Math.PI / 2).translate(0, 0, -0.1);
  const b = a.clone().rotateZ(Math.PI / 2);
  const c = new THREE.PlaneGeometry(0.1, 0.1);
  return mergeGeometries([a.toNonIndexed(), b.toNonIndexed(), c.toNonIndexed()], false)!;
})();
const flashMat = new THREE.MeshBasicNodeMaterial({
  color: new THREE.Color(0xffc46b).multiplyScalar(3),
  transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});

export function buildMuzzleFlash(): THREE.Mesh {
  const m = new THREE.Mesh(flashGeo, flashMat);
  m.visible = false;
  m.renderOrder = 5;
  return m;
}
