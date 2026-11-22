import * as THREE from 'three/webgpu';
import { GRAPPLE, PLAYER } from '../sim/constants';
import type { HookState } from '../sim/types';

/** Segments per rope (sag curve), ropes drawn at once (one per player), claw prongs per hook. */
const SEGS = 12, MAX_ROPES = 8, PRONGS = 3;
const CABLE_W = 0.022, PRONG_W = 0.035, PRONG_LEN = 0.2;

/**
 * Grappling hook ropes: every rope and claw in the match as thin boxes in ONE instanced mesh (one draw call; nothing
 * drawn and no work at all while no hook is out). A rope sags while it flies and pulls nearly straight once it
 * latches. Positions are worked out from the snapshot's HookState and the time (sim seconds) each frame.
 */
export class Ropes {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly p0 = new THREE.Vector3();
  private readonly p1 = new THREE.Vector3();
  private readonly tip = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3631, roughness: 0.75, metalness: 0.35 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_ROPES * (SEGS + PRONGS + 1));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false; // ropes span the map; per-instance bounds would cost more than they save
    this.mesh.castShadow = false;
    scene.add(this.mesh);
  }

  begin() { this.n = 0; }

  /**
   * One player's rope from their hand `from` for hook `h` at sim time `t`. `target`: the yanked player's feet
   * (st 2). Returns false when nothing is drawn (cap reached).
   */
  add(from: THREE.Vector3, h: HookState, t: number, target: THREE.Vector3 | null): boolean {
    if (this.n + SEGS + PRONGS + 1 > this.mesh.instanceMatrix.count) return false;
    const end = this.tip;
    if (h.st === 2 && target) end.set(target.x, target.y + PLAYER.height * 0.6, target.z);
    else end.set(h.x, h.y, h.z);
    const full = from.distanceTo(end);
    if (full < 0.05) return false;
    // How far the claw is out: flying (st 0), out and back (st 3), latched (1, 2).
    let out = full;
    if (h.st === 0) out = Math.min(full, Math.max(0, t - h.t0) * GRAPPLE.tipSpeed);
    else if (h.st === 3) out = Math.max(0, Math.min(full, (t - h.t0) * GRAPPLE.tipSpeed, (h.at - t) * GRAPPLE.tipSpeed));
    if (out < 0.05) return true;
    end.sub(from).multiplyScalar(out / full).add(from);
    const latched = h.st === 1 || h.st === 2;
    const sag = (latched ? 0.012 : 0.07) * out;
    for (let i = 0; i < SEGS; i++) {
      this.point(from, end, i / SEGS, sag, this.p0);
      this.point(from, end, (i + 1) / SEGS, sag, this.p1);
      this.seg(this.p0, this.p1, CABLE_W);
    }
    // The claw: a shank and three prongs bent back from the tip.
    this.d.subVectors(end, from).normalize();
    this.u.set(0, 1, 0);
    if (Math.abs(this.d.y) > 0.95) this.u.set(1, 0, 0);
    this.u.cross(this.d).normalize(); // perpendicular
    this.p0.copy(end).addScaledVector(this.d, -PRONG_LEN);
    this.seg(this.p0, end, PRONG_W);
    for (let k = 0; k < PRONGS; k++) {
      this.w.copy(this.u).applyAxisAngle(this.d, (k * Math.PI * 2) / PRONGS).multiplyScalar(0.8).addScaledVector(this.d, -0.6).normalize();
      this.p1.copy(end).addScaledVector(this.w, PRONG_LEN);
      this.seg(end, this.p1, PRONG_W);
    }
    return true;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private point(a: THREE.Vector3, b: THREE.Vector3, k: number, sag: number, out: THREE.Vector3) {
    out.lerpVectors(a, b, k);
    out.y -= sag * 4 * k * (1 - k);
  }

  private seg(a: THREE.Vector3, b: THREE.Vector3, width: number) {
    this.d.subVectors(b, a);
    const len = this.d.length();
    if (len < 1e-4) return;
    this.q.setFromUnitVectors(Ropes.Z, this.d.multiplyScalar(1 / len));
    this.m.compose(a, this.q, this.s.set(width, width, len));
    this.mesh.setMatrixAt(this.n++, this.m);
  }
}
