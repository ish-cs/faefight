import * as THREE from 'three/webgpu';
import { float, positionWorld, texture, uv, vec3 } from 'three/tsl';
import { bunkerWallBoxes, type IslandLayout, type MapDef, type StaticBox } from '../../sim/map';
import { PROP_HALF } from '../../sim/physics';
import { buildCenter } from './center';
import { boxUV, mat, StaticBatch } from './geo';
import { barrierProp, containerCover, containerLite, reefer, rtg } from './mapProps';
import { CONTAINER_COLORS, mats } from './materials';
import { bollard, container, containerStack, crane, drums, generatorProp, lightMast, pallet, palm, shopProp, vaultProp, warehouse } from './props';
import { type Footprint, grainTex, islandTopTex, makeRng, yardTopTex } from './textures';

const UNLIT_BOOST = 2.6;
const QUAY_DEPTH = 14; // how far the quay walls go below y=0 (never visible past the water)
const CHANNEL = 14; // water between the playable disc and the off-island backdrop quay
const TYRE = new THREE.TorusGeometry(0.34, 0.13, 8, 14);

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

/** Quay-wall material: seawall map with v tied to world height so the algae band sits at the waterline. */
function seawallMaterial(topY: number) {
  const M = mats();
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  m.name = 'quayWall';
  const tex = M.seawall.map!;
  // canvas covers 16 m of wall: v=1 at topY, v=0 at topY-16
  const v = positionWorld.y.sub(topY - 16).div(16);
  const u = uv().x;
  m.colorNode = texture(tex, vec3(u, v, 0).xy).rgb;
  return m;
}

export type IslandsOut = { collidables: THREE.Object3D[]; root: THREE.Group };

/** Island-local XZ footprints of island 0's built-in cover (identical on every island). */
function coverBays(isl: IslandLayout, statics: StaticBox[]): Footprint[] {
  const yaw = isl.bunker.facingYaw, c = Math.cos(yaw), s = Math.sin(yaw);
  return statics.filter((b) => b.island === isl.index).map((b) => {
    const dx = b.center.x - isl.center.x, dz = b.center.z - isl.center.z;
    // inverse of rotation.y = yaw
    return { x: dx * c - dz * s, z: dx * s + dz * c, hx: b.half.x, hz: b.half.z };
  });
}

