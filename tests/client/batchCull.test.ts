import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { batchCullStats, beginBatchCullFrame, installBatchCull } from '../../src/client/world/batchCull';

type Priv = {
  _updateDrawParameters: (c: THREE.Camera, g: THREE.BufferGeometry, m: THREE.Material, f?: string) => void;
  _indirectTexture: THREE.DataTexture; _mergedDrawCount: number; _multiDrawCount: number;
};

function setup() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicNodeMaterial();
  const mesh = new THREE.BatchedMesh(3, geo.getAttribute('position').count, geo.index!.count, mat);
  const gid = mesh.addGeometry(geo);
  const at = (x: number, z: number) => { const i = mesh.addInstance(gid); mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, z)); };
  at(0, -10); // in front of the camera
  at(0, 10); // behind it
  at(60, -10); // far to the side
  mesh.frustumCulled = false; mesh.sortObjects = false;
  installBatchCull(mesh);
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  cam.updateMatrixWorld();
  const shadow = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 50);
  shadow.position.set(0, 0, 20); // looks down -Z at the instance behind the camera
  shadow.updateMatrixWorld();
  return { mesh, p: mesh as unknown as Priv, geo, mat, cam, shadow };
}

describe('batchCull: one cull per frame for every pass', () => {
  it('draws what any of the frame frusta sees, culls the rest', () => {
    const { p, geo, mat, cam, shadow } = setup();
    beginBatchCullFrame(cam, [shadow]);
    p._updateDrawParameters(cam, geo, mat, 'merged');
    expect(p._multiDrawCount).toBe(2); // in view + behind (shadow cascade sees it); the far-side one is out
    expect(p._mergedDrawCount).toBe(1); // same geometry back to back: one instanced draw
  });

  it('later passes of the same frame reuse the list and do not re-upload', () => {
    const { p, geo, mat, cam, shadow } = setup();
    beginBatchCullFrame(cam, [shadow]);
    p._updateDrawParameters(cam, geo, mat, 'merged');
    const v = p._indirectTexture.version;
    const reused = batchCullStats.reused;
    p._updateDrawParameters(shadow, geo, mat, 'merged');
    expect(batchCullStats.reused).toBe(reused + 1);
    expect(p._indirectTexture.version).toBe(v);
  });

  it('a new frame with the same view does not re-upload; a changed view does', () => {
    const { p, geo, mat, cam, shadow } = setup();
    beginBatchCullFrame(cam, [shadow]);
    p._updateDrawParameters(cam, geo, mat, 'merged');
    const v = p._indirectTexture.version;
    beginBatchCullFrame(cam, [shadow]);
    p._updateDrawParameters(cam, geo, mat, 'merged');
    expect(p._indirectTexture.version).toBe(v);
    cam.rotation.y = -Math.PI / 2.4; // turn right toward the far-side instance
    cam.updateMatrixWorld();
    beginBatchCullFrame(cam, [shadow]);
    p._updateDrawParameters(cam, geo, mat, 'merged');
    expect(p._indirectTexture.version).toBeGreaterThan(v);
  });

  it('an unregistered camera (impostor bake) falls back to three\'s own per-pass cull', () => {
    const { p, geo, mat, cam, shadow } = setup();
    beginBatchCullFrame(cam, [shadow]);
    const other = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    other.position.set(60, 0, 0); other.updateMatrixWorld(); // looks down -Z from x = 60: sees only the far-side one
    const fb = batchCullStats.fallback;
    p._updateDrawParameters(other, geo, mat, 'merged');
    expect(batchCullStats.fallback).toBe(fb + 1);
    expect(p._multiDrawCount).toBe(1);
  });
});
