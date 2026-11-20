import * as THREE from 'three/webgpu';
import { float, mix, normalMap, positionWorld, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';
import { bunkerWallBoxes, type IslandLayout } from '../../sim/map';
import { PROP_HALF } from '../../sim/physics';
import { boxUV, mat, StaticBatch } from './geo';
import { mats } from './materials';
import { bollard, container, containerStack, crane, drums, generatorProp, lightMast, pallet, palm, shopProp, vaultProp, warehouse } from './props';
import { ISLAND_DECOR } from './decor';
import { pbrSample, worldNoise } from './pbr';
import { islandSurface, makeRng } from './textures';

const UNLIT_BOOST = 2.6;
const QUAY_DEPTH = 14; // how far the quay walls go below y=0 (never visible past the water)
const CHANNEL = 14; // water between the playable disc and the off-island backdrop quay

function labelSprite(text: string, bg: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('[world/islands] 2D canvas context unavailable');
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(8, 8, 240, 48, 24); g.fill();
  g.fillStyle = '#fff';
  g.font = '600 28px "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
  m.color.setScalar(UNLIT_BOOST);
  const s = new THREE.Sprite(m);
  s.scale.set(1.5, 0.375, 1);
  return s;
}

/**
 * Island slab: worn-concrete PBR in world space, blended with sand / grass-ground sets and glossy puddles by the
 * decor mask, then the painted overlay (markings, joints, stains, drains, litter) on top.
 */
function islandTopMaterial(R: number) {
  const surf = islandSurface(R, ISLAND_DECOR);
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'islandTop';
  const w = positionWorld.xz;
  const con = pbrSample('concrete', w.div(3.2));
  const sand = pbrSample('sand', w.div(2.2), true, true);
  const grass = pbrSample('grass', w.div(2.6), true, true);
  const mk = texture(surf.mask, uv());
  const ov = texture(surf.overlay, uv());
  const macro = mix(float(0.86), float(1.1), worldNoise(0.03));
  let alb = con.albedo.mul(3.6).mul(vec3(0.98, 0.96, 0.92)).mul(macro);
  alb = mix(alb, sand.albedo.mul(2.1), mk.r);
  alb = mix(alb, grass.albedo.mul(1.25), mk.g);
  const wet = mk.b;
  alb = alb.mul(mix(float(1), float(0.45), wet));
  alb = mix(alb, ov.rgb, ov.a);
  m.colorNode = alb;
  let nrm = mix(con.normal, sand.normal, mk.r);
  nrm = mix(nrm, grass.normal, mk.g);
  nrm = mix(nrm, vec3(0.5, 0.5, 1), wet.mul(0.9));
  m.normalNode = normalMap(nrm, vec2(1.1, 1.1));
  let rough = mix(con.arm.g.mul(1.25).add(0.12), float(0.95), mk.r);
  rough = mix(rough, float(0.92), mk.g);
  rough = mix(rough, float(0.04), smoothstep(0.35, 0.8, wet));
  m.roughnessNode = mix(rough, float(0.7), ov.a.mul(0.6)).clamp(0.03, 1);
  m.metalnessNode = float(0);
  m.aoNode = mix(con.arm.r, float(0.85), mk.g);
  return m;
}

export type IslandsOut = { collidables: THREE.Object3D[]; root: THREE.Group };

/** The island surface mask (R sand, G grass, B puddles) on the CPU, for scattering grass where the ground shows it. */
export function islandMask(isl: IslandLayout) {
  const s = islandSurface(isl.radius, ISLAND_DECOR);
  return { data: s.maskData, size: s.maskSize, R: isl.radius };
}

export function buildIslands(map: IslandLayout[], teamColors: number[]): IslandsOut {
  const root = new THREE.Group();
  root.name = 'islands';
  const collidables: THREE.Object3D[] = [];
  const dress = new StaticBatch(); // non-colliding decoration
  const solid = new StaticBatch(); // bunker walls: match sim colliders exactly
  const M = mats();
  const n = map.length;
  const R = map[0].radius;
  const groundY = map[0].groundY;

  const topMat = islandTopMaterial(R);
  const wallMat = M.seawall;
  const wallGeo = new THREE.CylinderGeometry(R, R, groundY + QUAY_DEPTH, 128, 1, true);
  {
    const uvA = wallGeo.getAttribute('uv');
    const rep = Math.round((2 * Math.PI * R) / 6);
    for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * rep);
  }
  const topGeo = new THREE.CircleGeometry(R, 128).rotateX(-Math.PI / 2);

  for (const isl of map) {
    const yaw = isl.bunker.facingYaw;
    const L = new THREE.Matrix4().compose(new THREE.Vector3(isl.center.x, 0, isl.center.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    const rng = makeRng(101 + isl.index * 977);

    // --- playable disc: exactly the sim's flat cylinder (radius R, top at groundY)
    const top = new THREE.Mesh(topGeo, topMat);
    top.position.set(isl.center.x, groundY, isl.center.z);
    top.rotation.y = yaw;
    top.receiveShadow = true;
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(isl.center.x, (groundY - QUAY_DEPTH) / 2, isl.center.z);
    wall.receiveShadow = true;
    root.add(top, wall);
    collidables.push(top, wall);

    // fenders hang on the outside of the wall (outside the disc); low mooring bollards on the coping
    const fenders = Math.round((2 * Math.PI * R) / 6);
    for (let k = 0; k < fenders; k++) {
      const a = (k / fenders) * Math.PI * 2;
      dress.add(M.rubber, new THREE.BoxGeometry(0.4, 1.3, 0.26), L.clone().multiply(mat(Math.sin(a) * (R + 0.12), groundY - 0.85, Math.cos(a) * (R + 0.12), 0, a, 0)), 0xffffff, true);
    }
    for (let k = 0; k < 14; k++) {
      const a = ((k + 0.5) / 14) * Math.PI * 2;
      bollard(dress, L.clone().multiply(mat(Math.sin(a) * (R - 0.45), groundY, Math.cos(a) * (R - 0.45))));
    }

    // --- bunker: concrete boxes identical to bunkerWallBoxes
    const b = isl.bunker;
    for (const bx of bunkerWallBoxes(b)) {
      const m = mat(bx.center.x, bx.center.y, bx.center.z, 0, bx.rotY, 0);
      solid.add(M.concrete, boxUV(bx.half.x * 2, bx.half.y * 2, bx.half.z * 2, 3), m, 0xd8d2c4);
    }
    const BL = new THREE.Matrix4().compose(new THREE.Vector3(b.center.x, groundY, b.center.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    dress.add(M.slab, boxUV(9, 0.04, 9, 3), BL.clone().multiply(mat(0, 0.02, 0)), 0xe6e0d2, false);
    dress.add(M.matte, new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2), BL.clone().multiply(mat(0, 0.045, 0)), 0x8f8a7f, false);
    // team stripe painted on the walls
    const team = teamColors[isl.index % teamColors.length];
    for (const d of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const DF = BL.clone().multiply(mat(0, 0, 0, 0, d, 0));
      for (const sx of [-1, 1]) dress.add(M.paint, new THREE.PlaneGeometry(1.3, 0.22).rotateY(Math.PI), DF.clone().multiply(mat(sx * 1.6, 1.6, -2.305)), team, false);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 0.05), new THREE.MeshStandardNodeMaterial({ color: team, roughness: 0.5 }));
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    plate.position.set(b.center.x, groundY + 2.4, b.center.z).addScaledVector(fwd, 2.33);
    plate.rotation.y = yaw;
    root.add(plate);

    // --- gameplay props: detailed visuals + invisible exact-size collision proxies
    const props = [
      { key: 'generator' as const, build: generatorProp, label: 'GENERATOR', bg: '#b07d00' },
      { key: 'vault' as const, build: vaultProp, label: 'VAULT', bg: '#2a3440' },
      { key: 'shop' as const, build: shopProp, label: 'SHOP', bg: '#0f8478' },
    ];
    for (const p of props) {
      const h = PROP_HALF[p.key], pos = isl[p.key];
      const PB = new THREE.Matrix4().compose(new THREE.Vector3(pos.x, pos.y, pos.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
      p.build(dress, PB, new THREE.Vector3(h.x, h.y, h.z));
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2), M.matte);
      proxy.position.set(pos.x, pos.y + h.y, pos.z);
      proxy.rotation.y = yaw;
      proxy.visible = false; // raycasts still hit it (Raycaster ignores .visible)
      proxy.name = `proxy:${p.key}`;
      root.add(proxy);
      collidables.push(proxy);
      const s = labelSprite(p.label, p.bg);
      s.position.set(pos.x, pos.y + h.y * 2 + (p.key === 'shop' ? 1.35 : 0.55), pos.z);
      root.add(s);
    }

    buildBackdrop(dress, L, rng, isl, n, R, groundY);
  }

  distantIslands(dress, map);

  const bunkers = solid.build(root, 'bunkers');
  collidables.push(...bunkers);
  dress.build(root, 'dressing');
  return { collidables, root };
}

/**
 * Harbor scenery behind each island (local +Z), separated from the playable disc by open water so nothing
 * here can be mistaken for walkable ground or cover.
 */
export function backdropFrame(isl: IslandLayout, n: number) {
  const ring = Math.hypot(isl.center.x, isl.center.z);
  const z0 = isl.radius + CHANNEL;
  const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8));
  return { z0, hw, top: isl.groundY + 0.2 };
}

