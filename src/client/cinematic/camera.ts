import * as THREE from 'three/webgpu';
import { ThirdPersonCamera } from '../camera';
import type { Pending, Shot } from './director';

/** Framing of each shot kind (m, rad/s, 1/s). */
export const FRAME = {
  /** Over the shoulder: the player's look, smoothed (yaw/pitch ease rates) and with a level, gentle pitch. */
  shoulder: { yawRate: 3.2, pitchRate: 2.5, minPitch: -0.32, maxPitch: 0.2 },
  /** Fight drone: elevated, framing both fighters, slowly tracking around them. */
  drone: { dist: 11, perPair: 0.75, height: 7.5, perPairUp: 0.25, spin: 0.05, follow: 1.6 },
  /** High wide drone: big moments and sudden death. */
  wide: { radius: 30, height: 34, spin: 0.04, follow: 1.0 },
  /** Subjects closer than this glide (the camera flies over); farther is a hard cut. */
  glideDist: 35,
  glideSec: 1.6,
  /** Anticipation: how far the camera turns toward the next subject before the cut (0..1). */
  leadTurn: 0.35,
  lookAt: 1.1,
  skin: 0.5,
  /** Keep at least this far above the focus' feet (never under a floor). */
  minUp: 1.2,
} as const;

const smooth = (x: number) => x * x * (3 - 2 * x);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Frames the director's shot: over the shoulder of the featured player (their aim, smoothed, level horizon),
 * an elevated drone shot framing both fighters, or a high wide drone. A new subject nearby is a glide (the
 * camera flies from where it is); far away, a hard cut. In the second before a cut the camera starts turning
 * toward the next subject. Geometry between the subject and the camera pulls the camera in front of it.
 * No per-frame allocations.
 */
export class CinematicCamera {
  private tpc: ThirdPersonCamera;
  private ray = new THREE.Raycaster();
  private focus = new THREE.Vector3();
  private want = new THREE.Vector3();
  private look = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private lastFocus = new THREE.Vector3();
  private startPos = new THREE.Vector3();
  private startQuat = new THREE.Quaternion();
  private endQuat = new THREE.Quaternion();
  private leadQuat = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  private seq = -1;
  private glideFrom = -Infinity;
  private yaw = 0;
  private pitch = 0;
  /** Fixed per shot: the side the drone camera starts from. */
  private angle0 = 0;
  private hasFocus = false;

  constructor(private cam: THREE.PerspectiveCamera, private blockers: () => THREE.Object3D[]) {
    this.tpc = new ThirdPersonCamera(cam, blockers);
  }

