import * as THREE from 'three/webgpu';

/**
 * Locomotion helpers: how fast each walk/run clip's feet travel over the ground (so playback speed can match the
 * player's real speed — no foot skating), and small procedural layers on top of the clips (breathing, hit flinch).
 */

/** Clips whose playback is matched to ground speed, with the axis their feet push along (model space: +Z = forward). */
export const LOCOMOTION_CLIPS: Record<string, 'z' | 'x'> = {
  Walk: 'z', Run: 'z', Run_Shoot: 'z', Run_Back: 'z', Run_Left: 'x', Run_Right: 'x',
};

/**
 * Ground speed (m/s at the avatar's on-screen scale) each in-place locomotion clip implies: while a foot is planted
 * (lowest part of its arc) it slides backwards relative to the hips at exactly the speed the body would travel.
 * Measured by sampling the clip on the bone template. Clips that can't be measured are left out.
 */
export function measureClipSpeeds(template: THREE.Object3D, clips: Map<string, THREE.AnimationClip>, scale: number): Map<string, number> {
  const out = new Map<string, number>();
  const feet = ['FootL', 'FootR'].map((n) => template.getObjectByName(n));
  const hips = template.getObjectByName('Hips');
  if (feet.some((f) => !f) || !hips) return out;
  const mixer = new THREE.AnimationMixer(template);
  const p = new THREE.Vector3(), h = new THREE.Vector3();
  for (const [name, axis] of Object.entries(LOCOMOTION_CLIPS)) {
    const clip = clips.get(name);
    if (!clip) continue;
    mixer.stopAllAction();
    const a = mixer.clipAction(clip);
    a.play();
    const N = 96, dt = clip.duration / N;
    const samples: { y: number; s: number }[][] = [[], []];
    for (let i = 0; i <= N; i++) {
      a.time = i * dt;
      mixer.update(0);
      template.updateMatrixWorld(true);
      hips.getWorldPosition(h);
      feet.forEach((f, k) => {
        f!.getWorldPosition(p);
        samples[k].push({ y: p.y, s: axis === 'z' ? p.z - h.z : p.x - h.x });
      });
    }
    // planted = within 15% of the arc's height of its lowest point; speed = mean |ds/dt| while planted
    let sum = 0, n = 0;
    for (const sm of samples) {
      const lo = Math.min(...sm.map((x) => x.y)), hi = Math.max(...sm.map((x) => x.y));
      const thr = lo + (hi - lo) * 0.15;
      for (let i = 1; i < sm.length; i++) {
        if (sm[i].y > thr || sm[i - 1].y > thr) continue;
        sum += Math.abs(sm[i].s - sm[i - 1].s) / dt;
        n++;
      }
    }
    a.stop();
    mixer.uncacheAction(clip);
    if (n >= 4) out.set(name, (sum / n) * scale);
  }
  mixer.uncacheRoot(template);
  return out;
}

/**
 * Playback rate and stride scale for a locomotion clip at a ground speed: the clips' strides are short for the game's
 * speeds, so part of the difference is taken by longer strides (StrideIK) and the rest by a faster cadence; together
 * they make the planted foot travel at exactly the body's speed (no skating) up to the cadence cap.
 */
export function strideFor(speed: number, native: number | undefined): { ts: number; stride: number } {
  if (!native || speed < 0.05) return { ts: 1, stride: 1 };
  const ratio = speed / native;
  const stride = Math.min(STRIDE_MAX, Math.max(1, ratio / 1.15));
  return { ts: Math.min(CADENCE_MAX, Math.max(0.55, ratio / stride)), stride };
}
export const STRIDE_MAX = 1.3;
export const CADENCE_MAX = 1.8;

