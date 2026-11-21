import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Procedural human body skinned to the rig's skeleton (bind pose = T-pose, character space: metres, Y up, facing +Z,
 * feet at y = 0). Every part is ordinary smooth geometry (lofted limbs/torso, a shaped head with a face, gear) merged
 * into ONE skinned geometry per look and level of detail, so an avatar is a single draw. Per-vertex attributes feed
 * the shared body material (charMaterials.ts): `color` = albedo, `surf` = (material kind, seam/stubble mask).
 */

/** Material channels (surf.x). */
export const K = { skin: 0, camo: 1, cloth: 2, leather: 3, metal: 4, polymer: 5, hair: 6, eye: 7, glint: 8, hivis: 9, team: 10 } as const;
export type Kind = (typeof K)[keyof typeof K];

export type Headgear = 'helmet' | 'cap' | 'hardhat' | 'beanie' | 'flatcap' | 'none';
export type Look = {
  role: 'soldier' | 'shop' | 'potion';
  skin: number; hair: number; eyes: number;
  /** 0 clean-shaven, 1 stubble, 2 full beard */
  beard: 0 | 1 | 2;
  head: Headgear;
  /** Civilian outfit colours (NPCs): shirt, trousers, vest/apron, hat. */
  shirt: number; pants: number; vest: number; hat: number;
  /** Soldiers: goggles on the helmet; NPCs: sleeves rolled to the elbow. */
  extra: boolean;
};

export type Lod = 0 | 1 | 2;
type Detail = { limb: number; torso: number; headU: number; headV: number; hands: 0 | 1 | 2; face: 0 | 1 | 2; gear: 0 | 1 | 2 };
const DETAIL: Record<Lod, Detail> = {
  0: { limb: 12, torso: 20, headU: 26, headV: 18, hands: 2, face: 2, gear: 2 },
  1: { limb: 9, torso: 14, headU: 16, headV: 12, hands: 1, face: 1, gear: 1 },
  2: { limb: 6, torso: 8, headU: 9, headV: 7, hands: 0, face: 0, gear: 0 },
};

export const SKIN_TONES = [0xf1c7a5, 0xe0ac85, 0xc68863, 0xa0694a, 0x7a4b31, 0x5a3624];
const HAIR = [0x1d1612, 0x3b2617, 0x6a4a2c, 0x9a7a4e, 0x24201c, 0x6e6a66];
const EYES = [0x4a2f1c, 0x2f5f86, 0x5d6b3a, 0x3a2a1c, 0x6b7f8f];

/** Deterministic per-player variety (skin tone, beard, eyes, goggles); every soldier wears a helmet. */
export function soldierLook(seed: number): Look {
  const r = rng(seed * 7919 + 13);
  return {
    role: 'soldier', skin: pick(SKIN_TONES, r()), hair: pick(HAIR, r()), eyes: pick(EYES, r()),
    beard: r() < 0.35 ? 1 : r() < 0.4 ? 2 : 0, head: 'helmet', shirt: 0, pants: 0, vest: 0, hat: 0, extra: r() < 0.45,
  };
}

/** Shop keepers: dock workers in hi-vis (shop) or an aproned stall keeper (potions). */
export function npcLook(role: 'shop' | 'potion', seed: number): Look {
  const r = rng(seed * 104729 + 7);
  if (role === 'shop') {
    return {
      role, skin: pick(SKIN_TONES, r()), hair: pick(HAIR, r()), eyes: pick(EYES, r()), beard: r() < 0.5 ? 1 : 2,
      head: r() < 0.6 ? 'hardhat' : 'beanie', shirt: pick([0x2c3e57, 0x4a4f55, 0x5b3a2e], r()), pants: pick([0x2f3640, 0x3d3a33], r()),
      vest: r() < 0.5 ? 0xff7a1a : 0xd8f23a, hat: pick([0xf2c418, 0xf4f4f0, 0x2b3a5c], r()), extra: r() < 0.5,
    };
  }
  return {
    role, skin: pick(SKIN_TONES, r()), hair: pick(HAIR, r()), eyes: pick(EYES, r()), beard: 2,
    head: r() < 0.7 ? 'flatcap' : 'none', shirt: pick([0xe6dcc6, 0xc9d3d6, 0x8a5a7a], r()), pants: pick([0x3a3046, 0x40362c], r()),
    vest: pick([0x5a3d8a, 0x6b4a2e], r()), hat: pick([0x5b4c3e, 0x3d3550], r()), extra: true,
  };
}

export function lookKey(l: Look): string {
  return [l.role, l.skin, l.hair, l.eyes, l.beard, l.head, l.shirt, l.pants, l.vest, l.hat, l.extra ? 1 : 0].join(',');
}

function rng(seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
const pick = <T>(a: readonly T[], u: number) => a[Math.min(a.length - 1, Math.floor(u * a.length))];

// ------------------------------------------------------------------------------------------------- rig + weights

/** Bind-pose (T-pose) positions of the rig's joints in character space, by bone name (GLTFLoader names: "UpperArmL"). */
export type Joints = (name: string) => THREE.Vector3;
type BoneW = [string, number][];
type Weigher = BoneW | ((p: THREE.Vector3) => BoneW);

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function mixW(a: BoneW, b: BoneW, k: number): BoneW {
  if (k <= 0) return a;
  if (k >= 1) return b;
  return [...a.map(([n, w]): [string, number] => [n, w * (1 - k)]), ...b.map(([n, w]): [string, number] => [n, w * k])];
}

/**
 * Weights along a chain of joints (each bone owns the stretch from its joint to the next), blended over `r` metres
 * either side of every joint, measured along the chain direction there. Points before the first joint go to the first bone.
 */
function chain(links: { bone: string; at: THREE.Vector3; r?: number }[]): (p: THREE.Vector3) => BoneW {
  const dirs = links.map((l, i) => {
    const a = links[Math.max(0, i - 1)].at, b = links[Math.min(links.length - 1, i + 1)].at;
    return b.clone().sub(a).normalize();
  });
  const tmp = new THREE.Vector3();
  return (p) => {
    let c = 0;
    for (let i = 1; i < links.length; i++) {
      const r = links[i].r ?? 0.03;
      c += sstep(-r, r, tmp.copy(p).sub(links[i].at).dot(dirs[i]));
    }
    const i0 = Math.min(links.length - 1, Math.floor(c)), f = c - i0;
    if (f < 1e-3 || i0 >= links.length - 1) return [[links[i0].bone, 1]];
    return [[links[i0].bone, 1 - f], [links[i0 + 1].bone, f]];
  };
}

// ------------------------------------------------------------------------------------------------- builder

type AddOpts = { m?: THREE.Matrix4; color: number | THREE.Color; kind: Kind; w: Weigher; seam?: number | ((p: THREE.Vector3, i: number) => number); mirror?: boolean };

/** Accumulates parts (any BufferGeometry, transformed + weighted) into one skinned geometry. */
export class BodyBuilder {
  private pos: number[] = []; private nrm: number[] = []; private col: number[] = []; private surf: number[] = [];
  private si: number[] = []; private sw: number[] = []; private idx: number[] = [];
  private bones = new Map<string, number>();
  constructor(boneNames: readonly string[]) { boneNames.forEach((n, i) => this.bones.set(n, i)); }

  /** Adds `geo`; with `mirror`, also its mirror image across x = 0 with every L bone swapped for its R twin. */
  add(geo: THREE.BufferGeometry, o: AddOpts) {
    this.addOne(geo, o, false);
    if (o.mirror) this.addOne(geo, o, true);
    geo.dispose();
  }

  private addOne(geo: THREE.BufferGeometry, o: AddOpts, mirror: boolean) {
    const P = geo.getAttribute('position'), N = geo.getAttribute('normal');
    if (!N) throw new Error('[body] part without normals');
    const nm = new THREE.Matrix3();
    if (o.m) nm.getNormalMatrix(o.m);
    const c = o.color instanceof THREE.Color ? o.color : new THREE.Color(o.color);
    const base = this.pos.length / 3;
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      p.fromBufferAttribute(P, i); n.fromBufferAttribute(N, i);
      if (o.m) { p.applyMatrix4(o.m); n.applyMatrix3(nm).normalize(); }
      let w = typeof o.w === 'function' ? o.w(p) : o.w;
      const seam = typeof o.seam === 'function' ? o.seam(p, i) : o.seam ?? 0;
      if (mirror) { p.x = -p.x; n.x = -n.x; w = w.map(([b, v]): [string, number] => [mirrorName(b), v]); }
      this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z);
      this.col.push(c.r, c.g, c.b); this.surf.push(o.kind, seam);
      this.pushWeights(w);
    }
    const tri = geo.index ? Array.from(geo.index.array) : Array.from({ length: P.count }, (_, i) => i);
    for (let t = 0; t < tri.length; t += 3) {
      if (mirror) this.idx.push(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
      else this.idx.push(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
    }
  }

  private pushWeights(w: BoneW) {
    const acc = new Map<number, number>();
    for (const [name, v] of w) {
      const b = this.bones.get(name);
      if (b === undefined) throw new Error(`[body] rig has no bone "${name}"`);
      acc.set(b, (acc.get(b) ?? 0) + v);
    }
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, v]) => s + v, 0) || 1;
    for (let k = 0; k < 4; k++) { this.si.push(top[k]?.[0] ?? 0); this.sw.push(top[k] ? top[k][1] / sum : 0); }
  }

  get vertexCount() { return this.pos.length / 3; }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.surf, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const mirrorName = (b: string) => (b.endsWith('L') ? b.slice(0, -1) + 'R' : b);

