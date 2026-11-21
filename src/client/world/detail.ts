import * as THREE from 'three/webgpu';
import { float, mix, normalMap, positionWorld, sin, smoothstep, abs, time, vec2, vec3 } from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import { BACKDROP_DECOR, ISLAND_DECOR } from './decor';
import { mat, StaticBatch, strut } from './geo';
import { mats } from './materials';
import { pbrSample, worldNoise } from './pbr';
import type { Scatter } from './scatter';
import { boxTape, faceLabel, labelMaterial } from './labels';
import { merge, part } from './geo';
import { makeRng, signTex } from './textures';

/** Ground spots under the harbor street lamps' heads (world), for the night light pools (dayNight.ts). Reset per map build. */
export const lampSpots: THREE.Vector3[] = [];

/**
 * Second detail layer: instanced litter / rubble / shells / seaweed / footprints (via Scatter), plus the bigger
 * static set dressing on the harbor quays (pallet stacks, tarps, crab pots, chains, signs, street lamps with cables)
 * and a small beach with tide pools at the foot of each harbor quay.
 */
type Rng = ReturnType<typeof makeRng>;
type Frame = { hw: number; z0: number; top: number };
const at = (B: THREE.Matrix4, L: THREE.Matrix4) => B.clone().multiply(L);

/** island-local → world (three.js Y rotation by facingYaw) */
function W(isl: IslandLayout, x: number, z: number) {
  const c = Math.cos(isl.bunker.facingYaw), s = Math.sin(isl.bunker.facingYaw);
  return { x: isl.center.x + x * c + z * s, z: isl.center.z - x * s + z * c };
}

function std(name: string, o: ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0]) {
  const m = new THREE.MeshStandardNodeMaterial(o);
  m.name = name;
  return m;
}

// ---------------------------------------------------------------- scatter kinds