const _h = new THREE.Vector3(), _k = new THREE.Vector3(), _a = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
const _d = new THREE.Vector3(), _pole = new THREE.Vector3(), _knee = new THREE.Vector3(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion();

/**
 * Longer strides on top of a locomotion clip: each foot (an IK target bone in this rig) is pushed further from the
 * pelvis along the direction of travel, the pelvis drops a little if a leg can't reach, and a two-bone IK bends the
 * thigh and shin (in the clip's own knee plane) so the leg meets the moved foot.
 */
export class StrideIK {
  private legs: { up: THREE.Bone; low: THREE.Bone; end: THREE.Object3D; foot: THREE.Object3D; l1: number; l2: number }[] = [];
  private body: THREE.Object3D | null;

  constructor(model: THREE.Object3D) {
    this.body = model.getObjectByName('Body') ?? null;
    for (const s of ['L', 'R']) {
      const up = model.getObjectByName(`UpperLeg${s}`) as THREE.Bone | undefined, low = model.getObjectByName(`LowerLeg${s}`) as THREE.Bone | undefined;
      const end = model.getObjectByName(`LowerLeg${s}_end`), foot = model.getObjectByName(`Foot${s}`);
      if (!up || !low || !end || !foot) { this.legs = []; return; }
      this.legs.push({ up, low, end, foot, l1: 0, l2: 0 });
    }
  }

  get ok() { return this.legs.length === 2 && this.body !== null; }

  /** `dir` = unit horizontal travel direction (world); call after the mixer, with world matrices current. */
  apply(stride: number, dir: THREE.Vector3) {
    if (!this.ok || stride <= 1.001) return;
    const body = this.body!;
    body.getWorldPosition(_b);
    // lengths in world units (the avatar is scaled), measured from the current pose (bones don't stretch)
    for (const L of this.legs) {
      L.up.getWorldPosition(_h); L.low.getWorldPosition(_k); L.end.getWorldPosition(_a);
      L.l1 = _h.distanceTo(_k); L.l2 = _k.distanceTo(_a);
    }
    // move the feet along the travel axis, relative to the pelvis
    let drop = 0;
    const targets = this.legs.map((L) => {
      L.foot.getWorldPosition(_t);
      const along = _d.copy(_t).sub(_b).dot(dir);
      const t = _t.clone().addScaledVector(dir, along * (stride - 1));
      L.up.getWorldPosition(_h);
      const reach = (L.l1 + L.l2) * 0.995, dist = t.distanceTo(_h);
      if (dist > reach) {
        // lower the hip just enough (vertical) for this leg to reach
        const dx = Math.hypot(t.x - _h.x, t.z - _h.z), need = (_h.y - t.y) - Math.sqrt(Math.max(0, reach * reach - dx * dx));
        drop = Math.max(drop, need);
      }
      return t;
    });
    drop = Math.min(drop, 0.06 * (this.legs[0].l1 + this.legs[0].l2));
    if (drop > 1e-4) {
      body.getWorldPosition(_b);
      _b.y -= drop;
      body.parent!.worldToLocal(_b);
      body.position.copy(_b);
      body.updateMatrixWorld(true);
    }
    this.legs.forEach((L, i) => {
      const T = targets[i];
      L.foot.parent!.updateWorldMatrix(true, false);
      L.foot.position.copy(L.foot.parent!.worldToLocal(_t.copy(T)));
      L.foot.updateMatrixWorld(true);
      this.solve(L, T);
    });
  }

  private solve(L: StrideIK['legs'][number], T: THREE.Vector3) {
    L.up.getWorldPosition(_h); L.low.getWorldPosition(_k); L.end.getWorldPosition(_a);
    const d = Math.min(_h.distanceTo(T), (L.l1 + L.l2) * 0.999);
    if (d < 1e-4) return;
    const dir = _d.copy(T).sub(_h).normalize();
    // knee pole: the clip's knee direction, perpendicular to the new hip→ankle line
    _pole.copy(_k).sub(_h);
    _pole.addScaledVector(dir, -_pole.dot(dir));
    if (_pole.lengthSq() < 1e-8) return;
    _pole.normalize();
    const along = (L.l1 * L.l1 - L.l2 * L.l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L.l1 * L.l1 - along * along));
    _knee.copy(_h).addScaledVector(dir, along).addScaledVector(_pole, h);
    rotateBoneToward(L.up, _k.sub(_h), _knee.clone().sub(_h));
    L.low.getWorldPosition(_k); L.end.getWorldPosition(_a);
    rotateBoneToward(L.low, _a.sub(_k), T.clone().sub(_k));
  }
}

/** Rotate `bone` (world-space delta) so its world vector `from` turns onto `to`. */
function rotateBoneToward(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(from.normalize(), to.normalize());
  bone.parent!.getWorldQuaternion(_pq);
  // local' = parentWorld⁻¹ · Δ · parentWorld · local
  bone.quaternion.premultiply(_pq).premultiply(_q).premultiply(_pq.invert());
  bone.updateMatrixWorld(true);
}

/** Hit flinch (additive, over the running clip): a quick bend back and twist that springs out. 0..1 envelope. */
export function flinchEnvelope(since: number, dur: number): number {
  if (since < 0 || since >= dur) return 0;
  const t = since / dur;
  return t < 0.18 ? t / 0.18 : (1 - (t - 0.18) / 0.82) ** 2;
}

/** Breathing: chest rise (rad) at rest, quicker and deeper after running (`effort` 0..1). */
export function breath(t: number, effort: number): number {
  const rate = 1.6 + effort * 1.6; // rad/s → ~15-30 breaths a minute
  return Math.sin(t * rate) * (0.018 + effort * 0.02);
}
