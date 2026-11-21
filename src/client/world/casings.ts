import * as THREE from 'three/webgpu';
import type { Quality } from './sky';

/** Spent cases left lying around, per quality preset (oldest recycled first). */
export const CASING_CAP: Record<Quality, number> = { low: 60, high: 160, ultra: 260 };
const MAX = Math.max(...Object.values(CASING_CAP));
/** Seconds a case stays on the ground before it shrinks away over the next second (if not recycled sooner). */
export const CASING_LIFE = 5;
const G = 14;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3(), _c = new THREE.Color();

/**
 * Ejected shell casings that tumble, bounce, lie on the ground a few seconds, then shrink away: one InstancedMesh
 * (1 draw call), a ring buffer capped per quality. Resting cases cost nothing per frame (their matrices are left alone).
 * Each hard bounce calls `onClink` (position, impact speed m/s, shotgun hull or brass) for the clink sound.
 */
export class Casings {
  readonly mesh: THREE.InstancedMesh;
  /** 16 floats each: px py pz vx vy vz qx qy qz qw spin floor len rad age active(0 free, 1 flying, 2 resting) */
  private st = new Float32Array(MAX * 16);
  private next = 0;
  private high = 0;
  limit = CASING_CAP.high;
  onClink: ((x: number, y: number, z: number, speed: number, hull: boolean) => void) | null = null;

  constructor() {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 7).rotateX(Math.PI / 2); // unit case along Z
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.85 });
    mat.name = 'casings';
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'casings';
  }

  get live() { let n = 0; for (let i = 0; i < this.high; i++) if (this.st[i * 16 + 15] > 0) n++; return n; }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, len: number, rad: number, color: number, floorY: number) {
    if (this.next >= this.limit) this.next = 0;
    const i = this.next++;
    if (i >= this.high) this.high = i + 1;
    const s = i * 16, st = this.st;
    st[s] = x; st[s + 1] = y; st[s + 2] = z; st[s + 3] = vx; st[s + 4] = vy; st[s + 5] = vz;
    _q.setFromAxisAngle(_ax.set(0, 1, 0), Math.random() * Math.PI * 2);
    st[s + 6] = _q.x; st[s + 7] = _q.y; st[s + 8] = _q.z; st[s + 9] = _q.w;
    st[s + 10] = 8 + Math.random() * 14; st[s + 11] = floorY; st[s + 12] = len; st[s + 13] = rad; st[s + 14] = 0; st[s + 15] = 1;
    this.mesh.setColorAt(i, _c.setHex(color).multiplyScalar(0.85 + Math.random() * 0.25));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = this.high;
  }

  update(dt: number) {
    if (this.high > this.limit) { // quality lowered: drop the extras
      for (let i = this.limit; i < this.high; i++) { this.st[i * 16 + 15] = 0; this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); }
      this.high = this.limit; this.mesh.count = this.high; if (this.next >= this.limit) this.next = 0;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    const st = this.st;
    let dirty = false;
    for (let i = 0; i < this.high; i++) {
      const s = i * 16, state = st[s + 15];
      if (state === 0) continue;
      const age = (st[s + 14] += dt);
      if (state === 2) {
        if (age < CASING_LIFE) continue;
        const k = Math.max(0, 1 - (age - CASING_LIFE)); // shrink over the last second
        if (k <= 0) { st[s + 15] = 0; this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); dirty = true; continue; }
        this.write(i, k); dirty = true;
        continue;
      }
      st[s + 4] -= G * dt;
      st[s] += st[s + 3] * dt; st[s + 1] += st[s + 4] * dt; st[s + 2] += st[s + 5] * dt;
      const floor = st[s + 11] + st[s + 13];
      _q.set(st[s + 6], st[s + 7], st[s + 8], st[s + 9]);
      if (st[s + 1] <= floor) {
        st[s + 1] = floor;
        if (st[s + 4] < -1.2) {
          this.onClink?.(st[s], st[s + 1], st[s + 2], -st[s + 4], st[s + 12] > 0.05);
          st[s + 4] *= -0.3; st[s + 3] *= 0.5; st[s + 5] *= 0.5; st[s + 10] *= 0.5;
        } else {
          // Settle: lie flat (case axis horizontal) at a random heading, and stop simulating.
          _q.setFromAxisAngle(_ax.set(0, 1, 0), Math.atan2(st[s + 3], st[s + 5]) + Math.random());
          st[s + 6] = _q.x; st[s + 7] = _q.y; st[s + 8] = _q.z; st[s + 9] = _q.w;
          st[s + 15] = 2; st[s + 14] = 0;
          this.write(i, 1); dirty = true;
          continue;
        }
      }
      _q2.setFromAxisAngle(_ax.set(0.6, 0.2, 0.77).normalize(), st[s + 10] * dt);
      _q.premultiply(_q2);
      st[s + 6] = _q.x; st[s + 7] = _q.y; st[s + 8] = _q.z; st[s + 9] = _q.w;
      this.write(i, 1); dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private write(i: number, k: number) {
    const s = i * 16, st = this.st;
    _q.set(st[s + 6], st[s + 7], st[s + 8], st[s + 9]);
    _m.compose(_p.set(st[s], st[s + 1], st[s + 2]), _q, _s.set(st[s + 13] * k, st[s + 13] * k, st[s + 12] * k));
    this.mesh.setMatrixAt(i, _m);
  }
}
