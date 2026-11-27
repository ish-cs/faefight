import * as THREE from 'three/webgpu';
import { float, Fn, luminance, max, min, mix, select, smoothstep, sqrt, step, toneMappingExposure, vec3 } from 'three/tsl';
import { grade } from './post';

/**
 * Exact on-screen colours for in-world UI (name tags) despite the scene's tone mapping and grade.
 *
 * The scene pass is tone-mapped (Khronos PBR Neutral, renderer.toneMappingExposure) and then graded (post.ts: tint,
 * S-curve contrast, saturation) as a whole, so a per-material `toneMapped = false` does nothing. Instead, a tag's
 * shader feeds the scene the HDR value that comes OUT of that chain as the colour it wants: the chain run backwards.
 * Without this, a pre-boosted sprite's hue and lightness drift (a yellow team's tag came out brown).
 *
 * Pure-JS twins (`displayOf`, `hdrFor`) mirror the shader for tests/client/displayColor.test.ts.
 */

/** The brightest display value a tag asks for (keeps tags out of the tone curve's shoulder and out of bloom). */
export const DISPLAY_MAX = 0.93;
// three's neutralToneMapping (nodes/display/ToneMappingFunctions.js)
const START = 0.8 - 0.04, DESAT = 0.15, D = 1 - START;

// ---- CPU twins (mirror three's chain) ----
type RGB = [number, number, number];
const srgbEncode = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** 0.41666 - 0.055);
const srgbDecode = (x: number) => (x <= 0.04045 ? x * 0.0773993808 : (x * 0.9478672986 + 0.0521327014) ** 2.4);
const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
type Grade = { shadow: RGB; high: RGB; contrast: number; saturation: number };
const gradeNow = (): Grade => {
  const s = grade.shadowTint.value as THREE.Color, h = grade.highlightTint.value as THREE.Color;
  return { shadow: [s.r, s.g, s.b], high: [h.r, h.g, h.b], contrast: grade.contrast.value as number, saturation: grade.saturation.value as number };
};

function neutral(c: RGB): RGB {
  const x = Math.min(...c), offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const o = c.map((v) => v - offset) as RGB;
  const peak = Math.max(...o);
  if (peak < START) return o;
  const np = 1 - (D * D) / (peak + D - START), g = 1 - 1 / (DESAT * (peak - np) + 1);
  return o.map((v) => (v * np) / peak * (1 - g) + np * g) as RGB;
}
function neutralInv(y: RGB): RGB {
  const np = Math.max(...y);
  let o = y;
  if (np >= START) {
    const peak = (D * D) / (1 - np) - D + START, g = 1 - 1 / (DESAT * (peak - np) + 1);
    o = y.map((v) => ((v - g * np) / (1 - g)) * peak / np) as RGB;
  }
  const m = Math.min(...o), offset = m < 0.04 ? 0.4 * Math.sqrt(Math.max(m, 0)) - m : 0.04;
  return o.map((v) => v + offset) as RGB;
}
/** post.ts's S-curve: mid-tone slope `contrast`, 0 and 1 pinned. */
const sCurve = (x: number, k: number) => x + 2 * (k - 1) * (x * x * (3 - 2 * x) - x);
/** its inverse (monotonic for contrast ≤ 1.5): a few Newton steps */
function sCurveInv(v: number, k: number) {
  const s = 2 * (k - 1);
  let x = v;
  for (let i = 0; i < 4; i++) x -= (sCurve(x, k) - v) / (1 + s * (6 * x - 6 * x * x - 1));
  return x;
}

/** Forward: scene HDR (linear) → final sRGB-encoded display value (tone map + sRGB + grade, no vignette/dither). */
export function displayOf(hdr: RGB, exposure: number, g: Grade = gradeNow()): RGB {
  const ldr = neutral(hdr.map((v) => v * exposure) as RGB).map((v) => srgbEncode(Math.min(1, Math.max(0, v)))) as RGB;
  const k = smooth(0.15, 0.75, lum(ldr));
  let c = ldr.map((v, i) => Math.min(1, Math.max(0, v * (g.shadow[i] + (g.high[i] - g.shadow[i]) * k)))) as RGB;
  c = c.map((v) => sCurve(v, g.contrast)) as RGB;
  const l = lum(c);
  return c.map((v) => Math.max(0, l + (v - l) * g.saturation)) as RGB;
}

/** Inverse: the scene HDR value whose display value is `display` (sRGB-encoded 0..1, like a CSS colour). */
export function hdrFor(display: RGB, exposure: number, g: Grade = gradeNow()): RGB {
  const l = lum(display);
  let c = display.map((v) => l + (v - l) / g.saturation) as RGB;
  c = c.map((v) => sCurveInv(Math.min(1, Math.max(0, v)), g.contrast)) as RGB;
  const k = smooth(0.15, 0.75, lum(c));
  const ldr = c.map((v, i) => Math.min(DISPLAY_MAX, Math.max(0, v / (g.shadow[i] + (g.high[i] - g.shadow[i]) * k)))) as RGB;
  const y = ldr.map((v) => Math.min(DISPLAY_MAX, srgbDecode(v))) as RGB;
  return neutralInv(y).map((v) => Math.max(0, v / exposure)) as RGB;
}

// ---- shader ----
const vmax = (v: THREE.Node<'vec3'>) => max(v.x, max(v.y, v.z));
const vmin = (v: THREE.Node<'vec3'>) => min(v.x, min(v.y, v.z));

/**
 * Shader twin of hdrFor: `display` is the wanted sRGB-encoded colour (e.g. a canvas texture sampled WITHOUT colour
 * space decoding), the result is what to output into the tone-mapped scene.
 */
export const sceneColorFor = Fn(([display]: [THREE.Node<'vec3'>]) => {
  const l = luminance(display);
  const c0 = vec3(l).add(display.sub(l).div(grade.saturation)).clamp(0, 1);
  // S-curve inverse: Newton steps
  const s = grade.contrast.sub(1).mul(2);
  let x: THREE.Node<'vec3'> = c0;
  for (let i = 0; i < 4; i++) {
    const f = x.add(x.mul(x).mul(x.mul(-2).add(3)).sub(x).mul(s));
    const df = x.mul(6).sub(x.mul(x).mul(6)).sub(1).mul(s).add(1);
    x = x.sub(f.sub(c0).div(df));
  }
  const tint = mix(grade.shadowTint, grade.highlightTint, smoothstep(0.15, 0.75, luminance(x)));
  const ldr = min(max(x.div(tint), 0), DISPLAY_MAX);
  // sRGB decode
  const y = min(mix(ldr.mul(0.0773993808), ldr.mul(0.9478672986).add(0.0521327014).pow(2.4), step(0.04045, ldr)), DISPLAY_MAX);
  // Neutral inverse: undo the shoulder (desaturation + peak compression) when the peak is past its start, then the toe
  const np = vmax(y);
  const peak = float(D * D).div(float(1).sub(np)).add(START - D);
  const g = float(1).sub(float(1).div(peak.sub(np).mul(DESAT).add(1)));
  const shoulder = y.sub(np.mul(g)).div(float(1).sub(g)).mul(peak.div(np));
  const o = select(np.lessThan(START), y, shoulder);
  const m = vmin(o);
  const offset = select(m.lessThan(0.04), sqrt(max(m, 0)).mul(0.4).sub(m), float(0.04));
  return max(o.add(offset), 0).div(toneMappingExposure as unknown as THREE.Node<'float'>);
});
