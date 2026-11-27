import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { bendQuayModule, structuresFrom, type StructureName } from '../../src/client/world/structureModel';
import { bunkerSlitBoxes, bunkerWallBoxes, type Bunker } from '../../src/sim/map';
import { MAP } from '../../src/sim/constants';

// The baked bunker (scripts/blender/structures/build_structures.py) is a visual mesh only: it must keep matching the
// sim's wall boxes exactly (players collide with those), keep the doors and firing slits open, and stay cheap. The
// quay module must bend onto the same 128-gon as the island slab.
let geo: Record<StructureName, THREE.BufferGeometry>;
beforeAll(async () => {
  const fsMod = 'node:fs'; // no @types/node in this repo
  const { readFileSync } = (await import(/* @vite-ignore */ fsMod)) as { readFileSync(p: string): Uint8Array };
  const buf = readFileSync('public/assets/models/structures.glb');
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  geo = structuresFrom(gltf.scene);
});

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const local: Bunker = { center: { x: 0, y: 0, z: 0 }, facingYaw: 0, doorways: [] };
const FLOOR_Y = 0.045;

function triCentroids(g: THREE.BufferGeometry): THREE.Vector3[] {
  const p = g.getAttribute('position'), idx = g.index;
  const out: THREE.Vector3[] = [];
  for (let t = 0; t < tris(g); t++) {
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(t * 3 + k) : t * 3 + k));
    out.push(c.divideScalar(3));
  }
  return out;
}

describe('baked bunker', () => {
  it('spans the sim bunker exactly: 4.6 × 4.6 outer, roof top at height + 0.2, base on the ground', () => {
    const g = geo.bunker;
    g.computeBoundingBox();
    const b = g.boundingBox!, outer = MAP.bunker.interior + 2 * MAP.bunker.wall;
    expect(b.min.x).toBeCloseTo(-outer / 2, 4); expect(b.max.x).toBeCloseTo(outer / 2, 4);
    expect(b.min.z).toBeCloseTo(-outer / 2, 4); expect(b.max.z).toBeCloseTo(outer / 2, 4);
    expect(b.min.y).toBeCloseTo(0, 4); expect(b.max.y).toBeCloseTo(MAP.bunker.height + 0.2, 4);
  });

  it('every wall triangle lies on the surface of the sim wall boxes (never inside one, never off them)', () => {
    const boxes = bunkerWallBoxes(local); // rotY 0: axis-aligned
    const inside = (c: THREE.Vector3, eps: number) => boxes.some((bx) =>
      Math.abs(c.x - bx.center.x) < bx.half.x - eps && Math.abs(c.y - bx.center.y) < bx.half.y - eps && Math.abs(c.z - bx.center.z) < bx.half.z - eps);
    let walls = 0;
    for (const c of triCentroids(geo.bunker)) {
      if (Math.abs(c.y - FLOOR_Y) < 1e-4) continue; // interior floor
      walls++;
      expect(inside(c, 1e-4)).toBe(false); // not buried in a box
      expect(inside(c, -1e-4)).toBe(true); // but on one's boundary
    }
    expect(walls).toBeGreaterThan(100);
  });

  it('keeps the doors and every firing slit open', () => {
    const mesh = new THREE.Mesh(geo.bunker, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    const clear = (o: THREE.Vector3, d: THREE.Vector3, len: number) => { ray.set(o, d.normalize()); ray.far = len; return ray.intersectObject(mesh).length === 0; };
    for (const sl of bunkerSlitBoxes(local)) {
      const thinX = sl.half.x < sl.half.z;
      const o = new THREE.Vector3(sl.center.x, sl.center.y, sl.center.z).add(thinX ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, -1));
      expect(clear(o, thinX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1), 2)).toBe(true);
    }
    // front door (−Z) at head height and knee height, side doors (±X)
    for (const y of [0.5, 2.1]) {
      expect(clear(new THREE.Vector3(0, y, -3.5), new THREE.Vector3(0, 0, 1), 1.6)).toBe(true);
      expect(clear(new THREE.Vector3(-3.5, y, 0), new THREE.Vector3(1, 0, 0), 1.6)).toBe(true);
      expect(clear(new THREE.Vector3(3.5, y, 0), new THREE.Vector3(-1, 0, 0), 1.6)).toBe(true);
    }
    // the back wall is solid
    expect(clear(new THREE.Vector3(0, 1, 3.5), new THREE.Vector3(0, 0, -1), 1.6)).toBe(false);
  });

  it('keeps the triangle budget and only position/normal/uv, UVs inside the atlas', () => {
    expect(tris(geo.bunker)).toBeLessThanOrEqual(1300);
    expect(tris(geo.quay)).toBeLessThanOrEqual(100);
    for (const g of [geo.bunker, geo.quay]) {
      expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position', 'uv']);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0); expect(uv.getX(i)).toBeLessThanOrEqual(1);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0); expect(uv.getY(i)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('baked quay module', () => {
  const R = MAP.islandRadius, arc = (R * 2 * Math.PI * 8) / 128;
  it('is 8 rim segments long, deck to 0.6 m under the waterline, beam 8 cm proud', () => {
    const g = geo.quay;
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.max.x - b.min.x).toBeCloseTo(arc, 3);
    expect(b.max.y).toBeCloseTo(0, 4);
    expect(b.min.y).toBeCloseTo(MAP.waterY - MAP.groundY - 0.6, 3);
    expect(b.min.z).toBeCloseTo(0, 4); expect(b.max.z).toBeCloseTo(0.08, 4);
  });

  it('bends onto the slab rim: its deck-edge corners land on the 128-gon vertices', () => {
    const bent = bendQuayModule(geo.quay, R, MAP.groundY);
    const p = bent.getAttribute('position');
    const want = [-1, 1].map((s) => { const th = (s * Math.PI) / 16; return new THREE.Vector3(R * Math.cos(th), MAP.groundY, -R * Math.sin(th)); });
    for (const w of want) {
      let best = Infinity;
      for (let i = 0; i < p.count; i++) best = Math.min(best, w.distanceTo(new THREE.Vector3().fromBufferAttribute(p, i)));
      expect(best).toBeLessThan(1e-4);
    }
    // outward normals of the wall face point away from the island centre
    const n = bent.getAttribute('normal');
    let outward = 0;
    for (let i = 0; i < p.count; i++) {
      const r = new THREE.Vector3(p.getX(i), 0, p.getZ(i)).normalize();
      if (Math.abs(n.getY(i)) < 0.5 && r.dot(new THREE.Vector3(n.getX(i), 0, n.getZ(i))) > 0.99) outward++;
    }
    expect(outward).toBeGreaterThan(p.count / 2);
  });
});
