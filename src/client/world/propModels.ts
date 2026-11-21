import * as THREE from 'three/webgpu';
import { DECAL, PROP_SPEC, type PropType, SIGN_TEXTS } from './clusters';
import { mat, merge, part, strut } from './geo';
import { MAP } from '../../sim/constants';
import { mats } from './materials';
import { canvasTex, makeRng } from './textures';
import { float, materialColor, mix, positionWorld, smoothstep, step, vec3 } from 'three/tsl';
import { worldNoise } from './pbr';

/**
 * One model per dock PropType: THE place each prop's geometry lives (propLayer.ts instances or bakes it). Origin at
 * the base centre, +Y up, front = -Z, sized to clusters.ts PROP_SPEC. A model is a few merged parts, one per
 * (material, tintable): tintable parts take the placement tint (instance colour), the rest keep their modelled colour.
 */
export type ModelPart = { material: THREE.Material; geometry: THREE.BufferGeometry; cast: boolean; tint: boolean };

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);

class Collector {
  private bins = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[]; tint: boolean }>();
  add(material: THREE.Material, geo: THREE.BufferGeometry, m: THREE.Matrix4 | null = null, col: THREE.ColorRepresentation = 0xffffff, tint = false) {
    const key = `${material.uuid}:${tint}`;
    let b = this.bins.get(key);
    if (!b) { b = { material, parts: [], tint }; this.bins.set(key, b); }
    b.parts.push(part(geo, m, col));
  }
  take(cast: boolean): ModelPart[] {
    return [...this.bins.values()].map((b) => ({ material: b.material, geometry: merge(b.parts), cast, tint: b.tint }));
  }
}

// ---------------------------------------------------------------- extra materials (shared)

let X: ReturnType<typeof makeExtra> | null = null;
function makeExtra() {
  const std = (name: string, o: ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0]) => {
    const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, ...o });
    m.name = name;
    return m;
  };
  const decal = new THREE.MeshStandardNodeMaterial({
    map: decalAtlas(), transparent: true, depthWrite: false, roughness: 0.7, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  decal.name = 'dockDecal';
  return {
    /** moulded plastic: bins, barriers, fish crates, cones, buoys, IBC tanks */
    plastic: plasticMaterial(std),
    sign: std('dockSign', { map: signAtlas(), roughness: 0.6 }),
    decal,
  };
}
export function propMaterials() {
  if (!X) X = makeExtra();
  return X;
}

/**
 * Moulded HDPE: sun-faded (lighter, less saturated) in noisy patches, fine scuff/scratch noise breaking up the
 * gloss, plus the shared grime gradient near the deck. All world-space, so every baked prop wears differently.
 */
function plasticMaterial(std: (n: string, o: ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0]) => THREE.MeshStandardNodeMaterial) {
  const m = std('plastic', { roughness: 0.5, metalness: 0 });
  const base = materialColor.rgb;
  const fade = smoothstep(0.35, 0.85, worldNoise(0.45)).mul(0.35);
  let c = mix(base, mix(vec3(base.r.add(base.g).add(base.b).div(3)), base, 0.6).mul(1.15), fade);
  const scuff = smoothstep(0.55, 0.8, worldNoise(4.0, 'g'));
  c = c.mul(mix(float(1), float(0.82), scuff.mul(0.6)));
  // grime gradient where it meets the deck (realism3's weathering.ts `weather()` can replace this at merge)
  const h = positionWorld.y.sub(MAP.groundY);
  const grime = float(1).sub(smoothstep(0.0, worldNoise(0.7, 'g').mul(0.45).add(0.25), h)).mul(step(-0.3, h)).mul(0.7);
  m.colorNode = mix(c, c.mul(vec3(0.5, 0.45, 0.38)), grime);
  m.roughnessNode = mix(mix(float(0.42), float(0.78), scuff.add(fade)), float(0.95), grime.mul(0.6));
  return m;
}

