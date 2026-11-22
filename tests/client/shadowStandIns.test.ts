import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SHADOW_STANDINS, StaticBatch } from '../../src/client/world/geo';
import { CAST_FAR_LAYER, SHADOW_ONLY_LAYER } from '../../src/client/world/lod';

const saved = { ...SHADOW_STANDINS };
afterEach(() => Object.assign(SHADOW_STANDINS, saved));

function build(spread: number) {
  const b = new StaticBatch();
  const mat = new THREE.MeshStandardNodeMaterial();
  for (const x of [-spread, spread]) b.add(mat, new THREE.BoxGeometry(2, 2, 2), new THREE.Matrix4().makeTranslation(x, 0, 0));
  const root = new THREE.Group();
  const meshes = b.build(root, 't', { chunked: true });
  const standIns = root.children.filter((o) => o.name.includes(':shadow@')) as THREE.Mesh[];
  return { meshes, standIns };
}

describe('shadow stand-ins for map-wide static meshes', () => {
  it('a heavy map-wide caster: per-cell copies cast into the near cascades, the merged mesh only into the far ones', () => {
    SHADOW_STANDINS.minTris = 0;
    const { meshes, standIns } = build(100);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].castShadow).toBe(true);
    expect(meshes[0].layers.mask).toBe(1 << CAST_FAR_LAYER); // camera + far cascades enable it, near cascades don't
    expect(standIns).toHaveLength(2);
    for (const s of standIns) {
      expect(s.castShadow).toBe(true);
      expect(s.layers.mask).toBe(1 << SHADOW_ONLY_LAYER);
    }
    const tris = (g: THREE.BufferGeometry) => g.getAttribute('position').count / 3;
    expect(standIns.reduce((n, s) => n + tris(s.geometry), 0)).toBe(tris(meshes[0].geometry));
  });

  it('a compact mesh keeps casting itself', () => {
    SHADOW_STANDINS.minTris = 0;
    const { meshes, standIns } = build(5);
    expect(meshes[0].castShadow).toBe(true);
    expect(standIns).toHaveLength(0);
  });
});
