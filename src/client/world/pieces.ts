import * as THREE from 'three/webgpu';
import {
  abs, attribute, bumpMap, float, max, mix, mx_noise_float, normalGeometry, normalLocal, normalMap, positionGeometry, positionLocal,
  pow, select, sin, smoothstep, step, texture, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { PIECES } from '../../sim/constants';
import type { PieceKind, PieceState } from '../../sim/types';
import { DAMAGE_TILE_M, damageTex } from './damageTex';
import { boxUV, mat, merge, part, strut } from './geo';
import { CONTAINER_COLORS } from './materials';
import { burlapTex, corrNormal, corrTex, makeRng, steelTex, woodTex } from './textures';

const KINDS: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- collision/ghost shapes (exact sim hulls)

/** Ramp: 2 wide, rises along local +Z from y=0 at z=-d/2 to y=h at z=+d/2 (matches the physics hull). */
function rampGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const x = w / 2, z = d / 2;
  const P = { a: [-x, 0, -z], b: [x, 0, -z], c: [-x, 0, z], e: [x, 0, z], f: [-x, h, z], g: [x, h, z] };
  const tris: number[][] = [
    [P.a, P.f, P.g], [P.a, P.g, P.b],
    [P.c, P.e, P.g], [P.c, P.g, P.f],
    [P.a, P.b, P.e], [P.a, P.e, P.c],
    [P.a, P.c, P.f],
    [P.b, P.g, P.e],
  ].map((t) => t.flat());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

/** Simple hull of a piece (origin at its base centre, like PieceState.pos). Used for ghost + raycasts. */
export function pieceGeometry(kind: PieceKind): THREE.BufferGeometry {
  const s = PIECES[kind];
  if (kind === 'ramp') return rampGeometry(s.w, s.h, s.d);
  const g = new THREE.BoxGeometry(s.w, s.h, s.d);
  g.translate(0, s.h / 2, 0);
  return g;
}

// ---------------------------------------------------------------- detailed visuals

type Slot = 'burlap' | 'wood' | 'corr' | 'steel' | 'galv' | 'paint';
type Visual = Partial<Record<Slot, THREE.BufferGeometry[]>>;
const push = (v: Visual, s: Slot, g: THREE.BufferGeometry, m: THREE.Matrix4 | null = null, col: THREE.ColorRepresentation = 0xffffff) => {
  (v[s] ??= []).push(part(g, m, col));
};

/** Squashed, slightly boxy pillow (one sandbag), unit size. */
const pillow = (() => {
  const g = new THREE.SphereGeometry(1, 10, 6);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const bx = Math.sign(x) * Math.pow(Math.abs(x), 0.55), bz = Math.sign(z) * Math.pow(Math.abs(z), 0.6);
    p.setXYZ(i, bx, y * (1 - 0.15 * Math.abs(bx)), bz);
  }
  g.computeVertexNormals();
  return g;
})();

function sandbags(): Visual {
  const v: Visual = {};
  const { h, d } = PIECES.sandbags;
  const rng = makeRng(7);
  const rows = 6, bh = h / rows;
  for (let r = 0; r < rows; r++) {
    const odd = r % 2 === 1;
    const xs = odd ? [-0.875, -0.5, 0, 0.5, 0.875] : [-0.75, -0.25, 0.25, 0.75];
    for (const zc of [-d / 4, d / 4]) for (const x of xs) {
      const half = odd && Math.abs(x) > 0.8;
      const L = (half ? 0.125 : 0.25) * rng.rr(0.94, 1.0);
      const tone = rng.rr(0.82, 1.05);
      push(v, 'burlap', pillow, mat(x + rng.rr(-0.015, 0.015), bh * (r + 0.5), zc + rng.rr(-0.015, 0.015), 0, rng.rr(-0.06, 0.06), rng.rr(-0.03, 0.03),
        L, (bh / 2) * 1.12, (d / 4) * 0.98), new THREE.Color(tone, tone * 0.98, tone * 0.93));
    }
  }
  return v;
}