// ------------------------------------------------------------------------------------------------- primitives

type Ring = { t: number; rx: number; ry: number; ox?: number; oy?: number };

/**
 * A smooth tube from a to b whose cross-section (ellipse, superellipse exponent `exp`) follows `prof` (t 0..1 along
 * the axis, radii along e1/e2, centre offsets). e1 = `side` made perpendicular to the axis, e2 = axis × e1.
 * Ends are rounded shut. Returns the geometry and, per vertex, its t and angle (for seams).
 */
function loft(a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, prof: Ring[], radial: number, rings: number, exp = 2, cap = true) {
  const d = b.clone().sub(a), L = d.length();
  d.normalize();
  const e1 = side.clone().sub(d.clone().multiplyScalar(side.dot(d))).normalize();
  const e2 = d.clone().cross(e1).normalize();
  const at = (t: number) => {
    let i = 0;
    while (i < prof.length - 2 && prof[i + 1].t < t) i++;
    const p0 = prof[i], p1 = prof[i + 1];
    const k = sstep(0, 1, (t - p0.t) / Math.max(1e-6, p1.t - p0.t));
    const lerp = (x: number, y: number) => x + (y - x) * k;
    return { rx: lerp(p0.rx, p1.rx), ry: lerp(p0.ry, p1.ry), ox: lerp(p0.ox ?? 0, p1.ox ?? 0), oy: lerp(p0.oy ?? 0, p1.oy ?? 0) };
  };
  const ts: { t: number; s: number; tt: number }[] = []; // tt = position along the axis, s = radius scale (caps)
  const t0 = prof[0].t, t1 = prof[prof.length - 1].t;
  const capN = cap ? 3 : 0;
  for (let i = capN; i >= 1; i--) { const ang = (i / (capN + 1)) * Math.PI / 2; ts.push({ t: t0, s: Math.cos(ang), tt: t0 - Math.sin(ang) * at(t0).rx / L * 0.8 }); }
  for (let i = 0; i <= rings; i++) { const t = t0 + (t1 - t0) * (i / rings); ts.push({ t, s: 1, tt: t }); }
  for (let i = 1; i <= capN; i++) { const ang = (i / (capN + 1)) * Math.PI / 2; ts.push({ t: t1, s: Math.cos(ang), tt: t1 + Math.sin(ang) * at(t1).rx / L * 0.8 }); }
  const pos: number[] = [], meta: { t: number; ang: number }[] = [];
  const pe = 2 / exp;
  for (const r of ts) {
    const c = at(r.t);
    for (let j = 0; j < radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const x = Math.sign(cs) * Math.abs(cs) ** pe * c.rx * r.s + c.ox, y = Math.sign(sn) * Math.abs(sn) ** pe * c.ry * r.s + c.oy;
      pos.push(a.x + d.x * r.tt * L + e1.x * x + e2.x * y, a.y + d.y * r.tt * L + e1.y * x + e2.y * y, a.z + d.z * r.tt * L + e1.z * x + e2.z * y);
      meta.push({ t: r.t, ang });
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < ts.length - 1; i++) for (let j = 0; j < radial; j++) {
    const a0 = i * radial + j, a1 = i * radial + ((j + 1) % radial), b0 = a0 + radial, b1 = a1 + radial;
    idx.push(a0, a1, b1, a0, b1, b0);
  }
  // pole vertices close the ends
  if (cap) {
    const n = ts.length;
    const first = ts[0], last = ts[n - 1];
    const ca = at(t0), cb = at(t1);
    const pole = (tt: number, c: { ox: number; oy: number }) => [a.x + d.x * tt * L + e1.x * c.ox + e2.x * c.oy, a.y + d.y * tt * L + e1.y * c.ox + e2.y * c.oy, a.z + d.z * tt * L + e1.z * c.ox + e2.z * c.oy];
    const p0 = pos.length / 3; pos.push(...pole(first.tt - ca.rx / L * 0.25, ca)); meta.push({ t: t0, ang: 0 });
    const p1 = pos.length / 3; pos.push(...pole(last.tt + cb.rx / L * 0.25, cb)); meta.push({ t: t1, ang: 0 });
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      idx.push(p0, j1, j);
      idx.push(p1, (n - 1) * radial + j, (n - 1) * radial + j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // outward check: flip winding if the first ring's normal points at the axis
  const nrm = g.getAttribute('normal');
  const v = new THREE.Vector3(pos[capN * radial * 3], pos[capN * radial * 3 + 1], pos[capN * radial * 3 + 2]);
  const axisPt = a.clone().addScaledVector(d, ts[capN].tt * L);
  if (new THREE.Vector3().fromBufferAttribute(nrm, capN * radial).dot(v.sub(axisPt)) < 0) {
    const ix = g.index!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
    g.computeVertexNormals();
  }
  return { geo: g, meta };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const M4 = (pos: THREE.Vector3, rot: THREE.Euler | null = null, scale: THREE.Vector3 | number = 1) =>
  new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler()), typeof scale === 'number' ? V(scale, scale, scale) : scale);
const sphere = (wSeg: number, hSeg: number, ts = 0, tl = Math.PI) => new THREE.SphereGeometry(1, wSeg, hSeg, 0, Math.PI * 2, ts, tl);
/** Set by buildBody: the far LOD uses plain boxes (12 triangles) instead of rounded ones. */
let LOW = false;
const rbox = (w: number, h: number, d: number, r: number, seg = 1) => {
  if (LOW) { const b = new THREE.BoxGeometry(w, h, d); b.deleteAttribute('uv'); return b; }
  const g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  g.deleteAttribute('uv');
  return g;
};
/** Capsule from a to b. */
function capsule(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 8) {
  const d = b.clone().sub(a);
  const g = new THREE.CapsuleGeometry(r, Math.max(1e-4, d.length()), 3, radial);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

// ------------------------------------------------------------------------------------------------- the body

const OLIVE = 0x4a4f3a, KHAKI = 0x8c7f62, BLACK = 0x1e1f21, BOOT = 0x2c241d, GLOVE = 0x2a2826, TAN = 0x8a6a48;

/**
 * Builds the merged skinned geometry for one look at one level of detail. `J` gives bind-pose joint positions,
 * `bones` the skeleton's bone order (skinIndex refers to it).
 */
export function buildBody(look: Look, lod: Lod, J: Joints, bones: readonly string[]): THREE.BufferGeometry {
  const D = DETAIL[lod];
  LOW = D.gear === 0;
  const B = new BodyBuilder(bones);
  const soldier = look.role === 'soldier';
  const top = soldier ? 0x6a6a5a : look.shirt;
  const topKind: Kind = soldier ? K.camo : K.cloth;
  const legKind: Kind = soldier ? K.camo : K.cloth;
  const legCol = soldier ? 0x6a6a5a : look.pants;

  // --- spine weights (+ the shoulder tops follow the shoulder bones)
  const spineW = chain([
    { bone: 'Hips', at: J('Hips') }, { bone: 'Abdomen', at: J('Abdomen'), r: 0.05 }, { bone: 'Torso', at: J('Torso'), r: 0.06 },
    { bone: 'Chest', at: J('Chest'), r: 0.06 }, { bone: 'Neck', at: J('Neck'), r: 0.03 }, { bone: 'Head', at: J('Head'), r: 0.03 },
  ]);
  const shoulderTop = J('ShoulderL').y;
  const torsoW = (p: THREE.Vector3): BoneW => {
    const k = sstep(0.075, 0.15, Math.abs(p.x)) * sstep(shoulderTop - 0.1, shoulderTop, p.y);
    return mixW(spineW(p), [[p.x >= 0 ? 'ShoulderL' : 'ShoulderR', 1]], k * 0.8);
  };
  const legW = chain([
    { bone: 'Hips', at: J('Hips') }, { bone: 'UpperLegL', at: J('UpperLegL'), r: 0.06 }, { bone: 'LowerLegL', at: J('LowerLegL'), r: 0.045 },
    { bone: 'FootL', at: V(J('FootL').x, 0.085, J('FootL').z), r: 0.03 },
  ]);
  const legSide = (p: THREE.Vector3) => (p.x >= 0 ? legW(p) : legW(V(-p.x, p.y, p.z)).map(([b, w]): [string, number] => [mirrorName(b), w]));
  const armW = chain([
    { bone: 'Chest', at: J('Chest') }, { bone: 'ShoulderL', at: J('ShoulderL').clone().setY(J('UpperArmL').y), r: 0.03 },
    { bone: 'UpperArmL', at: J('UpperArmL'), r: 0.035 }, { bone: 'LowerArmL', at: J('LowerArmL'), r: 0.035 }, { bone: 'WristL', at: J('WristL'), r: 0.022 },
  ]);
  const headW: BoneW = [['Head', 1]];

  // --- torso (pelvis → neck base): superelliptic sections, chest forward, glutes back
  const hz = J('Hips').z;
  const torso = loft(V(0, 0.79, hz), V(0, 1.505, hz), V(-1, 0, 0), [
    { t: 0.0, rx: 0.08, ry: 0.06, oy: 0 },
    { t: 0.1, rx: 0.155, ry: 0.098, oy: -0.004 },
    { t: 0.21, rx: 0.168, ry: 0.104, oy: -0.008 },
    { t: 0.36, rx: 0.148, ry: 0.094, oy: 0.0 },
    { t: 0.5, rx: 0.152, ry: 0.1, oy: 0.008 },
    { t: 0.64, rx: 0.17, ry: 0.112, oy: 0.012 },
    { t: 0.78, rx: 0.178, ry: 0.104, oy: 0.008 },
    { t: 0.87, rx: 0.165, ry: 0.088, oy: 0.0 },
    { t: 0.94, rx: 0.115, ry: 0.07, oy: -0.004 },
    { t: 1.0, rx: 0.062, ry: 0.058, oy: -0.004 },
  ], D.torso, Math.round(D.torso * 0.9), 2.4);
  // shirt / trousers split at the belt line; side seams on the shirt
  B.add(torso.geo, {
    color: top, kind: topKind, w: torsoW,
    seam: (p, i) => (Math.abs(Math.abs(Math.cos(torso.meta[i].ang)) - 1) < 0.02 && p.y > 0.98 ? 1 : 0),
  });

  // --- deltoids + upper arm + forearm (one loft, shoulder to wrist), mirrored
  const sh = J('UpperArmL'), el = J('LowerArmL'), wr = J('WristL');
  const sleeveEnd = !soldier && look.extra ? 0.42 : 1.0; // rolled sleeves stop above the elbow (t of the arm loft)
  const arm = loft(V(0.085, sh.y - 0.005, sh.z), wr.clone().add(V(0.012, 0, 0)), V(0, 1, 0), [
    { t: 0.0, rx: 0.05, ry: 0.06 },
    { t: 0.12, rx: 0.058, ry: 0.06 },
    { t: 0.24, rx: 0.052, ry: 0.054 },
    { t: 0.45, rx: 0.043, ry: 0.046 },
    { t: 0.53, rx: 0.041, ry: 0.043 },
    { t: 0.65, rx: 0.044, ry: 0.047, oy: 0.003 },
    { t: 0.9, rx: 0.033, ry: 0.037 },
    { t: 1.0, rx: 0.031, ry: 0.034 },
  ], D.limb, Math.round(D.limb * 1.4));
  // per-vertex: sleeve fabric up to the cuff, skin past a rolled sleeve
  const armGeo = arm.geo;
  const skinFrom = sleeveEnd < 1 ? sleeveEnd : 2;
  splitByT(B, armGeo, arm.meta, skinFrom, { color: top, kind: topKind }, { color: look.skin, kind: K.skin }, armW,
    (t, ang) => (Math.abs(Math.sin(ang) + 1) < 0.03 ? 1 : 0) + (Math.abs(t - Math.min(skinFrom, 0.97)) < 0.025 ? 1 : 0));
  if (sleeveEnd < 1) {
    // the rolled cuff: a thick ring of shirt above the elbow
    const cuffAt = V(0.085, sh.y - 0.005, sh.z).lerp(wr, sleeveEnd);
    B.add(new THREE.TorusGeometry(0.047, 0.011, 6, D.limb), { m: M4(cuffAt, new THREE.Euler(0, Math.PI / 2, 0)), color: look.shirt, kind: K.cloth, w: armW, mirror: true, seam: 0.5 });
  }

  // --- legs (hip → ankle, tucked into the boot), mirrored
  const hip = J('UpperLegL'), knee = J('LowerLegL'), foot = J('FootL');
  const leg = loft(V(hip.x - 0.008, 1.0, hip.z), V(foot.x, 0.18, foot.z + 0.005), V(1, 0, 0), [
    { t: 0.0, rx: 0.085, ry: 0.09, oy: 0.0 },
    { t: 0.1, rx: 0.088, ry: 0.095, oy: 0.005 },
    { t: 0.3, rx: 0.075, ry: 0.08, oy: 0.008 },
    { t: 0.46, rx: 0.058, ry: 0.062, oy: 0.01 },
    { t: 0.52, rx: 0.056, ry: 0.06, oy: 0.008 },
    { t: 0.66, rx: 0.06, ry: 0.066, oy: -0.008 },
    { t: 0.86, rx: 0.046, ry: 0.05, oy: 0.0 },
    { t: 1.0, rx: 0.044, ry: 0.048, oy: 0.004 },
  ], D.limb + 2, Math.round(D.limb * 1.4));
  B.add(leg.geo, { color: legCol, kind: legKind, w: legW, mirror: true, seam: (_p, i) => (Math.abs(Math.cos(leg.meta[i].ang) - 1) < 0.03 ? 1 : 0) });
  // seat / crotch filler so the trousers read as one garment
  B.add(sphere(Math.min(14, D.torso), Math.min(8, D.torso / 2)), { m: M4(V(0, 0.9, hz - 0.005), null, V(0.15, 0.1, 0.1)), color: legCol, kind: legKind, w: (p) => mixW([['Hips', 1]], legSide(p), sstep(0.04, 0.12, Math.abs(p.x)) * 0.6) });

  // --- boots
  const bootW = (p: THREE.Vector3) => legW(p);
  const fz = foot.z;
  const boot = rbox(0.104, 0.1, 0.27, D.gear ? 0.04 : 0.03, D.gear ? 2 : 1);
  shapeBoot(boot);
  B.add(boot, { m: M4(V(foot.x, 0.065, fz + 0.075)), color: soldier ? BOOT : 0x3a2c22, kind: K.leather, w: bootW, mirror: true });
  B.add(rbox(0.11, 0.028, 0.285, 0.012, 1), { m: M4(V(foot.x, 0.014, fz + 0.076)), color: 0x18171a, kind: K.polymer, w: bootW, mirror: true });
  const shaft = loft(V(foot.x, 0.07, fz + 0.006), V(foot.x, soldier ? 0.24 : 0.19, fz + 0.004), V(1, 0, 0), [
    { t: 0, rx: 0.05, ry: 0.06 }, { t: 0.5, rx: 0.051, ry: 0.056 }, { t: 1, rx: 0.056, ry: 0.06 },
  ], D.limb, 3, 2, false);
  B.add(shaft.geo, { color: soldier ? BOOT : 0x3a2c22, kind: K.leather, w: bootW, mirror: true, seam: (_p, i) => (shaft.meta[i].t > 0.95 ? 1 : 0) });
  if (D.gear >= 2) for (let k = 0; k < 4; k++) {
    // laces
    B.add(rbox(0.04, 0.006, 0.008, 0.002, 1), { m: M4(V(foot.x, 0.11 + k * 0.03, fz + 0.062 - k * 0.002)), color: 0x151413, kind: K.cloth, w: bootW, mirror: true });
  }

  // --- hands
  addHands(B, J, D, soldier || look.role === 'shop' ? (soldier ? GLOVE : 0x9a7b52) : look.skin, soldier || look.role === 'shop' ? K.leather : K.skin, look.skin);

  // --- neck + head
  const neck = loft(V(0, 1.45, hz - 0.01), V(0, 1.6, hz + 0.0), V(-1, 0, 0), [
    { t: 0, rx: 0.06, ry: 0.058 }, { t: 0.5, rx: 0.05, ry: 0.052 }, { t: 1, rx: 0.052, ry: 0.055 },
  ], Math.max(8, D.limb), 4, 2, false);
  B.add(neck.geo, { color: look.skin, kind: K.skin, w: spineW });
  addHead(B, look, D, J, headW);

  // --- clothing details / gear
  if (soldier) addSoldierGear(B, look, D, J, torsoW, spineW, armW, legW, legSide, headW);
  else addCivilian(B, look, D, J, torsoW, spineW, armW, headW);

  return B.build();
}

/** Arm loft vertices in two materials split at t (sleeve / skin). */
function splitByT(B: BodyBuilder, geo: THREE.BufferGeometry, meta: { t: number; ang: number }[], tSplit: number,
  a: { color: number; kind: Kind }, b: { color: number; kind: Kind }, w: Weigher, seam: (t: number, ang: number) => number) {
  if (tSplit > 1) { B.add(geo, { ...a, w, mirror: true, seam: (_p, i) => seam(meta[i].t, meta[i].ang) }); return; }
  // two copies of the same tube with the triangles on each side of the split
  const ix = geo.index!.array;
  const sel = (keep: (t: number) => boolean) => {
    const g = geo.clone();
    const out: number[] = [];
    for (let i = 0; i < ix.length; i += 3) {
      const t = (meta[ix[i]].t + meta[ix[i + 1]].t + meta[ix[i + 2]].t) / 3;
      if (keep(t)) out.push(ix[i], ix[i + 1], ix[i + 2]);
    }
    g.setIndex(out);
    return g;
  };
  B.add(sel((t) => t < tSplit), { ...a, w, mirror: true, seam: (_p, i) => seam(meta[i].t, meta[i].ang) });
  B.add(sel((t) => t >= tSplit), { ...b, w, mirror: true });
  geo.dispose();
}

/** Boot upper: lower, narrower toe box; heel stays full. */
function shapeBoot(g: THREE.BufferGeometry) {
  const P = g.getAttribute('position');
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const toe = sstep(0.0, 0.13, z); // front half
    P.setXYZ(i, x * (1 - 0.12 * toe), y < 0 ? y : y * (1 - 0.45 * toe), z);
  }
  g.computeVertexNormals();
}

function addHands(B: BodyBuilder, J: Joints, D: Detail, col: number, kind: Kind, skin: number) {
  const wr = J('WristL');
  const S = 0.9; // the rig's hands are a little big
  const sc = (v: THREE.Vector3) => v.clone().sub(wr).multiplyScalar(S).add(wr);
  const fingers = ['Index', 'Middle', 'Ring', 'Pinky'] as const;
  const end = (f: string) => J(`${f}4L`).clone().add(J(`${f}4L`).clone().sub(J(`${f}3L`)).multiplyScalar(0.9));
  // palm: weighted to the wrist, knuckle edge blends into the finger roots
  const palmW = (p: THREE.Vector3): BoneW => {
    const k = sstep(wr.x + 0.08, wr.x + 0.14, p.x);
    let best = 'Middle1L', bd = 1e9;
    for (const f of fingers) { const d = Math.abs(sc(J(`${f}2L`)).z - p.z); if (d < bd) { bd = d; best = `${f}1L`; } }
    return mixW([['WristL', 1]], [[best, 1]], k * 0.6);
  };
  const knuckX = sc(J('Middle2L')).x;
  const palmLen = knuckX - wr.x + 0.005;
  const zc = (sc(J('Index2L')).z + sc(J('Pinky2L')).z) / 2;
  const palm = D.hands ? rbox(palmLen, 0.032, 0.088, 0.014, 2) : sphere(8, 6);
  B.add(palm, { m: D.hands ? M4(V(wr.x + palmLen / 2 - 0.004, wr.y - 0.004, zc)) : M4(V(wr.x + 0.08, wr.y - 0.004, zc), null, V(0.09, 0.025, 0.048)), color: col, kind, w: D.hands ? palmW : [['WristL', 1]], mirror: true });
  if (D.hands === 0) return;
  if (D.hands === 2) {
    for (const f of fingers) {
      const j2 = sc(J(`${f}2L`)), j3 = sc(J(`${f}3L`)), j4 = sc(J(`${f}4L`)), tip = sc(end(f));
      const r = f === 'Pinky' ? 0.0078 : 0.0092;
      const g = loft(j2.clone().add(V(-0.012, 0, 0)), tip, V(0, 1, 0), [{ t: 0, rx: r * 1.05, ry: r * 1.1 }, { t: 0.5, rx: r, ry: r }, { t: 1, rx: r * 0.85, ry: r * 0.88 }], 6, 5);
      B.add(g.geo, { color: col, kind, w: chain([{ bone: `${f}1L`, at: j2.clone().add(V(-0.03, 0, 0)) }, { bone: `${f}2L`, at: j2, r: 0.008 }, { bone: `${f}3L`, at: j3, r: 0.006 }, { bone: `${f}4L`, at: j4, r: 0.006 }]), mirror: true });
    }
  } else {
    // mitten: one block over the four fingers, following the middle finger
    const j2 = sc(J('Middle2L')), tip = sc(end('Middle'));
    const g = loft(j2.clone().add(V(-0.01, 0, 0)), tip, V(0, 1, 0), [{ t: 0, rx: 0.011, ry: 0.042 }, { t: 1, rx: 0.009, ry: 0.036 }], 7, 3, 3);
    B.add(g.geo, { m: new THREE.Matrix4().makeTranslation(0, 0, zc - j2.z), color: col, kind, w: chain([{ bone: 'Middle1L', at: j2.clone().add(V(-0.03, 0, 0)) }, { bone: 'Middle2L', at: j2, r: 0.01 }, { bone: 'Middle3L', at: sc(J('Middle3L')), r: 0.008 }]), mirror: true });
  }
  const t1 = sc(J('Thumb1L')), t2 = sc(J('Thumb2L')), t3 = sc(J('Thumb3L'));
  const ttip = t3.clone().add(t3.clone().sub(t2).multiplyScalar(1.1));
  const th = loft(t1.clone().lerp(t2, 0.35), ttip, V(0, 1, 0), [{ t: 0, rx: 0.013, ry: 0.012 }, { t: 0.5, rx: 0.0105, ry: 0.0105 }, { t: 1, rx: 0.009, ry: 0.009 }], 7, 5);
  B.add(th.geo, { color: col, kind, w: chain([{ bone: 'Thumb1L', at: t1 }, { bone: 'Thumb2L', at: t2, r: 0.008 }, { bone: 'Thumb3L', at: t3, r: 0.006 }]), mirror: true });
  if (kind !== K.skin && D.hands === 2) {
    // glove cuff + knuckle guard on the back of the hand
    B.add(new THREE.TorusGeometry(0.036, 0.008, 6, 12), { m: M4(V(wr.x + 0.004, wr.y - 0.003, wr.z), new THREE.Euler(0, Math.PI / 2, 0), V(1, 0.75, 1)), color: col, kind, w: [['WristL', 0.7], ['LowerArmL', 0.3]], mirror: true });
    B.add(rbox(0.03, 0.012, 0.075, 0.005, 1), { m: M4(V(knuckX - 0.012, wr.y + 0.017, zc)), color: 0x1a1a1b, kind: K.polymer, w: palmW, mirror: true });
  }
  void skin;
}

/** Head shape: a unit-sphere direction → point on the skull/face surface (character space). */
export function headSurface(J: Joints) {
  const c = J('Head').clone().add(V(0, 0.085, 0.006));
  const eyeDir = V(0.38, 0.06, 0.92).normalize();
  const tmp = new THREE.Vector3();
  const f = (d: THREE.Vector3, out = new THREE.Vector3()) => {
    const u = tmp.copy(d).normalize();
    let { x, y, z } = u;
    const low = sstep(0.05, -0.95, y);
    const sx = 1 - 0.25 * low;
    if (z < 0) z *= 1 - 0.3 * sstep(0.0, -0.9, y) + 0.06 * sstep(0, 0.6, y);
    if (z > 0.55) z = 0.55 + (z - 0.55) * 0.62; // flatter face
    if (z > 0 && y < -0.55) z *= 1 - 0.1 * sstep(-0.55, -1, y); // chin underside
    // eye sockets
    let sock = 0;
    for (const s of [-1, 1]) {
      const dx = u.x - s * eyeDir.x, dy = u.y - eyeDir.y, dz = u.z - eyeDir.z;
      sock += Math.exp(-(dx * dx + dy * dy * 1.6 + dz * dz) / 0.012);
    }
    const k = 1 - 0.05 * sock;
    return out.set(c.x + x * 0.076 * sx * k, c.y + y * 0.114 * k, c.z + z * 0.096 * k);
  };
  return { c, f, eyeDir };
}

function addHead(B: BodyBuilder, look: Look, D: Detail, J: Joints, headW: BoneW) {
  const { c, f, eyeDir } = headSurface(J);
  // skull: a sphere pushed onto the head surface; stubble mask on the jaw/upper lip (surf.y)
  const g = sphere(D.headU, D.headV);
  const P = g.getAttribute('position');
  const stub: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const u = v.clone();
    f(u, v);
    P.setXYZ(i, v.x, v.y, v.z);
    const beardZone = sstep(-0.05, -0.4, u.y) * sstep(-0.35, 0.1, u.z) + sstep(0.2, 0.75, Math.abs(u.x)) * sstep(0.15, -0.2, u.y) * sstep(-0.3, 0.1, u.z) * 0.8;
    stub.push(look.beard ? Math.min(1, beardZone) * (look.beard === 1 ? 0.55 : 0.8) : Math.min(1, beardZone) * 0.15);
  }
  g.computeVertexNormals();
  const neckW = (p: THREE.Vector3): BoneW => mixW(headW, [['Neck', 1]], sstep(J('Head').y + 0.01, J('Head').y - 0.04, p.y) * sstep(0.03, -0.04, p.z - c.z) * 0.5);
  B.add(g, { color: look.skin, kind: K.skin, w: neckW, seam: (_p, i) => stub[i] });
  const nrm = (p: THREE.Vector3) => p.clone().sub(c).normalize();
  const skinDark = new THREE.Color(look.skin).multiplyScalar(0.82);

  // nose: bridge + tip + nostril wings
  const noseTip = f(V(0, -0.3, 1));
  const bridge = f(V(0, 0.02, 1));
  if (D.face >= 1) {
    const nose = capsule(bridge.clone().add(V(0, 0, -0.006)), noseTip.clone().add(V(0, 0.004, 0.012)), D.face > 1 ? 0.0085 : 0.009, D.face > 1 ? 8 : 6);
    B.add(nose, { color: look.skin, kind: K.skin, w: headW });
    B.add(sphere(8, 6), { m: M4(noseTip.clone().add(V(0, 0.0, 0.011)), null, V(0.0125, 0.011, 0.012)), color: look.skin, kind: K.skin, w: headW });
    if (D.face > 1) B.add(sphere(8, 6), { m: M4(noseTip.clone().add(V(0.0105, 0.002, 0.003)), null, V(0.0075, 0.0068, 0.0085)), color: look.skin, kind: K.skin, w: headW, mirror: true });
  }
  // ears
  const ear = f(V(1, 0.0, -0.08));
  B.add(sphere(D.face > 1 ? 10 : 6, D.face > 1 ? 8 : 5), { m: M4(ear.clone().add(V(0.004, -0.004, 0)), new THREE.Euler(0.15, -0.35, 0), V(0.01, 0.029, 0.018)), color: look.skin, kind: K.skin, w: headW, mirror: true });
  if (D.face === 0) return;

  // eyes: sclera sphere set into the socket, iris ring + pupil looking forward, a specular glint, upper lid
  const eyeSurf = f(eyeDir);
  const n = nrm(eyeSurf);
  const R = 0.0118;
  const eyeC = eyeSurf.clone().addScaledVector(n, -(R - 0.0042));
  B.add(sphere(D.face > 1 ? 12 : 8, D.face > 1 ? 10 : 6), { m: M4(eyeC, null, R), color: 0xe9e4dc, kind: K.eye, w: headW, mirror: true });
  const gaze = V(0.04, -0.02, 1).normalize();
  const irisM = (dz: number) => new THREE.Matrix4().compose(eyeC.clone().addScaledVector(gaze, R + dz), new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), gaze), V(1, 1, 1));
  B.add(new THREE.RingGeometry(0.0024, 0.0056, 14, 1), { m: irisM(0.0002), color: look.eyes, kind: K.eye, w: headW, mirror: true });
  B.add(new THREE.CircleGeometry(0.0025, 10), { m: irisM(0.0003), color: 0x050505, kind: K.eye, w: headW, mirror: true });
  if (D.face > 1) {
    B.add(new THREE.CircleGeometry(0.0011, 6), { m: irisM(0.0004).multiply(new THREE.Matrix4().makeTranslation(-0.0016, 0.0019, 0)), color: 0xffffff, kind: K.glint, w: headW, mirror: true });
    // upper + lower lids (skin shells over the eyeball)
    B.add(sphere(12, 4, 0, Math.PI * 0.36), { m: M4(eyeC, new THREE.Euler(0.55, 0, 0), R * 1.12), color: skinDark, kind: K.skin, w: headW, mirror: true });
    B.add(sphere(12, 3, Math.PI * 0.74, Math.PI * 0.26), { m: M4(eyeC, new THREE.Euler(-0.2, 0, 0), R * 1.1), color: look.skin, kind: K.skin, w: headW, mirror: true });
    // brows
    const b0 = f(V(0.17, 0.27, 1)).addScaledVector(nrm(f(V(0.17, 0.27, 1))), 0.002), b1 = f(V(0.6, 0.29, 0.8)).addScaledVector(nrm(f(V(0.6, 0.29, 0.8))), 0.001);
    B.add(capsule(b0, b1, 0.0042, 6), { m: new THREE.Matrix4().makeScale(1, 0.75, 1).premultiply(new THREE.Matrix4().makeTranslation(0, b0.y * 0.25, 0)), color: look.hair, kind: K.hair, w: headW, mirror: true });
    // lips + mouth line
    const m0 = f(V(0, -0.56, 1));
    B.add(capsule(m0.clone().add(V(-0.02, 0.004, 0.001)), m0.clone().add(V(0.02, 0.004, 0.001)), 0.0048, 6), { color: new THREE.Color(look.skin).lerp(new THREE.Color(0x9a4a44), 0.35), kind: K.skin, w: headW });
    B.add(capsule(m0.clone().add(V(-0.017, -0.006, 0.0)), m0.clone().add(V(0.017, -0.006, 0.0)), 0.0055, 6), { color: new THREE.Color(look.skin).lerp(new THREE.Color(0xa0524a), 0.3), kind: K.skin, w: headW });
    B.add(capsule(m0.clone().add(V(-0.022, -0.0005, 0.004)), m0.clone().add(V(0.022, -0.0005, 0.004)), 0.0016, 5), { color: 0x3a1c18, kind: K.skin, w: headW });
  }
  // beard: a shell over the jaw (full beard only)
  if (look.beard === 2) {
    const s = sphere(Math.max(10, D.headU), Math.max(8, D.headV));
    const SP = s.getAttribute('position');
    for (let i = 0; i < SP.count; i++) {
      v.fromBufferAttribute(SP, i);
      const u = v.clone();
      f(u, v);
      v.addScaledVector(nrm(v), 0.0055 * sstep(0.0, -0.5, u.y) + 0.0015);
      SP.setXYZ(i, v.x, v.y, v.z);
    }
    keepTris(s, (u) => (u.y < -0.32 && u.z > -0.3 && !(Math.abs(u.x) < 0.33 && u.y > -0.66 && u.z > 0.6)) || (u.y < 0.02 && Math.abs(u.x) > 0.7 && u.z > -0.2 && u.z < 0.55));
    s.computeVertexNormals();
    B.add(s, { color: look.hair, kind: K.hair, w: headW });
    // moustache
    if (D.face > 1) { const m0 = f(V(0, -0.44, 1)); B.add(capsule(m0.clone().add(V(-0.022, -0.006, -0.002)), m0.clone().add(V(0.022, -0.006, -0.002)), 0.006, 6), { color: look.hair, kind: K.hair, w: headW }); }
  }
  // hair: short at the back and sides (hidden under most headgear, shows below caps)
  if (look.head !== 'helmet' && look.head !== 'hardhat') {
    const s = sphere(Math.max(12, D.headU), Math.max(8, D.headV));
    const SP = s.getAttribute('position');
    const orig: THREE.Vector3[] = [];
    for (let i = 0; i < SP.count; i++) {
      v.fromBufferAttribute(SP, i); orig.push(v.clone());
      f(v.clone(), v);
      v.addScaledVector(nrm(v), 0.004);
      SP.setXYZ(i, v.x, v.y, v.z);
    }
    keepTris(s, (u) => u.y > -0.15 && u.z < 0.45 - Math.max(0, u.y) * 0.3 && !(Math.abs(u.x) > 0.8 && u.y < 0.15 && u.z > -0.25));
    s.computeVertexNormals();
    B.add(s, { color: look.hair, kind: K.hair, w: headW });
  }
}

