import * as THREE from 'three/webgpu';
import { float, positionWorld, texture, uv } from 'three/tsl';
import { CENTER } from '../../sim/constants';
import type { MapDef } from '../../sim/map';
import { CENTER_PROP_HALF, centerPropYaw } from '../../sim/physics';
import { mat, StaticBatch } from './geo';
import { goldGenProp, potionProp, supplyProp } from './mapProps';
import { mats } from './materials';
import { centerTopTex, grainTex } from './textures';

type Label = (text: string, bg: string) => THREE.Sprite;

/**
 * The neutral center island: disc + quay wall in the template's style, the three stations (exact collider
 * footprints, invisible proxies for the camera), the shield well pad (flat: nothing over ~3 cm) with a
 * glowing ring and a light column, and floating labels.
 */
export function buildCenter(def: MapDef, root: THREE.Group, dress: StaticBatch, collidables: THREE.Object3D[], wallMat: THREE.Material, quayDepth: number, label: Label) {
  const M = mats();
  const c = def.center;
  const R = c.radius, g = c.groundY;
  const yard = def.template === 'yard';
  // painted pads in island-local XZ (the center island is off the origin with 2 players)
  const stations = [c.goldGen, c.supplyGen, c.potionShop].map((p) => ({ x: p.x - c.center.x, z: p.z - c.center.z }));

  const topMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.93 });
  topMat.name = 'centerTop';
  const grain = texture(grainTex(), positionWorld.xz.mul(0.35)).r;
  topMat.colorNode = texture(centerTopTex(R, def.template, stations, CENTER.wellRadius), uv()).rgb.mul(grain.mul(0.5).add(0.75));
  topMat.roughnessNode = float(0.95).sub(grain.mul(0.1));
  const top = new THREE.Mesh(new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2), topMat);
  top.position.set(c.center.x, g, c.center.z);
  top.receiveShadow = true;
  const wallGeo = new THREE.CylinderGeometry(R, R, g + quayDepth, 96, 1, true);
  {
    const uvA = wallGeo.getAttribute('uv');
    const rep = Math.round((2 * Math.PI * R) / 6);
    for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * rep);
  }
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.set(c.center.x, (g - quayDepth) / 2, c.center.z);
  wall.receiveShadow = true;
  top.name = 'center:top'; wall.name = 'center:wall';
  root.add(top, wall);
  collidables.push(top, wall);

  // fenders on the outside of the wall: rubber blocks (harbor) or hung tyres (yard)
  const fenders = Math.round((2 * Math.PI * R) / 5);
  const tyre = new THREE.TorusGeometry(0.34, 0.13, 8, 14);
  for (let k = 0; k < fenders; k++) {
    const a = (k / fenders) * Math.PI * 2;
    const m = mat(c.center.x + Math.sin(a) * (R + 0.14), g - 0.9, c.center.z + Math.cos(a) * (R + 0.14), 0, a, 0);
    if (yard) dress.add(M.rubber, tyre, m, 0xffffff, true);
    else dress.add(M.rubber, new THREE.BoxGeometry(0.4, 1.3, 0.26), m, 0xffffff, true);
  }

  // shield well: flat steel pad, glowing ring and a faint light column (no collider, walkable)
  const w = c.shieldWell, wr = CENTER.wellRadius;
  dress.add(M.steel, new THREE.CylinderGeometry(wr + 0.25, wr + 0.32, 0.03, 48), mat(w.x, w.y + 0.015, w.z), 0x7d868d, false);
  dress.add(M.shield, new THREE.RingGeometry(wr - 0.09, wr + 0.04, 64).rotateX(-Math.PI / 2), mat(w.x, w.y + 0.034, w.z), 0xffffff, false);
  dress.add(M.shield, new THREE.RingGeometry(0.28, 0.4, 32).rotateX(-Math.PI / 2), mat(w.x, w.y + 0.034, w.z), 0x9fdfff, false);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    dress.add(M.shield, new THREE.CircleGeometry(0.07, 10).rotateX(-Math.PI / 2), mat(w.x + Math.cos(a) * (wr * 0.6), w.y + 0.034, w.z + Math.sin(a) * (wr * 0.6)), 0xffffff, false);
  }
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(wr - 0.05, wr, 3.4, 40, 1, true), M.beam);
  beam.position.set(w.x, w.y + 1.7, w.z);
  beam.name = 'center:wellBeam';
  beam.renderOrder = 2;
  root.add(beam);

  // stations: art faces the middle (the box colliders are symmetric, so the visual turns by π freely)
  const props = [
    { key: 'goldGen' as const, build: goldGenProp, label: 'GOLD 2×', bg: '#a8790a', lift: 0.55 },
    { key: 'supplyGen' as const, build: supplyProp, label: 'SUPPLIES', bg: '#4d5a36', lift: 0.55 },
    { key: 'potionShop' as const, build: potionProp, label: 'POTIONS', bg: '#5a3d8a', lift: 1.2 },
  ];
  for (const p of props) {
    const h = CENTER_PROP_HALF[p.key], pos = c[p.key];
    const yaw = centerPropYaw(pos, c.center);
    const PB = new THREE.Matrix4().compose(new THREE.Vector3(pos.x, pos.y, pos.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI), new THREE.Vector3(1, 1, 1));
    p.build(dress, PB, new THREE.Vector3(h.x, h.y, h.z));
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2), M.matte);
    proxy.position.set(pos.x, pos.y + h.y, pos.z);
    proxy.rotation.y = yaw;
    proxy.visible = false; // raycasts still hit it
    proxy.name = `proxy:${p.key}`;
    root.add(proxy);
    collidables.push(proxy);
    const s = label(p.label, p.bg);
    s.position.set(pos.x, pos.y + h.y * 2 + p.lift, pos.z);
    root.add(s);
  }
  const s = label('SHIELD', '#1d6f8c');
  s.position.set(w.x, w.y + 3.0, w.z);
  root.add(s);
}