function buildBackdrop(b: StaticBatch, L: THREE.Matrix4, rng: ReturnType<typeof makeRng>, isl: IslandLayout, n: number, _R: number, _groundY: number) {
  const M = mats();
  const { z0, hw, top } = backdropFrame(isl, n);
  const depth = 80, z1 = z0 + depth;
  const at = (x: number, y: number, z: number, ry = 0) => L.clone().multiply(mat(x, y, z, 0, ry, 0));

  // quay slab: concrete top + seawall faces (front + sides)
  {
    const slab = new THREE.PlaneGeometry(2 * hw, depth).rotateX(-Math.PI / 2);
    const u = slab.getAttribute('uv');
    for (let i = 0; i < u.count; i++) u.setXY(i, (u.getX(i) * 2 * hw) / 3, (u.getY(i) * depth) / 3);
    b.add(M.asphalt, slab, at(0, top, z0 + depth / 2), 0xffffff, false);
  }
  const face = (w: number) => {
    const g = new THREE.PlaneGeometry(w, top + QUAY_DEPTH);
    const u = g.getAttribute('uv');
    for (let i = 0; i < u.count; i++) u.setXY(i, (u.getX(i) * w) / 6, u.getY(i) * ((top + QUAY_DEPTH) / 16) + (1 - (top + QUAY_DEPTH) / 16));
    return g;
  };
  const wallY = (top - QUAY_DEPTH) / 2;
  b.add(M.seawall, face(2 * hw).rotateY(Math.PI), at(0, wallY, z0), 0xffffff, false);
  b.add(M.seawall, face(depth).rotateY(Math.PI / 2), at(hw, wallY, z0 + depth / 2), 0xffffff, false);
  b.add(M.seawall, face(depth).rotateY(-Math.PI / 2), at(-hw, wallY, z0 + depth / 2), 0xffffff, false);
  // edge: yellow line, bollards, fenders
  b.add(M.paint, new THREE.PlaneGeometry(2 * hw - 1, 0.18).rotateX(-Math.PI / 2), at(0, top + 0.065, z0 + 0.9), 0xe8b81c, false);
  b.add(M.slab, boxUV(2 * hw, 0.08, 1.4, 3), at(0, top + 0.02, z0 + 0.7), 0xffffff, false);
  for (let x = -hw + 3; x < hw - 1; x += 7) bollard(b, at(x, top, z0 + 0.6));
  for (let x = -hw + 2; x < hw; x += 4.5) b.add(M.rubber, new THREE.BoxGeometry(0.5, 1.2, 0.25), at(x, top - 0.9, z0 - 0.12));

  // crane over the channel, warehouse, containers, masts, palms, clutter
  crane(b, at(hw * 0.55, top, z0 + 9, 0), 22);
  warehouse(b, at(-hw * 0.38, top, z0 + 24), `PALMERA FREIGHT  ·  PIER ${isl.index + 3}`);
  containerStack(b, at(hw * 0.08, top, z0 + 8, Math.PI / 2), [2, 3, 1], rng);
  containerStack(b, at(hw * 0.2, top, z0 + 18, 0), [3, 2, 4, 3], rng);
  containerStack(b, at(hw * 0.85, top, z0 + 30, Math.PI / 2 + 0.02), [2, 3, 2], rng);
  containerStack(b, at(-hw * 0.88, top, z0 + 10, 0), [2, 1, 2], rng);
  container(b, at(-hw * 0.05, top, z0 + 3.5, 0.08), 0x2a7f86);
  lightMast(b, at(-hw * 0.7, top, z0 + 4));
  lightMast(b, at(hw * 0.25, top, z0 + 4));
  for (const [x, z] of [[-hw * 0.95, 3], [-hw * 0.6, 2.2], [hw * 0.98, 3.5], [-hw * 0.15, 2]]) palm(b, at(x, top, z0 + z, rng.rr(0, 6)), rng, rng.rr(8, 11), rng.rr(1.2, 2.4));
  drums(b, at(hw * 0.38, top, z0 + 3), 4, rng);
  drums(b, at(-hw * 0.3, top, z0 + 5), 3, rng);
  for (const [x, z] of [[-hw * 0.45, 4], [-hw * 0.42, 5.4], [hw * 0.02, 13]]) pallet(b, at(x, top, z0 + z));

  // jungle hill behind the yard
  const W = 2 * hw + 90, D = 110, SX = 60, SZ = 32;
  const g = new THREE.PlaneGeometry(W, D, SX, SZ).rotateX(-Math.PI / 2);
  const pos = g.getAttribute('position');
  const cols: number[] = [];
  const phase = isl.index * 1.7;
  const hAt = (x: number, zz: number) => {
    const k = Math.min(1, Math.max(0, (zz + D / 2 - 6) / 45));
    return Math.pow(k, 1.3) * 26 * (0.6 + 0.4 * Math.sin(x * 0.045 + phase)) + Math.sin(x * 0.11) * Math.cos(zz * 0.13) * 1.6;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), zz = pos.getZ(i);
    const ix = i % (SX + 1), iz = Math.floor(i / (SX + 1));
    const edge = ix === 0 || ix === SX || iz === SZ;
    const h = edge ? -6 : Math.max(0, hAt(x, zz) + rng.rr(-0.3, 0.3));
    pos.setY(i, h);
    const k = Math.min(1, h / 5);
    cols.push(0.62 - 0.45 * k, 0.58 - 0.22 * k, 0.42 - 0.3 * k);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  const hillZ = z1 - 4 + D / 2;
  b.add(M.terrain, g, at(0, top - 0.25, hillZ), 0xffffff, false);
  const blob = new THREE.IcosahedronGeometry(1, 2);
  {
    const bp = blob.getAttribute('position');
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      const k = 1 + 0.18 * Math.sin(x * 7.1 + y * 3.3) * Math.cos(z * 6.7 - y * 2.1);
      bp.setXYZ(i, x * k, y * k, z * k);
    }
    blob.computeVertexNormals();
  }
  const leafCols = [0x2a4f1f, 0x34602a, 0x22441b, 0x406d2c];
  for (let i = 0; i < 260; i++) {
    const x = rng.rr(-W / 2 + 8, W / 2 - 8), zz = rng.rr(-D / 2 + 10, D / 2 - 6);
    const h = hAt(x, zz);
    if (h < 1.2) continue;
    const s = rng.rr(2.4, 5);
    b.add(M.leaf, blob, at(x, top - 0.25 + h + s * 0.35, hillZ + zz).multiply(mat(0, 0, 0, 0, rng.rr(0, 6), 0, s * rng.rr(1, 1.4), s * rng.rr(0.8, 1.1), s * rng.rr(1, 1.4))), leafCols[i % 4], false, false);
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.rr(-W / 2 + 10, W / 2 - 10), zz = rng.rr(-D / 2 + 4, -D / 2 + 40);
    palm(b, at(x, top - 0.25 + Math.max(0, hAt(x, zz)) - 0.3, hillZ + zz, rng.rr(0, 6)), rng, rng.rr(9, 14), rng.rr(1, 3));
  }
}

