import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, float, mix, positionGeometry, sin, smoothstep, texture, vec3 } from 'three/tsl';
import { noiseTex } from '../world/pbr';
import type { WeaponKind } from '../../sim/types';

/**
 * Procedural low-poly guns, built in metres in a "grip frame": origin where the right hand closes,
 * barrel along -Z, +Y up. Each gun is two meshes (metal + furniture) sharing module-level materials
 * and cached geometry, so 8 armed players cost 16 tiny draws.
 */

type Part = { geo: THREE.BufferGeometry; furn?: boolean; col?: number };

const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, furn = false, col?: number): Part => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return { geo: g, furn, col };
};
/** Cylinder along Z from z0 to z1 (radius r at z1's end … r1 at z0's, as CylinderGeometry top/bottom after the turn). */
const tube = (r: number, z0: number, z1: number, x: number, y: number, furn = false, seg = 10, col?: number, r1 = r): Part => {
  const g = new THREE.CylinderGeometry(r, r1, Math.abs(z1 - z0), seg).rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return { geo: g, furn, col };
};

const LENS = 0x1b2a44, STEEL = 0x55585c, DARK = 0x0d0e10;
/** Base colours of the meshes (parts without their own tint take these). */
const METAL = 0x1c1e21, SHELL = 0xa32a1e;
const FURN: Record<Exclude<WeaponKind, 'fists'>, number> = { pistol: 0x15161a, smg: 0x23252a, shotgun: 0x6b3d1e, rifle: 0x7a431c, rocket: 0x4f5a2c, sniper: 0x5e6248 };

/** Picatinny rail along Z on top of y: base strip + cross ridges. */
const rail = (y: number, z0: number, z1: number, w = 0.022): Part[] => {
  const out = [box(w, 0.006, Math.abs(z1 - z0), 0, y + 0.003, (z0 + z1) / 2)];
  for (let z = Math.min(z0, z1) + 0.006; z < Math.max(z0, z1) - 0.004; z += 0.01) out.push(box(w + 0.004, 0.005, 0.005, 0, y + 0.0075, z));
  return out;
};
/** Riflescope along Z centred at (y, z): tube, bells, lenses, turrets, rings. */
const scope = (y: number, z: number, len = 0.17): Part[] => [
  tube(0.0135, z - len / 2 + 0.03, z + len / 2 - 0.035, 0, y, false, 14),
  tube(0.0145, z - len / 2, z - len / 2 + 0.035, 0, y, false, 16, undefined, 0.021), // objective bell
  tube(0.017, z + len / 2 - 0.04, z + len / 2, 0, y, false, 14, undefined, 0.0145), // eyepiece
  tube(0.0195, z - len / 2 - 0.002, z - len / 2 + 0.001, 0, y, false, 16, LENS),
  tube(0.0155, z + len / 2 - 0.001, z + len / 2 + 0.002, 0, y, false, 14, LENS),
  box(0.012, 0.016, 0.012, 0, y + 0.018, z), // elevation turret
  box(0.014, 0.012, 0.012, 0.017, y, z), // windage turret
  box(0.03, 0.016, 0.012, 0, y - 0.016, z - 0.04), box(0.03, 0.016, 0.012, 0, y - 0.016, z + 0.035), // rings
];

/**
 * `mag`: the detachable part (magazine / rocket) as its own mesh so reloads can pull it out; built in the
 * grip frame, then re-centred on `magAt`. `eject`: where spent cases leave the gun.
 */
type Spec = { parts: () => Part[]; muzzle: [number, number, number]; mag: () => Part[]; magAt: [number, number, number]; eject: [number, number, number] };

