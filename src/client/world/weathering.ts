import * as THREE from 'three/webgpu';
import { abs, attribute, float, fract, hash, instanceIndex, max, min, mix, normalLocal, normalWorld, positionWorld, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';
import { MAP } from '../../sim/constants';
import { noiseTex } from './pbr';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/**
 * Procedural weathering layered onto an existing node material: grime gradient up from the ground, rain/dirt
 * streaks down vertical faces, rust patches (+ rust runs below them), paint chips / edge wear along UV borders,
 * and per-object variation (instance hash for instanced meshes, low-frequency world noise for merged statics).
 *
 * Only the shared tileable noise texture is sampled (one binding however many calls), so it fits under WebGPU's
 * 16-textures-per-stage limit on top of any PBR set + env map + shadow cascades.
 *
 * `objectSpace` (moving instanced props: physics debris, gameplay props): noise follows the mesh's own vertex
 * positions, offset per instance, so rust and grime stay glued to a tumbling barrel instead of swimming over it.
 */
export type WeatherOpts = {
  /** dirt darkening up from the deck, 0..1 (default 0.6) */
  grime?: number;
  /** grime band height (m, default 0.7) */
  grimeHeight?: number;
  /** dark vertical streaks on walls/sides, 0..1 */
  streaks?: number;
  /** rust coverage 0..1 (0 = none) */
  rust?: number;
  /** chip/edge-wear strength 0..1 along UV borders (boxes, cylinders) */
  edge?: number;
  /** colour exposed by chips: bare steel (metallic), raw wood, or a lighter scuff of the base colour */
  chip?: 'steel' | 'wood' | 'light';
  /** per-object brightness/hue variation 0..1 (default 0.15) */
  vary?: number;
  /** instanced mesh: variation from the instance index instead of world noise */
  instanced?: boolean;
  /** moving props: noise + grime in the geometry's own space (implies instanced) */
  objectSpace?: boolean;
  /** ground height for the grime gradient in world space (default the island deck) */
  ground?: number;
};

const RUST = vec3(0.3, 0.13, 0.055);
const DIRT = vec3(0.24, 0.2, 0.15);

/** Same projection as pbr.worldNoise, at any position node. */
function noiseAt(p: V3, scale: number, ch: 'r' | 'g' = 'r'): F {
  const t = texture(noiseTex(), vec2(p.x.add(p.y.mul(0.71)), p.z.sub(p.y.mul(0.53))).mul(scale));
  return (ch === 'r' ? t.r : t.g) as F;
}

/** Rain/drip streaks: noise stretched ~25× vertically, only on steep faces. */
function streakMask(p: V3, ny: F): F {
  const s = texture(noiseTex(), vec2(p.x.add(p.z).mul(2.3), p.y.mul(0.09))).r;
  const steep = smoothstep(0.35, 0.8, float(1).sub(abs(ny)));
  return smoothstep(0.52, 0.78, s).mul(steep) as F;
}

/** 0 inside a UV face → 1 at its border (box faces and cylinder caps/seams have 0..1 UVs; scaled UVs use fract). */
function edgeMask(width = 0.045): F {
  const u = fract(uv());
  const d = min(min(u.x, float(1).sub(u.x)), min(u.y, float(1).sub(u.y)));
  return float(1).sub(smoothstep(0, width, d)) as F;
}

type Raw = { base: V3; rough: F; metal: F; opts: WeatherOpts };
/** unweathered nodes per material (not userData: Material.clone JSON-copies userData) */
const RAW = new WeakMap<THREE.Material, Raw>();

/** ?noweather (perf A/B): materials stay as built, no weathering nodes */
const OFF = typeof location !== 'undefined' && location.search.includes('noweather');

export function weather(m: THREE.MeshStandardNodeMaterial, o: WeatherOpts = {}) {
  if (OFF) return m;
  const raw: Raw = RAW.get(m) ?? {
    // a colorNode replaces material.color AND .map, so a textured material's map is folded into the base here
    base: (m.colorNode as V3 | null) ?? (m.map ? texture(m.map).rgb.mul(vec3(m.color.r, m.color.g, m.color.b)) : vec3(m.color.r, m.color.g, m.color.b)) as V3,
    rough: (m.roughnessNode as F | null) ?? float(m.roughness),
    metal: (m.metalnessNode as F | null) ?? float(m.metalness),
    opts: o,
  };
  RAW.set(m, { ...raw, opts: o });

  const obj = !!o.objectSpace;
  const inst = obj || !!o.instanced;
  const ik = hash(instanceIndex);
  // object space: raw vertex position (before the instance matrix) + a per-instance offset into the noise
  const p: V3 = obj ? (attribute('position', 'vec3') as V3).add(vec3(ik.mul(37.1), ik.mul(11.3), ik.mul(23.7))) : (positionWorld as V3);
  const ny: F = (obj ? normalLocal.y : normalWorld.y) as F;
  const nLo = noiseAt(p, 0.45), nHi = noiseAt(p, 3.1, 'g'), nMid = noiseAt(p, 1.2, 'g');
  const objK: F = inst ? ik : noiseAt(positionWorld as V3, 0.07);
  const vary = o.vary ?? 0.15;
  let col: V3 = raw.base.mul(mix(float(1 - vary), float(1 + vary * 0.6), objK)).mul(vec3(1, mix(float(0.97), float(1.02), nLo), mix(float(1.03), float(0.95), objK)));
  let rough: F = raw.rough.add(nMid.sub(0.5).mul(0.18));
  let metal: F = raw.metal;

  const g = o.grime ?? 0.6;
  if (g > 0) {
    // world: dirt splashed up from the deck; object space: dirt on the lower part of the object (its rest pose)
    const h = obj ? (attribute('position', 'vec3') as V3).y.add(0.5) : positionWorld.y.sub(o.ground ?? MAP.groundY);
    const band = float(1).sub(smoothstep(0, o.grimeHeight ?? 0.7, h.add(nMid.sub(0.5).mul(0.3)))).mul(obj ? float(1) : smoothstep(-0.2, 0, h));
    const k = band.mul(g).mul(nLo.mul(0.6).add(0.5)).min(1);
    col = mix(col, col.mul(DIRT).mul(2.4), k);
    rough = mix(rough, float(0.95), k);
  }
  if (o.streaks) {
    const k = streakMask(p, ny).mul(o.streaks);
    col = col.mul(float(1).sub(k.mul(0.38)));
    rough = mix(rough, float(0.92), k.mul(0.5));
  }
  if (o.rust) {
    // patches where low + high noise agree; per-object amount so some pieces are near-new, some badly rusted
    const amount = float(o.rust).mul(objK.mul(0.7).add(0.5));
    const field = nLo.mul(0.55).add(nHi.mul(0.45));
    const patch = smoothstep(float(1).sub(amount.mul(0.55)), float(1.08).sub(amount.mul(0.55)), field);
    const run = streakMask(p, ny).mul(smoothstep(0.45, 0.7, nLo)).mul(amount.mul(0.8));
    const k = max(patch, run.mul(0.7)).min(1);
    col = mix(col, RUST.mul(nHi.mul(0.7).add(0.65)), k);
    rough = mix(rough, float(0.88), k);
    metal = mix(metal, float(0.05), k);
  }
  if (o.edge) {
    const chips = edgeMask().mul(smoothstep(0.42, 0.62, nHi)).mul(o.edge).mul(objK.mul(0.6).add(0.6)).min(1);
    const ex = o.chip ?? 'steel';
    const cc = ex === 'steel' ? vec3(0.42, 0.42, 0.4) : ex === 'wood' ? vec3(0.62, 0.5, 0.34) : col.mul(1.35);
    col = mix(col, cc, chips);
    if (ex === 'steel') { metal = mix(metal, float(0.85), chips); rough = mix(rough, float(0.42), chips); }
    else rough = mix(rough, float(0.8), chips);
  }
  m.colorNode = col;
  // keep the map's alpha (alpha-tested labels, stencils) once colorNode has taken over from .map
  if (m.map && !m.opacityNode && (m.alphaTest > 0 || m.transparent)) m.opacityNode = texture(m.map).a;
  m.roughnessNode = rough.clamp(0.04, 1);
  m.metalnessNode = metal.clamp(0, 1);
  return m;
}

const variants = new Map<THREE.Material, THREE.MeshStandardNodeMaterial>();
/**
 * Moving-instance variant of a weathered static material (same PBR set, weathering re-applied in object space).
 * Unweathered materials come back as-is.
 */
export function movingVariant<M extends THREE.Material>(m: M): M {
  const raw = RAW.get(m);
  if (!raw || !(m instanceof THREE.MeshStandardNodeMaterial)) return m;
  let v = variants.get(m);
  if (!v) {
    v = (m as unknown as THREE.MeshStandardNodeMaterial).clone();
    v.name = `${m.name}:moving`;
    RAW.set(v, raw);
    weather(v, { ...raw.opts, objectSpace: true });
    variants.set(m, v);
  }
  return v as unknown as M;
}
