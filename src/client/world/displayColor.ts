import * as THREE from 'three/webgpu';
import { float, Fn, luminance, mat3, max, min, mix, smoothstep, sqrt, step, toneMappingExposure, vec3 } from 'three/tsl';
import { grade } from './post';

/**
 * Exact on-screen colours for in-world UI (name tags) despite the scene's tone mapping and grade.
 *
 * The scene pass is tone-mapped (ACES, renderer.toneMappingExposure) and then graded (post.ts: tint, contrast,
 * saturation) as a whole, so a per-material `toneMapped = false` does nothing. Instead, a tag's shader feeds the
 * scene the HDR value that comes OUT of that chain as the colour it wants: the chain run backwards. Without this,
 * a pre-boosted sprite's hue and lightness drift (a yellow team's tag came out brown).
 *
 * Pure-JS twins (`displayOf`, `hdrFor`) mirror the shader for tests/client/displayColor.test.ts.
 */

// three's ACES fit (nodes/display/ToneMappingFunctions.js), as row-major matrices.
const IN = [0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777];
const OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];
const inv = (m: number[]) => new THREE.Matrix3().set(...(m as [number, number, number, number, number, number, number, number, number])).invert();
const IN_INV = inv(IN), OUT_INV = inv(OUT);
/** Row-major entries of a THREE.Matrix3 (its .elements are column-major). */
const rows = (m: THREE.Matrix3) => { const e = m.elements; return [e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8]]; };

/** The brightest display value a tag asks for (1.0 would need infinite HDR input; keeps tags out of bloom). */
export const DISPLAY_MAX = 0.93;
const RRT = { a: 0.0245786, b: 0.000090537, c: 0.983729, d: 0.4329510, f: 0.238081 };

// ---- CPU twins (row-major math, mirrors three's chain) ----
type RGB = [number, number, number];
const mul = (m: number[], v: RGB): RGB => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const srgbEncode = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** 0.41666 - 0.055);
const srgbDecode = (x: number) => (x <= 0.04045 ? x * 0.0773993808 : (x * 0.9478672986 + 0.0521327014) ** 2.4);
const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
type Grade = { shadow: RGB; high: RGB; contrast: number; saturation: number };
const gradeNow = (): Grade => {
  const s = grade.shadowTint.value as THREE.Color, h = grade.highlightTint.value as THREE.Color;
  return { shadow: [s.r, s.g, s.b], high: [h.r, h.g, h.b], contrast: grade.contrast.value as number, saturation: grade.saturation.value as number };
};

/** Forward: scene HDR (linear) → final sRGB-encoded display value (ACES + sRGB + grade, no vignette). */
export function displayOf(hdr: RGB, exposure: number, g: Grade = gradeNow()): RGB {
  const x = mul(IN, hdr.map((v) => (v * exposure) / 0.6) as RGB).map((v) => (v * (v + RRT.a) - RRT.b) / (v * (RRT.c * v + RRT.d) + RRT.f)) as RGB;
  const ldr = mul(OUT, x).map((v) => srgbEncode(Math.min(1, Math.max(0, v)))) as RGB;
  const k = smooth(0.15, 0.75, lum(ldr));
  let c = ldr.map((v, i) => v * (g.shadow[i] + (g.high[i] - g.shadow[i]) * k)) as RGB;
  c = c.map((v) => Math.max(0, (v - 0.5) * g.contrast + 0.5)) as RGB;
  const l = lum(c);
  return c.map((v) => l + (v - l) * g.saturation) as RGB;
}

/** Inverse: the scene HDR value whose display value is `display` (sRGB-encoded 0..1, like a CSS colour). */
export function hdrFor(display: RGB, exposure: number, g: Grade = gradeNow()): RGB {
  const l = lum(display);
  let c = display.map((v) => l + (v - l) / g.saturation) as RGB;
  c = c.map((v) => (v - 0.5) / g.contrast + 0.5) as RGB;
  const k = smooth(0.15, 0.75, lum(c));
  const ldr = c.map((v, i) => Math.min(DISPLAY_MAX, Math.max(0, v / (g.shadow[i] + (g.high[i] - g.shadow[i]) * k)))) as RGB;
  const y = mul(rows(OUT_INV), ldr.map(srgbDecode) as RGB).map((v) => Math.min(DISPLAY_MAX, Math.max(0, v)));
  const x = y.map((v) => {
    const qa = RRT.c * v - 1, qb = RRT.d * v - RRT.a, qc = RRT.f * v + RRT.b;
    return (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  }) as RGB;
  return mul(rows(IN_INV), x).map((v) => Math.max(0, (v * 0.6) / exposure)) as RGB;
}

// ---- shader ----
const IN_INV_N = mat3(...(rows(IN_INV) as [number, number, number, number, number, number, number, number, number]));
const OUT_INV_N = mat3(...(rows(OUT_INV) as [number, number, number, number, number, number, number, number, number]));

const mulM = (m: THREE.Node<'mat3'>, v: THREE.Node<'vec3'>) => (m as unknown as { mul(v: THREE.Node<'vec3'>): THREE.Node<'vec3'> }).mul(v);

/**
 * Shader twin of hdrFor: `display` is the wanted sRGB-encoded colour (e.g. a canvas texture sampled WITHOUT colour
 * space decoding), the result is what to output into the tone-mapped scene. Matrices are built with mat3() exactly
 * as three builds ACES' own, so whatever order mat3() fills in, these are the inverses of the ones it applies.
 */
export const sceneColorFor = Fn(([display]: [THREE.Node<'vec3'>]) => {
  const l = luminance(display);
  const c0 = vec3(l).add(display.sub(l).div(grade.saturation));
  const c1 = c0.sub(0.5).div(grade.contrast).add(0.5);
  const tint = mix(grade.shadowTint, grade.highlightTint, smoothstep(0.15, 0.75, luminance(c1)));
  const ldr = min(max(c1.div(tint), 0), DISPLAY_MAX);
  // sRGB decode
  const lin = mix(ldr.mul(0.0773993808), ldr.mul(0.9478672986).add(0.0521327014).pow(2.4), step(0.04045, ldr));
  const y = min(max(mulM(OUT_INV_N, lin), 0), DISPLAY_MAX);
  const qa = y.mul(RRT.c).sub(1), qb = y.mul(RRT.d).sub(RRT.a), qc = y.mul(RRT.f).add(RRT.b);
  const x = qb.negate().sub(sqrt(qb.mul(qb).sub(qa.mul(qc).mul(4)))).div(qa.mul(2));
  return max(mulM(IN_INV_N, x), 0).mul(float(0.6).div(toneMappingExposure as unknown as THREE.Node<'float'>));
});