function distantIslands(b: StaticBatch, map: IslandLayout[]) {
  const M = mats();
  const rng = makeRng(4242);
  const ring = Math.hypot(map[0].center.x, map[0].center.z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng.rr(-0.25, 0.25);
    const d = ring + rng.rr(380, 650), s = rng.rr(55, 120), peak = s * rng.rr(0.22, 0.4);
    const seg = 18, ang = 40, pos: number[] = [], col: number[] = [], idx: number[] = [];
    const ph = rng.rr(0, 6), ph2 = rng.rr(0, 6);
    for (let r = 0; r <= seg; r++) for (let k = 0; k <= ang; k++) {
      const t = r / seg, th = (k / ang) * Math.PI * 2;
      const wob = 1 + 0.18 * Math.sin(th * 3 + ph) + 0.08 * Math.sin(th * 7 + ph2);
      const x = Math.cos(th) * t * wob, z = Math.sin(th) * t * wob * 0.6;
      const hump = Math.pow(Math.max(0, 1 - t * t), 1.4) * (0.75 + 0.25 * Math.sin(th * 2 + ph2) * t + 0.15 * Math.sin(th * 5 + ph) * t);
      const y = r === seg ? -0.04 : hump;
      pos.push(x * s * 1.6, y * peak, z * s * 1.6);
      const beach = t > 0.88 ? 1 : 0;
      const c = beach ? [0.78, 0.72, 0.56] : [0.2 + 0.08 * rng.rnd(), 0.36 + 0.08 * rng.rnd(), 0.17];
      col.push(...c);
    }
    for (let r = 0; r < seg; r++) for (let k = 0; k < ang; k++) {
      const p0 = r * (ang + 1) + k, p1 = p0 + 1, p2 = p0 + ang + 1, p3 = p2 + 1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    b.add(M.terrain, geo, mat(Math.cos(a) * d, -1, Math.sin(a) * d, 0, rng.rr(0, 6), 0), 0xffffff, false, false);
  }
}
