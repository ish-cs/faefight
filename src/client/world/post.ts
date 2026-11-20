import * as THREE from 'three/webgpu';
import {
  dot, emissive, float, luminance, mix, mrt, normalView, output, pass, renderOutput, screenUV, smoothstep, uniform, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';

export type PostOptions = { samples: number; bloom: boolean; ao: false | { resolution: number; samples: number } };

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
export function buildPipeline(gpu: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, o: PostOptions): THREE.RenderPipeline {
  const pipe = new THREE.RenderPipeline(gpu);
  pipe.outputColorTransform = false; // tone map + sRGB ourselves so the grade runs in display space

  const scenePass = pass(scene, camera, { samples: o.samples });
  const targets: Record<string, THREE.Node> = { output };
  if (o.bloom) targets.emissive = emissive;
  if (o.ao) targets.normal = normalView;
  if (Object.keys(targets).length > 1) scenePass.setMRT(mrt(targets));
  const col = scenePass.getTextureNode('output');

  let hdr = col.rgb;
  if (o.ao) {
    const aoPass = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera);
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
  if (o.bloom) {
    // only emissive output blooms (generator glow, water sun-glints write emissive) — never the bright sky
    hdr = hdr.add(bloom(scenePass.getTextureNode('emissive'), 0.75, 0.45, 0).rgb);
  }

  // Tone map (renderer.toneMapping, ACES) + sRGB, then grade in display space.
  const ldr = renderOutput(vec4(hdr, 1)).rgb;
  const l = luminance(ldr);
  const tint = mix(grade.shadowTint, grade.highlightTint, smoothstep(0.15, 0.75, l));
  let c = ldr.mul(tint);
  c = c.sub(0.5).mul(grade.contrast).add(0.5).max(0);
  c = mix(vec3(luminance(c)), c, grade.saturation);
  const v = screenUV.sub(0.5);
  const vig = float(1).sub(grade.vignette.mul(smoothstep(0.06, 0.5, dot(v, v))));
  pipe.outputNode = c.mul(vig);
  return pipe;
}