function jitterGeo(g: THREE.BufferGeometry, amt: number, seed: number) {
  const p = g.getAttribute('position');
  const r = makeRng(seed);
  // jitter shared corners identically so the mesh stays closed
  const key = (i: number) => `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
  const off = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    if (!off.has(k)) off.set(k, [r.rr(-amt, amt), r.rr(-amt, amt), r.rr(-amt, amt)]);
    const o = off.get(k)!;
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  g.computeVertexNormals();
  return g;
}

export function defineDetailKinds(sc: Scatter) {
  const M = mats();
  // few base materials → few pipelines (instance colours tint them)
  const matte = std('scatterMatte', { roughness: 0.92, color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1 });
  const matte2 = std('scatterMatte2', { roughness: 0.5, color: 0xffffff, side: THREE.DoubleSide });
  const shiny = std('scatterShiny', { roughness: 0.12, metalness: 0.35, color: 0xffffff });
  const all = (low: number, high: number, ultra = 1) => ({ low, high, ultra });
  const pebble = jitterGeo(new THREE.IcosahedronGeometry(1, 0), 0.25, 3);
  pebble.scale(1, 0.55, 1);
  sc.define('pebble', { geo: pebble, material: M.gravel, far: 26, density: all(0.25, 0.7) });
  sc.define('rubble', { geo: jitterGeo(new THREE.BoxGeometry(1, 0.7, 0.8, 1, 1, 1).toNonIndexed(), 0.18, 7), material: M.concrete, far: 45, density: all(0.35, 0.8) });
  // bottle: body + shoulder + neck (lathe), lying or standing
  const bottle = new THREE.LatheGeometry([0, 0.033, 0.035, 0.035, 0.03, 0.014, 0.013, 0.015, 0].map((r, i) => new THREE.Vector2(r, [0, 0, 0.005, 0.15, 0.18, 0.21, 0.26, 0.265, 0.265][i])), 8);
  sc.define('bottle', { geo: bottle, material: shiny, far: 22, density: all(0, 0.7) });
  sc.define('can', { geo: new THREE.CylinderGeometry(0.033, 0.033, 0.12, 10).translate(0, 0.06, 0), material: shiny, far: 20, density: all(0, 0.7) });
  const card = new THREE.BoxGeometry(0.6, 0.015, 0.45, 3, 1, 3).translate(0, 0.008, 0);
  {
    const p = card.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + Math.sin(p.getX(i) * 7) * 0.012 + Math.cos(p.getZ(i) * 9) * 0.008);
    card.computeVertexNormals();
  }
  sc.define('cardboard', { geo: card, material: matte, far: 35, density: all(0.2, 0.8) });
  sc.define('box', { geo: new THREE.BoxGeometry(0.45, 0.35, 0.4).translate(0, 0.175, 0), material: M.matte, far: 45, density: all(0.3, 0.9), blob: 0.34 });
  // tape + shipping label on every scatter box (placed alongside each 'box', same transform)
  sc.define('boxLabel', {
    geo: merge([...boxTape(0.225, 0.175, 0.2).map((g) => part(g.translate(0, 0.175, 0), null)), part(faceLabel(0.15, 0.15, new THREE.Vector3(0.06, 0.15, 0.2), new THREE.Vector3(0, 0, 1), 2), null)]),
    material: labelMaterial(), far: 30, density: all(0.3, 0.9), follows: 'box',
  });
  const shell = new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1.25);
  sc.define('shell', { geo: shell, material: matte, far: 16, density: all(0, 0.6) });
  const weed = new THREE.PlaneGeometry(0.08, 0.6, 1, 4).rotateX(-Math.PI / 2).translate(0, 0.012, 0);
  {
    const p = weed.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + Math.sin(p.getZ(i) * 9) * 0.05);
  }
  sc.define('seaweed', { geo: weed, material: matte2, far: 30, density: all(0.3, 0.8) });
  sc.define('footprint', { geo: new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2).scale(0.055, 1, 0.13).translate(0, 0.006, 0), material: matte, far: 25, density: all(0, 1) });
  const leaf = new THREE.PlaneGeometry(0.07, 0.04).rotateX(-Math.PI / 2).translate(0, 0.004, 0);
  sc.define('leaf', { geo: leaf, material: matte2, far: 18, density: all(0, 0.7) });
}

// ---------------------------------------------------------------- island litter / rubble

export function scatterIsland(sc: Scatter, isl: IslandLayout) {
  const rng = makeRng(9001 + isl.index * 53);
  const y0 = isl.groundY;
  const R = isl.radius;
  const put = (key: string, x: number, z: number, y: number, yaw: number, s: number | [number, number, number], tilt: [number, number] = [0, 0], col: THREE.ColorRepresentation = 0xffffff) => {
    const w = W(isl, x, z);
    sc.add(key, w.x, y0 + y, w.z, yaw + isl.bunker.facingYaw, s, tilt, col);
  };
  // rubble + chips along the bunker walls (outer faces) and around the bunker apron
  const b = MAP.bunker, half = b.interior / 2 + b.wall;
  const bz = R - 7;
  for (let i = 0; i < 46; i++) {
    const side = Math.floor(rng.rnd() * 4), t = rng.rr(-half, half), d = half + rng.rr(0.05, 0.6);
    const [x, z] = side === 0 ? [t, bz - d] : side === 1 ? [t, bz + d] : side === 2 ? [-d, bz + t] : [d, bz + t];
    if (side !== 1 && Math.abs(t) < b.doorWidth / 2 + 0.3) continue; // keep doorways clear
    const s = rng.rnd() < 0.15 ? rng.rr(0.12, 0.22) : rng.rr(0.03, 0.09);
    put(s > 0.1 ? 'rubble' : 'pebble', x, z, s * 0.25, rng.rr(0, 6), s, [rng.rr(-0.3, 0.3), rng.rr(-0.3, 0.3)], new THREE.Color().setHSL(0.1, 0.05, rng.rr(0.65, 0.95)));
  }
  // chips + grit along the rim coping and at the foot of props
  for (let i = 0; i < 70; i++) {
    const a = rng.rr(0, Math.PI * 2), r = R - rng.rr(0.6, 1.4);
    put('pebble', Math.sin(a) * r, Math.cos(a) * r, 0.006, rng.rr(0, 6), rng.rr(0.015, 0.04), [0, 0], new THREE.Color().setHSL(0.08, 0.05, rng.rr(0.6, 1)));
  }
  // litter: bottles, cans, cardboard, a dropped box — away from the centre lanes
  const spots: [number, number][] = [[-9, -3], [10, 0], [-14, -9], [14, -10], [-4, 12], [5, 11.5], [-18, 3], [18, 5], [0, -19], [-11, 13], [11, 13]];
  for (const [sx, sz] of spots) {
    const n = Math.floor(rng.rr(2, 5));
    for (let k = 0; k < n; k++) {
      const x = sx + rng.rr(-1.2, 1.2), z = sz + rng.rr(-1.2, 1.2), u = rng.rnd();
      if (u < 0.3) put('bottle', x, z, 0.035, rng.rr(0, 6), 1, [Math.PI / 2, 0], [0x2e6b34, 0x6b3b12, 0xc8d8d0][Math.floor(rng.rnd() * 3)]);
      else if (u < 0.6) put('can', x, z, rng.rnd() < 0.5 ? 0.033 : 0, rng.rr(0, 6), 1, rng.rnd() < 0.5 ? [Math.PI / 2, 0] : [0, 0], [0xb8202a, 0x1f5fa8, 0xd8d8d0, 0x2f8a3a][Math.floor(rng.rnd() * 4)]);
      else if (u < 0.85) put('cardboard', x, z, 0, rng.rr(0, 6), [rng.rr(0.7, 1.2), 1, rng.rr(0.7, 1.2)], [0, 0], 0xa88a62);
      else put('leaf', x, z, 0, rng.rr(0, 6), rng.rr(0.8, 1.5), [0, 0], 0x6b5a2a);
    }
  }
  // a few dropped cardboard boxes by the props (purely visual, small)
  for (const [x, z] of [[-7.4, -4.6], [7.6, -4.8]]) put('box', x, z, 0, rng.rr(0, 6), rng.rr(0.8, 1.1), [0, 0], 0xb0905e);
  // shells, a footprint trail and a chain by the rim on the sand beds
  for (const e of ISLAND_DECOR.sandBeds) {
    for (let k = 0; k < Math.round(e.rx * e.rz * 3); k++) {
      const a = rng.rr(0, Math.PI * 2), r = Math.sqrt(rng.rnd()) * 0.9;
      put('shell', e.x + Math.cos(a) * e.rx * r, e.z + Math.sin(a) * e.rz * r, 0.004, rng.rr(0, 6), rng.rr(0.02, 0.04), [0, 0], [0xf2e8dc, 0xe8c8b8, 0xd8d0c0, 0xf0d8a8][k % 4]);
    }
    let x = e.x - e.rx * 0.8, z = e.z + rng.rr(-0.5, 0.5);
    const a0 = rng.rr(-0.3, 0.3);
    for (let k = 0; x < e.x + e.rx * 0.8; k++) {
      const side = k % 2 ? 1 : -1;
      put('footprint', x + Math.sin(a0) * 0.12 * side, z - Math.cos(a0) * 0.12 * side, 0.001, a0 + Math.PI / 2, 1, [0, 0], 0x9a8a70);
      x += 0.66; z += Math.sin(k * 0.5) * 0.04;
    }
  }
  // pebbles + sand grains spilled across gravel patches
  for (const e of ISLAND_DECOR.gravel) {
    for (let k = 0; k < Math.round(e.rx * e.rz * 6); k++) {
      const a = rng.rr(0, Math.PI * 2), r = Math.sqrt(rng.rnd()) * 0.95;
      put('pebble', e.x + Math.cos(a) * e.rx * r, e.z + Math.sin(a) * e.rz * r, 0.008, rng.rr(0, 6), rng.rr(0.015, 0.05), [0, 0], new THREE.Color().setHSL(0.08, 0.05, rng.rr(0.6, 1.05)));
    }
  }
}

// ---------------------------------------------------------------- harbor quay set dressing (static)

function palletStack(b: StaticBatch, B: THREE.Matrix4, n: number, rng: Rng) {
  const M = mats();
  for (let k = 0; k < n; k++) {
    const P = at(B, mat(rng.rr(-0.04, 0.04), k * 0.15, rng.rr(-0.04, 0.04), 0, rng.rr(-0.05, 0.05), 0));
    for (const x of [-0.5, 0, 0.5]) b.add(M.wood, new THREE.BoxGeometry(0.1, 0.09, 1.0), at(P, mat(x, 0.045, 0)), 0xc8b48c);
    for (let j = 0; j < 5; j++) b.add(M.wood, new THREE.BoxGeometry(1.2, 0.022, 0.14), at(P, mat(0, 0.1, -0.42 + j * 0.21)), 0xd8c49c);
  }
}

function tarpOver(b: StaticBatch, B: THREE.Matrix4, w: number, h: number, d: number, col: number) {
  const M = mats();
  b.add(M.wood, new THREE.BoxGeometry(w - 0.1, h - 0.05, d - 0.1), at(B, mat(0, (h - 0.05) / 2, 0)), 0xb09a74);
  const g = new THREE.PlaneGeometry(w + 1.0, d + 1.0, 14, 14).rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const ox = Math.max(0, Math.abs(x) - w / 2), oz = Math.max(0, Math.abs(z) - d / 2);
    const out = Math.hypot(ox, oz);
    const y = out > 0 ? h - Math.min(h - 0.03, out * 2.2) : h + 0.02;
    p.setY(i, y + Math.sin(x * 6.3) * Math.cos(z * 5.1) * 0.025);
  }
  g.computeVertexNormals();
  b.add(M.matte, g, B, col, true, true);
  // tie-down ropes
  for (const sx of [-1, 1]) b.add(M.burlap, strut(new THREE.Vector3(sx * (w / 2 + 0.2), 0.2, -d / 2 - 0.3), new THREE.Vector3(sx * (w / 2 + 0.2), 0.2, d / 2 + 0.3), 0.012, 4), B, 0xb7a27a, false);
}

function crabPot(b: StaticBatch, B: THREE.Matrix4) {
  const M = mats();
  const W2 = 0.42, H = 0.32;
  for (const y of [0.01, H]) for (const s of [-1, 1]) {
    b.add(M.galv, new THREE.BoxGeometry(W2 * 2, 0.012, 0.012), at(B, mat(0, y, s * W2)), 0x8a8f92, false);
    b.add(M.galv, new THREE.BoxGeometry(0.012, 0.012, W2 * 2), at(B, mat(s * W2, y, 0)), 0x8a8f92, false);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(M.galv, new THREE.BoxGeometry(0.012, H, 0.012), at(B, mat(sx * W2, H / 2, sz * W2)), 0x8a8f92, false);
  b.add(M.burlap, new THREE.BoxGeometry(W2 * 2 - 0.02, H - 0.02, W2 * 2 - 0.02), at(B, mat(0, H / 2, 0)), 0x2f4a3c, false);
  b.add(M.paint, new THREE.SphereGeometry(0.09, 10, 8), at(B, mat(W2 + 0.15, 0.09, 0.1)), 0xe0661c);
}

function chain(b: StaticBatch, B: THREE.Matrix4, n: number, rng: Rng) {
  const M = mats();
  const link = new THREE.TorusGeometry(0.035, 0.01, 4, 8).scale(1.4, 1, 1);
  let x = 0, z = 0, a = rng.rr(0, 6);
  for (let k = 0; k < n; k++) {
    b.add(M.dark, link, at(B, mat(x, 0.012, z, k % 2 ? Math.PI / 2 : 0, a, 0)), 0x5a4030, false);
    x += Math.cos(a) * 0.085; z += Math.sin(a) * 0.085; a += rng.rr(-0.25, 0.25);
  }
}

/** One material per sign text (shared by every island): a new material per call made each island's copy its own draw. */
const signMats = new Map<string, THREE.MeshStandardNodeMaterial>();

function sign(b: StaticBatch, B: THREE.Matrix4, text: string, bg: string) {
  const M = mats();
  b.add(M.galv, new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), at(B, mat(0, 1.1, 0)));
  let sm = signMats.get(`${text}|${bg}`);
  if (!sm) {
    sm = new THREE.MeshStandardNodeMaterial({ map: signTex(text, bg), roughness: 0.6, vertexColors: true });
    sm.name = `sign:${text}`;
    signMats.set(`${text}|${bg}`, sm);
  }
  b.add(sm, new THREE.PlaneGeometry(1.4, 0.18), at(B, mat(0, 2.05, -0.035)), 0xffffff, false);
  b.add(M.dark, new THREE.BoxGeometry(1.42, 0.2, 0.02), at(B, mat(0, 2.05, -0.015)), 0x303438);
}

function streetLamps(b: StaticBatch, atF: (x: number, y: number, z: number, ry?: number) => THREE.Matrix4, xs: number[], z: number, top: number) {
  const M = mats();
  const heads: THREE.Vector3[] = [];
  for (const x of xs) {
    const B = atF(x, top, z);
    b.add(M.galv, new THREE.CylinderGeometry(0.06, 0.09, 6, 8), at(B, mat(0, 3, 0)), 0x7d8488);
    b.add(M.galv, new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6).rotateX(Math.PI / 2), at(B, mat(0, 5.9, -0.5)), 0x7d8488);
    b.add(M.dark, new THREE.BoxGeometry(0.32, 0.12, 0.5), at(B, mat(0, 5.85, -1.05)), 0xffffff);
    b.add(M.lamp, new THREE.BoxGeometry(0.26, 0.02, 0.42), at(B, mat(0, 5.78, -1.05)), 0xfff2d0);
    lampSpots.push(new THREE.Vector3().setFromMatrixPosition(at(B, mat(0, 0, -1.05))));
    heads.push(new THREE.Vector3().setFromMatrixPosition(at(B, mat(0, 5.7, 0.06))));
  }
  // sagging power cables between consecutive posts (world-space tubes)
  for (let i = 0; i + 1 < heads.length; i++) {
    const a = heads[i], c = heads[i + 1];
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      pts.push(new THREE.Vector3().lerpVectors(a, c, t).add(new THREE.Vector3(0, -0.6 * 4 * t * (1 - t), 0)));
    }
    b.add(M.dark, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.012, 3), null, 0x202020, false, false);
  }
}

/** Island set dressing: mooring chains lying by a few rim bollards (flat, ≤ 3 cm). `L` = island frame at y = 0. */
export function dressIslandDetail(b: StaticBatch, L: THREE.Matrix4, isl: IslandLayout) {
  const rng = makeRng(611 + isl.index * 17);
  for (const k of [4, 7, 11]) {
    const a = ((k + 0.5) / 14) * Math.PI * 2, r = isl.radius - 0.75;
    chain(b, at(L, mat(Math.sin(a) * r, isl.groundY, Math.cos(a) * r, 0, -a, 0)), Math.round(rng.rr(14, 26)), rng);
  }
}

/** Static dressing on each harbor quay (outside the playable islands). */
export function dressHarbor(b: StaticBatch, atF: (x: number, y: number, z: number, ry?: number) => THREE.Matrix4, f: Frame, rng: Rng) {
  const { hw, z0, top } = f;
  const D = BACKDROP_DECOR;
  for (const p of D.pallets) palletStack(b, atF(p.x * hw, top, z0 + p.z, p.yaw), p.n, rng);
  for (const t of D.tarps) tarpOver(b, atF(t.x * hw, top, z0 + t.z, t.yaw), 1.6, 1.1, 1.3, t.col);
  for (const c of D.crabPots) crabPot(b, atF(c.x * hw, top, z0 + c.z, rng.rr(0, 6)));
  for (const c of D.chains) chain(b, atF(c.x * hw, top, z0 + c.z), c.n, rng);
  for (const s of D.signs) sign(b, atF(s.x * hw, top, z0 + s.z, Math.PI), s.text, s.bg);
  streetLamps(b, atF, D.lamps.map((x) => x * hw), z0 + 2.6, top);
  // rain puddles in the dips of the yard paving: dark mirror-smooth water
  for (let k = 0; k < 7; k++) {
    const g = new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position');
    const ph = rng.rr(0, 6);
    for (let i = 1; i < p.count; i++) {
      const a = Math.atan2(p.getZ(i), p.getX(i)), r = 1 + 0.25 * Math.sin(a * 3 + ph) + 0.1 * Math.sin(a * 5 + ph * 2);
      p.setXYZ(i, p.getX(i) * r, 0, p.getZ(i) * r);
    }
    b.add(puddleMaterial(), g, atF(rng.rr(-hw + 4, hw - 4), top + 0.004, z0 + rng.rr(3, 12), rng.rr(0, 6)).multiply(mat(0, 0, 0, 0, 0, 0, rng.rr(0.6, 1.6), 1, rng.rr(0.4, 0.9))), 0x3a3c3e, false, true);
  }
}

let puddleMat: THREE.MeshStandardNodeMaterial | null = null;
function puddleMaterial() {
  if (!puddleMat) puddleMat = std('puddle', { color: 0x4a5258, vertexColors: true, roughness: 0.03, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 });
  return puddleMat;
}

export function scatterHarbor(sc: Scatter, atW: (x: number, y: number, z: number) => THREE.Vector3, yaw: number, f: Frame, rng: Rng) {
  const { hw, z0, top } = f;
  const put = (key: string, x: number, z: number, y: number, s: number | [number, number, number], tilt: [number, number] = [0, 0], col: THREE.ColorRepresentation = 0xffffff) => {
    const p = atW(x, y, z);
    sc.add(key, p.x, p.y, p.z, rng.rr(0, 6) + yaw, s, tilt, col);
  };
  // litter + cardboard along the quay front and around the warehouse doors
  for (let i = 0; i < 70; i++) {
    const x = rng.rr(-hw + 2, hw - 2), z = z0 + (rng.rnd() < 0.6 ? rng.rr(1, 6) : rng.rr(12, 14.5));
    const u = rng.rnd();
    if (u < 0.25) put('bottle', x, z, top + 0.035, 1, [Math.PI / 2, 0], [0x2e6b34, 0x6b3b12, 0xc8d8d0][i % 3]);
    else if (u < 0.5) put('can', x, z, top + 0.033, 1, [Math.PI / 2, 0], [0xb8202a, 0x1f5fa8, 0xd8d8d0][i % 3]);
    else if (u < 0.75) put('cardboard', x, z, top, [rng.rr(0.8, 1.4), 1, rng.rr(0.8, 1.4)], [0, 0], 0xa88a62);
    else put('pebble', x, z, top + 0.01, rng.rr(0.02, 0.06), [0, 0], 0xbbbbbb);
  }
  for (let i = 0; i < 14; i++) put('box', rng.rr(-hw * 0.6, -hw * 0.1), z0 + rng.rr(12.5, 14.4), top, rng.rr(0.8, 1.3), [0, 0], 0xb0905e);
}

// ---------------------------------------------------------------- beach + tide pools

/** Sand: PBR sand, darker and glossy where wet, an animated swash/foam line at the water's edge. */
let beachMat: THREE.MeshStandardNodeMaterial | null = null;
function beachMaterial() {
  if (beachMat) return beachMat;
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
  m.name = 'beach';
  const s = pbrSample('sand', positionWorld.xz.div(2), true);
  const y = positionWorld.y.sub(MAP.waterY);
  const wet = float(1).sub(smoothstep(0.15, 0.75, y));
  const macro = mix(float(0.9), float(1.08), worldNoise(0.05));
  let c = s.albedo.mul(2.2).mul(macro);
  c = c.mul(mix(float(1), float(0.55), wet));
  // swash line: a thin bright foam band that rides up and down with a slow swell
  const swash = sin(time.mul(0.9).add(positionWorld.x.mul(0.15))).mul(0.12).add(0.12);
  const foam = float(1).sub(smoothstep(0.0, 0.06, abs(y.sub(swash)))).mul(smoothstep(0.3, 0.7, worldNoise(0.6, 'g')));
  c = mix(c, vec3(0.92, 0.95, 0.94), foam.mul(0.8));
  m.colorNode = c;
  m.normalNode = normalMap(mix(s.normal, vec3(0.5, 0.5, 1), wet.mul(0.7)), vec2(1, 1));
  m.roughnessNode = mix(s.arm.g, float(0.12), wet.mul(0.9));
  m.metalnessNode = float(0);
  beachMat = m;
  return m;
}

export function buildBeach(b: StaticBatch, sc: Scatter, atF: (x: number, y: number, z: number, ry?: number) => THREE.Matrix4, f: Frame, rng: Rng) {
  const { hw, z0 } = f;
  for (const [u0, u1] of BACKDROP_DECOR.beaches) {
    const x0 = u0 * hw, x1 = u1 * hw, len = x1 - x0, depth = 8;
    const SX = Math.max(8, Math.round(len / 1.2)), SZ = 10;
    const g = new THREE.PlaneGeometry(len, depth, SX, SZ).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const t = (z + depth / 2) / depth; // 0 at the water, 1 at the wall foot
      const ends = Math.min(1, (len / 2 - Math.abs(x)) / 2.5); // taper into the water at both ends
      const y = -1.3 + 2.4 * Math.pow(t, 0.8) * Math.max(0, ends) + Math.sin(x * 0.7) * 0.06 + Math.cos(x * 1.3 + z) * 0.04;
      p.setXYZ(i, x, Math.min(1.1, y), z);
    }
    g.computeVertexNormals();
    const B = atF((x0 + x1) / 2, 0, z0 - depth / 2 + 0.2, 0);
    b.add(beachMaterial(), g, B, 0xffffff, false, true);
    const heightAt = (x: number, z: number) => {
      const t = (z + depth / 2) / depth, ends = Math.min(1, (len / 2 - Math.abs(x)) / 2.5);
      return Math.min(1.1, -1.3 + 2.4 * Math.pow(t, 0.8) * Math.max(0, ends) + Math.sin(x * 0.7) * 0.06 + Math.cos(x * 1.3 + z) * 0.04);
    };
    const onBeach = (x: number, z: number, lift = 0) => new THREE.Vector3(x, heightAt(x, z) + lift, z).applyMatrix4(B);
    const M = mats();
    // tide pools ringed by rocks and weed, in the wet band
    for (let k = 0; k < 3; k++) {
      const x = rng.rr(-len / 2 + 3, len / 2 - 3), z = -depth / 2 + rng.rr(2.4, 3.4);
      const y = heightAt(x, z);
      const r = rng.rr(0.5, 0.9);
      b.add(puddleMaterial(), new THREE.CircleGeometry(r, 16).rotateX(-Math.PI / 2).scale(1.3, 1, 1), at(B, mat(x, y + 0.03, z)), 0x2a6a66, false, true);
      for (let j = 0; j < 7; j++) {
        const a = (j / 7) * Math.PI * 2 + rng.rr(-0.3, 0.3), s = rng.rr(0.15, 0.35);
        b.add(M.rock, new THREE.IcosahedronGeometry(1, 1), at(B, mat(x + Math.cos(a) * r * 1.35, y + s * 0.2, z + Math.sin(a) * r, 0, rng.rr(0, 6), 0, s, s * 0.6, s)), new THREE.Color().setHSL(0.08, 0.1, rng.rr(0.6, 0.9)), true, true);
        const w = onBeach(x + Math.cos(a) * r * 1.1, z + Math.sin(a) * r * 0.85, 0.03);
        sc.add('seaweed', w.x, w.y, w.z, rng.rr(0, 6), rng.rr(0.7, 1.3), [0, 0], [0x3a4a1c, 0x2c3a18, 0x4a5222][j % 3]);
      }
    }
    // wrack line: seaweed, shells, driftwood along the high-tide mark
    for (let k = 0; k < Math.round(len * 3); k++) {
      const x = rng.rr(-len / 2 + 1, len / 2 - 1), z = -depth / 2 + rng.rr(4.2, 5.2);
      const w = onBeach(x, z, 0.01);
      sc.add('seaweed', w.x, w.y, w.z, rng.rr(0, 6), rng.rr(0.6, 1.2), [0, 0], [0x3a4a1c, 0x2c3a18, 0x55482a][k % 3]);
    }
    for (let k = 0; k < Math.round(len * 5); k++) {
      const x = rng.rr(-len / 2 + 1, len / 2 - 1), z = -depth / 2 + rng.rr(3.2, 7);
      const w = onBeach(x, z, 0.0);
      sc.add('shell', w.x, w.y, w.z, rng.rr(0, 6), rng.rr(0.02, 0.045), [0, 0], [0xf2e8dc, 0xe8c8b8, 0xd8d0c0, 0xf0d8a8][k % 4]);
    }
    for (let k = 0; k < 3; k++) {
      const x = rng.rr(-len / 2 + 2, len / 2 - 2), z = -depth / 2 + rng.rr(4.5, 6.5), L = rng.rr(1.2, 2.6);
      const y = heightAt(x, z);
      b.add(M.bark, new THREE.CylinderGeometry(0.07, 0.11, L, 7).rotateZ(Math.PI / 2), at(B, mat(x, y + 0.06, z, 0, rng.rr(0, 6), 0)), 0xb8aa98);
      b.add(M.bark, new THREE.CylinderGeometry(0.03, 0.05, 0.5, 5).rotateZ(Math.PI / 2 - 0.6), at(B, mat(x + 0.3, y + 0.12, z + 0.1, 0, rng.rr(0, 6), 0)), 0xb8aa98);
    }
    // a trail of footprints across the dry sand
    {
      let x = rng.rr(-len / 2 + 2, -len / 4), z = -depth / 2 + 6.4;
      const a0 = rng.rr(-0.25, 0.25);
      for (let k = 0; k < 26; k++) {
        const side = k % 2 ? 1 : -1;
        const w = onBeach(x + Math.sin(a0) * 0.12 * side, z + Math.cos(a0) * 0.12 * side, 0.0);
        sc.add('footprint', w.x, w.y, w.z, a0 + Math.PI / 2, 1, [0, 0], 0x9a8a70);
        x += 0.68; z += Math.sin(k * 0.4) * 0.05 - 0.04;
      }
    }
    // a few boulders scattered at the ends
    for (let k = 0; k < 8; k++) {
      const x = (rng.rnd() < 0.5 ? -1 : 1) * rng.rr(len / 2 - 2.5, len / 2), z = rng.rr(-depth / 2, depth / 2 - 1.5), s = rng.rr(0.3, 0.8);
      b.add(M.rock, new THREE.IcosahedronGeometry(1, 1), at(B, mat(x, heightAt(x, z) + s * 0.15, z, 0, rng.rr(0, 6), 0, s, s * 0.65, s)), new THREE.Color().setHSL(0.08, 0.1, rng.rr(0.6, 0.9)), true, true);
    }
  }
}
