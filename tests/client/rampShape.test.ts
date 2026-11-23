import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { pieceGeometry } from '../../src/client/world/pieces';
import { PIECES, RAMP_SLAB, rampHull } from '../../src/sim/constants';

// The build ghost / raycast proxy for a ramp is exactly the sim's thin slab, not a wedge.
describe('ramp ghost shape', () => {
  const g = pieceGeometry('ramp');
  const p = g.getAttribute('position');
  const hull = rampHull();
  const R = PIECES.ramp;

  it('uses only the collider hull points, closed (12 triangles)', () => {
    expect(p.count).toBe(36);
    for (let i = 0; i < p.count; i++) {
      let found = false;
      for (let k = 0; k < hull.length; k += 3)
        if (Math.abs(p.getX(i) - hull[k]) + Math.abs(p.getY(i) - hull[k + 1]) + Math.abs(p.getZ(i) - hull[k + 2]) < 1e-6) found = true;
      expect(found).toBe(true);
    }
  });

  it('faces point outward and the underside is open under the slope (no solid base)', () => {
    const c = new THREE.Vector3();
    for (let k = 0; k < hull.length; k += 3) c.add(new THREE.Vector3(hull[k], hull[k + 1], hull[k + 2]));
    c.divideScalar(hull.length / 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
    let downArea = 0;
    for (let t = 0; t < p.count; t += 3) {
      a.fromBufferAttribute(p, t); b.fromBufferAttribute(p, t + 1); d.fromBufferAttribute(p, t + 2);
      n.copy(b).sub(a).cross(d.clone().sub(a));
      const centroid = a.clone().add(b).add(d).divideScalar(3);
      expect(n.dot(centroid.sub(c))).toBeGreaterThan(0);
      if (n.y < 0) downArea += n.length() / 2;
    }
    // the only down-facing face is the sloped underside (w × slope length), not a w × d floor
    expect(downArea).toBeGreaterThan(R.w * 2.5);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(g.boundingBox!.max.y).toBeCloseTo(R.h, 6);
    // a vertical line near the middle (off the triangle diagonals) crosses only RAMP_SLAB of material
    const ray = new THREE.Raycaster(new THREE.Vector3(0.3, -1, 0.1), new THREE.Vector3(0, 1, 0));
    const hits = ray.intersectObject(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
    expect(hits.length).toBe(2);
    expect(hits[1].distance - hits[0].distance).toBeCloseTo(RAMP_SLAB, 5);
  });
});
