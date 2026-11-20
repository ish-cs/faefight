import * as THREE from 'three/webgpu';
import { PLAYER } from '../sim/constants';

const RIGHT = 0.6;
const UP = PLAYER.eyeHeight; // 1.6 m
const BACK = 3.2;
const SKIN = 0.2; // keep this far in front of whatever blocks the camera
const EASE_OUT_RATE = 6; // m/s

/** Third-person over-the-shoulder camera that pulls in when geometry blocks it. */
export class ThirdPersonCamera {
  private ray = new THREE.Raycaster();
  private dist = BACK;
  private pivot = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private side = new THREE.Vector3();

  constructor(private cam: THREE.PerspectiveCamera, private blockers: () => THREE.Object3D[]) {}

  /** feet: interpolated player feet position. yaw/pitch: look angles (three.js convention). */
  update(feet: THREE.Vector3, yaw: number, pitch: number, dt: number) {
    const cp = Math.cos(pitch);
    const fwd = this.dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    const right = this.side.set(Math.cos(yaw), 0, -Math.sin(yaw));
    // Pivot at eye height, shifted over the right shoulder; the camera sits BACK metres behind it.
    const pivot = this.pivot.copy(feet).setY(feet.y + UP).addScaledVector(right, RIGHT);

    // Shoulder offset itself can clip into a wall right next to the player.
    const eye = new THREE.Vector3(feet.x, feet.y + UP, feet.z);
    this.ray.set(eye, right);
    this.ray.far = RIGHT + SKIN;
    const sideHit = this.ray.intersectObjects(this.blockers(), false)[0];
    if (sideHit) pivot.copy(eye).addScaledVector(right, Math.max(0, sideHit.distance - SKIN));

    const back = fwd.clone().negate();
    this.ray.set(pivot, back);
    this.ray.far = BACK + SKIN;
    const hit = this.ray.intersectObjects(this.blockers(), false)[0];
    const want = hit ? Math.max(0.3, hit.distance - SKIN) : BACK;
    // Snap in instantly (never render from inside a wall), ease back out smoothly.
    this.dist = want < this.dist ? want : Math.min(want, this.dist + EASE_OUT_RATE * dt);

    this.cam.position.copy(pivot).addScaledVector(back, this.dist);
    this.cam.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  /**
   * World point under the crosshair (screen centre), so the sim's eye ray can be aimed at it.
   * Points not at least 0.6 m in front of `eye` (along the view) are pushed out, so things between
   * the camera and the head don't flip the aim backwards.
   */
  aimPoint(targets: THREE.Object3D[], maxDist: number, eye: THREE.Vector3): THREE.Vector3 {
    const origin = this.cam.position;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    const minDist = eye.clone().sub(origin).dot(dir) + 0.6;
    this.ray.set(origin, dir);
    this.ray.far = maxDist;
    const hit = this.ray.intersectObjects(targets, false)[0];
    const d = Math.max(minDist, hit ? hit.distance : maxDist);
    return origin.clone().addScaledVector(dir, d);
  }
}