export function buildIslands(def: MapDef, teamColors: number[]): IslandsOut {
  const map = def.islands;
  const yard = def.template === 'yard';
  const root = new THREE.Group();
  root.name = 'islands';
  const collidables: THREE.Object3D[] = [];
  const dress = new StaticBatch(); // non-colliding decoration
  const solid = new StaticBatch(); // bunker walls + barriers: match sim colliders exactly
  const M = mats();
  const n = map.length;
  const R = map[0].radius;
  const groundY = map[0].groundY;

  // shared island top material: painted layout map × fine grain
  const topMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.93 });
  topMat.name = 'islandTop';
  const grain = texture(grainTex(), positionWorld.xz.mul(0.35)).r;
  const topTex = yard ? yardTopTex(R, coverBays(map[0], def.statics)) : islandTopTex(R);
  topMat.colorNode = texture(topTex, uv()).rgb.mul(grain.mul(0.5).add(0.75));
  topMat.roughnessNode = float(0.95).sub(grain.mul(0.1));
  const wallMat = seawallMaterial(groundY);
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

    // fenders hang on the outside of the wall (outside the disc): rubber blocks (harbor) or tyres (yard).
    // The mooring bollards on the coping are breakable cosmetics now (cosmetics.ts).
    const fenders = Math.round((2 * Math.PI * R) / 6);
    for (let k = 0; k < fenders; k++) {
      const a = (k / fenders) * Math.PI * 2;
      const m = L.clone().multiply(mat(Math.sin(a) * (R + 0.12), groundY - 0.85, Math.cos(a) * (R + 0.12), 0, a, 0));
      if (yard) dress.add(M.rubber, TYRE, m.multiply(mat(0, 0, 0.06)), 0xffffff, true);
      else dress.add(M.rubber, new THREE.BoxGeometry(0.4, 1.3, 0.26), m, 0xffffff, true);
    }

    // --- bunker: concrete boxes identical to bunkerWallBoxes
    const b = isl.bunker;
    for (const bx of bunkerWallBoxes(b)) {
      const m = mat(bx.center.x, bx.center.y, bx.center.z, 0, bx.rotY, 0);
      solid.add(M.concrete, boxUV(bx.half.x * 2, bx.half.y * 2, bx.half.z * 2, 3), m, 0xd8d2c4);
    }
    const BL = new THREE.Matrix4().compose(new THREE.Vector3(b.center.x, groundY, b.center.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    dress.add(M.concrete, boxUV(9, 0.04, 9, 3), BL.clone().multiply(mat(0, 0.02, 0)), 0xe6e0d2, false);
    dress.add(M.matte, new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2), BL.clone().multiply(mat(0, 0.045, 0)), 0x8f8a7f, false);
    // team stripe painted on the walls
    const team = teamColors[isl.index % teamColors.length];
    for (const d of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const DF = BL.clone().multiply(mat(0, 0, 0, 0, d, 0));
      for (const sx of [-1, 1]) dress.add(M.paint, new THREE.PlaneGeometry(1.3, 0.22).rotateY(Math.PI), DF.clone().multiply(mat(sx * 1.6, 1.95, -2.305)), team, false);
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

    if (yard) buildYardBackdrop(dress, L, rng, isl, n, R, groundY);
    else buildBackdrop(dress, L, rng, isl, n, R, groundY);
  }

  // built-in cover: container stacks on the player islands, concrete barriers on the center island.
  // Visual hulls fill the sim's boxes exactly; containers get an invisible exact proxy for the camera.
  def.statics.forEach((st, i) => {
    const c = new THREE.Vector3(st.center.x, st.center.y, st.center.z), h = new THREE.Vector3(st.half.x, st.half.y, st.half.z);
    if (st.look === 'barrier') {
      barrierProp(solid, dress, new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.rotY), new THREE.Vector3(1, 1, 1)), h);
      return;
    }
    containerCover(dress, c, h, st.rotY, i);
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2), M.matte);
    proxy.position.copy(c);
    proxy.rotation.y = st.rotY;
    proxy.visible = false;
    proxy.name = `proxy:cover${i}`;
    root.add(proxy);
    collidables.push(proxy);
  });

  buildCenter(def, root, dress, collidables, wallMat, QUAY_DEPTH, labelSprite);
  if (yard) gapCranes(dress, map, groundY, def.center);
  distantIslands(dress, map);

  const bunkers = solid.build(root, 'bunkers');
  collidables.push(...bunkers);
  dress.build(root, 'dressing');
  return { collidables, root };
}

type Rng = ReturnType<typeof makeRng>;
type At = (x: number, y: number, z: number, ry?: number) => THREE.Matrix4;
type Frame = { at: At; z0: number; z1: number; depth: number; hw: number; top: number };

/** Backdrop frame behind an island (local +Z): quay from z0 to z1, half-width hw, deck at `top`. */
function backdropFrame(L: THREE.Matrix4, isl: IslandLayout, n: number, R: number, groundY: number): Frame {
  const ring = Math.hypot(isl.center.x, isl.center.z);
  const z0 = R + CHANNEL, depth = 80;
  return {
    at: (x, y, z, ry = 0) => L.clone().multiply(mat(x, y, z, 0, ry, 0)),
    z0, z1: z0 + depth, depth,
    hw: Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8)),
    top: groundY + 0.2,
  };
}

