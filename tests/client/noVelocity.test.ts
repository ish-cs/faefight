import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { noVelocity } from '../../src/client/world/post';

describe('noVelocity', () => {
  // On presets without a scene-pass MRT (low, competitive) three uses the material's MRT alone: it must still
  // write the colour output, or the fragment shader has no outputs (invalid WGSL, critters/swarms vanished on low).
  it('keeps the colour output next to the zero velocity', () => {
    const m = new THREE.MeshStandardNodeMaterial();
    noVelocity(m);
    const keys = Object.keys((m.mrtNode as unknown as { outputNodes: Record<string, unknown> }).outputNodes);
    expect(keys).toContain('output');
    expect(keys).toContain('velocity');
  });
});
