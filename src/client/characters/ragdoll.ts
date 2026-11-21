import * as THREE from 'three/webgpu';
import { RagdollSim, RP, RP_COUNT } from './ragdollSim';

/** Rig bone at each ragdoll point (RP order); the head point sits HEAD_UP above the Head bone, along the neck. */
const POINT_BONES = ['Hips', 'Neck', 'Head', 'UpperArmL', 'LowerArmL', 'WristL', 'UpperArmR', 'LowerArmR', 'WristR',
  'UpperLegL', 'LowerLegL', 'FootL', 'UpperLegR', 'LowerLegR', 'FootR'] as const;
const HEAD_UP = 0.14;

/** Bones turned to follow a point pair: parent = 'body' (rigid with the torso) or the index of the segment above. */
const SEGMENTS: { bone: string; a: number; b: number; parent: 'body' | number }[] = [
  { bone: 'Neck', a: RP.chest, b: RP.head, parent: 'body' },
  { bone: 'UpperArmL', a: RP.shL, b: RP.elL, parent: 'body' },
  { bone: 'LowerArmL', a: RP.elL, b: RP.haL, parent: 1 },
  { bone: 'UpperArmR', a: RP.shR, b: RP.elR, parent: 'body' },
  { bone: 'LowerArmR', a: RP.elR, b: RP.haR, parent: 3 },
  { bone: 'UpperLegL', a: RP.hipL, b: RP.knL, parent: 'body' },
  { bone: 'LowerLegL', a: RP.knL, b: RP.anL, parent: 5 },
  { bone: 'UpperLegR', a: RP.hipR, b: RP.knR, parent: 'body' },
  { bone: 'LowerLegR', a: RP.knR, b: RP.anR, parent: 7 },
];
/** The rig's IK feet hang off Root: placed at the ankle points, turned with their shin. */
const FEET: { bone: string; at: number; shin: number }[] = [{ bone: 'FootL', at: RP.anL, shin: 6 }, { bone: 'FootR', at: RP.anR, shin: 8 }];

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _t: number[] = new Array<number>(12).fill(0);

type Seg = { bone: THREE.Bone; a: number; b: number; parent: 'body' | number; rel: THREE.Quaternion; q: THREE.Quaternion; q0: THREE.Quaternion; d: THREE.Vector3 };
type Saved = { bone: THREE.Bone; p: THREE.Vector3; q: THREE.Quaternion };

/**
 * Drives a skinned soldier from a RagdollSim. Started from whatever pose the body was in at death; every bone not
 * listed keeps its local pose (spine, hands, fingers), so the torso is rigid and the limbs swing. Bones' world
 * rotations are tracked by swing (shortest arc from last frame's segment direction), which never degenerates.
 * `restore()` puts back the local pose it started from so the animation mixer takes over cleanly on respawn.
 */
export class Ragdoll {
  readonly sim: RagdollSim;
  private body: THREE.Bone;
  private bodyQ0 = new THREE.Quaternion();
  private bodyQ = new THREE.Quaternion();
  private torso0Inv = new THREE.Quaternion();
  private bodyOff = new THREE.Vector3(); // body bone − pelvis point at start (world)
  private rootInv = new THREE.Matrix4();
  private rootQInv = new THREE.Quaternion();
  private segs: Seg[] = [];
  private feet: { bone: THREE.Bone; at: number; shin: number; q0: THREE.Quaternion }[] = [];
  private saved: Saved[] = [];