/** Drops triangles whose unit-sphere vertices (the original SphereGeometry positions) fail `keep`. */
function keepTris(g: THREE.BufferGeometry, keep: (u: THREE.Vector3) => boolean) {
  // The positions were already moved; rebuild the unit directions from a fresh sphere of the same layout.
  const P = g.getAttribute('position');
  const p = (g as THREE.SphereGeometry).parameters as { widthSegments: number; heightSegments: number; phiStart: number; phiLength: number; thetaStart: number; thetaLength: number };
  const ref = new THREE.SphereGeometry(1, p.widthSegments, p.heightSegments, p.phiStart, p.phiLength, p.thetaStart, p.thetaLength).getAttribute('position');
  if (ref.count !== P.count) throw new Error('[body] keepTris: layout mismatch');
  const ix = g.index!.array, out: number[] = [];
  const u = new THREE.Vector3();
  const ok = (i: number) => keep(u.fromBufferAttribute(ref, i));
  for (let i = 0; i < ix.length; i += 3) if (ok(ix[i]) && ok(ix[i + 1]) && ok(ix[i + 2])) out.push(ix[i], ix[i + 1], ix[i + 2]);
  g.setIndex(out);
}

function addHeadgear(B: BodyBuilder, look: Look, D: Detail, J: Joints, headW: BoneW) {
  const { c, f } = headSurface(J);
  const seg = Math.max(8, D.headU - 4), hs = Math.max(5, Math.round(D.headV / 2));
  if (look.head === 'helmet') {
    // high-cut ballistic helmet with a fabric cover, team band, NVG shroud, side rails, ear pro, chin strap
    const hc = c.clone().add(V(0, 0.022, -0.004));
    const shell = sphere(seg, hs + 2, 0, Math.PI * 0.47);
    const SP = shell.getAttribute('position');
    for (let i = 0; i < SP.count; i++) {
      const x = SP.getX(i), y = SP.getY(i), z = SP.getZ(i);
      // high cut over the ears: lift the rim at the sides
      const lift = Math.abs(x) > 0.55 && y < 0.25 ? (0.25 - y) * 0.6 * sstep(0.55, 0.95, Math.abs(x)) : 0;
      SP.setXYZ(i, x, y + lift, z);
    }
    shell.computeVertexNormals();
    B.add(shell, { m: M4(hc, null, V(0.099, 0.104, 0.116)), color: 0x6a6a5a, kind: K.camo, w: headW });
    // rim lip + team band
    B.add(new THREE.TorusGeometry(1, 0.06, 4, seg), { m: M4(hc.clone().add(V(0, 0.01, 0)), new THREE.Euler(Math.PI / 2, 0, 0), V(0.101, 0.118, 0.1)), color: BLACK, kind: K.polymer, w: headW });
    B.add(new THREE.CylinderGeometry(1, 1, 1, seg, 1, true), { m: M4(hc.clone().add(V(0, 0.024, 0)), null, V(0.0985, 0.022, 0.1155)), color: 0xffffff, kind: K.team, w: headW });
    if (D.gear >= 1) {
      // NVG shroud on the front, side rails
      B.add(rbox(0.04, 0.03, 0.016, 0.006, 1), { m: M4(hc.clone().add(V(0, 0.062, 0.096)), new THREE.Euler(-0.6, 0, 0)), color: 0x2a2b2d, kind: K.metal, w: headW });
      B.add(rbox(0.012, 0.022, 0.085, 0.004, 1), { m: M4(hc.clone().add(V(0.097, 0.042, 0.0)), new THREE.Euler(0, 0, -0.18)), color: 0x262728, kind: K.polymer, w: headW, mirror: true });
      // ear pro cups + chin strap
      const ear = f(V(1, 0, -0.08));
      B.add(new THREE.CylinderGeometry(0.034, 0.036, 0.03, D.gear > 1 ? 14 : 8), { m: M4(ear.clone().add(V(0.014, 0, 0)), new THREE.Euler(0, 0, Math.PI / 2)), color: 0x3a3d33, kind: K.polymer, w: headW, mirror: true });
      if (D.gear > 1) {
        const a = hc.clone().add(V(0.09, -0.005, 0.03)), b = f(V(0.75, -0.6, 0.3)).add(V(0.006, 0, 0)), chin = f(V(0, -0.98, 0.2)).add(V(0, -0.004, 0));
        B.add(capsule(a, b, 0.0035, 5), { color: 0x1d1e1c, kind: K.cloth, w: headW, mirror: true });
        B.add(capsule(b, chin, 0.0035, 5), { color: 0x1d1e1c, kind: K.cloth, w: headW, mirror: true });
        if (look.extra) {
          // goggles pushed up on the helmet front: strap round the shell + two lenses
          B.add(new THREE.CylinderGeometry(1, 1, 1, seg, 1, true), { m: M4(hc.clone().add(V(0, 0.05, 0)), null, V(0.089, 0.014, 0.104)), color: 0x262626, kind: K.cloth, w: headW });
          for (const s of [-1, 1]) B.add(rbox(0.062, 0.032, 0.02, 0.011, 1), { m: M4(hc.clone().add(V(s * 0.033, 0.05, 0.1)), new THREE.Euler(-0.3, -s * 0.3, 0)), color: 0x5a4a20, kind: K.eye, w: headW });
        }
      }
    }
  } else if (look.head === 'cap' || look.head === 'flatcap') {
    const flat = look.head === 'flatcap';
    const hc = c.clone().add(V(0, flat ? 0.045 : 0.03, flat ? 0.004 : -0.002));
    B.add(sphere(seg, hs, 0, Math.PI * 0.5), { m: M4(hc, new THREE.Euler(flat ? 0.12 : 0, 0, 0), flat ? V(0.088, 0.058, 0.112) : V(0.086, 0.09, 0.104)), color: look.hat, kind: K.cloth, w: headW });
    B.add(new THREE.CylinderGeometry(1, 1, 1, seg, 1, false, -Math.PI * 0.42, Math.PI * 0.84), { m: M4(hc.clone().add(V(0, 0.002, 0.02)), new THREE.Euler(flat ? -0.12 : -0.1, 0, 0), V(0.088, 0.006, flat ? 0.105 : 0.135)), color: new THREE.Color(look.hat).multiplyScalar(0.85), kind: K.cloth, w: headW });
  } else if (look.head === 'hardhat') {
    const hc = c.clone().add(V(0, 0.04, -0.002));
    B.add(sphere(seg, hs + 1, 0, Math.PI * 0.5), { m: M4(hc, null, V(0.1, 0.1, 0.118)), color: look.hat, kind: K.polymer, w: headW });
    B.add(new THREE.CylinderGeometry(1, 1.1, 1, seg), { m: M4(hc.clone().add(V(0, -0.003, 0.012)), null, V(0.112, 0.008, 0.135)), color: look.hat, kind: K.polymer, w: headW });
    B.add(rbox(0.026, 0.02, 0.15, 0.008, 1), { m: M4(hc.clone().add(V(0, 0.095, 0)), null), color: new THREE.Color(look.hat).multiplyScalar(0.9), kind: K.polymer, w: headW });
  } else if (look.head === 'beanie') {
    const hc = c.clone().add(V(0, 0.03, -0.004));
    B.add(sphere(seg, hs, 0, Math.PI * 0.52), { m: M4(hc, null, V(0.087, 0.098, 0.103)), color: look.hat, kind: K.cloth, w: headW });
    B.add(new THREE.TorusGeometry(1, 0.13, 5, seg), { m: M4(hc.clone().add(V(0, 0.0, 0)), new THREE.Euler(Math.PI / 2, 0, 0), V(0.088, 0.104, 0.09)), color: look.hat, kind: K.cloth, w: headW, seam: 1 });
  }
}