function woodBarricade(): Visual {
  const v: Visual = {};
  const { w, h, d } = PIECES.wood;
  const rng = makeRng(11);
  const n = 8, ph = h / n;
  for (let k = 0; k < n; k++) {
    const g = boxUV(w - rng.rr(0, 0.04), ph - 0.008, 0.06, 2);
    const uvA = g.getAttribute('uv');
    for (let i = 0; i < uvA.count; i++) uvA.setY(i, uvA.getY(i) + ((k * 3) % 8) / 8);
    push(v, 'wood', g, mat(rng.rr(-0.01, 0.01), ph * (k + 0.5), -d / 2 + 0.03, 0, 0, rng.rr(-0.006, 0.006)), new THREE.Color().setScalar(rng.rr(0.85, 1.05)));
  }
  for (const x of [-0.8, 0.8]) push(v, 'wood', boxUV(0.12, h, 0.09, 2), mat(x, h / 2, -d / 2 + 0.105), 0xc8b8a0);
  const diag = Math.hypot(1.5, h - 0.3);
  push(v, 'wood', boxUV(0.1, diag, 0.05, 2), mat(0, h / 2, d / 2 - 0.025, 0, 0, Math.atan2(1.5, h - 0.3)), 0xb8a890);
  for (const y of [0.25, h - 0.25]) push(v, 'wood', boxUV(w - 0.1, 0.1, 0.05, 2), mat(0, y, d / 2 - 0.025), 0xc0b098);
  return v;
}

function metalSheet(): Visual {
  const v: Visual = {};
  const { w, h, d } = PIECES.metal;
  const g = new THREE.PlaneGeometry(w, h, 80, 16); // rows so damage can dent it
  const p = g.getAttribute('position');
  const pitch = 0.15, amp = 0.028;
  for (let i = 0; i < p.count; i++) p.setZ(i, -0.012 + amp * Math.sin((p.getX(i) / pitch) * Math.PI * 2));
  g.computeVertexNormals();
  const uvA = g.getAttribute('uv');
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, (uvA.getX(i) * w) / (28 * pitch), (uvA.getY(i) * h) / 2.5);
  push(v, 'corr', g, mat(0, h / 2, 0), 0xc4c8c8);
  // timber posts + rails behind (+Z side), inside the 0.1 depth
  for (const x of [-w / 2 + 0.12, w / 2 - 0.12]) push(v, 'wood', boxUV(0.09, h, 0.034, 2), mat(x, h / 2, d / 2 - 0.017), 0xa89880);
  for (const y of [0.35, h - 0.35]) push(v, 'wood', boxUV(w - 0.1, 0.09, 0.03, 2), mat(0, y, d / 2 - 0.015), 0xa89880);
  return v;
}

function steelPlate(): Visual {
  const v: Visual = {};
  const { w, h, d } = PIECES.steel;
  push(v, 'steel', boxUVSeg(w, h, 0.1, 1.25, 12, 14, 1), mat(0, h / 2, 0));
  // raised border frame + weld seam on the front (-Z)
  for (const y of [0.04, h - 0.04]) push(v, 'steel', boxUV(w, 0.08, 0.014, 1.25), mat(0, y, -0.057), 0x8a9298);
  for (const x of [-w / 2 + 0.04, w / 2 - 0.04]) push(v, 'steel', boxUV(0.08, h, 0.014, 1.25), mat(x, h / 2, -0.057), 0x8a9298);
  push(v, 'steel', boxUV(w - 0.16, 0.018, 0.008, 1.25), mat(0, h * 0.55, -0.053), 0x5a5f63);
  // bolts
  const bolt = new THREE.CylinderGeometry(0.022, 0.022, 0.016, 6).rotateX(Math.PI / 2);
  for (let k = 0; k <= 6; k++) for (const y of [0.04, h - 0.04]) push(v, 'galv', bolt, mat(-w / 2 + 0.1 + k * ((w - 0.2) / 6), y, -0.071), 0x6d7378);
  for (let k = 1; k < 8; k++) for (const x of [-w / 2 + 0.04, w / 2 - 0.04]) push(v, 'galv', bolt, mat(x, k * (h / 8), -0.071), 0x6d7378);
  // stiffeners on the back (+Z)
  for (const y of [0.7, h - 0.7]) push(v, 'steel', boxUV(w - 0.1, 0.12, 0.024, 1.25), mat(0, y, 0.062), 0x80878c);
  push(v, 'steel', boxUV(0.12, h - 0.2, 0.024, 1.25), mat(0, h / 2, 0.062), 0x80878c);
  return v;
}