  /** `model`'s world matrices must be current. `fwd`: the way the body faced (x, z). */
  constructor(model: THREE.Object3D, fwd: { x: number; z: number }, floorY: number) {
    const bone = (n: string) => {
      const b = model.getObjectByName(n) as THREE.Bone | undefined;
      if (!b?.parent) throw new Error(`[ragdoll] rig has no bone ${n}`);
      return b;
    };
    const pts = new Float32Array(RP_COUNT * 3);
    POINT_BONES.forEach((n, i) => { _v.setFromMatrixPosition(bone(n).matrixWorld).toArray(pts, i * 3); });
    _v.fromArray(pts, RP.head * 3);
    _w.fromArray(pts, RP.chest * 3);
    _v.addScaledVector(_w.subVectors(_v, _w).normalize(), HEAD_UP).toArray(pts, RP.head * 3);
    this.sim = new RagdollSim(pts, fwd, floorY);

    this.body = bone('Body');
    const root = this.body.parent!;
    this.rootInv.copy(root.matrixWorld).invert();
    root.getWorldQuaternion(this.rootQInv).invert();
    this.body.getWorldQuaternion(this.bodyQ0);
    this.bodyQ.copy(this.bodyQ0);
    this.torso0Inv.copy(this.torsoFrame(_q)).invert();
    this.bodyOff.setFromMatrixPosition(this.body.matrixWorld).sub(_v.fromArray(pts, RP.pelvis * 3));
    this.save(this.body);

    const bodyQ0Inv = this.bodyQ0.clone().invert();
    for (const s of SEGMENTS) {
      const b = bone(s.bone);
      const q0 = b.getWorldQuaternion(new THREE.Quaternion());
      const rel = s.parent === 'body' ? bodyQ0Inv.clone().multiply(b.parent!.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion();
      this.segs.push({ bone: b, a: s.a, b: s.b, parent: s.parent, rel, q: q0.clone(), q0, d: this.dir(s.a, s.b, new THREE.Vector3()) });
      this.save(b);
    }
    for (const f of FEET) {
      const b = bone(f.bone);
      if (b.parent !== root) throw new Error(`[ragdoll] ${f.bone} is expected under ${root.name}`);
      this.feet.push({ ...f, bone: b, q0: b.getWorldQuaternion(new THREE.Quaternion()) });
      this.save(b);
    }
  }

  /** Simulate a frame and pose the rig. Returns false once the body has come to rest (pose frozen). */
  step(dt: number): boolean {
    const moving = this.sim.update(dt);
    this.pose();
    return moving;
  }

  /** Put the bones back as they were when the ragdoll started. */
  restore() {
    for (const s of this.saved) { s.bone.position.copy(s.p); s.bone.quaternion.copy(s.q); }
  }

  private save(bone: THREE.Bone) { this.saved.push({ bone, p: bone.position.clone(), q: bone.quaternion.clone() }); }

  private pose() {
    const P = this.sim.pos;
    // Torso: rigid, so a full frame (up = pelvis→chest, side = shoulders + hips) gives its rotation.
    const delta = this.torsoFrame(_q).multiply(this.torso0Inv);
    this.bodyQ.copy(delta).multiply(this.bodyQ0);
    this.body.quaternion.copy(this.rootQInv).multiply(this.bodyQ);
    _v.copy(this.bodyOff).applyQuaternion(delta).add(_w.fromArray(P, RP.pelvis * 3));
    this.body.position.copy(_v.applyMatrix4(this.rootInv));

    for (const s of this.segs) {
      const d = this.dir(s.a, s.b, _v);
      s.q.premultiply(_q.setFromUnitVectors(s.d, d));
      s.d.copy(d);
      const parentQ = s.parent === 'body' ? _q.copy(this.bodyQ).multiply(s.rel) : _q.copy(this.segs[s.parent].q);
      s.bone.quaternion.copy(parentQ.invert().multiply(s.q));
    }
    for (const f of this.feet) {
      const shin = this.segs[f.shin];
      // world: shin's turn since the start × the foot's start rotation; local = root⁻¹ · world
      _q.copy(shin.q0).invert().premultiply(shin.q).multiply(f.q0);
      f.bone.quaternion.copy(this.rootQInv).multiply(_q);
      f.bone.position.copy(_v.fromArray(P, f.at * 3).applyMatrix4(this.rootInv));
    }
  }

  private dir(a: number, b: number, out: THREE.Vector3) {
    const P = this.sim.pos;
    return out.set(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]).normalize();
  }

  /** The sim's torso frame as a quaternion (x = body left, y = up the spine). */
  private torsoFrame(out: THREE.Quaternion) {
    const t = this.sim.torsoFrame(_t);
    _x.set(t[0], t[1], t[2]); _y.set(t[3], t[4], t[5]); _z.set(t[6], t[7], t[8]);
    return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  }
}
