import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { StaticBatch, STATIC_INDEX_MIN_VERTS } from '../../src/client/world/geo';

const mat = new THREE.Matrix4().compose(new THREE.Vector3(3, 1, -2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(2, 1, 1));

describe('StaticBatch parts', () => {
  // indexed parts keep one (indexed) copy and are flattened only when the merged mesh is non-indexed: the
  // flattened result must equal flattening first (the old path), vertex for vertex
  it('a light bin merges non-indexed, same vertices as the flattened source', () => {
    const b = new StaticBatch();
    const box = new THREE.BoxGeometry(1, 2, 3);
    b.add(new THREE.MeshBasicNodeMaterial(), box, mat, 0x336699);
    const [{ geometry: g }] = b.take();
    const want = box.toNonIndexed().applyMatrix4(mat);
    expect(g.index).toBeNull();
    expect(Object.keys(g.attributes).sort()).toEqual(['color', 'normal', 'pc', 'position', 'uv']);
    expect(Array.from(g.getAttribute('position').array)).toEqual(Array.from(want.getAttribute('position').array));
    expect(Array.from(g.getAttribute('normal').array).map((x) => +x.toFixed(5))).toEqual(Array.from(want.getAttribute('normal').array).map((x) => +x.toFixed(5)));
    const c = new THREE.Color(0x336699);
    expect(Array.from(g.getAttribute('color').array.slice(0, 3))).toEqual(Array.from(new Float32Array([c.r, c.g, c.b])));
    // part centre: the transformed box's centre, on every vertex
    const pc = g.getAttribute('pc');
    expect([pc.getX(5), pc.getY(5), pc.getZ(5)].map((x) => +x.toFixed(4))).toEqual([3, 1, -2]);
  });

  it('a heavy bin stays indexed (no re-welding)', () => {
    const b = new StaticBatch();
    const m = new THREE.MeshBasicNodeMaterial();
    const sphere = new THREE.SphereGeometry(1, 64, 64); // 4225 verts, 8064 tris → 24k non-indexed verts each
    for (let i = 0; i < 2; i++) b.add(m, sphere, new THREE.Matrix4().makeTranslation(i * 3, 0, 0));
    expect(8064 * 3 * 2).toBeGreaterThanOrEqual(STATIC_INDEX_MIN_VERTS);
    const meshes = b.build(new THREE.Group(), 'test');
    expect(meshes).toHaveLength(1);
    expect(meshes[0].geometry.index?.count).toBe(8064 * 3 * 2);
  });

  it('parts without normals keep the flat-shaded non-indexed copy (unchanged path)', () => {
    const b = new StaticBatch();
    const g0 = new THREE.BoxGeometry(1, 1, 1);
    g0.deleteAttribute('normal');
    b.add(new THREE.MeshBasicNodeMaterial(), g0, null);
    const [{ geometry: g }] = b.take();
    const want = g0.toNonIndexed();
    want.computeVertexNormals();
    expect(Array.from(g.getAttribute('normal').array)).toEqual(Array.from(want.getAttribute('normal').array));
  });
});