function scaffold(): Visual {
  const v: Visual = {};
  const { w, h, d } = PIECES.scaffold;
  const rng = makeRng(23);
  // deck boards along Z
  const nb = 6, bw = w / nb;
  for (let k = 0; k < nb; k++) {
    const g = boxUV(d - 0.02, 0.045, bw - 0.012, 2).rotateY(Math.PI / 2);
    push(v, 'wood', g, mat(-w / 2 + bw * (k + 0.5), h - 0.0225, rng.rr(-0.01, 0.01)), new THREE.Color().setScalar(rng.rr(0.9, 1.1)).multiply(new THREE.Color(0xe6cfa4)));
  }
  // frame tubes
  const r = 0.024;
  for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) push(v, 'galv', strut(V(x, h - 0.08, -d / 2), V(x, h - 0.08, d / 2), r));
  for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) push(v, 'galv', strut(V(-w / 2, h - 0.08, z), V(w / 2, h - 0.08, z), r));
  // support posts (down into the water/ground, up to the deck frame), toe boards, braces — no handrails
  const down = -2.2;
  for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) {
    for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) push(v, 'galv', strut(V(x, down, z), V(x, h - 0.08, z), r));
    push(v, 'paint', new THREE.BoxGeometry(0.025, 0.15, d - 0.04), mat(x - Math.sign(x) * 0.01, h + 0.075, 0), 0xe8b81c);
    push(v, 'galv', strut(V(x, down + 0.3, -d / 2 + 0.03), V(x, h - 0.1, -0.02), 0.018));
    push(v, 'galv', strut(V(x, down + 0.3, d / 2 - 0.03), V(x, h - 0.1, 0.02), 0.018));
  }
  // couplers at the deck frame
  const coupler = new THREE.BoxGeometry(0.07, 0.07, 0.07);
  for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) push(v, 'paint', coupler, mat(x, h - 0.08, z), 0x3a3d40);
  return v;
}

function ramp(): Visual {
  const v: Visual = {};
  const { w, h, d } = PIECES.ramp;
  const a = Math.atan2(h, d), len = Math.hypot(h, d), t = 0.05;
  const off = new THREE.Vector3(0, -Math.cos(a), Math.sin(a)).multiplyScalar(t / 2);
  push(v, 'wood', boxUV(w - 0.04, t, len, 2), mat(off.x, h / 2 + off.y, off.z, -a, 0, 0), 0xd8c0a0);
  // anti-slip cleats
  const n = 8;
  for (let k = 1; k < n; k++) {
    const s = k / n;
    push(v, 'wood', boxUV(w - 0.12, 0.025, 0.05, 2), mat(0, s * h + 0.012, -d / 2 + s * d, -a, 0, 0), 0x9a8468);
  }
  // steel side stringers (triangles) + back frame
  const tri = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(d / 2, h)]);
  const side = new THREE.ExtrudeGeometry(tri, { depth: 0.03, bevelEnabled: false });
  const su = side.getAttribute('uv');
  for (let i = 0; i < su.count; i++) su.setXY(i, su.getX(i) / 1.25, su.getY(i) / 1.25);
  // shape x → local +Z, shape y → Y, extrusion → local -X (rotateY(-90°))
  for (const x of [-w / 2 + 0.03, w / 2]) push(v, 'steel', side, mat(x, 0, 0, 0, -Math.PI / 2, 0), 0x7c8287);
  push(v, 'steel', boxUV(w, h - 0.02, 0.04, 1.25), mat(0, (h - 0.02) / 2, d / 2 - 0.02), 0x7c8287);
  return v;
}

function containerPiece(): Visual {
  const v: Visual = {};
  const { w: L, h: H, d: D } = PIECES.container;
  push(v, 'corr', boxUVSeg(L - 0.1, H - 0.14, D - 0.08, 7.8, 30, 12, 12), mat(0, H / 2, 0));
  for (const y of [0.07, H - 0.07]) for (const z of [-D / 2 + 0.05, D / 2 - 0.05]) push(v, 'paint', new THREE.BoxGeometry(L, 0.14, 0.1), mat(0, y, z), 0x8a8a8a);
  for (const y of [0.07, H - 0.07]) for (const x of [-L / 2 + 0.05, L / 2 - 0.05]) push(v, 'paint', new THREE.BoxGeometry(0.1, 0.14, D), mat(x, y, 0), 0x8a8a8a);
  for (const x of [-L / 2 + 0.07, L / 2 - 0.07]) for (const z of [-D / 2 + 0.07, D / 2 - 0.07]) push(v, 'paint', new THREE.BoxGeometry(0.14, H, 0.14), mat(x, H / 2, z), 0x8a8a8a);
  // corner castings
  for (const x of [-L / 2 + 0.09, L / 2 - 0.09]) for (const z of [-D / 2 + 0.09, D / 2 - 0.09]) for (const y of [0.09, H - 0.09]) push(v, 'galv', new THREE.BoxGeometry(0.18, 0.12, 0.17), mat(x, y, z), 0x55585a);
  // doors at +X: two leaves, locking bars, handles, hinges
  const dx = L / 2 - 0.03;
  for (const z of [-D / 4, D / 4]) push(v, 'corr', boxUV(0.03, H - 0.3, D / 2 - 0.08, 3), mat(dx, H / 2, z), 0xe4e4e4);
  push(v, 'paint', new THREE.BoxGeometry(0.035, H - 0.3, 0.025), mat(dx + 0.005, H / 2, 0), 0x6a6a6a);
  for (const z of [-0.85, -0.3, 0.3, 0.85]) {
    push(v, 'galv', new THREE.CylinderGeometry(0.022, 0.022, H - 0.32, 6), mat(L / 2 + 0.008, H / 2, z), 0xa9aeb2);
    push(v, 'galv', new THREE.BoxGeometry(0.03, 0.04, 0.22), mat(L / 2 + 0.02, H * 0.42, z + 0.1), 0xa9aeb2);
  }
  for (const z of [-D / 2 + 0.12, D / 2 - 0.12]) for (const y of [0.5, 1.3, 2.1]) push(v, 'galv', new THREE.BoxGeometry(0.04, 0.12, 0.05), mat(dx + 0.01, y, z), 0x6a6e70);
  return v;
}

