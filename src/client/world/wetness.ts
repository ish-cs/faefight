import type * as THREE from 'three/webgpu';
import { float, max, min, mix, normalViewGeometry, normalWorldGeometry, renderGroup, smoothstep, uniform, vec4 } from 'three/tsl';
import { worldNoise } from './pbr';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/**
 * Wet ground: one global uniform (0 dry … 1 soaked) that the shared world materials read, so rain costs a few ALU
 * ops per pixel and no new materials. Wet = darker albedo (water fills the pores), much lower roughness (a film of
 * water), most on up-facing surfaces; on flat ground standing puddles open up as it gets wetter (mirror-smooth,
 * flat normal). StormFx drives it from the rain, and night dew (day/night) keeps the ground damp after dark.
 */
// shared render-group uniform: uploaded once per render, not per object drawn (it is in most world materials)
export const wetness = uniform(0).setGroup(renderGroup);

export const WET = {
  /** s to soak through once rain starts / to dry out after it stops (time constants) */
  riseS: 14,
  dryS: 75,
  /** night dew: wetness at full night (max'd with the rain), a damp sheen on the ground */
  nightDew: 0.3,
};

/** One frame of soaking / drying toward `target` (0..1). */
export function stepWetness(cur: number, target: number, dt: number): number {
  const tau = target > cur ? WET.riseS : WET.dryS;
  const next = cur + (target - cur) * (1 - Math.exp(-dt / tau));
  return Math.abs(next - target) < 1e-4 ? target : next;
}

/** ?wet=0..1 pins wetness (screenshots, perf A/B). */
export function wetOverride(): number | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('wet');
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

let puddleNoise: F | null = null;

/**
 * Make a material's colour / roughness / normal respond to `wetness`. `porosity` scales the darkening (1 = sand,
 * concrete; low for metal and paint), `puddles` lets standing water collect on its flat, up-facing parts.
 * Call after the material's colorNode / roughnessNode (and normalNode, for puddles) are set; `rgba` when colorNode
 * is a vec4.
 */
export function applyWet(m: THREE.MeshStandardNodeMaterial, o: { porosity?: number; puddles?: boolean; rgba?: boolean } = {}) {
  if (!m.colorNode || !m.roughnessNode) throw new Error(`[world/wetness] ${m.name}: set colorNode and roughnessNode before applyWet`);
  const up = normalWorldGeometry.y.clamp(0, 1);
  // rain soaks what faces the sky; walls only get the run-off
  const w = wetness.mul(mix(float(0.35), float(1), up));
  const dark = mix(float(1), float(1 - 0.45 * (o.porosity ?? 1)), w);
  // rgba: a vec4 colorNode (its alpha must stay as it is)
  const c0 = m.colorNode as THREE.Node<'vec4'>;
  let col: V3 = (o.rgba ? c0.rgb : (m.colorNode as V3)).mul(dark);
  const r = m.roughnessNode as F;
  let rough: F = mix(r, min(r, r.mul(0.35).add(0.08)), w);
  if (o.puddles) {
    puddleNoise ??= worldNoise(0.06, 'g'); // one shared node: one texture binding however many materials use it
    const flat = smoothstep(0.93, 0.99, up);
    const edge = float(1).sub(wetness.mul(0.36)); // puddles spread as it gets wetter
    const pud = smoothstep(edge, edge.add(0.06), puddleNoise).mul(flat).mul(smoothstep(0.25, 0.7, wetness));
    col = col.mul(mix(float(1), float(0.72), pud));
    rough = mix(rough, float(0.035), pud);
    if (m.normalNode) m.normalNode = mix(m.normalNode as V3, normalViewGeometry, pud).normalize();
  }
  m.colorNode = o.rgba ? vec4(col, c0.a) : col;
  m.roughnessNode = max(float(0.03), rough);
  return m;
}