/** 4 × 2 atlas of flat ground decals (clusters.ts DECAL): a few dozen path ops, no per-pixel work. */
function decalAtlas() {
  const r = makeRng(77);
  return canvasTex(1024, 512, (g) => {
    g.clearRect(0, 0, 1024, 512);
    const cell = (i: number, f: () => void) => {
      g.save(); g.translate((i % 4) * 256, Math.floor(i / 4) * 256); g.beginPath(); g.rect(0, 0, 256, 256); g.clip(); f(); g.restore();
    };
    const blob = (x: number, y: number, rx: number, ry: number, rgb: string, a: number) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
      gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(0.6, `rgba(${rgb},${a * 0.7})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rx, ry, r.rr(0, 3), 0, 7); g.fill();
    };
    cell(DECAL.oil, () => { for (let k = 0; k < 7; k++) blob(128 + r.rr(-40, 40), 128 + r.rr(-40, 40), r.rr(30, 80), r.rr(25, 60), '24,20,16', r.rr(0.12, 0.26)); });
    cell(DECAL.oil2, () => {
      blob(118, 128, 70, 50, '24,20,16', 0.3);
      for (let k = 0; k < 18; k++) blob(128 + r.rr(-100, 100), 128 + r.rr(-90, 90), r.rr(4, 14), r.rr(4, 12), '24,20,16', r.rr(0.2, 0.4));
    });
    cell(DECAL.tyreMarks, () => {
      g.lineCap = 'round';
      for (const off of [-46, 46]) {
        g.strokeStyle = 'rgba(18,18,18,0.34)'; g.lineWidth = 30;
        g.beginPath(); g.moveTo(128 + off, 0); g.bezierCurveTo(128 + off + 30, 90, 128 + off - 30, 170, 128 + off + 10, 256); g.stroke();
        g.strokeStyle = 'rgba(10,10,10,0.25)'; g.lineWidth = 5; g.setLineDash([6, 9]);
        g.beginPath(); g.moveTo(128 + off, 0); g.bezierCurveTo(128 + off + 30, 90, 128 + off - 30, 170, 128 + off + 10, 256); g.stroke();
        g.setLineDash([]);
      }
    });
    cell(DECAL.crack, () => {
      g.strokeStyle = 'rgba(28,26,24,0.75)'; g.lineCap = 'round';
      const walk = (x: number, y: number, a: number, n: number, w: number) => {
        g.lineWidth = w; g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < n; k++) {
          a += r.rr(-0.5, 0.5); x += Math.cos(a) * 14; y += Math.sin(a) * 14; g.lineTo(x, y);
          if (k === 4 && n > 6) { g.stroke(); walk(x, y, a + r.rr(0.6, 1.1) * (r.rnd() < 0.5 ? -1 : 1), 6, w * 0.6); g.lineWidth = w; g.beginPath(); g.moveTo(x, y); }
        }
        g.stroke();
      };
      walk(128, 6, Math.PI / 2, 17, 3.2);
    });
    cell(DECAL.patch, () => {
      g.fillStyle = 'rgba(70,68,64,0.42)'; g.fillRect(34, 40, 188, 170);
      g.strokeStyle = 'rgba(30,28,26,0.55)'; g.lineWidth = 4; g.strokeRect(34, 40, 188, 170);
      g.strokeStyle = 'rgba(210,206,198,0.25)'; g.lineWidth = 2; g.strokeRect(40, 46, 176, 158);
      g.strokeStyle = 'rgba(30,28,26,0.4)'; g.beginPath(); g.moveTo(128, 40); g.lineTo(128, 210); g.stroke();
    });
    cell(DECAL.rust, () => { blob(128, 128, 90, 70, '120,62,28', 0.55); blob(128, 120, 40, 30, '90,44,20', 0.5); });
    cell(DECAL.arrow, () => {
      g.fillStyle = 'rgba(236,232,220,0.82)';
      g.beginPath(); g.moveTo(128, 20); g.lineTo(200, 100); g.lineTo(150, 100); g.lineTo(150, 236); g.lineTo(106, 236); g.lineTo(106, 100); g.lineTo(56, 100); g.closePath(); g.fill();
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(0,0,0,${r.rr(0.3, 0.9)})`; g.fillRect(r.rr(50, 200), r.rr(20, 236), r.rr(2, 10), r.rr(2, 8)); }
      g.globalCompositeOperation = 'source-over';
    });
    cell(DECAL.bay, () => {
      g.strokeStyle = 'rgba(232,184,28,0.85)'; g.lineWidth = 12;
      g.strokeRect(14, 14, 228, 228);
      g.lineWidth = 8;
      for (let k = -4; k <= 4; k++) { g.beginPath(); g.moveTo(14 + k * 50, 242); g.lineTo(14 + k * 50 + 60, 182); g.stroke(); }
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(0,0,0,${r.rr(0.3, 0.9)})`; g.fillRect(r.rr(0, 256), r.rr(0, 256), r.rr(2, 10), r.rr(2, 8)); }
      g.globalCompositeOperation = 'source-over';
    });
  });
}

/** Sign-board texts stacked in one texture (one material for every sign). */
function signAtlas() {
  const bgs = ['#1d4a6e', '#9a1c1c', '#f2f0e8', '#2f6b3a'];
  const fgs = ['#f4f1e8', '#f4f1e8', '#1a1a1a', '#f4f1e8'];
  return canvasTex(512, 256, (g) => {
    SIGN_TEXTS.forEach((t, i) => {
      g.fillStyle = bgs[i]; g.fillRect(0, i * 64, 512, 64);
      g.strokeStyle = fgs[i]; g.lineWidth = 3; g.strokeRect(6, i * 64 + 6, 500, 52);
      g.fillStyle = fgs[i]; g.font = '700 30px "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t, 256, i * 64 + 33, 480);
    });
  });
}

/** Unit plane on the ground with uvs mapped to one decal atlas cell. */
export function decalGeometry(cell: number) {
  const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const u = g.getAttribute('uv');
  const cx = cell % 4, cy = Math.floor(cell / 4);
  for (let i = 0; i < u.count; i++) u.setXY(i, (cx + u.getX(i)) / 4, 1 - (cy + 1 - u.getY(i)) / 2);
  return g;
}

/** Plane uvs → one sign atlas row. */
function signGeometry(row: number, w: number, h: number) {
  const g = new THREE.PlaneGeometry(w, h);
  const u = g.getAttribute('uv');
  const n = SIGN_TEXTS.length;
  for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i), 1 - (row + 1 - u.getY(i)) / n);
  return g;
}

/** Lumpy cone heap (unit radius 1, height 1) with a flattened top and a ragged toe. */
function heapGeometry(seed: number) {
  const r = makeRng(seed);
  const g = new THREE.CylinderGeometry(0.12, 1, 1, 22, 6, false);
  g.translate(0, 0.5, 0);
  const p = g.getAttribute('position');
  const ph = r.rr(0, 6);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x), rad = Math.hypot(x, z);
    if (rad < 1e-4) continue;
    const k = 1 + 0.08 * Math.sin(a * 3 + ph) + 0.05 * Math.sin(a * 7 + ph * 2) + 0.04 * Math.sin(y * 9 + a * 2);
    const sag = 1 - 0.12 * Math.sin(Math.PI * y); // concave flanks, like a tipped heap
    p.setXYZ(i, x * k * sag, y <= 1e-4 ? 0 : y * (1 + 0.05 * Math.sin(a * 5 + ph)), z * k * sag);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

/** Lumpy stone (unit ~0.3 wide, 0.1 high at scale 1). */
function stoneGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.25 * Math.sin(x * 3.1) * Math.cos(z * 2.7);
    p.setXYZ(i, x * k * 0.15, (y * k * 0.5 + 0.5) * 0.1, z * k * 0.15);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- models

type Build = (c: Collector) => void;

const MODELS: Record<Exclude<PropType, 'decal'>, Build> = {
  pallet: (c) => {
    const M = mats();
    for (const x of [-0.55, 0, 0.55]) c.add(M.wood, box(0.1, 0.1, 1.0), mat(x, 0.05, 0), 0xcfba92, true);
    for (let j = 0; j < 5; j++) c.add(M.wood, box(1.2, 0.022, 0.15), mat(0, 0.111, -0.425 + j * 0.2125), 0xe0cca8, true);
  },
  crate: (c) => {
    const M = mats();
    c.add(M.wood, box(0.76, 0.76, 0.76), mat(0, 0.38, 0), 0xffffff, true);
    for (const y of [0.03, 0.77]) c.add(M.wood, box(0.8, 0.06, 0.8), mat(0, y, 0), 0xb89c70, true);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.add(M.wood, box(0.06, 0.7, 0.06), mat(sx * 0.375, 0.4, sz * 0.375), 0xb89c70, true);
  },
  fishCrate: (c) => {
    const P = propMaterials().plastic;
    c.add(P, box(0.6, 0.02, 0.4), mat(0, 0.01, 0), 0xffffff, true);
    for (const s of [-1, 1]) {
      c.add(P, box(0.6, 0.3, 0.025), mat(0, 0.15, s * 0.19), 0xffffff, true);
      c.add(P, box(0.025, 0.3, 0.36), mat(s * 0.29, 0.15, 0), 0xffffff, true);
    }
    c.add(P, box(0.55, 0.04, 0.35), mat(0, 0.25, 0), 0xeef4f6); // ice / catch under a sheet
  },
  drum: (c) => {
    const M = mats();
    c.add(M.paint, cyl(0.29, 0.29, 0.86, 12), mat(0, 0.44, 0), 0xffffff, true);
    for (const y of [0.29, 0.59]) c.add(M.paint, new THREE.CylinderGeometry(0.297, 0.297, 0.025, 12, 1, true), mat(0, y, 0), 0xc0c0c0, true);
    c.add(M.dark, cyl(0.27, 0.27, 0.02, 12), mat(0, 0.875, 0), 0x6a6a6a);
    c.add(M.dark, cyl(0.03, 0.03, 0.02, 6), mat(0.15, 0.89, 0.05), 0x808080);
  },
  cone: (c) => {
    const P = propMaterials().plastic;
    c.add(P, new THREE.ConeGeometry(0.17, 0.62, 12, 1, true), mat(0, 0.36, 0), 0xffffff, true);
    c.add(P, box(0.42, 0.04, 0.42), mat(0, 0.02, 0), 0xffffff, true);
    c.add(P, cyl(0.093, 0.118, 0.1, 12), mat(0, 0.36, 0), 0xf2f2f0);
  },
  tyre: (c) => { c.add(mats().rubber, new THREE.TorusGeometry(0.4, 0.18, 5, 12).rotateX(Math.PI / 2), mat(0, 0.18, 0)); },
  sack: (c) => {
    const g = new THREE.SphereGeometry(1, 10, 6);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      p.setXYZ(i, x * 0.31 * (1 - 0.15 * y * y), (y * 0.5 + 0.5) * 0.24 * (1 - 0.1 * Math.abs(x)), z * 0.21);
    }
    g.computeVertexNormals();
    c.add(mats().burlap, g, null, 0xffffff, true);
  },
  bin: (c) => {
    const P = propMaterials().plastic, M = mats();
    c.add(P, cyl(0.29, 0.25, 0.92, 4).rotateY(Math.PI / 4).scale(1, 1, 1.22), mat(0, 0.5, 0), 0xffffff, true);
    c.add(P, box(0.6, 0.05, 0.76), mat(0, 0.985, 0.02, -0.05), 0xffffff, true);
    for (const s of [-1, 1]) c.add(M.rubber, cyl(0.1, 0.1, 0.05, 10).rotateZ(Math.PI / 2), mat(s * 0.24, 0.1, 0.3));
  },
  bag: (c) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.12 * Math.sin(x * 5 + z * 3);
      p.setXYZ(i, x * 0.28 * k, (y * 0.5 + 0.5) * 0.36, z * 0.28 * k);
    }
    g.computeVertexNormals();
    c.add(propMaterials().plastic, g, null, 0xffffff, true);
    c.add(propMaterials().plastic, cyl(0.02, 0.05, 0.08, 6), mat(0, 0.39, 0), 0x202020);
  },
  ibc: (c) => {
    const M = mats(), P = propMaterials().plastic;
    c.add(M.dark, box(1.2, 0.14, 1.0), mat(0, 0.07, 0), 0x3a3a3a);
    c.add(P, box(1.12, 0.94, 0.92), mat(0, 0.62, 0), 0xffffff, true);
    c.add(M.galv, cyl(0.12, 0.12, 0.06, 10), mat(0, 1.11, 0));
    for (const y of [0.2, 1.1]) for (const s of [-1, 1]) {
      c.add(M.galv, box(1.2, 0.025, 0.025), mat(0, y, s * 0.5));
      c.add(M.galv, box(0.025, 0.025, 1.0), mat(s * 0.6, y, 0));
    }
    for (const x of [-0.6, 0, 0.6]) for (const s of [-1, 1]) c.add(M.galv, box(0.025, 0.96, 0.025), mat(x, 0.64, s * 0.5));
    c.add(M.dark, cyl(0.05, 0.05, 0.12, 8).rotateX(Math.PI / 2), mat(0, 0.22, -0.5), 0x303030);
  },
  reel: (c) => {
    const M = mats();
    for (const s of [-1, 1]) c.add(M.wood, cyl(0.6, 0.6, 0.06, 16).rotateZ(Math.PI / 2), mat(s * 0.32, 0.6, 0), 0xffffff, true);
    c.add(M.rubber, cyl(0.42, 0.42, 0.58, 14).rotateZ(Math.PI / 2), mat(0, 0.6, 0), 0x2a2a2a);
    c.add(M.dark, cyl(0.07, 0.07, 0.72, 8).rotateZ(Math.PI / 2), mat(0, 0.6, 0), 0x505050);
  },
  barrier: (c) => {
    const P = propMaterials().plastic;
    const s = new THREE.Shape([V(-0.23, 0, 0), V(0.23, 0, 0), V(0.2, 0.22, 0), V(0.09, 0.3, 0), V(0.09, 0.72, 0), V(-0.09, 0.8, 0), V(-0.09, 0.3, 0), V(-0.2, 0.22, 0)].map((v) => new THREE.Vector2(v.x, v.y)));
    const g = new THREE.ExtrudeGeometry(s, { depth: 1.18, bevelEnabled: false }).translate(0, 0, -0.59).rotateY(Math.PI / 2);
    c.add(P, g, null, 0xffffff, true);
  },
  lobsterPot: (c) => {
    const M = mats();
    const half = new THREE.CylinderGeometry(0.26, 0.26, 0.78, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
    c.add(M.burlap, half, mat(0, 0.1, 0, 0, 0, 0, 1, 1, 1), 0xffffff, true);
    c.add(M.burlap, box(0.58, 0.1, 0.78), mat(0, 0.05, 0), 0xffffff, true);
    for (const z of [-0.38, 0, 0.38]) c.add(M.galv, new THREE.TorusGeometry(0.27, 0.01, 3, 10, Math.PI).rotateY(Math.PI / 2), mat(0, 0.1, z), 0x7a7a70);
  },
  buoy: (c) => {
    const P = propMaterials().plastic;
    c.add(P, new THREE.SphereGeometry(0.3, 12, 8), mat(0, 0.3, 0), 0xffffff, true);
    c.add(mats().dark, new THREE.TorusGeometry(0.07, 0.018, 4, 8), mat(0, 0.62, 0));
  },
  toolbox: (c) => {
    const M = mats();
    c.add(M.paint, box(0.5, 0.2, 0.22), mat(0, 0.1, 0), 0xffffff, true);
    c.add(M.dark, box(0.3, 0.025, 0.025), mat(0, 0.24, 0), 0x202020);
    for (const s of [-1, 1]) c.add(M.dark, box(0.02, 0.05, 0.02), mat(s * 0.14, 0.215, 0), 0x202020);
  },
  jerrycan: (c) => {
    const M = mats();
    c.add(M.paint, box(0.34, 0.38, 0.16), mat(0, 0.19, 0), 0xffffff, true);
    c.add(M.paint, box(0.22, 0.05, 0.05), mat(-0.04, 0.41, 0), 0xffffff, true);
    c.add(M.dark, cyl(0.025, 0.025, 0.05, 6), mat(0.12, 0.42, 0));
  },
  bucket: (c) => {
    c.add(propMaterials().plastic, cyl(0.15, 0.12, 0.3, 12, ), mat(0, 0.15, 0), 0xffffff, true);
    c.add(mats().galv, new THREE.TorusGeometry(0.15, 0.006, 3, 10, Math.PI), mat(0, 0.3, 0));
  },
  cleat: (c) => {
    const M = mats();
    c.add(M.dark, box(0.4, 0.05, 0.08), mat(0, 0.1, 0));
    for (const s of [-1, 1]) c.add(M.dark, box(0.06, 0.1, 0.08), mat(s * 0.09, 0.05, 0));
    c.add(M.dark, box(0.3, 0.012, 0.14), mat(0, 0.006, 0));
  },
  bitt: (c) => {
    const M = mats();
    c.add(M.dark, box(0.9, 0.06, 0.38), mat(0, 0.03, 0));
    for (const s of [-1, 1]) {
      c.add(M.dark, cyl(0.13, 0.14, 0.42, 12), mat(s * 0.27, 0.27, 0));
      c.add(M.dark, cyl(0.17, 0.17, 0.06, 12), mat(s * 0.27, 0.51, 0));
    }
  },
  lifeRing: (c) => {
    const M = mats(), P = propMaterials().plastic;
    c.add(M.galv, cyl(0.04, 0.04, 1.4, 6), mat(0, 0.7, 0.06));
    c.add(M.galv, box(0.5, 0.04, 0.04), mat(0, 1.32, 0.06));
    c.add(P, new THREE.TorusGeometry(0.26, 0.06, 6, 16), mat(0, 1.0, -0.02), 0xffffff, true);
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) c.add(P, box(0.07, 0.13, 0.13), mat(Math.cos(a) * 0.26, 1.0 + Math.sin(a) * 0.26, -0.02, 0, 0, a), 0xf2f2f0);
  },
  manhole: (c) => {
    const M = mats();
    c.add(M.dark, cyl(0.35, 0.36, 0.03, 18), mat(0, 0.015, 0), 0x3a3836);
    for (let k = -3; k <= 3; k++) c.add(M.dark, box(0.56 * Math.cos(Math.asin(Math.abs(k) / 4.2)), 0.008, 0.025), mat(0, 0.034, k * 0.075), 0x2a2826);
  },
  stone: (c) => { c.add(mats().rock, stoneGeometry(), null, 0xffffff, true); },
  coil: (c) => {
    const M = mats();
    for (let k = 0; k < 3; k++) c.add(M.rubber, new THREE.TorusGeometry(0.3 - k * 0.035, 0.03, 4, 12).rotateX(Math.PI / 2), mat(0, 0.03 + k * 0.045, 0), 0xffffff, true);
    c.add(M.rubber, cyl(0.028, 0.028, 0.7, 5).rotateZ(Math.PI / 2), mat(0.55, 0.03, 0.2, 0, 0.5, 0), 0xffffff, true);
  },
  fence: (c) => {
    const M = mats();
    c.add(M.galv, new THREE.CylinderGeometry(0.035, 0.035, 2.1, 6, 1, true), mat(-1.25, 1.05, 0));
    c.add(M.galv, new THREE.CylinderGeometry(0.022, 0.022, 2.5, 4, 1, true).rotateZ(Math.PI / 2), mat(0, 2.02, 0));
    const mesh = new THREE.PlaneGeometry(2.5, 1.95);
    const u = mesh.getAttribute('uv');
    for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i) * 2.5 / 0.12, u.getY(i) * 1.95 / 0.12);
    c.add(M.chain, mesh, mat(0, 1.05, 0), 0xb8bec2);
  },
  gate: (c) => {
    const M = mats();
    for (const s of [-1, 1]) c.add(M.galv, cyl(0.05, 0.05, 2.2, 8), mat(s * 1.5, 1.1, 0));
    for (const y of [0.15, 1.95]) c.add(M.paint, box(2.9, 0.06, 0.06), mat(0, y, 0), 0xffffff, true);
    for (const s of [-1, 1]) c.add(M.paint, box(0.06, 1.86, 0.06), mat(s * 1.42, 1.05, 0), 0xffffff, true);
    c.add(M.paint, box(0.05, 2.25, 0.05), mat(0, 1.05, 0, 0, 0, Math.atan2(2.84, 1.8)), 0xffffff, true);
    const mesh = new THREE.PlaneGeometry(2.8, 1.8);
    const u = mesh.getAttribute('uv');
    for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i) * 2.8 / 0.12, u.getY(i) * 1.8 / 0.12);
    c.add(M.chain, mesh, mat(0, 1.05, 0.02), 0xb8bec2);
  },
  rail: (c) => {
    const M = mats();
    c.add(M.steel, box(4, 0.02, 0.075), mat(0, 0.012, 0), 0xb8b0a4);
    c.add(M.dark, box(4, 0.004, 0.2), mat(0, 0.003, 0), 0x4a4640);
  },
  block: (c) => {
    const M = mats();
    c.add(M.concrete, box(1.58, 0.78, 0.78), mat(0, 0.39, 0), 0xffffff, true);
  },
  workbench: (c) => {
    const M = mats(), P = propMaterials();
    c.add(M.wood, box(2.0, 0.06, 0.8), mat(0, 0.89, 0), 0xd8c8a8);
    c.add(M.wood, box(1.9, 0.03, 0.7), mat(0, 0.22, 0), 0xc8b898);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.add(M.paint, box(0.05, 0.86, 0.05), mat(sx * 0.95, 0.43, sz * 0.36), 0x3a5a8a);
    c.add(M.dark, box(0.2, 0.12, 0.14), mat(0.85, 0.98, -0.3), 0x2a3a5a); // vise
    c.add(M.paint, box(2.0, 0.7, 0.03), mat(0, 1.27, 0.38), 0xc0c4c4); // pegboard
    for (let k = 0; k < 6; k++) c.add(M.dark, box(0.04, 0.22, 0.02), mat(-0.8 + k * 0.32, 1.3, 0.35, 0, 0, (k % 3 - 1) * 0.3), 0x505050);
    c.add(P.plastic, box(0.22, 0.3, 0.01), mat(-0.5, 1.2, 0.35), 0x8a6a3a); // clipboard
    c.add(P.plastic, box(0.18, 0.24, 0.005), mat(-0.5, 1.19, 0.345), 0xf4f2ea);
    c.add(P.plastic, box(0.3, 0.15, 0.2), mat(-0.7, 0.3, 0), 0x4a6a8a);
  },
  genset: (c) => {
    const M = mats();
    c.add(M.dark, box(1.6, 0.12, 0.9), mat(0, 0.06, 0), 0x404040);
    c.add(M.paint, box(1.5, 0.95, 0.85), mat(0, 0.6, 0), 0xffffff, true);
    for (let k = 0; k < 6; k++) c.add(M.dark, box(0.4, 0.02, 0.01), mat(-0.45, 0.4 + k * 0.08, -0.43), 0x303030);
    c.add(M.dark, box(0.35, 0.25, 0.02), mat(0.4, 0.75, -0.43), 0x202428);
    c.add(M.galv, cyl(0.05, 0.05, 0.3, 8), mat(0.55, 1.2, 0.2));
    c.add(M.paint, box(0.3, 0.02, 0.2), mat(-0.3, 1.08, 0.2), 0xe8e4dc);
  },
  compressor: (c) => {
    const M = mats();
    c.add(M.paint, cyl(0.25, 0.25, 0.95, 12).rotateZ(Math.PI / 2), mat(0, 0.36, 0), 0xffffff, true);
    c.add(M.dark, box(0.45, 0.32, 0.3), mat(0.1, 0.76, 0), 0x2a2a2a);
    for (const s of [-1, 1]) c.add(M.rubber, cyl(0.13, 0.13, 0.08, 10).rotateX(Math.PI / 2), mat(-0.35, 0.13, s * 0.29));
    c.add(M.galv, strut(V(0.45, 0.35, 0), V(0.62, 0.8, 0), 0.015, 5));
  },
  weldCart: (c) => {
    const M = mats();
    c.add(M.dark, box(0.5, 0.04, 0.4), mat(0, 0.08, 0), 0x2a2a2a);
    c.add(M.dark, box(0.04, 1.1, 0.04), mat(0, 0.6, 0.18), 0x2a2a2a);
    for (const s of [-1, 1]) c.add(M.rubber, cyl(0.1, 0.1, 0.05, 10).rotateZ(Math.PI / 2), mat(s * 0.27, 0.1, 0.12));
    const tanks: [number, number][] = [[-0.12, 0x2f6b3a], [0.12, 0x1a1a1a]];
    for (const [x, col] of tanks) {
      c.add(M.paint, cyl(0.1, 0.1, 1.2, 10), mat(x, 0.7, 0), col);
      c.add(M.galv, cyl(0.035, 0.05, 0.1, 6), mat(x, 1.36, 0), 0xc8a040);
    }
    c.add(M.rubber, new THREE.TorusGeometry(0.18, 0.012, 4, 14).rotateX(Math.PI / 2.4), mat(0, 1.1, 0.25), 0x8a2020);
  },
  dumpster: (c) => {
    const M = mats();
    const g = cyl(0.62, 0.5, 1.1, 4).rotateY(Math.PI / 4).scale(1.45, 1, 1);
    c.add(M.paint, g, mat(0, 0.62, 0), 0xffffff, true);
    c.add(M.paint, box(1.84, 0.05, 1.24), mat(0, 1.2, 0.03, -0.06), 0x3a3a3a);
    for (const s of [-1, 1]) c.add(M.paint, box(0.08, 0.08, 1.3), mat(s * 0.95, 0.8, 0), 0xffffff, true);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.add(M.rubber, cyl(0.06, 0.06, 0.05, 8).rotateZ(Math.PI / 2), mat(sx * 0.6, 0.06, sz * 0.4));
  },
  portacabin: (c) => {
    const M = mats(), P = propMaterials();
    c.add(M.corr, box(6, 2.45, 2.45), mat(0, 1.4, 0.45), 0xffffff, true);
    c.add(M.paint, box(6.1, 0.12, 2.55), mat(0, 2.68, 0.45), 0xd8d8d0);
    c.add(M.dark, box(6, 0.18, 2.4), mat(0, 0.09, 0.45), 0x303030);
    // windows (front = -Z), frames, door, steps, AC unit, clipboard by the door
    for (const x of [-2.1, -0.6, 2.2]) {
      c.add(M.dark, box(1.1, 0.8, 0.02), mat(x, 1.65, -0.785), 0x8aa4b8);
      c.add(M.galv, box(1.2, 0.05, 0.05), mat(x, 2.08, -0.77));
      c.add(M.galv, box(1.2, 0.05, 0.05), mat(x, 1.23, -0.77));
      for (const s of [-1, 1]) c.add(M.galv, box(0.05, 0.86, 0.05), mat(x + s * 0.58, 1.65, -0.77));
    }
    c.add(M.paint, box(0.9, 2.0, 0.04), mat(0.85, 1.18, -0.78), 0x5a6a7a);
    c.add(M.dark, box(0.4, 0.5, 0.02), mat(0.85, 1.7, -0.8), 0x8aa4b8);
    c.add(M.galv, box(1.2, 0.04, 0.8), mat(0.85, 0.36, -1.2));
    c.add(M.galv, box(1.2, 0.04, 0.3), mat(0.85, 0.18, -1.55));
    for (const s of [-1, 1]) c.add(M.galv, cyl(0.02, 0.02, 1.0, 5), mat(0.85 + s * 0.6, 0.86, -1.55));
    c.add(M.galv, box(0.7, 0.45, 0.35), mat(-2.2, 2.0, 1.84), 0xd8d8d0);
    c.add(P.plastic, box(0.22, 0.3, 0.01), mat(1.55, 1.45, -0.78), 0x8a6a3a);
    c.add(P.plastic, box(0.18, 0.24, 0.005), mat(1.55, 1.44, -0.787), 0xf4f2ea);
    c.add(P.sign, signGeometry(0, 1.6, 0.2).rotateY(Math.PI), mat(-1.4, 2.3, -0.79));
  },
  vending: (c) => {
    const M = mats(), P = propMaterials();
    c.add(M.paint, box(0.9, 1.85, 0.8), mat(0, 0.925, 0), 0xffffff, true);
    c.add(M.lit, box(0.6, 1.2, 0.02), mat(-0.1, 1.15, -0.405), 0x6a7a8a);
    for (let k = 0; k < 5; k++) c.add(M.lit, box(0.56, 0.03, 0.025), mat(-0.1, 0.65 + k * 0.24, -0.41), [0xd84a2a, 0x2a7ad8, 0xe8c82a, 0x3a9a5a, 0xe8e8e8][k]);
    c.add(M.dark, box(0.2, 0.5, 0.03), mat(0.32, 1.25, -0.41), 0x202020);
    c.add(M.dark, box(0.5, 0.18, 0.03), mat(-0.1, 0.3, -0.41), 0x101010);
      },
  bench: (c) => {
    const M = mats();
    for (let k = 0; k < 3; k++) c.add(M.wood, box(1.8, 0.04, 0.12), mat(0, 0.45, -0.15 + k * 0.14), 0xc8a878);
    for (let k = 0; k < 2; k++) c.add(M.wood, box(1.8, 0.12, 0.04), mat(0, 0.62 + k * 0.15, 0.24, -0.2), 0xc8a878);
    for (const s of [-1, 1]) {
      c.add(M.dark, box(0.06, 0.45, 0.5), mat(s * 0.8, 0.22, 0.02), 0x2a2a2a);
      c.add(M.dark, box(0.06, 0.45, 0.05), mat(s * 0.8, 0.62, 0.24, -0.2), 0x2a2a2a);
    }
  },
  bicycle: (c) => {
    const M = mats();
    for (const s of [-1, 1]) {
      c.add(M.rubber, new THREE.TorusGeometry(0.33, 0.022, 4, 18), mat(s * 0.52, 0.35, 0), 0x1a1a1a);
      c.add(M.galv, cyl(0.02, 0.02, 0.06, 6).rotateX(Math.PI / 2), mat(s * 0.52, 0.35, 0));
    }
    const f = (a: THREE.Vector3, b: THREE.Vector3) => c.add(M.paint, strut(a, b, 0.018, 5), null, 0xffffff, true);
    const bb = V(0, 0.32, 0), seat = V(-0.12, 0.85, 0), head = V(0.42, 0.85, 0);
    f(V(-0.52, 0.35, 0), bb); f(bb, seat); f(seat, head); f(bb, head); f(V(-0.52, 0.35, 0), seat); f(head, V(0.52, 0.35, 0));
    c.add(M.dark, box(0.22, 0.04, 0.1), mat(-0.14, 0.89, 0), 0x1a1a1a);
    c.add(M.galv, cyl(0.014, 0.014, 0.5, 5).rotateX(Math.PI / 2), mat(0.44, 0.95, 0));
  },
  signBoard: () => { /* per-row geometry: see signBoardModel */ },
  netPile: (c) => {
    const M = mats();
    const g = new THREE.SphereGeometry(0.6, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * (0.55 + 0.3 * Math.sin(p.getX(i) * 7 + p.getZ(i) * 5)));
    g.computeVertexNormals();
    c.add(M.burlap, g, mat(0, 0, 0, 0, 0, 0, 1.45, 1, 1.1), 0xffffff, true);
    for (let k = 0; k < 6; k++) c.add(M.paint, new THREE.SphereGeometry(0.07, 8, 6), mat(-0.7 + k * 0.28, 0.22 + 0.08 * Math.sin(k * 2), -0.3 + 0.12 * Math.cos(k * 3)), 0xe0a020);
  },
  tarpPile: (c) => {
    const M = mats();
    const w = 2.2, d = 1.8, h = 1.15;
    c.add(M.wood, box(w - 0.1, h - 0.05, d - 0.1), mat(0, (h - 0.05) / 2, 0), 0xb09a74);
    const g = new THREE.PlaneGeometry(w + 0.4, d + 0.4, 12, 12).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const out = Math.hypot(Math.max(0, Math.abs(x) - w / 2), Math.max(0, Math.abs(z) - d / 2));
      p.setY(i, (out > 0 ? h - Math.min(h - 0.03, out * 5) : h + 0.02) + Math.sin(x * 6.3) * Math.cos(z * 5.1) * 0.025);
    }
    g.computeVertexNormals();
    c.add(M.matte, g, null, 0xffffff, true);
    for (const sx of [-1, 1]) c.add(M.burlap, strut(V(sx * (w / 2 - 0.2), 0.05, -d / 2 - 0.2), V(sx * (w / 2 - 0.2), 0.05, d / 2 + 0.2), 0.012, 4), null, 0xb7a27a);
  },
  timber: (c) => {
    const M = mats();
    for (let layer = 0; layer < 4; layer++) {
      for (let k = 0; k < 7; k++) c.add(M.wood, box(3.6, 0.15, 0.17), mat(0, 0.175 + layer * 0.2, -0.54 + k * 0.18), 0xffffff, true);
      if (layer < 3) for (const x of [-1.4, 0, 1.4]) c.add(M.wood, box(0.08, 0.05, 1.3), mat(x, 0.275 + layer * 0.2, 0), 0x8a7050);
    }
    for (const x of [-1.4, 0, 1.4]) c.add(M.wood, box(0.12, 0.1, 1.3), mat(x, 0.05, 0), 0x6a5038);
  },
  rebar: (c) => {
    const M = mats();
    for (const x of [-2.2, 0, 2.2]) c.add(M.wood, box(0.15, 0.12, 0.9), mat(x, 0.06, 0), 0x6a5038);
    const rod = new THREE.CylinderGeometry(0.016, 0.016, 6, 4, 1, true).rotateZ(Math.PI / 2);
    for (let row = 0; row < 3; row++) for (let k = 0; k < 8 - row; k++) c.add(M.dark, rod, mat(0, 0.14 + row * 0.09, -0.32 + (k + row * 0.5) * 0.09), 0xffffff, true);
    for (const x of [-1.5, 1.5]) c.add(M.dark, new THREE.TorusGeometry(0.42, 0.006, 3, 12).rotateY(Math.PI / 2).scale(1, 0.45, 1), mat(x, 0.25, 0), 0x404040);
  },
  forklift: (c) => {
    const M = mats();
    // chassis runs along Z, forks out the front (-Z)
    c.add(M.paint, box(1.1, 0.75, 1.9), mat(0, 0.62, 0.2), 0xffffff, true);
    c.add(M.paint, box(1.12, 0.6, 0.5), mat(0, 0.75, 1.15), 0x303030); // counterweight
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.add(M.dark, box(0.06, 1.25, 0.06), mat(sx * 0.48, 1.6, 0.2 + sz * 0.55), 0x202020);
    c.add(M.dark, box(1.05, 0.06, 1.2), mat(0, 2.2, 0.2), 0x202020);
    c.add(M.dark, box(0.45, 0.4, 0.45), mat(0, 1.15, 0.45), 0x1a1a1a); // seat
    c.add(M.dark, cyl(0.15, 0.15, 0.03, 10).rotateX(-0.9), mat(0, 1.35, -0.15), 0x1a1a1a);
    for (const sx of [-1, 1]) c.add(M.galv, box(0.1, 2.1, 0.1), mat(sx * 0.35, 1.05, -0.8), 0x606060); // mast
    c.add(M.galv, box(0.8, 0.5, 0.06), mat(0, 0.45, -0.88), 0x505050); // carriage
    for (const sx of [-1, 1]) c.add(M.galv, box(0.1, 0.05, 1.1), mat(sx * 0.3, 0.06, -1.42), 0x404040);
    for (const sx of [-1, 1]) for (const z of [-0.45, 0.85]) c.add(M.rubber, cyl(0.26, 0.26, 0.22, 12).rotateZ(Math.PI / 2), mat(sx * 0.5, 0.26, z));
    c.add(M.lit, box(0.12, 0.08, 0.04), mat(0, 2.25, -0.4), 0xffa020);
  },
  gravelHeap: (c) => { c.add(mats().gravel, heapGeometry(5), mat(0, 0, 0, 0, 0, 0, 3.2, 2.0, 3.2), 0xffffff, true); },
  sandPile: (c) => { c.add(mats().gravel, heapGeometry(9), mat(0, 0, 0, 0, 0, 0, 2.6, 1.5, 2.6), 0xffffff, true); }, // sand-tinted gravel set: no extra material
  ladder: (c) => {
    const M = mats();
    // on the wall face (z = 0, water at -Z): rails from 3.2 m below the deck to hoops 1 m above it
    for (const s of [-1, 1]) {
      c.add(M.galv, box(0.05, 4.2, 0.05), mat(s * 0.22, -1.1, -0.12), 0x8a8a84);
      c.add(M.galv, new THREE.TorusGeometry(0.32, 0.025, 4, 10, Math.PI).rotateY(Math.PI / 2), mat(s * 0.22, 0.68, 0.2), 0x8a8a84);
    }
    for (let k = 0; k < 11; k++) c.add(M.galv, new THREE.CylinderGeometry(0.016, 0.016, 0.44, 4, 1, true).rotateZ(Math.PI / 2), mat(0, -3.0 + k * 0.3, -0.12), 0x7a7a74);
  },
  ladderLow: (c) => {
    const M = mats();
    for (const s of [-1, 1]) {
      c.add(M.galv, box(0.05, 3.8, 0.05), mat(s * 0.22, -1.9 + 0.0, -0.1), 0x8a8a84);
      c.add(M.galv, new THREE.TorusGeometry(0.14, 0.02, 4, 8, Math.PI).rotateY(Math.PI / 2), mat(s * 0.22, 0.0, 0.04), 0x8a8a84);
    }
    for (let k = 0; k < 11; k++) c.add(M.galv, new THREE.CylinderGeometry(0.014, 0.014, 0.44, 4, 1, true).rotateZ(Math.PI / 2), mat(0, -3.4 + k * 0.3, -0.1), 0x7a7a74);
  },
  ropeLoop: (c) => {
    const M = mats();
    // eye splice dropped over a bollard head (bollard: 0.42 tall + domed head) and the tail coiled beside it
    c.add(M.burlap, new THREE.TorusGeometry(0.21, 0.025, 4, 10).rotateX(Math.PI / 2 - 0.2), mat(0, 0.33, 0), 0xffffff, true);
    c.add(M.burlap, strut(V(0, 0.3, 0.2), V(0.35, 0.03, 0.42), 0.025, 5), null, 0xffffff, true);
    for (let k = 0; k < 2; k++) c.add(M.burlap, new THREE.TorusGeometry(0.2 - k * 0.03, 0.025, 4, 10).rotateX(Math.PI / 2), mat(0.42, 0.025 + k * 0.045, 0.5), 0xffffff, true);
  },
  tyreFender: (c) => {
    const M = mats();
    c.add(M.rubber, new THREE.TorusGeometry(0.4, 0.15, 6, 12), mat(0, -1.0, -0.05));
    c.add(M.dark, cyl(0.012, 0.012, 0.85, 4), mat(0, -0.25, 0.05), 0x404040);
  },
};

/** Sign board: two posts + a board showing SIGN_TEXTS[row] on both faces. */
function signBoardModel(c: Collector, row: number) {
  const M = mats(), P = propMaterials();
  for (const s of [-1, 1]) c.add(M.galv, cyl(0.035, 0.035, 2.2, 6), mat(s * 0.75, 1.1, 0));
  c.add(M.dark, box(1.8, 0.42, 0.04), mat(0, 1.85, 0), 0x303438);
  c.add(P.sign, signGeometry(row, 1.76, 0.38).rotateY(Math.PI), mat(0, 1.85, -0.025));
  c.add(P.sign, signGeometry(row, 1.76, 0.38), mat(0, 1.85, 0.025));
}

const cache = new Map<string, ModelPart[]>();
/** The merged parts of one prop model (cached). `variant` = sign row / decal cell. */
export function propModel(type: PropType, variant = 0): ModelPart[] {
  const key = `${type}:${type === 'signBoard' || type === 'decal' ? variant : 0}`;
  let out = cache.get(key);
  if (out) return out;
  const c = new Collector();
  if (type === 'decal') c.add(propMaterials().decal, decalGeometry(variant), null);
  else if (type === 'signBoard') signBoardModel(c, variant);
  else MODELS[type](c);
  out = c.take(PROP_SPEC[type].cast);
  cache.set(key, out);
  return out;
}