const SPECS: Record<Exclude<WeaponKind, 'fists'>, Spec> = {
  pistol: {
    muzzle: [0, 0.065, -0.2],
    eject: [0.02, 0.075, -0.05],
    magAt: [0, -0.03, 0.006],
    mag: () => [box(0.024, 0.11, 0.036, 0, -0.03, 0.006, -0.25), box(0.03, 0.012, 0.042, 0, -0.085, 0.02, -0.25, true, FURN.pistol)],
    parts: () => [
      box(0.032, 0.034, 0.19, 0, 0.066, -0.075), // slide
      ...[0, 1, 2, 3, 4].map((k) => box(0.0335, 0.024, 0.003, 0, 0.068, -0.004 - k * 0.007, 0, false, DARK)), // slide serrations
      box(0.012, 0.004, 0.035, 0.0105, 0.0835, -0.06, 0, false, DARK), // ejection port
      box(0.012, 0.008, 0.006, 0, 0.086, 0.012), box(0.004, 0.007, 0.004, 0, 0.086, -0.16), // sights
      box(0.028, 0.02, 0.15, 0, 0.042, -0.07, 0, true), // frame
      box(0.02, 0.008, 0.06, 0, 0.03, -0.12, 0, true), // accessory rail
      box(0.03, 0.11, 0.045, 0, -0.005, 0.0, -0.25, true), // grip
      box(0.006, 0.02, 0.045, 0, 0.022, -0.035, 0, true), // trigger guard
      box(0.004, 0.016, 0.006, 0, 0.026, -0.028, 0.3), // trigger
      tube(0.008, -0.17, -0.19, 0, 0.066, false, 10, STEEL),
    ],
  },
  smg: {
    muzzle: [0, 0.075, -0.36],
    eject: [0.03, 0.09, -0.06],
    magAt: [0, -0.035, -0.12],
    mag: () => [box(0.03, 0.17, 0.042, 0, -0.035, -0.12, 0.12), ...[0, 1, 2].map((k) => box(0.031, 0.004, 0.036, 0, -0.01 - k * 0.04, -0.123 + k * 0.005, 0.12, false, DARK))],
    parts: () => [
      box(0.048, 0.07, 0.3, 0, 0.065, -0.08), // receiver
      ...rail(0.1, -0.2, 0.04),
      box(0.012, 0.03, 0.06, 0.0245, 0.08, -0.04, 0, false, DARK), // ejection port
      box(0.008, 0.008, 0.03, -0.027, 0.09, 0.02), // charging handle
      tube(0.013, -0.23, -0.33, 0, 0.075, false, 10, STEEL), // barrel
      tube(0.02, -0.23, -0.27, 0, 0.075, false, 12), // shroud
      tube(0.016, -0.33, -0.36, 0, 0.075, false, 10), // muzzle
      box(0.004, 0.024, 0.006, 0, 0.115, -0.21), // front post
      box(0.032, 0.1, 0.042, 0, -0.01, 0.01, -0.3, true), // grip
      box(0.006, 0.022, 0.05, 0, 0.022, -0.03, 0, true), box(0.004, 0.016, 0.006, 0, 0.025, -0.025, 0.3), // guard + trigger
      box(0.012, 0.012, 0.2, 0.0, 0.08, 0.16), // wire stock rail
      box(0.012, 0.07, 0.016, 0, 0.055, 0.26, 0, true), // butt plate
    ],
  },
  shotgun: {
    muzzle: [0, 0.095, -0.66],
    eject: [0.03, 0.08, -0.02],
    magAt: [0, 0.025, -0.06],
    mag: () => [tube(0.011, -0.03, 0.03, 0, 0.025, true, 8), tube(0.0115, 0.03, 0.045, 0, 0.025, false, 8, 0xb08a3a)],
    parts: () => [
      box(0.05, 0.07, 0.2, 0, 0.065, -0.04), // receiver
      box(0.012, 0.03, 0.07, 0.0255, 0.075, -0.04, 0, false, DARK), // ejection port
      tube(0.017, -0.14, -0.65, 0, 0.095, false, 14), // barrel
      tube(0.003, -0.64, -0.645, 0, 0.113, false, 6, 0xd8c070), // bead
      tube(0.014, -0.14, -0.58, 0, 0.06, false, 10), // tube magazine
      tube(0.016, -0.575, -0.59, 0, 0.06, false, 10, STEEL), // mag cap
      box(0.06, 0.05, 0.18, 0, 0.065, -0.33, 0, true), // pump
      ...[0, 1, 2, 3, 4, 5].map((k) => box(0.062, 0.004, 0.006, 0, 0.042, -0.26 - k * 0.028, 0, true, 0x2a160a)), // pump grooves
      box(0.034, 0.1, 0.045, 0, -0.005, 0.03, -0.35, true), // grip
      box(0.006, 0.022, 0.05, 0, 0.022, -0.02, 0), box(0.004, 0.016, 0.006, 0, 0.025, -0.015, 0.3), // guard + trigger
      box(0.042, 0.09, 0.3, 0, 0.04, 0.2, 0.18, true), // stock
      box(0.044, 0.094, 0.02, 0, 0.01, 0.35, 0.18, false, DARK), // butt pad
    ],
  },
  rifle: {
    muzzle: [0, 0.085, -0.74],
    eject: [0.03, 0.09, -0.08],
    magAt: [0, -0.04, -0.13],
    mag: () => [box(0.032, 0.15, 0.05, 0, -0.04, -0.13, 0.35), box(0.03, 0.04, 0.05, 0, -0.12, -0.155, 0.6), ...[0, 1, 2].map((k) => box(0.0325, 0.004, 0.044, 0, -0.01 - k * 0.035, -0.12 - k * 0.012, 0.35, false, DARK))],
    parts: () => [
      box(0.05, 0.075, 0.36, 0, 0.07, -0.06), // receiver
      ...rail(0.1075, -0.24, 0.1),
      box(0.012, 0.022, 0.07, 0.0255, 0.08, -0.07, 0, false, DARK), // ejection port
      box(0.012, 0.01, 0.03, -0.026, 0.09, 0.05), // charging handle
      tube(0.011, -0.42, -0.69, 0, 0.085, false, 10, STEEL), // barrel
      tube(0.016, -0.69, -0.74, 0, 0.085, false, 8), // muzzle brake
      box(0.034, 0.008, 0.03, 0, 0.085, -0.715, 0, false, DARK), // brake ports
      box(0.056, 0.06, 0.2, 0, 0.075, -0.33, 0, true), // handguard
      ...[0, 1, 2, 3, 4].map((k) => box(0.058, 0.014, 0.012, 0, 0.075, -0.25 - k * 0.036, 0, true, 0x3a1e0c)), // vent slots
      tube(0.007, -0.2, -0.52, 0, 0.12), // gas tube
      box(0.032, 0.1, 0.042, 0, -0.005, 0.02, -0.3, true), // grip
      box(0.006, 0.022, 0.05, 0, 0.022, -0.035, 0), box(0.004, 0.016, 0.006, 0, 0.025, -0.03, 0.3), // guard + trigger
      box(0.042, 0.085, 0.3, 0, 0.045, 0.24, 0.15, true), // stock
      box(0.044, 0.09, 0.018, 0, 0.022, 0.39, 0.15, false, DARK), // butt pad
      box(0.008, 0.035, 0.01, 0, 0.13, -0.6), // front sight
      ...scope(0.145, -0.06),
    ],
  },
  sniper: {
    // Bolt-action long rifle: long fluted barrel with a can-shaped brake, a big 56 mm scope on high rings, bolt handle
    // on the right, short 5-round box mag, olive-drab stock with a cheek riser and a folded bipod. Clearly longer
    // and slimmer than the assault rifle, with no handguard vents or carry rail.
    muzzle: [0, 0.08, -1.08],
    eject: [0.03, 0.09, -0.04],
    magAt: [0, -0.02, -0.1],
    mag: () => [box(0.03, 0.07, 0.07, 0, -0.02, -0.1, 0.1), box(0.032, 0.008, 0.074, 0, -0.058, -0.104, 0.1, false, DARK)],
    parts: () => [
      tube(0.022, 0.08, -0.26, 0, 0.075, false, 14), // round receiver
      box(0.014, 0.012, 0.06, 0.022, 0.085, -0.04, 0, false, DARK), // ejection port
      tube(0.006, 0.05, 0.12, 0.045, 0.08, false, 8, STEEL), box(0.012, 0.012, 0.012, 0.075, 0.08, 0.05, 0, false, DARK), // bolt handle + knob
      tube(0.0115, -0.26, -0.98, 0, 0.08, false, 12, STEEL), // long barrel
      ...[0, 1, 2].map((k) => box(0.026, 0.004, 0.2, 0, 0.08 + (k - 1) * 0.008, -0.55, 0, false, DARK)), // flutes
      tube(0.02, -0.98, -1.08, 0, 0.08, false, 10), // brake
      box(0.042, 0.01, 0.05, 0, 0.08, -1.03, 0, false, DARK), // brake ports
      box(0.05, 0.05, 0.34, 0, 0.045, -0.36, 0, true), // forend
      box(0.032, 0.1, 0.042, 0, -0.005, 0.03, -0.3, true), // grip
      box(0.006, 0.022, 0.05, 0, 0.022, -0.03, 0), box(0.004, 0.016, 0.006, 0, 0.025, -0.025, 0.3), // guard + trigger
      box(0.046, 0.08, 0.34, 0, 0.035, 0.26, 0.08, true), // stock
      box(0.04, 0.03, 0.16, 0, 0.1, 0.22, 0.05, true), // cheek riser
      box(0.05, 0.1, 0.02, 0, 0.015, 0.43, 0.08, false, DARK), // butt pad
      box(0.01, 0.012, 0.22, 0.018, 0.02, -0.46, 0.05, false, DARK), box(0.01, 0.012, 0.22, -0.018, 0.02, -0.46, 0.05, false, DARK), // folded bipod
      ...rail(0.1, -0.22, 0.08),
      box(0.032, 0.03, 0.014, 0, 0.115, -0.15), box(0.032, 0.03, 0.014, 0, 0.115, 0.03), // high rings
      tube(0.016, -0.22, 0.1, 0, 0.15, false, 14), // scope tube
      tube(0.017, -0.33, -0.22, 0, 0.15, false, 16, undefined, 0.03), // objective bell (56 mm)
      tube(0.019, 0.1, 0.16, 0, 0.15, false, 14, undefined, 0.016), // eyepiece
      tube(0.028, -0.334, -0.33, 0, 0.15, false, 16, LENS),
      tube(0.0175, 0.16, 0.163, 0, 0.15, false, 14, LENS),
      box(0.018, 0.024, 0.018, 0, 0.176, -0.06), box(0.022, 0.018, 0.018, 0.024, 0.15, -0.06), // turrets
    ],
  },
  rocket: {
    // Shoulder-fired tube (loads from the rear); the rocket itself is the "mag".
    muzzle: [0, 0.11, -0.64],
    eject: [0, 0.11, 0.48],
    magAt: [0, 0.11, -0.3],
    mag: () => {
      const nose = new THREE.ConeGeometry(0.036, 0.16, 12).rotateX(-Math.PI / 2).translate(0, 0.11, -0.53);
      return [tube(0.034, -0.45, -0.12, 0, 0.11, false, 12, 0x5c6638), { geo: nose, furn: true, col: 0x3f4824 }, tube(0.02, -0.12, -0.04, 0, 0.11, false, 8, METAL)];
    },
    parts: () => [
      tube(0.05, 0.46, -0.6, 0, 0.11, true, 16), // launch tube
      tube(0.064, 0.4, 0.5, 0, 0.11, false, 16), // rear venturi flare
      tube(0.058, -0.56, -0.64, 0, 0.11, false, 16), // muzzle ring
      tube(0.056, -0.1, 0.02, 0, 0.11, false, 14), // centre band
      tube(0.053, 0.2, 0.24, 0, 0.11, true, 16, 0xc8a030), // warning band
      box(0.032, 0.1, 0.042, 0, -0.005, 0.0, -0.3), // grip
      box(0.006, 0.022, 0.05, 0, 0.022, -0.035, 0), box(0.004, 0.016, 0.006, 0, 0.025, -0.03, 0.3), // guard + trigger
      box(0.03, 0.09, 0.04, 0, 0.01, -0.27, -0.2), // fore grip
      box(0.028, 0.05, 0.08, -0.07, 0.16, -0.14), // optical sight
      tube(0.012, -0.181, -0.178, -0.07, 0.165, false, 10, LENS),
      box(0.06, 0.035, 0.14, 0, 0.055, 0.26, 0, true), // shoulder pad
    ],
  },
};

