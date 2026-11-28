import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { Ropes } from '../../src/client/ropes';
import type { HookState } from '../../src/sim/types';

// The rope look (ropes.ts) is a smooth function of render time: at any frame rate, with snapshots arriving at 30 Hz,
// the rope's middle never jumps between frames (the old look drew its sag from the 30 Hz rest length and flickered).
const DT_SNAP = 1 / 30;

/** Rope middle (segment 8's start) per frame from the bite on, while the hand closes in on the anchor at ~25 m/s. */
function middles(fps: number) {
  const scene = new THREE.Scene();
  const r = new Ropes(scene);
  const anchor = { x: 0, y: 5, z: -20 };
  const out: THREE.Vector3[] = [];
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  const hand = new THREE.Vector3();
  for (let f = 0; f < fps * 0.6; f++) {
    const t = f / fps;
    // The snapshot (what the renderer gets) only changes at 30 Hz: st flips to 1 on the snapshot after the bite.
    const snapT = Math.floor(t / DT_SNAP) * DT_SNAP;
    const h: HookState = { st: snapT >= 0.1 ? 1 : 0, x: anchor.x, y: anchor.y, z: anchor.z, t0: 0, at: 0.09 };
    hand.set(0, 1.3 + Math.max(0, t - 0.1) * 6, -Math.max(0, t - 0.1) * 24);
    r.begin();
    r.add(1, hand, h, t, null);
    r.end();
    r.mesh.getMatrixAt(8, m);
    if (t >= 0.14) out.push(p.setFromMatrixPosition(m).clone()); // the claw is there (~20 m at 160 m/s): full length from here
  }
  return out;
}

describe('rope look', () => {
  for (const fps of [60, 144, 200]) {
    test(`no frame-to-frame jumps beyond the hand's own motion at ${fps} fps`, () => {
      const mids = middles(fps);
      let worst = 0;
      for (let i = 1; i < mids.length; i++) worst = Math.max(worst, mids[i].distanceTo(mids[i - 1]));
      // The middle moves with the hand (half its 26 m/s) plus the bite's take-up; no snapshot-rate pops.
      expect(worst).toBeLessThan((13 + 6) / fps + 0.08);
    });
  }
});
