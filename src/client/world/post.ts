import * as THREE from 'three/webgpu';
import {
  abs, builtinAOContext, dot, emissive, exp, float, Fn, If, interleavedGradientNoise, length, luminance, min, mix, mrt, normalView, output, pass, renderOutput, screenCoordinate, screenSize, screenUV, smoothstep, step,
  uniform, vec2, vec3, vec4, velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { perfOff } from './perfFlags';

export type PostOptions = {
  samples: number; bloom: boolean; ao: false | { resolution: number; samples: number }; flare?: boolean;
  /**
   * Render the scene at `scale` × the output resolution and upscale. Same-frame: no added latency.
   * - 'fsr': keeps MSAA; spatial FSR 1 (EASU edge-adaptive upscale + RCAS sharpen, `sharpen` = RCAS stops, 0 =
   *   sharpest). No history, so no ghosting; thin wires and alpha-to-coverage foliage survive.
   * - 'taau': temporal (Karis 2014 / FSR2-style): jittered, no MSAA, motion vectors (velocity MRT), history
   *   reconstruction + a 5-tap contrast-adaptive sharpen (`sharpen` 0–1). Cheaper but softer; loses sub-pixel
   *   wires and dithers foliage that relies on MSAA alpha-to-coverage.
   * - 'cas': keeps MSAA; bilinear upscale + the same contrast-adaptive sharpen, folded into the final grade pass
   *   (no extra full-resolution passes: FSR 1's EASU + RCAS are two more output-sized passes, ~40 % of ultra's
   *   output-resolution GPU time at 2× DPR).
   */
  upscale?: { mode: 'fsr' | 'taau' | 'cas'; scale: number; sharpen: number };
  /** Killcam slow-motion blur, compiled in up front and off (a uniform branch) until `killcamBlur` turns it on. */
  motionBlur?: boolean;
};

/** Killcam motion blur (see motionBlurNode): on/off, previous-frame reprojection (prevVP × currVP⁻¹), shutter and radial. */
const mb = { on: uniform(0), reproj: uniform(new THREE.Matrix4()), shutter: uniform(0), radial: uniform(0) };
const MB_TAPS = 8;
/** Longest blur streak (uv) and the radial smear at the screen edge at full strength (uv per uv from the centre). */
const MB_MAX = 0.03, MB_RADIAL = 0.045;
/** Exposure the camera motion is smeared over at full strength (s): a long, filmic shutter for the slow beat. */
const MB_SHUTTER_SEC = 1 / 24;
const _vp = new THREE.Matrix4(), _prevVP = new THREE.Matrix4(), _inv = new THREE.Matrix4();
let mbWas = false, mbLastMs = 0;

/**
 * Per frame, after the camera is placed: killcam blur strength `k` (0 off, 1 full). Off and staying off
 * it returns at once (no uniform writes), so normal play pays nothing; the first frame on has no history (no blur
 * from the cut into the replay). No-op on a pipeline built without `motionBlur`.
 */
export function killcamBlur(camera: THREE.Camera, k: number) {
  if (k <= 0 && !mbWas) return;
  // the real time since the last frame (not the loop's clamped dt): a stalled frame's longer camera move is not a faster one
  const now = performance.now(), dt = (now - mbLastMs) / 1000;
  mbLastMs = now;
  camera.updateMatrixWorld();
  _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (!mbWas) _prevVP.copy(_vp);
  mb.reproj.value.multiplyMatrices(_prevVP, _inv.copy(_vp).invert());
  _prevVP.copy(_vp);
  mbWas = k > 0;
  mb.on.value = mbWas ? 1 : 0;
  mb.shutter.value = k * MB_SHUTTER_SEC / Math.min(0.5, Math.max(dt, 1 / 240));
  mb.radial.value = k * MB_RADIAL;
}

/**
 * Killcam motion blur over `col` (the scene colour, sampled from `raw`), 8 taps along a per-pixel streak: the camera's
 * own motion (depth reprojected through the previous view-projection: glide, push-in) over a long shutter, plus a
 * radial smear growing from the screen centre (the two-shot's subject) to the edges. No per-object velocity: in slow
 * motion the players barely move between frames, and the camera carries the motion. Behind a uniform branch, so with
 * it off the pass runs the same work as without it.
 */
function motionBlurNode(raw: THREE.TextureNode, depth: THREE.TextureNode, col: THREE.Node<'vec4'>): THREE.Node<'vec4'> {
  return Fn(() => {
    const c = vec4(col).toVar();
    If(mb.on.greaterThan(0.5), () => {
      const uv = screenUV;
      const d = depth.sample(uv).r;
      const prev = mb.reproj.mul(vec4(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)), d, 1));
      const prevUV = vec2(prev.x.div(prev.w).mul(0.5).add(0.5), float(0.5).sub(prev.y.div(prev.w).mul(0.5)));
      const v = uv.sub(prevUV).mul(mb.shutter).add(uv.sub(0.5).mul(mb.radial)).toVar();
      const len = length(v);
      v.assign(v.mul(min(len, MB_MAX).div(len.max(1e-5))));
      const acc = vec3(0, 0, 0).toVar();
      for (let i = 0; i < MB_TAPS; i++) acc.addAssign(raw.sample(uv.add(v.mul((i + 0.5) / MB_TAPS - 0.5))).level(float(0)).rgb);
      // a sub-pixel streak keeps the sharpened colour (no softening where nothing moves)
      c.assign(vec4(mix(c.rgb, acc.div(MB_TAPS), smoothstep(0.0005, 0.002, len)), 1));
    });
    return c;
  })();
}