/**
 * Worn gun finishes: per-part vertex colours (bluing, bare steel, lenses, wood), bright scuffs where a noise field in
 * the gun's own space peaks, roughness varying across the surface; wood gets a grain.
 */
function gunMaterial(rough: number, metal: number, wood = false) {
  const m = new THREE.MeshStandardNodeMaterial();
  const vc = attribute('color', 'vec3');
  const P = positionGeometry;
  const n = texture(noiseTex(), P.xz.mul(7).add(P.y.mul(3.1)));
  const n2 = texture(noiseTex(), P.zy.mul(31).add(P.x.mul(11)));
  let col = vc.mul(float(0.92).add(n.x.mul(0.14)));
  if (wood) col = col.mul(float(0.88).add(sin(P.z.mul(260).add(n.y.mul(9))).mul(0.08)));
  const wear = smoothstep(0.9, 0.97, n2.y).mul(metal > 0.3 ? 0.35 : 0);
  m.colorNode = mix(col, vec3(0.22, 0.22, 0.23), wear);
  m.roughnessNode = float(rough).add(n.y.sub(0.5).mul(0.25)).sub(wear.mul(0.12)).clamp(0.08, 1);
  m.metalnessNode = float(metal).add(wear.mul(1 - metal));
  return m;
}

const metalMat = gunMaterial(0.38, 0.75);
// Keyed by every gun (not string): a missing entry left the sniper's stock on three's default flat material.
const furnMat: Record<Exclude<WeaponKind, 'fists'>, THREE.MeshStandardNodeMaterial> = {
  pistol: gunMaterial(0.68, 0.1), smg: gunMaterial(0.72, 0.1), shotgun: gunMaterial(0.62, 0, true), rifle: gunMaterial(0.58, 0, true), rocket: gunMaterial(0.7, 0.15),
  sniper: gunMaterial(0.74, 0.05), // matte polymer stock
};
const shellMat = gunMaterial(0.6, 0);
const geoCache = new Map<string, { metal: THREE.BufferGeometry; furn: THREE.BufferGeometry; mag: THREE.BufferGeometry }>();