const BUILDERS: Record<PieceKind, () => Visual> = {
  sandbags, wood: woodBarricade, metal: metalSheet, steel: steelPlate, scaffold, ramp, container: containerPiece,
};

// ---------------------------------------------------------------- materials with damage

/** BoxGeometry with segments whose UVs are metres / `tile` (same face mapping as boxUV), so damage can displace it. */
function boxUVSeg(w: number, h: number, d: number, tile: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
  const uvA = g.getAttribute('uv') as THREE.BufferAttribute, nA = g.getAttribute('normal');
  for (let i = 0; i < uvA.count; i++) {
    const ax = Math.abs(nA.getX(i)), ay = Math.abs(nA.getY(i));
    const [su, sv] = ax > 0.5 ? [d, h] : ay > 0.5 ? [w, d] : [w, h];
    uvA.setXY(i, (uvA.getX(i) * su) / tile, (uvA.getY(i) * sv) / tile);
  }
  return g;
}

type Style = 'burlap' | 'wood' | 'sheet' | 'steel' | 'trim';
type DmgOpts = {
  style: Style;
  /** Holes (alpha-tested): fraction of surface missing = (damage - start) * gain. */
  hole?: [number, number];
  /** Vertex dents along piece-local +Z (plates) or inward along the normal (container walls). */
  dent?: 'z' | 'in';
  dentDepth?: number;
  /** Steel plate bows out at low hp. */
  bow?: boolean;
  /** Sandbags: top courses slump. */
  slump?: boolean;
  /** Scaffold: deck sags between the posts. */
  sag?: boolean;
};

function dmgOpts(kind: PieceKind, slot: Slot): DmgOpts {
  switch (kind) {
    case 'sandbags': return { style: 'burlap', slump: true };
    case 'wood': return { style: 'wood', hole: [0.42, 0.85] };
    case 'metal': return slot === 'corr' ? { style: 'sheet', hole: [0.5, 0.7], dent: 'z', dentDepth: 0.1 } : { style: 'wood' };
    case 'steel': return slot === 'steel'
      ? { style: 'steel', hole: [0.68, 0.55], dent: 'z', dentDepth: 0.05, bow: true }
      : { style: 'trim', dent: 'z', dentDepth: 0.05, bow: true };
    case 'scaffold': return slot === 'wood' ? { style: 'wood', hole: [0.48, 0.75], sag: true } : { style: 'trim', sag: true };
    case 'ramp': return slot === 'wood' ? { style: 'wood', hole: [0.45, 0.8] } : { style: 'steel' };
    case 'container': return slot === 'corr' ? { style: 'sheet', hole: [0.55, 0.6], dent: 'in', dentDepth: 0.16 } : { style: 'trim' };
  }
}

const SLOT_BASE: Record<Slot, { map?: () => THREE.Texture; normal?: () => THREE.Texture; rough: number; metal: number; side?: THREE.Side }> = {
  burlap: { map: burlapTex, rough: 0.97, metal: 0 },
  wood: { map: woodTex, rough: 0.82, metal: 0 },
  corr: { map: corrTex, normal: corrNormal, rough: 0.5, metal: 0.55, side: THREE.DoubleSide },
  steel: { map: steelTex, rough: 0.42, metal: 0.75 },
  galv: { rough: 0.38, metal: 0.85 },
  paint: { rough: 0.6, metal: 0.25 },
};

type N = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
const below = (x: N, t: N, k: number) => float(1).sub(smoothstep(t.sub(k), t.add(k), x));