/**
 * Opt a material out of TAAU motion vectors (writes zero velocity; the history clamp absorbs the error). Needed for
 * instanced meshes that already use most vertex buffers: velocity adds the previous instance matrix (4 more), and
 * WebGPU allows 8 (critters: 9 → pipeline creation fails and the mesh disappears). Free when TAAU is off.
 */
export function noVelocity(m: THREE.NodeMaterial) {
  // `output` too: with no MRT on the scene pass (low, competitive) three uses the material's MRT alone, and a
  // velocity-only MRT left the fragment shader with no outputs at all (invalid WGSL, the mesh vanished on low)
  m.mrtNode = mrt({ output, velocity: vec4(0, 0, 0, 0) });
}

/** live sharpen strength for 'taau' / 'cas' (debug) */
const sharpenAmount = uniform(0.25);
/** scene input scale (× output resolution) under 'cas', kept live by SkyLighting for dynamic resolution */
export const upscaleInput = uniform(1);

/**
 * Contrast-adaptive 5-tap sharpen (CAS-lite) of `t` at screen uv, taps `px` apart (uv): restores the crispness an
 * upscale/reconstruction softens, weaker where local contrast is already high so edges don't ring.
 */
function casSample(t: THREE.TextureNode, px: THREE.Node<'vec2'>): THREE.Node<'vec4'> {
  const c0 = t.sample(screenUV);
  const n = t.sample(screenUV.add(vec2(0, px.y))).rgb, s2 = t.sample(screenUV.sub(vec2(0, px.y))).rgb;
  const e = t.sample(screenUV.add(vec2(px.x, 0))).rgb, w = t.sample(screenUV.sub(vec2(px.x, 0))).rgb;
  const lo = min(min(min(n, s2), min(e, w)), c0.rgb), hi = n.max(s2).max(e).max(w).max(c0.rgb);
  const contrast = luminance(hi.sub(lo)).div(luminance(hi).add(1e-3)).clamp(0, 1);
  const k = sharpenAmount.mul(float(1).sub(contrast)).mul(0.25);
  return vec4(c0.rgb.add(c0.rgb.mul(4).sub(n.add(s2).add(e).add(w)).mul(k)).max(0), 1);
}

/** Sun position on screen (uv, y up) + whether it's in front of the camera; SkyLighting updates these per frame. */
export const sunScreen = { uv: uniform(new THREE.Vector2(0.5, 0.5)), front: uniform(0), aspect: uniform(16 / 9) };

/**
 * Display-space colour grade, shared by every preset (tweak live via `World.sky.grade` in ?debug=1).
 * Warm highlights / cool shadows, gentle S-contrast, soft vignette, ±1 LSB dither.
 */
export const grade = {
  shadowTint: uniform(new THREE.Color(0.94, 0.99, 1.07)),
  highlightTint: uniform(new THREE.Color(1.03, 1.0, 0.95)),
  contrast: uniform(1.08),
  saturation: uniform(1),
  vignette: uniform(0.26),
  /** ambient-occlusion strength (high/ultra) */
  ao: uniform(0.9),
  /** scene-linear luminance where geometry highlights start to bloom (high/ultra) */
  bloomThreshold: uniform(6),
  /** output dither amplitude (display units; 1/255 = ±1 LSB triangular) */
  dither: uniform(1 / 255),
};

