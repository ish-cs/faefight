import * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { describe, expect, test } from 'vitest';
import { applyWet, stepWetness, WET } from '../../src/client/world/wetness';

const run = (from: number, to: number, s: number) => { let w = from; for (let t = 0; t < s; t += 1 / 60) w = stepWetness(w, to, 1 / 60); return w; };

describe('wetness', () => {
  test('soaks in over the rise time and dries much more slowly', () => {
    expect(run(0, 1, WET.riseS)).toBeGreaterThan(0.6);
    expect(run(0, 1, WET.riseS)).toBeLessThan(0.7);
    expect(run(0, 1, 10 * WET.riseS)).toBe(1); // snaps onto the target
    const dried = run(1, 0, WET.riseS);
    expect(dried).toBeGreaterThan(0.75); // still wet a while after the rain stops
    expect(run(1, 0, 10 * WET.dryS)).toBe(0);
  });

  test('a frame step never overshoots', () => {
    expect(stepWetness(0.2, 1, 1000)).toBeLessThanOrEqual(1);
    expect(stepWetness(0.8, 0, 1000)).toBeGreaterThanOrEqual(0);
  });

  test('applyWet wraps colour + roughness (and keeps a vec4 alpha), and refuses a bare material', () => {
    const m = new THREE.MeshStandardNodeMaterial();
    expect(() => applyWet(m)).toThrow(/wetness/);
    m.colorNode = vec3(0.5, 0.5, 0.5);
    m.roughnessNode = float(0.8);
    const c = m.colorNode, r = m.roughnessNode;
    applyWet(m, { puddles: true });
    expect(m.colorNode).not.toBe(c);
    expect(m.roughnessNode).not.toBe(r);
  });
});