function addSoldierGear(B: BodyBuilder, look: Look, D: Detail, J: Joints, torsoW: Weigher, spineW: Weigher, armW: Weigher, legW: Weigher, legSide: Weigher, headW: BoneW) {
  addHeadgear(B, look, D, J, headW);
  const hz = J('Hips').z;
  const g2 = D.gear >= 2, g1 = D.gear >= 1;
  const CAR = 0x55573f; // coyote/ranger plate carrier
  // plate carrier: front + back plates, cummerbund, shoulder straps
  B.add(rbox(0.3, 0.31, 0.055, 0.022, g2 ? 2 : 1), { m: M4(V(0, 1.245, hz + 0.155), new THREE.Euler(-0.05, 0, 0)), color: CAR, kind: K.cloth, w: spineW, seam: g1 ? (p) => (Math.abs(p.y - 1.385) < 0.006 ? 1 : 0) : 0 });
  B.add(rbox(0.3, 0.33, 0.05, 0.022, g2 ? 2 : 1), { m: M4(V(0, 1.25, hz - 0.125), new THREE.Euler(0.05, 0, 0)), color: CAR, kind: K.cloth, w: spineW });
  const cb = loft(V(0, 1.06, hz), V(0, 1.2, hz), V(-1, 0, 0), [{ t: 0, rx: 0.168, ry: 0.115, oy: 0.012 }, { t: 1, rx: 0.172, ry: 0.12, oy: 0.012 }], D.torso, 2, 2.4, false);
  B.add(cb.geo, { color: CAR, kind: K.cloth, w: spineW, seam: (_p, i) => (cb.meta[i].t < 0.05 || cb.meta[i].t > 0.95 ? 1 : 0) });
  for (const s of [-1, 1]) {
    const a = V(s * 0.095, 1.395, hz + 0.13), m = V(s * 0.105, 1.475, hz + 0.02), b = V(s * 0.095, 1.405, hz - 0.095);
    B.add(capsule(a, m, 0.016, 6), { color: CAR, kind: K.cloth, w: torsoW });
    B.add(capsule(m, b, 0.016, 6), { color: CAR, kind: K.cloth, w: torsoW });
  }
  // team ID patch on the front + mag pouches + admin pouch
  B.add(rbox(0.1, 0.045, 0.01, 0.004, 1), { m: M4(V(0, 1.355, hz + 0.186), new THREE.Euler(-0.05, 0, 0)), color: 0xffffff, kind: K.team, w: spineW });
  if (g1) for (let k = -1; k <= 1; k++) {
    B.add(rbox(0.07, 0.095, 0.04, 0.01, 1), { m: M4(V(k * 0.078, 1.165, hz + 0.2), new THREE.Euler(-0.05, 0, 0)), color: CAR, kind: K.cloth, w: spineW, seam: g2 ? (p) => (p.y > 1.2 ? 1 : 0) : 0 });
    if (g2) B.add(rbox(0.074, 0.03, 0.046, 0.008, 1), { m: M4(V(k * 0.078, 1.218, hz + 0.2), new THREE.Euler(-0.05, 0, 0)), color: new THREE.Color(CAR).multiplyScalar(0.85), kind: K.cloth, w: spineW });
  }
  if (g2) {
    B.add(rbox(0.13, 0.07, 0.025, 0.008, 1), { m: M4(V(0, 1.285, hz + 0.192), new THREE.Euler(-0.05, 0, 0)), color: CAR, kind: K.cloth, w: spineW, seam: (p) => (Math.abs(p.y - 1.31) < 0.004 ? 1 : 0) });
    // radio on the left side + antenna
    B.add(rbox(0.04, 0.12, 0.065, 0.01, 1), { m: M4(V(0.185, 1.14, hz + 0.01)), color: 0x2c2e2b, kind: K.polymer, w: spineW });
    B.add(capsule(V(0.19, 1.2, hz - 0.005), V(0.2, 1.47, hz - 0.03), 0.0035, 4), { color: 0x151515, kind: K.polymer, w: torsoW });
  }
  // belt + buckle + holster on the right thigh + dump pouch
  const belt = loft(V(0, 0.925, hz), V(0, 0.97, hz), V(-1, 0, 0), [{ t: 0, rx: 0.176, ry: 0.112, oy: -0.004 }, { t: 1, rx: 0.172, ry: 0.11, oy: -0.004 }], D.torso, 1, 2.4, false);
  B.add(belt.geo, { color: 0x2b2a26, kind: K.cloth, w: spineW });
  B.add(rbox(0.05, 0.04, 0.012, 0.004, 1), { m: M4(V(0, 0.947, hz + 0.115)), color: 0x6d6e6a, kind: K.metal, w: spineW });
  const hip = J('UpperLegR');
  if (g1) {
    B.add(rbox(0.05, 0.17, 0.1, 0.012, 1), { m: M4(V(hip.x - 0.085, 0.82, hip.z + 0.02), new THREE.Euler(0, 0, 0.06)), color: 0x262624, kind: K.polymer, w: legSide });
    if (g2) B.add(rbox(0.03, 0.06, 0.028, 0.008, 1), { m: M4(V(hip.x - 0.085, 0.925, hip.z + 0.045), new THREE.Euler(0.3, 0, 0.06)), color: 0x1c1d1f, kind: K.metal, w: spineW });
    B.add(rbox(0.11, 0.1, 0.06, 0.02, 1), { m: M4(V(0.115, 0.89, hz - 0.1), new THREE.Euler(0, 0.4, 0)), color: CAR, kind: K.cloth, w: spineW });
  }
  // knee + elbow pads
  const knee = J('LowerLegL');
  B.add(sphere(g2 ? 12 : 6, g2 ? 8 : 4, 0, Math.PI / 2), { m: M4(V(knee.x, knee.y - 0.01, knee.z + 0.03), new THREE.Euler(Math.PI / 2, 0, 0), V(0.05, 0.05, 0.065)), color: 0x262624, kind: K.polymer, w: legW, mirror: true });
  if (g2) B.add(sphere(10, 6, 0, Math.PI / 2), { m: M4(J('LowerArmL').clone().add(V(0, 0.0, -0.022)), new THREE.Euler(-Math.PI / 2, 0, 0), V(0.04, 0.03, 0.04)), color: 0x262624, kind: K.polymer, w: armW, mirror: true });
  // team armbands on both upper arms
  const ua = J('UpperArmL').clone().lerp(J('LowerArmL'), 0.55);
  B.add(new THREE.CylinderGeometry(1, 1, 1, D.limb, 1, true), { m: M4(ua, new THREE.Euler(0, 0, Math.PI / 2), V(0.05, 0.045, 0.052)), color: 0xffffff, kind: K.team, w: armW, mirror: true });
  // assault pack
  B.add(rbox(0.26, 0.3, 0.12, 0.04, g2 ? 2 : 1), { m: M4(V(0, 1.22, hz - 0.21)), color: CAR, kind: K.cloth, w: spineW, seam: g1 ? (p) => (Math.abs(p.z - (hz - 0.27)) < 0.006 ? 1 : 0) : 0 });
  if (g1) B.add(rbox(0.22, 0.12, 0.05, 0.02, 1), { m: M4(V(0, 1.15, hz - 0.285)), color: new THREE.Color(CAR).multiplyScalar(0.9), kind: K.cloth, w: spineW });
  void KHAKI; void OLIVE; void TAN;
}

