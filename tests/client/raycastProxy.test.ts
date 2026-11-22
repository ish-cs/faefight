import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { raycastProxies } from '../../src/client/world/raycastProxy';

function twoBoxes() {
  const a = new THREE.BoxGeometry(2, 2, 2).toNonIndexed().translate(-50, 0, 10);
  const b = new THREE.BoxGeometry(2, 2, 2).toNonIndexed().translate(50, 0, 10);
  return new THREE.Mesh(mergeGeometries([a, b]), new THREE.MeshBasicMaterial());
}

describe('raycastProxies', () => {
  it('splits a map-wide mesh into per-cell meshes that keep every triangle', () => {
    const mesh = twoBoxes();
    const proxies = raycastProxies(mesh, 32);
    expect(proxies.length).toBe(2);
    const tris = proxies.reduce((n, p) => n + p.geometry.getAttribute('position').count / 3, 0);
    expect(tris).toBe(24);
    for (const p of proxies) expect(p.visible).toBe(false); // raycast only, never drawn
  });

  it('a ray hits the proxies exactly where it hits the original', () => {
    const mesh = twoBoxes();
    const proxies = raycastProxies(mesh, 32);
    const ray = new THREE.Raycaster(new THREE.Vector3(50, 0, 30), new THREE.Vector3(0, 0, -1));
    const a = ray.intersectObject(mesh, false)[0];
    const b = ray.intersectObjects(proxies, false)[0];
    expect(b.point.distanceTo(a.point)).toBeLessThan(1e-6);
    expect(b.distance).toBeCloseTo(a.distance, 6);
  });

  it('follows the source mesh transform', () => {
    const mesh = twoBoxes();
    mesh.position.set(0, 5, 0);
    mesh.updateMatrixWorld();
    const proxies = raycastProxies(mesh, 32);
    for (const p of proxies) p.updateMatrixWorld();
    const ray = new THREE.Raycaster(new THREE.Vector3(-50, 5, 30), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObjects(proxies, false)[0].point.z).toBeCloseTo(11, 6);
  });

  it('leaves a small mesh alone (one proxy is the mesh itself)', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    expect(raycastProxies(mesh, 32)).toEqual([mesh]);
  });
});
