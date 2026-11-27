import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { containerLodsFrom } from '../../src/client/world/containerModel';

// The baked container (scripts/blender/container/build_container.py) must keep filling the sim's cover boxes exactly
// (6.058 × 2.591 × 2.438, base at y = 0, long axis X) and stay cheap: it is merged into the static batches by the dozen.
let lods: [THREE.BufferGeometry, THREE.BufferGeometry];
beforeAll(async () => {
  const fsMod = 'node:fs'; // no @types/node in this repo
  const { readFileSync } = (await import(/* @vite-ignore */ fsMod)) as { readFileSync(p: string): Uint8Array };
  const buf = readFileSync('public/assets/models/container.glb');
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  lods = containerLodsFrom(gltf.scene);
});

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('baked container model', () => {
  it('both LODs span the ISO 20 ft box: base on the deck, long axis X', () => {
    for (const g of lods) {
      g.computeBoundingBox();
      const b = g.boundingBox!;
      expect(b.min.y).toBeCloseTo(0, 2);
      expect(b.max.y).toBeCloseTo(2.591, 2);
      expect(b.max.x - b.min.x).toBeCloseTo(6.058, 1);
      expect(b.max.z - b.min.z).toBeCloseTo(2.438, 1);
    }
  });
  it('keeps the triangle budget (LOD0 ≤ 300, LOD1 ≤ 12) and only position/normal/uv', () => {
    expect(tris(lods[0])).toBeLessThanOrEqual(300);
    expect(tris(lods[1])).toBeLessThanOrEqual(12);
    for (const g of lods) expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position', 'uv']);
  });
  it('UVs stay inside the atlas (v already un-flipped from glTF)', () => {
    for (const g of lods) {
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0); expect(uv.getX(i)).toBeLessThanOrEqual(1);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0); expect(uv.getY(i)).toBeLessThanOrEqual(1);
      }
    }
  });
});