/** Quay slab (deck tinted by `deck`) + seawall faces (front + sides) + coping, bollards and fenders. */
function backdropQuay(b: StaticBatch, { at, z0, depth, hw, top }: Frame, deck: number, tyres: boolean) {
  const M = mats();
  {
    const slab = new THREE.PlaneGeometry(2 * hw, depth).rotateX(-Math.PI / 2);
    const u = slab.getAttribute('uv');
    for (let i = 0; i < u.count; i++) u.setXY(i, (u.getX(i) * 2 * hw) / 3, (u.getY(i) * depth) / 3);
    b.add(M.concrete, slab, at(0, top, z0 + depth / 2), deck, false);
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
  b.add(M.paint, new THREE.PlaneGeometry(2 * hw - 1, 0.18).rotateX(-Math.PI / 2), at(0, top + 0.01, z0 + 0.9), 0xe8b81c, false);
  b.add(M.concrete, boxUV(2 * hw, 0.08, 0.5, 3), at(0, top + 0.02, z0 + 0.25), 0xd6d0c2, false);
  for (let x = -hw + 3; x < hw - 1; x += 7) bollard(b, at(x, top, z0 + 0.6));
  for (let x = -hw + 2; x < hw; x += 4.5) {
    if (tyres) b.add(M.rubber, TYRE, at(x, top - 0.9, z0 - 0.2));
    else b.add(M.rubber, new THREE.BoxGeometry(0.5, 1.2, 0.25), at(x, top - 0.9, z0 - 0.12));
  }
}

/**
 * Harbor scenery behind each island (local +Z), separated from the playable disc by open water so nothing
 * here can be mistaken for walkable ground or cover.
 */
function buildBackdrop(b: StaticBatch, L: THREE.Matrix4, rng: Rng, isl: IslandLayout, n: number, R: number, groundY: number) {
  const F = backdropFrame(L, isl, n, R, groundY);
  const { at, z0, hw, top } = F;
  backdropQuay(b, F, 0xffffff, false);

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
  jungleHill(b, F, rng, isl, 260, 14);
}

/** Jungle hill behind the quay: displaced terrain, `blobs` canopy blobs, `palms` palms. */
function jungleHill(b: StaticBatch, { at, z1, hw, top }: Frame, rng: Rng, isl: IslandLayout, blobs: number, palms: number) {
  const M = mats();
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
  for (let i = 0; i < blobs; i++) {
    const x = rng.rr(-W / 2 + 8, W / 2 - 8), zz = rng.rr(-D / 2 + 10, D / 2 - 6);
    const h = hAt(x, zz);
    if (h < 1.2) continue;
    const s = rng.rr(2.4, 5);
    b.add(M.leaf, blob, at(x, top - 0.25 + h + s * 0.35, hillZ + zz).multiply(mat(0, 0, 0, 0, rng.rr(0, 6), 0, s * rng.rr(1, 1.4), s * rng.rr(0.8, 1.1), s * rng.rr(1, 1.4))), leafCols[i % 4], false, false);
  }
  for (let i = 0; i < palms; i++) {
    const x = rng.rr(-W / 2 + 10, W / 2 - 10), zz = rng.rr(-D / 2 + 4, -D / 2 + 40);
    palm(b, at(x, top - 0.25 + Math.max(0, hAt(x, zz)) - 0.3, hillZ + zz, rng.rr(0, 6)), rng, rng.rr(9, 14), rng.rr(1, 3));
  }
}

/**
 * Container Yard scenery behind each island: a terminal apron with RTG-served container blocks, a reefer
 * row, light masts, a ship-to-shore crane over the channel and the warehouse; the hill is thinner.
 */
function buildYardBackdrop(b: StaticBatch, L: THREE.Matrix4, rng: Rng, isl: IslandLayout, n: number, R: number, groundY: number) {
  const F = backdropFrame(L, isl, n, R, groundY);
  const { at, z0, hw, top } = F;
  const M = mats();
  backdropQuay(b, F, 0x9a968e, true);
  const pick = () => CONTAINER_COLORS[Math.floor(rng.rnd() * CONTAINER_COLORS.length)];
  // painted apron: lane lines along the quay
  for (const z of [5.5, 11.5, 30]) b.add(M.paint, new THREE.PlaneGeometry(2 * hw - 4, 0.15).rotateX(-Math.PI / 2), at(0, top + 0.01, z0 + z), z === 5.5 ? 0xe8b81c : 0xe6e3da, false);
  /** A block of `bays` × `rows` stacks (long axis X), first row at z, heights 1..maxH. */
  const block = (cx: number, z: number, bays: number, rows: number, maxH: number) => {
    for (let bay = 0; bay < bays; bay++) for (let row = 0; row < rows; row++) {
      const hgt = 1 + Math.floor(rng.rnd() * maxH);
      for (let k = 0; k < hgt; k++) {
        const x = cx + (bay - (bays - 1) / 2) * 6.4;
        containerLite(b, at(x + rng.rr(-0.05, 0.05), top + k * 2.59, z + row * 2.6, rng.rr(-0.01, 0.01)), pick());
      }
    }
  };
  const bx = hw * 0.45;
  for (const sx of [-1, 1]) {
    block(sx * bx, z0 + 15, 2, 4, 3);
    rtg(b, at(sx * bx, top, z0 + 15 + 3.9), 19, 14, 17);
    block(sx * bx, z0 + 34, 3, 5, 4);
  }
  block(0, z0 + 50, 4, 4, 2);
  // reefer row on the apron (plugged into a power rack) + a few loose boxes
  for (let k = 0; k < 3; k++) reefer(b, at(-hw * 0.1, top, z0 + 7 + k * 2.6, Math.PI));
  b.add(M.galv, new THREE.BoxGeometry(0.3, 3, 8), at(-hw * 0.1 - 4.2, top + 1.5, z0 + 9.6));
  container(b, at(hw * 0.12, top, z0 + 4, 0.06), pick());
  container(b, at(hw * 0.12, top, z0 + 7.5, -0.03), pick());
  container(b, at(hw * 0.12, top + 2.59, z0 + 5.8, 0.02), pick());
  // ship-to-shore crane over the channel, warehouse at the back, light masts
  crane(b, at(-hw * 0.62, top, z0 + 9, 0), 22);
  warehouse(b, at(hw * 0.05, top, z0 + 66), `PALMERA CONTAINER TERMINAL  ·  BERTH ${isl.index + 1}`);
  for (const [x, z] of [[-hw * 0.82, 4], [hw * 0.82, 4], [-hw * 0.2, 26], [hw * 0.7, 26]]) lightMast(b, at(x, top, z0 + z));
  drums(b, at(hw * 0.3, top, z0 + 3), 4, rng);
  for (const [x, z] of [[hw * 0.36, 5.2], [hw * 0.4, 6.6]]) pallet(b, at(x, top, z0 + z));
  jungleHill(b, F, rng, isl, 120, 8);
}

/** Yard only: a ship-to-shore crane standing in the water over each gap between islands, boom toward the middle. */
function gapCranes(b: StaticBatch, map: IslandLayout[], groundY: number, center: MapDef['center']) {
  const M = mats();
  const n = map.length;
  const ring = Math.hypot(map[0].center.x, map[0].center.z);
  const R = map[0].radius;
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (2 * Math.PI * (i + 0.5)) / n;
    const d = ring + R * 0.75;
    // with 2 players the center island sits on a gap bisector: no crane (legs or boom) over it or its approach
    if (Math.hypot(Math.cos(a) * d - center.center.x, Math.sin(a) * d - center.center.z) < center.radius + 36) continue;
    const yaw = Math.atan2(Math.cos(a), Math.sin(a)); // local -Z points at the middle
    const B = mat(Math.cos(a) * d, groundY - 1.2, Math.sin(a) * d, 0, yaw, 0);
    crane(b, B, 24);
    // pile caps under the four legs (below deck level, never reachable)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.add(M.concrete, boxUV(3, QUAY_DEPTH, 3, 3), B.clone().multiply(mat(sx * 8, -QUAY_DEPTH / 2 + 0.3, sz * 8)), 0xc9c2b4, false);
    }
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