/**
 * Per-instance `dmg` vec4 = (damage 0..1, seed, sin rotY, cos rotY). Damage is drawn from damageTex sampled by box
 * projection of piece-local position, so every part of a piece cracks/holes coherently. Tiers: <0.25 a few hairline
 * cracks; 0.25–0.6 cracks, grime/soot, tears, rust, dents; >0.6 holes with splintered/torn rims, slump/sag/bow.
 */
function slotMaterial(kind: PieceKind, slot: Slot): THREE.MeshStandardNodeMaterial {
  const b = SLOT_BASE[slot];
  const o = dmgOpts(kind, slot);
  const spec = PIECES[kind];
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: b.rough, metalness: b.metal, side: b.side ?? THREE.FrontSide });
  m.name = `piece:${kind}:${slot}`;
  const dt = damageTex();
  const info = attribute('dmg', 'vec4');
  const d = info.x;
  const projUV = (p: typeof positionGeometry, n: typeof normalGeometry) => {
    const a = abs(n);
    return select(a.y.greaterThan(max(a.x, a.z)), p.xz, select(a.x.greaterThan(a.z), p.zy, p.xy))
      .div(DAMAGE_TILE_M).add(info.y.mul(vec2(0.37, 0.71)));
  };
  const puv = projUV(positionGeometry, normalGeometry);
  const s = texture(dt, puv);
  const on = smoothstep(0.02, 0.08, d); // pristine at full hp
  const reveal = below(s.g, d.mul(1.6), 0.04).mul(on);
  const crackCore = smoothstep(0.75, 0.95, s.r).mul(reveal);
  const crackHalo = smoothstep(0.12, 0.35, s.r).mul(reveal);
  // soot/grime patches, broken up by the streak channel so they read as runs and smears rather than flat blobs
  const grime = below(s.g, d.mul(1.15), 0.2).mul(smoothstep(0.08, 0.45, d)).mul(s.b.mul(0.6).add(0.45).clamp(0, 1));
  const heavy = smoothstep(0.5, 0.85, d);
  const holeT = o.hole ? d.sub(o.hole[0]).mul(o.hole[1]) : float(-1);
  const hasHole = step(0.001, holeT);
  const rim = below(s.g, holeT.add(0.022), 0.006).mul(hasHole);

  let col = (b.map ? texture(b.map(), uv()).rgb : vec3(1, 1, 1)) as unknown as V3;
  let wear: N = float(0); // 0..1: how much the surface turned to rough, non-metal grime/rust/char
  const SAND = vec3(0.84, 0.7, 0.46);
  switch (o.style) {
    case 'burlap': {
      col = col.mul(mix(vec3(1, 1, 1), vec3(0.45, 0.38, 0.3), grime));
      col = mix(col, vec3(0.12, 0.08, 0.05), crackHalo.mul(0.85));
      col = mix(col, SAND, crackCore);
      col = mix(col, SAND, smoothstep(0.35, 0.8, normalGeometry.y).mul(grime).mul(0.75)); // sand spilled on top
      col = col.mul(float(1).sub(d.mul(0.3)).sub(heavy.mul(0.1))); // whole wall dirties as it's shot up
      break;
    }
    case 'wood': {
      col = col.mul(mix(vec3(1, 1, 1), vec3(0.62, 0.56, 0.5), grime));
      col = mix(col, vec3(0.08, 0.055, 0.035), crackHalo.mul(0.9));
      const char = below(s.g, holeT.add(0.14), 0.05).mul(hasHole);
      col = mix(col, vec3(0.1, 0.08, 0.06), char.mul(0.7));
      col = mix(col, vec3(1.0, 0.8, 0.52), rim); // fresh splintered wood
      break;
    }
    case 'sheet': {
      const rust = smoothstep(0.52, 0.78, s.b).mul(below(s.g, d.mul(1.4), 0.15)).mul(smoothstep(0.15, 0.55, d));
      col = mix(col, vec3(0.06, 0.055, 0.05), grime.mul(0.72));
      col = mix(col, vec3(0.42, 0.18, 0.06), rust.mul(0.85));
      col = mix(col, vec3(0.04, 0.04, 0.04), crackHalo.mul(smoothstep(0.3, 0.6, d)).mul(0.6));
      col = mix(col, vec3(0.72, 0.73, 0.75), rim); // torn bare-metal edge
      wear = max(grime.mul(0.7), rust).mul(float(1).sub(rim));
      break;
    }
    case 'steel': {
      const k = d.mul(1.15);
      const temper = below(s.g, k.add(0.1), 0.06).sub(below(s.g, k.sub(0.02), 0.06)).clamp(0, 1).mul(smoothstep(0.1, 0.4, d));
      col = mix(col, vec3(0.5, 0.42, 0.3), temper.mul(0.35)); // heat-tint ring around scorch
      col = mix(col, vec3(0.05, 0.045, 0.04), grime.mul(0.78));
      col = mix(col, vec3(0.03, 0.03, 0.03), crackCore.mul(smoothstep(0.55, 0.8, d)));
      col = mix(col, vec3(0.78, 0.79, 0.8), rim);
      wear = grime.mul(0.75).mul(float(1).sub(rim));
      break;
    }
    case 'trim': {
      const rust = smoothstep(0.55, 0.8, s.b).mul(grime);
      col = mix(col, vec3(0.06, 0.055, 0.05), grime.mul(0.65));
      col = mix(col, vec3(0.4, 0.18, 0.07), rust.mul(0.6));
      wear = grime.mul(0.65);
      break;
    }
  }
  m.colorNode = vec4(col, 1);
  if (o.style === 'sheet' || o.style === 'steel' || o.style === 'trim') {
    m.roughnessNode = mix(float(b.rough), float(0.95), wear);
    m.metalnessNode = mix(float(b.metal), float(0.1), wear);
  }
  if (o.hole) {
    m.opacityNode = step(holeT, s.g);
    m.alphaTest = 0.5;
  }

  // dent shading: bump from the dent channel (re-sampled by the bump node at offset uvs)
  if (o.dent) {
    const tb = texture(dt, puv);
    const h = tb.a.mul(below(tb.g, d.mul(1.4), 0.2)).mul(smoothstep(0.1, 0.6, d));
    const baseN = b.normal ? normalMap(texture(b.normal(), uv()), vec2(1.1, 1.1)) : undefined;
    m.normalNode = bumpMap(h, float(o.style === 'steel' || o.style === 'trim' ? 2.5 : 4), baseN);
  } else if (b.normal) {
    m.normalMap = b.normal();
    m.normalScale = new THREE.Vector2(1.1, 1.1);
  }

  // vertex deformation
  if (o.dent || o.bow || o.slump || o.sag) {
    const P = positionGeometry;
    const heavyV = smoothstep(0.5, 0.85, info.x);
    const fwd = vec3(info.z, 0, info.w); // piece-local +Z in instanced space
    let pos = positionLocal as unknown as V3;
    if (o.dent) {
      const vt = texture(dt, projUV(P, normalGeometry)).level(float(0));
      let amt = vt.a.mul(below(vt.g, info.x.mul(1.4), 0.2)).mul(smoothstep(0.15, 0.7, info.x)).mul(o.dentDepth ?? 0.05);
      if (o.dent === 'z') {
        // edges stay put (welded/nailed border); keeps faces of a plate together
        const ex = float(1).sub(pow(abs(P.x.mul(2 / spec.w)), 6));
        const ey = float(1).sub(pow(abs(P.y.mul(2 / spec.h).sub(1)), 6));
        amt = amt.mul(ex.clamp(0, 1)).mul(ey.clamp(0, 1));
        pos = pos.add(fwd.mul(amt));
      } else {
        pos = pos.sub(normalLocal.mul(amt));
      }
    }
    if (o.bow) {
      const bx = float(1).sub(P.x.mul(2 / spec.w).pow(2)).clamp(0, 1);
      pos = pos.add(fwd.mul(heavyV.mul(0.16).mul(bx).mul(sin(P.y.mul(Math.PI / spec.h)).clamp(0, 1))));
    }
    if (o.slump) {
      const n = mx_noise_float(vec3(P.x.mul(1.8), 0.0, info.y.mul(7))).mul(0.5).add(0.5);
      const cutoff = float(spec.h).mul(float(1).sub(heavyV.mul(n.mul(0.22).add(0.12))));
      const drop = max(P.y.sub(cutoff), 0).add(P.y.mul(0.06).mul(heavyV));
      pos = pos.sub(vec3(0, drop, 0));
    }
    if (o.sag) {
      const n = mx_noise_float(vec3(P.z.mul(0.9), info.y.mul(5), 0.0)).mul(0.25).add(0.75);
      const across = float(1).sub(P.x.mul(2 / spec.w).pow(2)).clamp(0, 1);
      const inDeck = step(spec.h - 0.2, P.y);
      pos = pos.sub(vec3(0, heavyV.mul(0.3).mul(across).mul(n).mul(inDeck), 0));
    }
    m.positionNode = pos;
  }
  return m;
}