function addCivilian(B: BodyBuilder, look: Look, D: Detail, J: Joints, torsoW: Weigher, spineW: Weigher, armW: Weigher, headW: BoneW) {
  addHeadgear(B, look, D, J, headW);
  const hz = J('Hips').z;
  // collar
  B.add(new THREE.TorusGeometry(0.058, 0.012, 5, Math.max(8, D.limb)), { m: M4(V(0, 1.47, hz + 0.004), new THREE.Euler(Math.PI / 2 + 0.25, 0, 0), V(1, 1.1, 1)), color: look.shirt, kind: K.cloth, w: torsoW, seam: 0.4 });
  // belt
  const belt = loft(V(0, 0.93, hz), V(0, 0.965, hz), V(-1, 0, 0), [{ t: 0, rx: 0.165, ry: 0.106, oy: -0.004 }, { t: 1, rx: 0.162, ry: 0.104, oy: -0.004 }], D.torso, 1, 2.4, false);
  B.add(belt.geo, { color: 0x2e2318, kind: K.leather, w: spineW });
  if (look.role === 'shop') {
    // hi-vis vest: an open shell over the torso with two reflective bands
    const vest = loft(V(0, 1.0, hz), V(0, 1.43, hz), V(-1, 0, 0), [
      { t: 0, rx: 0.165, ry: 0.112, oy: 0.002 }, { t: 0.55, rx: 0.165, ry: 0.115, oy: 0.012 }, { t: 0.85, rx: 0.176, ry: 0.112, oy: 0.012 }, { t: 1, rx: 0.15, ry: 0.098, oy: 0.004 },
    ], D.torso, Math.max(4, D.torso / 2), 2.4, false);
    // open at the front (zip line) and round the arm holes
    const keep = (i: number) => { const m = vest.meta[i]; const a = m.ang; const front = Math.abs(a - Math.PI / 2) < 0.12; return !front; };
    const ix = vest.geo.index!.array, out: number[] = [];
    for (let i = 0; i < ix.length; i += 3) if (keep(ix[i]) && keep(ix[i + 1]) && keep(ix[i + 2])) out.push(ix[i], ix[i + 1], ix[i + 2]);
    vest.geo.setIndex(out);
    B.add(vest.geo, { color: look.vest, kind: K.cloth, w: torsoW, seam: (_p, i) => (Math.abs(vest.meta[i].t - 0.0) < 0.02 ? 1 : 0) });
    for (const y of [1.11, 1.17]) {
      const band = loft(V(0, y, hz), V(0, y + 0.028, hz), V(-1, 0, 0), [{ t: 0, rx: 0.169, ry: 0.118, oy: 0.008 }, { t: 1, rx: 0.17, ry: 0.119, oy: 0.008 }], D.torso, 1, 2.4, false);
      const bi = band.geo.index!.array, bo: number[] = [];
      for (let i = 0; i < bi.length; i += 3) if ([bi[i], bi[i + 1], bi[i + 2]].every((k) => Math.abs(band.meta[k].ang - Math.PI / 2) > 0.14)) bo.push(bi[i], bi[i + 1], bi[i + 2]);
      band.geo.setIndex(bo);
      B.add(band.geo, { color: 0xc8cccf, kind: K.hivis, w: spineW });
    }
    // vertical bands over the shoulders
    for (const s of [-1, 1]) {
      B.add(capsule(V(s * 0.1, 1.2, hz + 0.122), V(s * 0.105, 1.44, hz + 0.05), 0.012, 5), { m: new THREE.Matrix4(), color: 0xc8cccf, kind: K.hivis, w: torsoW });
      B.add(capsule(V(s * 0.105, 1.44, hz + 0.05), V(s * 0.1, 1.2, hz - 0.112), 0.012, 5), { color: 0xc8cccf, kind: K.hivis, w: torsoW });
    }
    // radio/phone on the chest + a tape measure on the belt
    if (D.gear >= 1) B.add(rbox(0.05, 0.08, 0.025, 0.008, 1), { m: M4(V(-0.075, 1.3, hz + 0.13), new THREE.Euler(-0.1, 0, 0)), color: 0x1d1f22, kind: K.polymer, w: spineW });
    if (D.gear >= 1) B.add(rbox(0.06, 0.06, 0.035, 0.012, 1), { m: M4(V(0.15, 0.93, hz + 0.06)), color: 0xe0b020, kind: K.polymer, w: spineW });
  } else {
    // bib apron from chest to knees with a neck strap + pocket
    const apron = loft(V(0, 0.42, hz), V(0, 1.36, hz), V(-1, 0, 0), [
      { t: 0, rx: 0.175, ry: 0.125, oy: 0.02 }, { t: 0.45, rx: 0.18, ry: 0.122, oy: 0.012 }, { t: 0.56, rx: 0.17, ry: 0.106, oy: 0.006 },
      { t: 0.7, rx: 0.165, ry: 0.11, oy: 0.012 }, { t: 1, rx: 0.155, ry: 0.115, oy: 0.016 },
    ], D.torso, Math.max(5, D.torso / 2), 2.4, false);
    const ai = apron.geo.index!.array, ao: number[] = [];
    // front panel only: wide below the waist, a narrower bib above
    const ok = (k: number) => { const m = apron.meta[k]; const half = m.t > 0.58 ? 0.62 : 1.05; return Math.abs(m.ang - Math.PI / 2) < half; };
    for (let i = 0; i < ai.length; i += 3) if (ok(ai[i]) && ok(ai[i + 1]) && ok(ai[i + 2])) ao.push(ai[i], ai[i + 1], ai[i + 2]);
    apron.geo.setIndex(ao);
    // the skirt part follows the legs a little less stiffly: hips, blending to the upper legs low down
    B.add(apron.geo, { color: look.vest, kind: K.leather, w: (p) => (p.y > 0.95 ? (spineW as (p: THREE.Vector3) => BoneW)(p) : mixW([['Hips', 1]], [[p.x >= 0 ? 'UpperLegL' : 'UpperLegR', 1]], sstep(0.95, 0.55, p.y) * 0.55 * sstep(0.0, 0.08, Math.abs(p.x)))), seam: (_p, i) => (apron.meta[i].t < 0.03 ? 1 : 0) });
    for (const s of [-1, 1]) B.add(capsule(V(s * 0.075, 1.36, hz + 0.115), V(s * 0.05, 1.49, hz + 0.02), 0.007, 5), { color: look.vest, kind: K.leather, w: torsoW });
    if (D.gear >= 1) B.add(rbox(0.16, 0.09, 0.012, 0.01, 1), { m: M4(V(0, 0.82, hz + 0.135), new THREE.Euler(0.08, 0, 0)), color: new THREE.Color(look.vest).multiplyScalar(0.8), kind: K.leather, w: [['Hips', 1]], seam: 0.5 });
    // a corked flask hanging from the belt
    if (D.gear >= 1) {
      B.add(sphere(10, 8), { m: M4(V(-0.17, 0.86, hz + 0.05), null, V(0.035, 0.04, 0.035)), color: 0x7a3cc8, kind: K.eye, w: [['Hips', 1]] });
      B.add(capsule(V(-0.17, 0.89, hz + 0.05), V(-0.17, 0.93, hz + 0.05), 0.011, 6), { color: 0x9a7a4e, kind: K.leather, w: [['Hips', 1]] });
    }
  }
  void armW;
}
