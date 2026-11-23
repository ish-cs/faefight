import * as THREE from 'three/webgpu';
import { ThirdPersonCamera } from '../camera';
import type { Shot } from './director';

/** Framing of each shot kind (m, rad/s). */
export const FRAME = {
  wide: { dist: 13, perPair: 0.6, height: 5.5, follow: 2.2 },
  orbit: { radius: 6.5, height: 2.6, spin: 0.32 },
  drone: { radius: 26, height: 42, spin: 0.07 },
  lookAt: 1.1,
  skin: 0.4,
} as const;

/**
 * Frames the director's shot: over the shoulder (the featured player's own aim, smoothed), a wide two-shot
 * of them and their opponent, a slow orbit around a kill spot, or a high drone view. A new shot is a hard
 * cut; within a shot the camera moves smoothly. No per-frame allocations.
 */
export class CinematicCamera {
  private tpc: ThirdPersonCamera;
  private ray = new THREE.Raycaster();
  private focus = new THREE.Vector3();
  private want = new THREE.Vector3();
  private look = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private seq = -1;
  /** Fixed per shot: the side the wide / orbit / drone camera starts from. */
  private angle0 = 0;

  constructor(private cam: THREE.PerspectiveCamera, private blockers: () => THREE.Object3D[]) {
    this.tpc = new ThirdPersonCamera(cam, blockers);
  }

  frame(shot: Shot, t: number, dt: number,
    posOf: (id: number, out: THREE.Vector3) => THREE.Vector3 | null,
    lookOf: (id: number) => { yaw: number; pitch: number } | null) {
    const cut = shot.seq !== this.seq;
    const p = posOf(shot.playerId, this.a);
    const o = shot.otherId !== undefined ? posOf(shot.otherId, this.b) : null;
    if (cut) {
      this.seq = shot.seq;
      // Start from the side facing the action: perpendicular to the pair, else behind the player's look.
      const lk = lookOf(shot.playerId);
      this.angle0 = p && o ? Math.atan2(o.z - p.z, o.x - p.x) + Math.PI / 2 : lk ? -lk.yaw + Math.PI / 2 : shot.seq * 1.7;
    }
    const k = cut ? 1 : 1 - Math.exp(-FRAME.wide.follow * dt);
    if (shot.kind === 'shoulder' && p) {
      const lk = lookOf(shot.playerId) ?? { yaw: this.cam.rotation.y, pitch: 0 };
      this.tpc.update(p, lk.yaw, Math.max(-0.5, Math.min(0.35, lk.pitch * 0.6)), dt);
      return;
    }
    const sp = t - shot.startedAt;
    if (shot.kind === 'orbit' || (shot.kind === 'shoulder' && !p)) {
      if (shot.at) this.focus.set(shot.at.x, shot.at.y, shot.at.z); else if (p) this.focus.copy(p); else if (cut) this.focus.copy(this.cam.position);
      const ang = this.angle0 + sp * FRAME.orbit.spin;
      this.want.set(this.focus.x + Math.cos(ang) * FRAME.orbit.radius, this.focus.y + FRAME.orbit.height, this.focus.z + Math.sin(ang) * FRAME.orbit.radius);
      this.place(this.focus, 1, cut);
      return;
    }
    if (shot.kind === 'drone') {
      if (shot.at) this.focus.set(shot.at.x, shot.at.y, shot.at.z); else if (p) this.focus.copy(p);
      const ang = this.angle0 + sp * FRAME.drone.spin;
      this.want.set(this.focus.x + Math.cos(ang) * FRAME.drone.radius, this.focus.y + FRAME.drone.height, this.focus.z + Math.sin(ang) * FRAME.drone.radius);
      this.place(this.focus, k, cut, false);
      return;
    }
    // Wide: frame the player (and their opponent), from the side, a little above.
    if (!p) return;
    if (o) this.focus.copy(p).add(o).multiplyScalar(0.5); else this.focus.copy(p);
    const span = o ? p.distanceTo(o) : 0;
    const d = FRAME.wide.dist + span * FRAME.wide.perPair;
    const ang = this.angle0 + sp * 0.02;
    this.want.set(this.focus.x + Math.cos(ang) * d, this.focus.y + FRAME.wide.height, this.focus.z + Math.sin(ang) * d);
    this.place(this.focus, k, cut);
  }

  /** Ease the camera toward `want` looking at `focus` (+ chest height); pulled in front of anything blocking the view. */
  private place(focus: THREE.Vector3, k: number, cut: boolean, occlude = true) {
    const target = this.dir.copy(focus).setY(focus.y + FRAME.lookAt);
    if (occlude) {
      const toCam = this.want;
      const len = target.distanceTo(toCam);
      if (len > 0.01) {
        const d = this.b.copy(toCam).sub(target).divideScalar(len);
        this.ray.set(target, d);
        this.ray.far = len;
        const hit = this.ray.intersectObjects(this.blockers(), false)[0];
        if (hit) this.want.copy(target).addScaledVector(d, Math.max(1.5, hit.distance - FRAME.skin));
      }
    }
    if (cut) { this.cam.position.copy(this.want); this.look.copy(target); }
    else { this.cam.position.lerp(this.want, k); this.look.lerp(target, Math.min(1, k * 1.6)); }
    this.cam.lookAt(this.look);
  }
}
