import * as THREE from 'three/webgpu';
import { attribute, float, length, max, min, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { bunkerWallBoxes, type MapDef } from '../../sim/map';
import { CENTER_PROP_HALF, centerPropYaw, PROP_HALF } from '../../sim/physics';

/**
 * Baked-style ambient occlusion on the ground: one merged mesh of soft dark footprints under everything that stands
 * on the slab (containers, barriers, bunker walls, generator/vault/shop, center stations). The falloff is a rounded-box
 * distance field in the fragment shader, so it costs one transparent draw and no per-frame CPU. It complements GTAO
 * (high/ultra) and is the only contact darkening on low.
 */
export type Footprint = { x: number; y: number; z: number; hx: number; hz: number; rotY: number; margin: number };

/** Strength of the footprint darkening (debug-tweakable). */
export const groundAOStrength = uniform(0.42);

/** Ground footprints for a map (pure: unit-tested). Only boxes resting on the ground (bottom within 15 cm). */
export function groundFootprints(def: MapDef): Footprint[] {
  const out: Footprint[] = [];
  const grounds = [def.center.groundY, ...def.islands.map((i) => i.groundY)];
  const onGround = (y: number) => grounds.some((g) => Math.abs(y - g) < 0.15);
  const box = (c: { x: number; y: number; z: number }, h: { x: number; y: number; z: number }, rotY: number, margin: number) => {
    const bottom = c.y - h.y;
    if (!onGround(bottom)) return;
    out.push({ x: c.x, y: bottom, z: c.z, hx: h.x, hz: h.z, rotY, margin });
  };
  for (const s of def.statics) box(s.center, s.half, s.rotY, Math.min(1.1, 0.35 + s.half.y * 0.45));
  for (const isl of def.islands) {
    for (const b of bunkerWallBoxes(isl.bunker, false)) box(b.center, b.half, b.rotY, 0.7);
    for (const key of ['generator', 'vault', 'shop'] as const) {
      const p = isl[key], h = PROP_HALF[key];
      box({ x: p.x, y: p.y + h.y, z: p.z }, h, isl.bunker.facingYaw, 0.45);
    }
  }
  const c = def.center;
  for (const key of ['goldGen', 'supplyGen', 'potionShop'] as const) {
    const p = c[key], h = CENTER_PROP_HALF[key];
    box({ x: p.x, y: p.y + h.y, z: p.z }, h, centerPropYaw(p, c.center), 0.45);
  }
  return out;
}

export function buildGroundAO(def: MapDef): THREE.Mesh | null {
  const fps = groundFootprints(def);
  if (fps.length === 0) return null;
  const pos = new Float32Array(fps.length * 4 * 3), loc = new Float32Array(fps.length * 4 * 2), box = new Float32Array(fps.length * 4 * 3);
  const idx: number[] = [];
  fps.forEach((f, i) => {
    const ex = f.hx + f.margin, ez = f.hz + f.margin;
    const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz], k) => {
      const lx = sx * ex, lz = sz * ez;
      // three.js rotation.y: x' = x c + z s, z' = -x s + z c
      pos.set([f.x + lx * c + lz * s, f.y + 0.012, f.z - lx * s + lz * c], (i * 4 + k) * 3);
      loc.set([lx, lz], (i * 4 + k) * 2);
      box.set([f.hx, f.hz, f.margin], (i * 4 + k) * 3);
    });
    const b = i * 4;
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aoLocal', new THREE.BufferAttribute(loc, 2));
  g.setAttribute('aoBox', new THREE.BufferAttribute(box, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();

  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  m.name = 'groundAO';
  const p = attribute<'vec2'>('aoLocal', 'vec2'), bx = attribute<'vec3'>('aoBox', 'vec3');
  // distance outside the footprint rectangle (0 inside), softened by a rounded corner
  const q = p.abs().sub(vec2(bx.x, bx.y));
  const outside = length(max(q, vec2(0, 0))).add(min(max(q.x, q.y), float(0)));
  const k = float(1).sub(smoothstep(float(0), bx.z, outside));
  m.colorNode = vec3(0.02, 0.025, 0.03);
  m.opacityNode = k.mul(k).mul(groundAOStrength);
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'groundAO';
  mesh.renderOrder = 1;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  return mesh;
}
