/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Motion vectors for TAAU (post.ts / taau.ts). three's VelocityNode handles object matrices, instance matrices,
 * batching and skinning, but not a material's `positionNode`: it reprojects the *undisplaced* geometry
 * (`positionPrevious`), so every vertex-animated surface (grass, palm fronds, ocean, gulls, critters, impostor
 * billboards, distance-fade shrinks) would report its whole displacement as motion and smear under TAAU.
 *
 * Fix, once for every material: when the pass writes velocity, the displacement a `positionNode` applies this
 * frame is applied to the previous position too (prev += displaced − undisplaced). Surfaces then move with their
 * object / instance / bone / camera motion, minus the displacement's own frame-to-frame motion (a few mm at
 * 120 fps for wind and waves; TAAU's variance clip absorbs it). No cost when velocity is off (low / competitive).
 *
 * Reactive mask: additive FX (tracers, muzzle flames, sparks, bolts) and reactive() materials (rain) write
 * (0, 0, brightness × alpha, alpha) into the velocity target with their own blending, so z ends up as their coverage and xy keeps
 * (most of) the surface behind them; taau.ts gives those pixels a high current-frame weight and no history lock,
 * so they never ghost. Other transparents write (0, 0, 0, 0): the surface behind keeps its motion and its AA.
 */
import * as THREE from 'three/webgpu';
import { cameraViewMatrix, deltaTime, luminance, mrt, output, positionLocal, positionPrevious, positionWorld, subBuild, time, vec4, velocity } from 'three/tsl';

let installed = false;
/** additive FX + opt-ins (reactive()): blend their coverage into z, leave xy (mostly) to the surface behind */
// coverage weighted by how bright the layer actually is (an unlit additive lamp pool at noon is not reactive)
const reactiveMrt = mrt({ velocity: vec4(0, 0, luminance(output.rgb).mul(output.a).mul(2).saturate(), output.a) });
/** other transparents (decals, labels, beams, blob shadows): alpha 0 leaves the surface behind's motion as it was */
const keepMrt = mrt({ velocity: vec4(0, 0, 0, 0) });

/** Mark a normal-blended transparent FX material (rain) reactive for TAAU: no history lock behind it. */
export function reactive(m: THREE.Material) { (m as any).faeReactive = true; }

/** Patch NodeMaterial so positionNode displacement and transparent coverage reach the velocity target. Idempotent. */
export function installVelocityFix() {
  if (installed) return;
  installed = true;
  const proto = THREE.NodeMaterial.prototype as any;
  const setupPosition = proto.setupPosition, setup = proto.setup;
  if (typeof setupPosition !== 'function' || typeof setup !== 'function') throw new Error('[world/velocity] three NodeMaterial API changed: setupPosition/setup missing');
  proto.setupPosition = function (this: any, builder: any) {
    const pn = this.positionNode;
    if (pn === null || !builder.needsPreviousData()) return setupPosition.call(this, builder);
    this.positionNode = null;
    try { setupPosition.call(this, builder); } finally { this.positionNode = pn; }
    const before = positionLocal.toVar();
    // timeDisplaced(): last frame's displacement, built before positionLocal is overwritten
    const prevDisp = this.faePrevPosition ? (subBuild(this.faePrevPosition, 'POSITION', 'vec3') as any).sub(before).toVar() : null;
    positionLocal.assign(subBuild(pn, 'POSITION', 'vec3'));
    positionPrevious.assign(positionPrevious.add(prevDisp ?? positionLocal.sub(before)));
    return positionLocal;
  };
  proto.setup = function (this: any, builder: any) {
    if (this.faeStaticVelocity) {
      // no previous-frame vertex data at all (instance matrices, bones): its velocity comes from staticVelocity().
      // Left on this builder (one per render object): instance/skinning nodes ask during the build, after setup.
      builder.needsPreviousData = () => false;
    }
    if (!this.transparent || this.mrtNode !== null || !builder.needsPreviousData()) return setup.call(this, builder);
    this.mrtNode = this.blending === THREE.AdditiveBlending || this.faeReactive ? reactiveMrt : keepMrt;
    try { return setup.call(this, builder); } finally { this.mrtNode = null; }
  };
}

/**
 * Camera-only motion vectors from the fragment's world position: for instanced materials that can't afford
 * velocity's extra previous-instance-matrix vertex buffer (WebGPU allows 8; critters use their own instance
 * buffers on top). Correct for anything that doesn't move between frames; a moving one only lacks its own motion.
 */
export function staticVelocity(m: THREE.NodeMaterial) {
  const v = velocity as any;
  const cur = v.currentProjectionMatrix.mul(cameraViewMatrix).mul(vec4(positionWorld, 1));
  const prev = v.previousProjectionMatrix.mul(v.previousCameraViewMatrix).mul(vec4(positionWorld, 1));
  (m as any).faeStaticVelocity = true;
  m.mrtNode = mrt({ velocity: vec4(cur.xy.div(cur.w).sub(prev.xy.div(prev.w)), m.transparent ? 1 : 0, 1) });
}

/**
 * Set a fast time-driven vertex animation (e.g. wing flaps): `f(t)` builds the position node at time `t`. The
 * previous position uses last frame's time, so the animation's own motion reaches the motion vectors too (slow
 * sways don't need this: the default carries this frame's displacement over).
 */
export function timeDisplaced(m: THREE.NodeMaterial, f: (t: THREE.Node<'float'>) => THREE.Node<'vec3'>) {
  m.positionNode = f(time);
  (m as any).faePrevPosition = f(time.sub(deltaTime));
}