  frame(shot: Shot, pending: Pending | null, t: number, dt: number,
    posOf: (id: number, out: THREE.Vector3) => THREE.Vector3 | null,
    lookOf: (id: number) => { yaw: number; pitch: number } | null) {
    const p = posOf(shot.playerId, this.a);
    const o = shot.otherId !== undefined ? posOf(shot.otherId, this.b) : null;
    if (!p) return; // gone this frame: hold the last pose
    const lk = lookOf(shot.playerId);
    if (shot.seq !== this.seq) {
      // New shot: glide from the current pose when the new subject is close, else cut.
      const close = this.hasFocus && this.lastFocus.distanceTo(p) < FRAME.glideDist;
      this.seq = shot.seq;
      this.glideFrom = close ? t : -Infinity;
      this.startPos.copy(this.cam.position);
      this.startQuat.copy(this.cam.quaternion);
      this.yaw = lk?.yaw ?? this.cam.rotation.y;
      this.pitch = 0;
      // Drone: start on the side facing the action (perpendicular to the pair), else behind the player.
      this.angle0 = o ? Math.atan2(o.z - p.z, o.x - p.x) + Math.PI / 2 : Math.PI / 2 - this.yaw;
      // A drone shot coming in from close by starts on the camera's own side (no swing across).
      if (close && shot.kind !== 'shoulder') {
        const cur = Math.atan2(this.cam.position.z - p.z, this.cam.position.x - p.x);
        if (Math.abs(wrap(cur - this.angle0)) > Math.PI / 2) this.angle0 += Math.PI;
      }
    }
    const fresh = this.glideFrom === -Infinity && t - shot.startedAt < 1e-6;
    if (shot.kind === 'shoulder') {
      // The player's aim, eased (bots snap their aim; the camera doesn't), pitch kept gentle: a level horizon.
      const k = lk ?? { yaw: this.yaw, pitch: 0 };
      this.yaw += wrap(k.yaw - this.yaw) * (1 - Math.exp(-FRAME.shoulder.yawRate * dt));
      const wantPitch = Math.max(FRAME.shoulder.minPitch, Math.min(FRAME.shoulder.maxPitch, k.pitch * 0.5));
      this.pitch += (wantPitch - this.pitch) * (1 - Math.exp(-FRAME.shoulder.pitchRate * dt));
      this.tpc.update(p, this.yaw, this.pitch, dt);
      this.focus.copy(p);
    } else {
      const ang = this.angle0 + (t - shot.startedAt) * (shot.kind === 'wide' ? FRAME.wide.spin : FRAME.drone.spin);
      let d: number, h: number, follow: number;
      if (shot.kind === 'wide') {
        if (shot.at) this.focus.set(shot.at.x, p.y, shot.at.z); else this.focus.copy(p);
        d = FRAME.wide.radius; h = FRAME.wide.height; follow = FRAME.wide.follow;
      } else {
        // Frame both fighters: the midpoint, farther and higher the farther apart they are.
        if (o) this.focus.copy(p).add(o).multiplyScalar(0.5); else this.focus.copy(p);
        const span = o ? Math.min(30, p.distanceTo(o)) : 0;
        d = FRAME.drone.dist + span * FRAME.drone.perPair; h = FRAME.drone.height + span * FRAME.drone.perPairUp; follow = FRAME.drone.follow;
      }
      this.want.set(this.focus.x + Math.cos(ang) * d, this.focus.y + h, this.focus.z + Math.sin(ang) * d);
      this.place(this.focus, fresh ? 1 : 1 - Math.exp(-follow * dt), fresh);
    }
    this.lastFocus.copy(this.focus);
    this.hasFocus = true;

    // Glide: blend from the pose at the cut to the shot's pose.
    const g = (t - this.glideFrom) / FRAME.glideSec;
    if (g >= 0 && g < 1) {
      const s = smooth(g);
      this.endQuat.copy(this.cam.quaternion);
      this.cam.position.lerpVectors(this.startPos, this.cam.position, s);
      this.cam.quaternion.slerpQuaternions(this.startQuat, this.endQuat, s);
    }
    // Anticipation: in the second before a cut, start turning toward the next subject.
    if (pending && pending.playerId !== shot.playerId) {
      const q = posOf(pending.playerId, this.c);
      const span = pending.at - pending.from;
      if (q && span > 0) {
        const u = smooth(Math.max(0, Math.min(1, (t - pending.from) / span)));
        this.dir.copy(q).setY(q.y + FRAME.lookAt);
        this.m.lookAt(this.cam.position, this.dir, this.cam.up);
        this.leadQuat.setFromRotationMatrix(this.m);
        this.cam.quaternion.slerp(this.leadQuat, u * FRAME.leadTurn);
      }
    }
  }

  /** Ease the camera toward `want`, looking at `focus` (chest height), in front of anything blocking the view. */
  private place(focus: THREE.Vector3, k: number, cut: boolean) {
    const target = this.dir.copy(focus).setY(focus.y + FRAME.lookAt);
    this.want.y = Math.max(this.want.y, focus.y + FRAME.minUp);
    const len = target.distanceTo(this.want);
    if (len > 0.01) {
      const d = this.c.copy(this.want).sub(target).divideScalar(len);
      this.ray.set(target, d);
      this.ray.far = len;
      const hit = this.ray.intersectObjects(this.blockers(), false)[0];
      if (hit) this.want.copy(target).addScaledVector(d, Math.max(1.5, hit.distance - FRAME.skin));
    }
    if (cut) { this.cam.position.copy(this.want); this.look.copy(target); }
    else { this.cam.position.lerp(this.want, k); this.look.lerp(target, Math.min(1, k * 1.6)); }
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this.look); // up = +Y: a level horizon
  }
}
