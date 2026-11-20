import * as THREE from 'three/webgpu';
import { attribute, float, step, texture, uv, vec3, vec4 } from 'three/tsl';
import { PIECES } from '../../sim/constants';
import type { PieceKind, PieceState } from '../../sim/types';
import { boxUV, mat, merge, part, strut } from './geo';
import { CONTAINER_COLORS } from './materials';
import { burlapTex, corrNormal, corrTex, crackTex, makeRng, steelTex, woodTex } from './textures';

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
  const g = new THREE.PlaneGeometry(w, h, 80, 1);
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
  push(v, 'steel', boxUV(w, h, 0.1, 1.25), mat(0, h / 2, 0));
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
  // posts (down into the water/ground, up to the handrail), handrails, toe boards, braces
  const down = -2.2, rail = 1.05;
  for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) {
    for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) push(v, 'galv', strut(V(x, down, z), V(x, rail, z), r));
    for (const y of [0.55, rail]) push(v, 'galv', strut(V(x, y, -d / 2), V(x, y, d / 2), r));
    push(v, 'paint', new THREE.BoxGeometry(0.025, 0.15, d - 0.04), mat(x - Math.sign(x) * 0.01, h + 0.075, 0), 0xe8b81c);
    push(v, 'galv', strut(V(x, down + 0.3, -d / 2 + 0.03), V(x, h - 0.1, -0.02), 0.018));
    push(v, 'galv', strut(V(x, down + 0.3, d / 2 - 0.03), V(x, h - 0.1, 0.02), 0.018));
  }
  // couplers
  const coupler = new THREE.BoxGeometry(0.07, 0.07, 0.07);
  for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) for (const z of [-d / 2 + 0.03, 0, d / 2 - 0.03]) for (const y of [h - 0.08, 0.55, rail]) push(v, 'paint', coupler, mat(x, y, z), 0x3a3d40);
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
  push(v, 'corr', boxUV(L - 0.1, H - 0.14, D - 0.08, 7.8), mat(0, H / 2, 0));
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

function slotMaterial(slot: Slot): THREE.MeshStandardNodeMaterial {
  const base: Record<Slot, { map?: THREE.Texture; normal?: THREE.Texture; rough: number; metal: number; side?: THREE.Side }> = {
    burlap: { map: burlapTex(), rough: 0.97, metal: 0 },
    wood: { map: woodTex(), rough: 0.82, metal: 0 },
    corr: { map: corrTex(), normal: corrNormal(), rough: 0.5, metal: 0.55, side: THREE.DoubleSide },
    steel: { map: steelTex(), rough: 0.42, metal: 0.75 },
    galv: { rough: 0.38, metal: 0.85 },
    paint: { rough: 0.6, metal: 0.25 },
  };
  const b = base[slot];
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: b.rough, metalness: b.metal, side: b.side ?? THREE.FrontSide });
  m.name = `piece:${slot}`;
  if (b.normal) { m.normalMap = b.normal; m.normalScale = new THREE.Vector2(1.1, 1.1); }
  const dmg = attribute('dmg', 'float');
  const albedo = b.map ? texture(b.map, uv()).rgb : vec3(1, 1, 1);
  const crack = texture(crackTex(), uv().mul(0.9)).r;
  const showCrack = step(float(1.02).sub(dmg), crack); // more of the crack network appears as damage rises
  const shade = float(1).sub(dmg.mul(0.42)).mul(float(1).sub(showCrack.mul(0.78)));
  m.colorNode = vec4(albedo.mul(shade), 1);
  return m;
}

// ---------------------------------------------------------------- instanced layer

type KindLayer = {
  meshes: THREE.InstancedMesh[];
  proxy: THREE.InstancedMesh;
  dmg: THREE.InstancedBufferAttribute;
  cap: number;
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);

/**
 * All building pieces: one InstancedMesh per kind × material slot (≈14 draw calls for any number of pieces),
 * plus one invisible instanced hull per kind that the camera/aim raycasts hit.
 */
export class PieceLayer {
  readonly root = new THREE.Group();
  private kinds = new Map<PieceKind, KindLayer>();
  private visuals = new Map<PieceKind, Partial<Record<Slot, THREE.BufferGeometry>>>();
  private mats = new Map<Slot, THREE.MeshStandardNodeMaterial>();
  private proxyMat = new THREE.MeshBasicNodeMaterial();
  /** Invisible hull meshes, stable for the life of the layer except when capacity grows. */
  readonly proxies: THREE.InstancedMesh[] = [];
  onProxiesChanged: (() => void) | null = null;

  constructor() {
    this.root.name = 'pieces';
    for (const k of KINDS) {
      const v = BUILDERS[k]();
      const merged: Partial<Record<Slot, THREE.BufferGeometry>> = {};
      for (const s of Object.keys(v) as Slot[]) merged[s] = merge(v[s]!);
      this.visuals.set(k, merged);
      this.alloc(k, 64);
    }
  }

  private matFor(s: Slot) {
    let m = this.mats.get(s);
    if (!m) { m = slotMaterial(s); this.mats.set(s, m); }
    return m;
  }

  private alloc(kind: PieceKind, cap: number) {
    const old = this.kinds.get(kind);
    if (old) {
      for (const m of old.meshes) { this.root.remove(m); m.dispose(); }
      this.root.remove(old.proxy); old.proxy.dispose();
      this.proxies.splice(this.proxies.indexOf(old.proxy), 1);
    }
    const dmg = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    dmg.setUsage(THREE.DynamicDrawUsage);
    const meshes: THREE.InstancedMesh[] = [];
    for (const [slot, g] of Object.entries(this.visuals.get(kind)!) as [Slot, THREE.BufferGeometry][]) {
      const geo = g.clone();
      geo.setAttribute('dmg', dmg);
      const im = new THREE.InstancedMesh(geo, this.matFor(slot), cap);
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
        L.dmg.setX(i, Math.min(1, Math.max(0, 1 - p.hp / maxHp)));
        if (kind === 'container') _c.setHex(CONTAINER_COLORS[p.id % CONTAINER_COLORS.length]);
        else { const j = 0.92 + ((p.id * 37) % 17) / 100; _c.setRGB(j, j, j); }
        for (const im of L.meshes) im.setColorAt(i, _c);
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
  }
}
