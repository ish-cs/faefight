import * as THREE from 'three/webgpu';

/**
 * Raycast-only split of a mesh that spans the map (e.g. every island's bunker walls merged into one draw).
 * three's Mesh.raycast rejects by bounding box, then tests every triangle: a map-wide mesh's box contains every
 * ray, so the 3rd-person camera's 2–3 rays per frame each tested all 3.5k bunker triangles (~0.3 ms/frame).
 * Triangles are binned by centroid into `cell`-metre XZ cells; each cell becomes an invisible mesh (Raycaster
 * ignores `.visible`, the renderer skips it) with the source's transform and material, so hits are identical.
 * A mesh whose bounds already fit one cell is returned as is.
 */
export function raycastProxies(mesh: THREE.Mesh, cell: number): THREE.Mesh[] {
  const src = mesh.geometry;
  if (!src.boundingBox) src.computeBoundingBox();
  const bb = src.boundingBox!;
  if (bb.max.x - bb.min.x <= cell && bb.max.z - bb.min.z <= cell) return [mesh];
  const pos = src.getAttribute('position');
  const idx = src.index;
  const nTri = (idx ? idx.count : pos.count) / 3;
  const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const bins = new Map<string, number[]>();
  for (let t = 0; t < nTri; t++) {
    let cx = 0, cz = 0;
    for (let k = 0; k < 3; k++) { cx += pos.getX(vi(t, k)); cz += pos.getZ(vi(t, k)); }
    const key = `${Math.floor(cx / 3 / cell)},${Math.floor(cz / 3 / cell)}`;
    let b = bins.get(key);
    if (!b) bins.set(key, (b = []));
    b.push(t);
  }
  const out: THREE.Mesh[] = [];
  for (const [key, tris] of bins) {
    const a = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const v = vi(t, k); a[i * 9 + k * 3] = pos.getX(v); a[i * 9 + k * 3 + 1] = pos.getY(v); a[i * 9 + k * 3 + 2] = pos.getZ(v); } });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const p = new THREE.Mesh(g, mesh.material);
    p.name = `${mesh.name}:ray@${key}`;
    p.visible = false;
    p.position.copy(mesh.position);
    p.quaternion.copy(mesh.quaternion);
    p.scale.copy(mesh.scale);
    p.matrixWorld.copy(mesh.matrixWorld);
    out.push(p);
  }
  return out;
}
