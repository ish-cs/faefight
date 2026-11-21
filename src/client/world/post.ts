import * as THREE from 'three/webgpu';
import {
  abs, builtinAOContext, dot, emissive, exp, float, length, luminance, min, mix, mrt, normalView, output, pass, renderOutput, screenSize, screenUV, smoothstep, step,
  uniform, vec2, vec3, vec4, velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';

export type PostOptions = {
  samples: number; bloom: boolean; ao: false | { resolution: number; samples: number }; flare?: boolean;
  /**
   * Render the scene at `scale` × the output resolution and upscale. Same-frame: no added latency.
   * - 'fsr': keeps MSAA; spatial FSR 1 (EASU edge-adaptive upscale + RCAS sharpen, `sharpen` = RCAS stops, 0 =
   *   sharpest). No history, so no ghosting; thin wires and alpha-to-coverage foliage survive.
   * - 'taau': temporal (Karis 2014 / FSR2-style): jittered, no MSAA, motion vectors (velocity MRT), history
   *   reconstruction + a 5-tap contrast-adaptive sharpen (`sharpen` 0–1). Cheaper but softer; loses sub-pixel
   *   wires and dithers foliage that relies on MSAA alpha-to-coverage.
   */
  upscale?: { mode: 'fsr' | 'taau'; scale: number; sharpen: number };
};

/**
 * Opt a material out of TAAU motion vectors (writes zero velocity; the history clamp absorbs the error). Needed for
 * instanced meshes that already use most vertex buffers: velocity adds the previous instance matrix (4 more), and
 * WebGPU allows 8 (critters: 9 → pipeline creation fails and the mesh disappears). Free when TAAU is off.
 */
export function noVelocity(m: THREE.NodeMaterial) {
  m.mrtNode = mrt({ velocity: vec4(0, 0, 0, 0) });
}

/** live TAAU sharpen strength (debug: tweak in ?debug=1 via World.sky.grade) */
const sharpenAmount = uniform(0.25);

/** Sun position on screen (uv, y up) + whether it's in front of the camera; SkyLighting updates these per frame. */
export const sunScreen = { uv: uniform(new THREE.Vector2(0.5, 0.5)), front: uniform(0), aspect: uniform(16 / 9) };

/**
 * Display-space colour grade, shared by every preset (tweak live via `World.sky.grade` in ?debug=1).
 * Warm highlights / cool shadows, gentle S-contrast, a touch of saturation, soft vignette.
 */
export const grade = {
  shadowTint: uniform(new THREE.Color(0.94, 0.99, 1.07)),
  highlightTint: uniform(new THREE.Color(1.03, 1.0, 0.95)),
  contrast: uniform(1.08),
  saturation: uniform(1.1),
  vignette: uniform(0.26),
  /** ambient-occlusion strength (high/ultra) */
  ao: uniform(0.9),
};

/**
 * Builds the frame's render pipeline from ONE scene pass. (A separate GTAO normal pre-pass cost ~3 ms of CPU per
 * frame for ~600 draws, so normals come out of the main pass as an extra MRT target instead.)
 *   lit scene (MSAA; MRT output/emissive/normal) → [GTAO] → [bloom of emissive] → ACES → grade.
 */
export function buildPipeline(
  gpu: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, o: PostOptions, ambientOcclusion?: THREE.Node<'float'>,
): { pipe: THREE.RenderPipeline; scenePass: THREE.PassNode; aoPass: { resolutionScale: number } | null; bloomPass: { setResolutionScale(s: number): unknown } | null } {
  const pipe = new THREE.RenderPipeline(gpu);
  pipe.outputColorTransform = false; // tone map + sRGB ourselves so the grade runs in display space

  const taauOn = o.upscale?.mode === 'taau';
  // TAAU needs MSAA off (the jittered history is the anti-aliasing)
  const scenePass = pass(scene, camera, { samples: taauOn ? 0 : o.samples });
  if (o.upscale) scenePass.setResolutionScale(o.upscale.scale);
  // analytic ambient-only occlusion (bunker interiors), every preset: sky light must not flood enclosed rooms
  if (ambientOcclusion) scenePass.contextNode = builtinAOContext(ambientOcclusion);
  const targets: Record<string, THREE.Node> = { output };
  if (o.bloom) targets.emissive = emissive;
  if (o.ao) targets.normal = normalView;
  if (taauOn) targets.velocity = velocity;
  if (Object.keys(targets).length > 1) scenePass.setMRT(mrt(targets));
  const raw = scenePass.getTextureNode('output');
  // TAAU: everything after this runs at output resolution on the reconstructed image; AO and bloom stay at their
  // (input-relative) resolutions and are sampled by screen uv.
  let col: THREE.Node<'vec4'> = raw;
  if (o.upscale?.mode === 'fsr') col = fsr1(raw, o.upscale.sharpen);
  if (taauOn) {
    const t = taau(raw, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera).getTextureNode();
    sharpenAmount.value = o.upscale!.sharpen;
    // contrast-adaptive 5-tap sharpen (CAS-lite): restores the crispness the reconstruction filter softens,
    // weaker where local contrast is already high so edges don't ring
    const px = vec2(1, 1).div(screenSize); // output pixels (TAAU resolves at drawing-buffer size)
    const c0 = t.sample(screenUV);
    const n = t.sample(screenUV.add(vec2(0, px.y))).rgb, s2 = t.sample(screenUV.sub(vec2(0, px.y))).rgb;
    const e = t.sample(screenUV.add(vec2(px.x, 0))).rgb, w = t.sample(screenUV.sub(vec2(px.x, 0))).rgb;
    const lo = min(min(min(n, s2), min(e, w)), c0.rgb), hi = n.max(s2).max(e).max(w).max(c0.rgb);
    const contrast = luminance(hi.sub(lo)).div(luminance(hi).add(1e-3)).clamp(0, 1);
    const k = sharpenAmount.mul(float(1).sub(contrast)).mul(0.25);
    const sharp = c0.rgb.add(c0.rgb.mul(4).sub(n.add(s2).add(e).add(w)).mul(k)).max(0);
    col = vec4(sharp, 1);
  }

  let aoPass: ReturnType<typeof ao> | null = null;
  let hdr = col.rgb;
  if (o.ao) {
    aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
    aoPass.resolutionScale = o.ao.resolution;
    aoPass.samples.value = o.ao.samples;
    aoPass.radius.value = 0.9;
    aoPass.thickness.value = 1.2;
    aoPass.distanceExponent.value = 1.4;
    aoPass.scale.value = 1.15;
    // Post-applied AO also hits direct sunlight: full strength in shade, lighter on bright sunlit pixels, so contact
    // shadows ground props and characters without dirtying lit walls.
    const occ = aoPass.getTextureNode().sample(screenUV).r;
    const lit = smoothstep(0.25, 1.6, luminance(col.rgb));
    hdr = hdr.mul(mix(float(1), occ, mix(grade.ao, grade.ao.mul(0.45), lit)));
  }
  let bloomPass: ReturnType<typeof bloom> | null = null;
  if (o.bloom) {
    // only emissive output blooms (generator glow, water sun-glints write emissive) — never the bright sky
    bloomPass = bloom(scenePass.getTextureNode('emissive'), 0.75, 0.45, 0);
    // bloom sizes itself off the drawing buffer: keep it at half the *scene* resolution under TAAU
    if (o.upscale) bloomPass.setResolutionScale(0.5 * o.upscale.scale);
    hdr = hdr.add(bloomPass.rgb);
  }

  let flare: THREE.Node<'vec3'> | null = null;
  if (o.flare) {
    // Subtle lens glare: soft halo + a few tinted ghosts mirrored through the centre, faded by how much of the sun
    // disc is unoccluded (5 depth taps around it: sky depth ≈ 1).
    const depth = scenePass.getTextureNode('depth');
    const su = sunScreen.uv;
    let vis: THREE.Node<'float'> = float(0);
    for (const [dx, dy] of [[0, 0], [0.012, 0], [-0.012, 0], [0, 0.02], [0, -0.02]]) {
      const tuv = vec2(su.x.add(dx), float(1).sub(su.y).add(dy)); // depth texture uv is y-down
      vis = vis.add(step(0.9999, depth.sample(tuv).r));
    }
    vis = vis.div(5).mul(sunScreen.front).mul(smoothstep(-0.15, 0.1, min(min(su.x, su.y), min(float(1).sub(su.x), float(1).sub(su.y)))));
    const p = vec2(screenUV.x, float(1).sub(screenUV.y));
    const asp = vec2(sunScreen.aspect, 1);
    const toSun = p.sub(su).mul(asp);
    const halo = exp(length(toSun).mul(-9)).mul(0.22).add(exp(abs(toSun.y).mul(-140)).mul(exp(abs(toSun.x).mul(-6))).mul(0.06));
    let ghosts: THREE.Node<'vec3'> = vec3(0, 0, 0);
    for (const [k, r, col] of [[-0.35, 0.05, [0.5, 0.8, 1]], [0.3, 0.025, [1, 0.8, 0.5]], [0.62, 0.075, [0.6, 1, 0.7]], [1.25, 0.11, [0.7, 0.6, 1]]] as const) {
      const g = vec2(0.5, 0.5).add(su.sub(0.5).mul(-k));
      const d = length(p.sub(g).mul(asp));
      ghosts = ghosts.add(vec3(...col).mul(smoothstep(r, r * 0.55, d).mul(0.035)));
    }
    flare = vec3(1, 0.93, 0.8).mul(halo).add(ghosts).mul(vis);
  }

  // Tone map (renderer.toneMapping, ACES) + sRGB, then grade in display space.
  const ldr = renderOutput(vec4(hdr, 1)).rgb;
  const l = luminance(ldr);
  const tint = mix(grade.shadowTint, grade.highlightTint, smoothstep(0.15, 0.75, l));
  let c: THREE.Node<'vec3'> = ldr.mul(tint);
  c = c.sub(0.5).mul(grade.contrast).add(0.5).max(0);
  c = mix(vec3(luminance(c)), c, grade.saturation);
  const v = screenUV.sub(0.5);
  const vig = float(1).sub(grade.vignette.mul(smoothstep(0.06, 0.5, dot(v, v))));
  c = c.mul(vig);
  if (flare) c = c.add(flare);
  pipe.outputNode = c;
  return { pipe, scenePass, aoPass, bloomPass }; // the scene pass: the warm-up compiles world materials for its exact target/MRT
}
