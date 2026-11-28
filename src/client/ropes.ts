import * as THREE from 'three/webgpu';
import { GRAPPLE, PLAYER } from '../sim/constants';
import type { HookState } from '../sim/types';

/** Segments per rope (sag curve), ropes drawn at once (one per player), claw prongs per hook. */
const SEGS = 16, MAX_ROPES = 8, PRONGS = 3;
const CABLE_W = 0.022, PRONG_W = 0.035, PRONG_LEN = 0.2;
/**
 * The elastic look, all from the time since the bite (no sim rope state, so nothing steps at the 30 Hz snapshot rate):
 * the rope lands with BITE_SLACK of extra length per metre that is taken up at TAKE_UP /s, with one damped twang
 * (amplitude per metre, capped; frequency; decay /s). Flying out it sags FLY_SAG per metre with a slow whip.
 */
const BITE_SLACK = 0.06, TAKE_UP = 14, TWANG_AMP = 0.03, TWANG_MAX = 0.3, TWANG_HZ = 6, TWANG_DECAY = 9;
const FLY_SAG = 0.05, WHIP = 0.06, WHIP_HZ = 2.5;

/** Per-player rope look state (reused: one object per player id for the match). */
type RopeLook = { st: number; bitAt: number };

/**
 * Grappling hook ropes: every rope and claw in the match as thin boxes in ONE instanced mesh (one draw call; nothing
 * drawn and no work at all while no hook is out). Flying out the rope sags a little with a slow whip; when it bites it
 * lands a touch slack, snaps taut within a few frames with one small damped twang, and then stays straight while it
 * pulls. Everything is a smooth function of the render time since the bite (exact at any frame rate; no per-frame
 * allocations).
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
  private readonly side = new THREE.Vector3();
  private static readonly Z = new THREE.Vector3(0, 0, 1);
  private readonly looks = new Map<number, RopeLook>();
  /** Per-rope shape for point(): sag depth (m), twang amplitude (m) and phase, whip (flying) amplitude and phase. */
  private sag = 0;
  private wob = 0;
  private wobPhase = 0;
  private whip = 0;
  private whipT = 0;

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
   * Player `id`'s rope from their hand `from` for hook `h` at sim time `t`. `target`: the yanked player's feet
   * (st 2). Returns false when nothing is drawn (cap reached).
   */
  add(id: number, from: THREE.Vector3, h: HookState, t: number, target: THREE.Vector3 | null): boolean {
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
    let look = this.looks.get(id);
    if (!look) { look = { st: -1, bitAt: -1e9 }; this.looks.set(id, look); }
    const latched = h.st === 1 || h.st === 2;
    if (latched && look.st !== h.st) look.bitAt = Math.max(h.at, t - 0.05); // bit (the snapshot can land a tick late)
    look.st = h.st;
    const age = Math.max(0, t - look.bitAt);
    if (latched) {
      // Slack taken up fast after the bite (parabola of the same length), then a straight rope.
      const extra = BITE_SLACK * out * Math.exp(-TAKE_UP * age);
      this.sag = Math.sqrt((3 * out * extra) / 8) + 0.004 * out;
      this.wob = Math.min(TWANG_MAX, TWANG_AMP * out) * Math.exp(-TWANG_DECAY * age);
      this.wobPhase = Math.sin(age * TWANG_HZ * Math.PI * 2);
      this.whip = 0;
    } else {
      this.sag = FLY_SAG * out;
      this.wob = 0;
      this.whip = WHIP * Math.min(1, out / 6);
      this.whipT = t * WHIP_HZ * Math.PI * 2;
    }
    const width = CABLE_W;
    // Sideways for the wobble: horizontal, across the rope.
    this.side.subVectors(end, from).cross(this.u.set(0, 1, 0));
    if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
    this.side.normalize();
    for (let i = 0; i < SEGS; i++) {
      this.point(from, end, i / SEGS, this.p0);
      this.point(from, end, (i + 1) / SEGS, this.p1);
      this.seg(this.p0, this.p1, width);
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

  /** Forget a player's rope look (they left). */
  drop(id: number) { this.looks.delete(id); }

  end() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private point(a: THREE.Vector3, b: THREE.Vector3, k: number, out: THREE.Vector3) {
    out.lerpVectors(a, b, k);
    const bell = 4 * k * (1 - k);
    out.y -= this.sag * bell;
    // Twang: the first string mode (fixed at both ends); whip: a wave running out along a flying rope.
    const across = this.wob * Math.sin(Math.PI * k) * this.wobPhase + this.whip * bell * Math.sin(k * 6 - this.whipT);
    if (across !== 0) out.addScaledVector(this.side, across);
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