/** Non-indexed part with a `color` attribute: its own tint, else the base colour of the mesh it merges into. */
function tinted(p: Part, base: number): THREE.BufferGeometry {
  const g = p.geo.toNonIndexed();
  const c = new THREE.Color(p.col ?? base);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function geometriesFor(kind: Exclude<WeaponKind, 'fists'>) {
  let g = geoCache.get(kind);
  if (!g) {
    const parts = SPECS[kind].parts().map((p) => ({ ...p, geo: tinted(p, p.furn ? FURN[kind] : METAL) }));
    const merge = (sel: Part[]) => {
      const m = mergeGeometries(sel.map((p) => p.geo), false);
      if (!m) throw new Error(`[weapons] could not merge ${kind} geometry`);
      return m;
    };
    const [mx, my, mz] = SPECS[kind].magAt;
    // The mag/shell/rocket is one mesh (first-part material decides: furniture-coloured for a shell).
    const magBase = kind === 'shotgun' ? SHELL : kind === 'rocket' ? FURN.rocket : METAL;
    const mag = merge(SPECS[kind].mag().map((p) => ({ ...p, geo: tinted(p, magBase) })));
    mag.translate(-mx, -my, -mz);
    g = { metal: merge(parts.filter((p) => !p.furn)), furn: merge(parts.filter((p) => p.furn)), mag };
    geoCache.set(kind, g);
  }
  return g;
}

/**
 * A gun model in the grip frame, or null for fists. userData: muzzle = local muzzle point, eject = case
 * ejection port, mag = the detachable magazine/shell/rocket mesh, magHome = where it sits.
 */
export function buildWeapon(kind: WeaponKind): THREE.Group | null {
  if (kind === 'fists') return null;
  const g = geometriesFor(kind);
  const group = new THREE.Group();
  group.name = `weapon:${kind}`;
  const metal = new THREE.Mesh(g.metal, metalMat);
  const furn = new THREE.Mesh(g.furn, furnMat[kind]);
  const mag = new THREE.Mesh(g.mag, kind === 'shotgun' ? shellMat : kind === 'rocket' ? furnMat.rocket : metalMat);
  mag.name = 'mag';
  mag.position.set(...SPECS[kind].magAt);
  if (kind === 'shotgun') mag.visible = false; // only appears in the hand while loading
  for (const m of [metal, furn, mag]) { m.castShadow = true; group.add(m); }
  group.userData.muzzle = new THREE.Vector3(...SPECS[kind].muzzle);
  group.userData.eject = new THREE.Vector3(...SPECS[kind].eject);
  group.userData.mag = mag;
  group.userData.magHome = mag.position.clone();
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
