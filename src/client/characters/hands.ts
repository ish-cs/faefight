import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BodyBuilder, K, type Kind } from './body';

/**
 * First-person hands and sleeves (viewmodel.ts), built with the same parts and material channels as the bodies so
 * they wear the same gloves and team camo: a gloved hand closed around a cylinder (pistol grip, handguard, or
 * nothing for a fist) plus the forearm sleeve back to the elbow. Static meshes in the parent's local frame.
 */

const STATIC = ['static'];
const W: [string, number][] = [['static', 1]];
const GLOVE = 0x5a4a38, GUARD = 0x2a2a2b;

export type Grip = {
  /** Centre of the gripped cylinder, its axis (fingers stack along it), and its radius. */
  center: THREE.Vector3; axis: THREE.Vector3; radius: number;
  /** Direction from the cylinder centre to where the palm presses (perpendicular to axis). */
  palm: THREE.Vector3;
  /** Wrist position and the elbow the sleeve runs back to (out of frame). */
  wrist: THREE.Vector3; elbow: THREE.Vector3;
  /** Finger wrap (rad) and whether the thumb wraps the other way (else it lies along the axis). */
  wrap?: number; thumbWrap?: boolean;
  /** Mirror the finger stacking (left hand). */
  left?: boolean;
};

const basis = (x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3, at: THREE.Vector3) => new THREE.Matrix4().makeBasis(x, y, z).setPosition(at);

/** Hand + sleeve geometry (static: no skinning attributes needed beyond the shared layout). */
export function handGeometry(g: Grip): THREE.BufferGeometry {
  const B = new BodyBuilder(STATIC);
  const a = g.axis.clone().normalize();
  const p = g.palm.clone().sub(a.clone().multiplyScalar(g.palm.dot(a))).normalize();
  const q = a.clone().cross(p); // positive wrap direction round the axis
  const R = g.radius;
  const fr = 0.0092;
  const side = g.left ? -1 : 1;
  const add = (geo: THREE.BufferGeometry, kind: Kind, color: number, m?: THREE.Matrix4, seam = 0) => B.add(geo, { m, color, kind, w: W, seam });

  // fingers: four torus arcs round the cylinder, stacked along the axis (index nearest the top for the right hand)
  const wrap = g.wrap ?? 3.3;
  for (let k = 0; k < 4; k++) {
    const off = (1.5 - k) * 0.0205 * side - 0.004;
    const r = k === 3 ? fr * 0.85 : fr;
    const start = 0.55 + k * 0.05;
    const arc = wrap - k * 0.12;
    // three phalanges as capsules along the arc (knuckles slightly proud), tapering to the tip
    const at = (ang: number, lift: number) => g.center.clone().addScaledVector(a, off)
      .addScaledVector(p, Math.cos(ang) * (R + r * 0.9 + lift)).addScaledVector(q, Math.sin(ang) * (R + r * 0.9 + lift));
    const joints = [0, 0.42, 0.74, 1].map((f, i) => at(start + arc * f, i === 0 ? 0.004 : i < 3 ? 0.0025 : 0));
    for (let j = 0; j < 3; j++) {
      const s0 = joints[j], s1 = joints[j + 1], d = s1.clone().sub(s0);
      const c = new THREE.CapsuleGeometry(r * (1 - j * 0.07), Math.max(1e-3, d.length()), 3, 8);
      c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
      c.translate((s0.x + s1.x) / 2, (s0.y + s1.y) / 2, (s0.z + s1.z) / 2);
      add(c, K.leather, GLOVE);
    }
  }
  // knuckle line + palm: a rounded block from the knuckles back to the wrist
  const knuckle = g.center.clone().addScaledVector(p, Math.cos(0.5) * (R + 0.014)).addScaledVector(q, Math.sin(0.5) * (R + 0.014)).addScaledVector(a, -0.004);
  const len = knuckle.distanceTo(g.wrist);
  const ly = knuckle.clone().sub(g.wrist).normalize();
  const lz = a.clone().sub(ly.clone().multiplyScalar(a.dot(ly))).normalize();
  const lx = ly.clone().cross(lz);
  const palm = new RoundedBoxGeometry(0.03, len + 0.012, 0.086, 2, 0.013);
  palm.deleteAttribute('uv');
  add(palm, K.leather, GLOVE, basis(lx, ly, lz, knuckle.clone().add(g.wrist).multiplyScalar(0.5)));
  // knuckle guard on the back of the hand (the side away from the grip)
  const back = lx.dot(p) > 0 ? lx : lx.clone().negate();
  const guard = new RoundedBoxGeometry(0.012, 0.03, 0.074, 1, 0.005);
  guard.deleteAttribute('uv');
  add(guard, K.polymer, GUARD, basis(lx, ly, lz, knuckle.clone().addScaledVector(ly, -0.016).addScaledVector(back, 0.018)));
  // thumb: wraps the other way round (power grip) or lies along the axis (support hand)
  const thumbBase = g.wrist.clone().lerp(knuckle, 0.35).addScaledVector(a, 0.03 * side);
  const thumbTip = g.thumbWrap
    ? g.center.clone().addScaledVector(a, 0.03 * side).addScaledVector(p, Math.cos(-1.5) * (R + 0.01)).addScaledVector(q, Math.sin(-1.5) * (R + 0.01))
    : g.center.clone().addScaledVector(a, 0.055 * side).addScaledVector(p, R * 0.3).addScaledVector(q, -R - 0.01);
  const mid = thumbBase.clone().lerp(thumbTip, 0.5).addScaledVector(p, 0.008);
  for (const [s, e, r] of [[thumbBase, mid, 0.012], [mid, thumbTip, 0.0105]] as const) {
    const d = e.clone().sub(s);
    const c = new THREE.CapsuleGeometry(r, d.length(), 3, 8);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    c.translate((s.x + e.x) / 2, (s.y + e.y) / 2, (s.z + e.z) / 2);
    add(c, K.leather, GLOVE);
  }
  // glove cuff
  const fwd = g.wrist.clone().sub(g.elbow).normalize();
  const cuff = new THREE.CylinderGeometry(0.032, 0.033, 0.035, 14);
  add(cuff, K.leather, 0x232220, new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), fwd)).setPosition(g.wrist.clone().addScaledVector(fwd, -0.008)), 0.3);
  // sleeve: wrist → elbow, a bit baggy, with the cuff seam
  const sl = new THREE.CylinderGeometry(0.033, 0.041, g.wrist.distanceTo(g.elbow) + 0.02, 14, 6, true);
  sl.computeVertexNormals();
  const P = sl.getAttribute('position');
  const seams: number[] = [];
  for (let i = 0; i < P.count; i++) seams.push(P.getY(i) > (g.wrist.distanceTo(g.elbow) + 0.02) / 2 - 0.004 ? 1 : 0);
  const mid2 = g.wrist.clone().addScaledVector(fwd, -0.025).add(g.elbow).multiplyScalar(0.5);
  B.add(sl, { m: new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), fwd)).setPosition(mid2), color: 0x6a6a5a, kind: K.camo, w: W, seam: (_p, i) => seams[i] });
  const geo = B.build();
  geo.deleteAttribute('skinIndex');
  geo.deleteAttribute('skinWeight');
  return geo;
}