// ---------------------------------------------------------------- instanced layer

type KindLayer = {
  meshes: THREE.InstancedMesh[];
  proxy: THREE.InstancedMesh;
  dmg: THREE.InstancedBufferAttribute;
  cap: number;
};

/** What the damage FX need to know about a live piece. */
export type PieceInfo = { kind: PieceKind; index: number; x: number; y: number; z: number; rotY: number; color: number };
export type VisualHit = { point: THREE.Vector3; normal: THREE.Vector3; slot: Slot };
export type { Slot as PieceSlot };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);
const _inv = new THREE.Matrix4(), _ray = new THREE.Raycaster(), _o = new THREE.Vector3(), _dir = new THREE.Vector3();
const _hits: THREE.Intersection[] = [];
const SHAKE_MS = 320;

/**
 * All building pieces: one InstancedMesh per kind × material slot (≈14 draw calls for any number of pieces),
 * plus one invisible instanced hull per kind that the camera/aim raycasts hit.
 */
export class PieceLayer {
  readonly root = new THREE.Group();
  private kinds = new Map<PieceKind, KindLayer>();
  private visuals = new Map<PieceKind, Partial<Record<Slot, THREE.BufferGeometry>>>();
  /** Untransformed visual meshes per kind, for placing decals on the real surface (not the hull). */
  private pickers = new Map<PieceKind, THREE.Mesh[]>();
  private mats = new Map<string, THREE.MeshStandardNodeMaterial>();
  private proxyMat = new THREE.MeshBasicNodeMaterial();
  private byId = new Map<number, PieceInfo>();
  private shakes = new Map<number, { t0: number; amp: number }>();
  /** Invisible hull meshes, stable for the life of the layer except when capacity grows. */
  readonly proxies: THREE.InstancedMesh[] = [];
  onProxiesChanged: (() => void) | null = null;