/**
 * Builds the frame's render pipeline from ONE scene pass. (A separate GTAO normal pre-pass cost ~3 ms of CPU per
 * frame for ~600 draws, so normals come out of the main pass as an extra MRT target instead.)
 *   lit scene (MSAA; MRT output/emissive/normal) → [GTAO] → [bloom of emissive] → Neutral tone map → grade (+ dither).
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
  if (o.upscale) sharpenAmount.value = o.upscale.sharpen;
  if (o.upscale?.mode === 'fsr') col = fsr1(raw, o.upscale.sharpen);
  // taps one input pixel apart (bilinear between them), so the sharpen works on the scene's own detail
  if (o.upscale?.mode === 'cas') col = casSample(raw, vec2(1, 1).div(screenSize.mul(upscaleInput)));
  if (taauOn) {
    const t = taau(raw, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera).getTextureNode();
    col = casSample(t, vec2(1, 1).div(screenSize)); // TAAU resolves at output size: output-pixel taps
  }

  if (o.motionBlur) col = motionBlurNode(raw, scenePass.getTextureNode('depth'), col);

  let aoPass: ReturnType<typeof ao> | null = null;
  let hdr = col.rgb;
  if (o.ao) {
    aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
    aoPass.resolutionScale = o.ao.resolution;
    aoPass.samples.value = o.ao.samples;
    // ~1.1 m reach: crate/drum/container feet, wall bases and characters get a contact shadow; a lower thickness
    // keeps thin poles from smearing a halo onto the wall behind them
    aoPass.radius.value = 1.1;
    aoPass.thickness.value = 0.9;
    aoPass.distanceExponent.value = 1.6;
    aoPass.scale.value = 1.25;
    // Post-applied AO also hits direct sunlight: full strength in shade, lighter on bright sunlit pixels, so contact
    // shadows ground props and characters without dirtying lit walls.
    const occ = aoPass.getTextureNode().sample(screenUV).r;
    const lit = smoothstep(0.25, 1.6, luminance(col.rgb));
    hdr = hdr.mul(mix(float(1), occ, mix(grade.ao, grade.ao.mul(0.45), lit)));
  }
  let bloomPass: ReturnType<typeof bloom> | null = null;
  if (o.bloom) {
    // Emissive output blooms (generator glow, water sun-glints write emissive), plus a subtle bloom of geometry hot
    // spots: sun specular on wet ground, chrome, galvanised steel. Never the sky (depth ≈ 1) — the sky dome is bright
    // everywhere and would fog the whole horizon.
    const lum = luminance(col.rgb);
    const notSky = step(scenePass.getTextureNode('depth').r, 0.9999);
    const hot = col.rgb.mul(smoothstep(grade.bloomThreshold, grade.bloomThreshold.mul(2.5), lum)).mul(notSky).mul(0.35);
    bloomPass = bloom(perfOff('nohotbloom') ? scenePass.getTextureNode('emissive') : vec4(scenePass.getTextureNode('emissive').rgb.add(hot), 1), 0.75, 0.45, 0);
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

  // Tone map (renderer.toneMapping, Neutral) + sRGB, then grade in display space. world/displayColor.ts inverts this
  // chain for name tags: keep the two in step.
  const ldr = renderOutput(vec4(hdr, 1)).rgb;
  const l = luminance(ldr);
  const tint = mix(grade.shadowTint, grade.highlightTint, smoothstep(0.15, 0.75, l));
  let c: THREE.Node<'vec3'> = ldr.mul(tint).clamp(0, 1);
  // S-curve contrast that pins 0 and 1: mid-tone slope = contrast, toe and shoulder ease off instead of clipping
  // (a linear stretch around 0.5 crushed everything below ~4 % to black and clipped the top end)
  c = mix(c, c.mul(c).mul(c.mul(-2).add(3)), grade.contrast.sub(1).mul(2));
  c = mix(vec3(luminance(c)), c, grade.saturation).max(0);
  const v = screenUV.sub(0.5);
  const vig = float(1).sub(grade.vignette.mul(smoothstep(0.06, 0.5, dot(v, v))));
  c = c.mul(vig);
  if (flare) c = c.add(flare);
  // Triangular ±1 LSB dither before the 8-bit canvas: breaks the banding in smooth sky gradients (sunset). Two
  // interleaved-gradient-noise taps at different pixel offsets, no texture, no extra pass.
  const px = screenCoordinate.xy;
  if (!perfOff('nodither')) c = c.add(interleavedGradientNoise(px).add(interleavedGradientNoise(px.add(vec2(47, 113)))).sub(1).mul(grade.dither));
  pipe.outputNode = c;
  return { pipe, scenePass, aoPass, bloomPass }; // the scene pass: the warm-up compiles world materials for its exact target/MRT
}