  constructor() {
    this.root.name = 'pieces';
    const pickMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    for (const k of KINDS) {
      const v = BUILDERS[k]();
      const merged: Partial<Record<Slot, THREE.BufferGeometry>> = {};
      for (const s of Object.keys(v) as Slot[]) merged[s] = merge(v[s]!);
      this.visuals.set(k, merged);
      const pick: THREE.Mesh[] = [];
      for (const [s, g] of Object.entries(merged) as [Slot, THREE.BufferGeometry][]) {
        const pm = new THREE.Mesh(g, pickMat);
        pm.userData.slot = s;
        pm.updateMatrixWorld(true);
        pick.push(pm);
      }
      this.pickers.set(k, pick);
      this.alloc(k, 64);
    }
  }

  private matFor(kind: PieceKind, s: Slot) {
    const key = `${kind}:${s}`;
    let m = this.mats.get(key);
    if (!m) { m = slotMaterial(kind, s); this.mats.set(key, m); }
    return m;
  }

  private alloc(kind: PieceKind, cap: number) {
    const old = this.kinds.get(kind);
    if (old) {
      for (const m of old.meshes) { this.root.remove(m); m.dispose(); }
      this.root.remove(old.proxy); old.proxy.dispose();
      this.proxies.splice(this.proxies.indexOf(old.proxy), 1);
    }
    const dmg = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    dmg.setUsage(THREE.DynamicDrawUsage);
    const meshes: THREE.InstancedMesh[] = [];
    for (const [slot, g] of Object.entries(this.visuals.get(kind)!) as [Slot, THREE.BufferGeometry][]) {
      const geo = g.clone();
      geo.setAttribute('dmg', dmg);
      const im = new THREE.InstancedMesh(geo, this.matFor(kind, slot), cap);
      im.setColorAt(0, new THREE.Color(1, 1, 1)); // create instanceColor up front so the material compiles with it
      im.count = 0;
      im.castShadow = im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.name = `piece:${kind}:${slot}`;
      this.root.add(im);
      meshes.push(im);
    }
    const proxy = new THREE.InstancedMesh(pieceGeometry(kind), this.proxyMat, cap);
    proxy.count = 0;
    proxy.visible = false; // raycast-only (Raycaster ignores .visible)
    proxy.name = `pieceHull:${kind}`;
    this.root.add(proxy);
    this.proxies.push(proxy);
    this.kinds.set(kind, { meshes, proxy, dmg, cap });
    if (old) {
      console.info(`[world/pieces] grew ${kind} capacity to ${cap}`);
      this.onProxiesChanged?.();
    }
  }

  sync(pieces: PieceState[]) {
    const byKind = new Map<PieceKind, PieceState[]>();
    for (const p of pieces) {
      let a = byKind.get(p.kind);
      if (!a) { a = []; byKind.set(p.kind, a); }
      a.push(p);
    }
    this.byId.clear();
    for (const kind of KINDS) {
      const list = byKind.get(kind) ?? [];
      let L = this.kinds.get(kind)!;
      if (list.length > L.cap) { this.alloc(kind, Math.max(list.length, L.cap * 2)); L = this.kinds.get(kind)!; }
      const maxHp = PIECES[kind].hp;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        _p.set(p.pos.x, p.pos.y, p.pos.z);
        _q.setFromAxisAngle(_up, p.rotY);
        _m.compose(_p, _q, _s);
        for (const im of L.meshes) im.setMatrixAt(i, _m);
        L.proxy.setMatrixAt(i, _m);
        const seed = ((p.id * 0.6180339) % 1) * 10;
        L.dmg.setXYZW(i, Math.min(1, Math.max(0, 1 - p.hp / maxHp)), seed, Math.sin(p.rotY), Math.cos(p.rotY));
        if (kind === 'container') _c.setHex(CONTAINER_COLORS[p.id % CONTAINER_COLORS.length]);
        else { const j = 0.92 + ((p.id * 37) % 17) / 100; _c.setRGB(j, j, j); }
        for (const im of L.meshes) im.setColorAt(i, _c);
        this.byId.set(p.id, { kind, index: i, x: p.pos.x, y: p.pos.y, z: p.pos.z, rotY: p.rotY, color: _c.getHex() });
      }
      for (const im of L.meshes) {
        im.count = list.length;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.boundingSphere = null; // recomputed lazily for culling
      }
      L.proxy.count = list.length;
      L.proxy.instanceMatrix.needsUpdate = true;
      L.proxy.boundingSphere = null;
      L.dmg.needsUpdate = true;
    }
    for (const id of this.shakes.keys()) if (!this.byId.has(id)) this.shakes.delete(id);
  }

  info(id: number): PieceInfo | undefined { return this.byId.get(id); }

  /** Brief wobble of one piece (explosive hits). Visual only; the hull stays put. */
  shake(id: number, amp: number) {
    if (!this.byId.has(id)) return;
    const cur = this.shakes.get(id);
    this.shakes.set(id, { t0: performance.now(), amp: Math.min(0.12, Math.max(amp, cur?.amp ?? 0)) });
  }

  /** Per frame: apply shake offsets on top of the last synced matrices. */
  update(now: number) {
    for (const [id, s] of this.shakes) {
      const p = this.byId.get(id);
      if (!p) { this.shakes.delete(id); continue; }
      const L = this.kinds.get(p.kind)!;
      const k = (now - s.t0) / SHAKE_MS;
      const done = k >= 1;
      const a = done ? 0 : s.amp * (1 - k) * (1 - k);
      const w = k * 38;
      _p.set(p.x + Math.sin(w) * a, p.y + Math.abs(Math.sin(w * 1.3)) * a * 0.4, p.z + Math.cos(w * 0.9) * a);
      _q.setFromAxisAngle(_up, p.rotY + Math.sin(w * 1.1) * a * 0.25);
      _m.compose(_p, _q, _s);
      for (const im of L.meshes) { im.setMatrixAt(p.index, _m); im.instanceMatrix.needsUpdate = true; }
      if (done) this.shakes.delete(id);
    }
  }

  /** Cast a world-space ray against one piece's visual surface (not its hull). Normal faces the ray origin. */
  raycastVisual(id: number, origin: THREE.Vector3, dir: THREE.Vector3, far: number, out: VisualHit): boolean {
    const p = this.byId.get(id);
    if (!p) return false;
    _q.setFromAxisAngle(_up, p.rotY);
    _inv.compose(_p.set(p.x, p.y, p.z), _q, _s).invert();
    _o.copy(origin).applyMatrix4(_inv);
    _dir.copy(dir).applyQuaternion(_q.invert()).normalize();
    _ray.set(_o, _dir);
    _ray.far = far;
    _hits.length = 0;
    _ray.intersectObjects(this.pickers.get(p.kind)!, false, _hits);
    const h = _hits[0];
    if (!h || !h.face) return false;
    _q.setFromAxisAngle(_up, p.rotY);
    out.point.copy(h.point).applyQuaternion(_q).add(_p.set(p.x, p.y, p.z));
    out.normal.copy(h.face.normal).applyQuaternion(_q);
    if (out.normal.dot(dir) > 0) out.normal.negate();
    out.slot = (h.object.userData.slot as Slot) ?? 'wood';
    return true;
  }
}
