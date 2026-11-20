import * as THREE from 'three/webgpu';
import { abs, float, luminance, max, mix, normalMap, positionWorld, smoothstep, texture, uv, vec2, vec3, normalWorld } from 'three/tsl';

/**
 * CC0 PBR texture sets (Poly Haven, see public/assets/CREDITS.md): albedo (sRGB), OpenGL normal, ARM (AO / rough /
 * metal). Helpers sample them with anti-tiling ("texture bombing": a second, rotated + offset sample blended in by
 * low-frequency noise) and world-space macro variation, so large surfaces don't show a repeating grid.
 */
export type PbrName = 'concrete' | 'concrete_wall' | 'sand' | 'grass' | 'rock' | 'corrugated' | 'painted_metal' | 'planks' | 'linen' | 'asphalt' | 'steel_plate' | 'gravel';

type V3 = THREE.Node<'vec3'>;
type V2 = THREE.Node<'vec2'>;
type F = THREE.Node<'float'>;

const BASE = `${import.meta.env.BASE_URL}assets/textures/`;
const loader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();

function load(path: string, srgb: boolean): THREE.Texture {
  let t = texCache.get(path);
  if (t) return t;
  t = loader.load(BASE + path, undefined, undefined, (err) => console.error(`[world/pbr] failed to load ${BASE + path}`, err));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(path, t);
  return t;
}

export function pbrTex(name: PbrName) {
  return { map: load(`${name}/albedo.jpg`, true), normal: load(`${name}/normal.jpg`, false), arm: load(`${name}/arm.jpg`, false) };
}

let noise: THREE.DataTexture | null = null;
/** Tileable smooth value noise, 4 octaves; R and G are independent fields (0..1). */
export function noiseTex(): THREE.DataTexture {
  if (noise) return noise;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const lattice = (seed: number, p: number) => {
    const a = new Float32Array(p * p);
    let s = seed;
    for (let i = 0; i < a.length; i++) { s = (s * 16807) % 2147483647; a[i] = s / 2147483647; }
    return a;
  };
  const field = (seed: number) => {
    const out = new Float32Array(N * N);
    let amp = 0.5, total = 0;
    for (let o = 0; o < 4; o++) {
      const P = 4 << o; // lattice cells per tile (periodic → tileable)
      const L = lattice(seed + o * 7919, P);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = (x / N) * P, fy = (y / N) * P;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const g = (i: number, j: number) => L[((j % P) * P) + (i % P)];
        const v = (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
        out[y * N + x] += v * amp;
      }
      total += amp; amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  };
  const r = field(12345), g = field(98765);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(Math.min(1, Math.max(0, (r[i] - 0.5) * 1.8 + 0.5)) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, (g[i] - 0.5) * 1.8 + 0.5)) * 255);
    data[i * 4 + 2] = 128; data[i * 4 + 3] = 255;
  }
  noise = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = noise.minFilter = THREE.LinearFilter;
  noise.generateMipmaps = false;
  noise.needsUpdate = true;
  return noise;
}

/** Low-frequency world noise (0..1) for macro variation; `scale` = cycles per metre / 1 tile = 1/scale m. */
export function worldNoise(scale = 0.02, ch: 'r' | 'g' = 'r'): F {
  const p = positionWorld;
  const t = texture(noiseTex(), vec2(p.x.add(p.y.mul(0.71)), p.z.sub(p.y.mul(0.53))).mul(scale));
  return (ch === 'r' ? t.r : t.g) as F;
}

const ROT = 0.83, C = Math.cos(ROT), S = Math.sin(ROT);
const rot = (v: V2, c: number, s: number) => vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));

export type PbrSample = { albedo: V3; normal: V3; arm: V3 };

/** Samples a set at `uvN`; with `untile`, blends a rotated/offset second sample by noise (normal XY rotated back). */
export function pbrSample(name: PbrName, uvN: V2, untile: boolean | 'shift' = true, lean = false): PbrSample {
  const t = pbrTex(name);
  // lean: no ARM texture (constant rough 0.9, AO 1) — keeps a fragment stage under WebGPU's 16-texture limit
  const armOf = (u: V2) => (lean ? vec3(1, 0.9, 0) : texture(t.arm, u).rgb) as V3;
  const a = { albedo: texture(t.map, uvN).rgb, normal: texture(t.normal, uvN).rgb, arm: armOf(uvN) };
  if (!untile) return a as PbrSample;
  // 'shift' keeps orientation (directional patterns: formwork joints); otherwise rotate + scale too
  const shift = untile === 'shift';
  const uvB = shift ? uvN.add(vec2(0.37, 0.61)) : rot(uvN, C, S).mul(0.87).add(vec2(0.37, 0.61));
  const nB = texture(t.normal, uvB).rgb.mul(2).sub(1);
  const nBxy = shift ? nB.xy : rot(nB.xy, C, -S); // undo the sample rotation in tangent space
  const b = { albedo: texture(t.map, uvB).rgb, normal: vec3(nBxy, nB.z).mul(0.5).add(0.5), arm: armOf(uvB) };
  const k = smoothstep(0.4, 0.6, texture(noiseTex(), uvN.mul(0.21)).g);
  return { albedo: mix(a.albedo, b.albedo, k), normal: mix(a.normal, b.normal, k), arm: mix(a.arm, b.arm, k) } as PbrSample;
}

/** Albedo only (one texture binding), optionally untiled like pbrSample. */
export function pbrAlbedo(name: PbrName, uvN: V2, untile = true): V3 {
  const t = pbrTex(name);
  const a = texture(t.map, uvN).rgb;
  if (!untile) return a as V3;
  const uvB = rot(uvN, C, S).mul(0.87).add(vec2(0.37, 0.61));
  const k = smoothstep(0.4, 0.6, texture(noiseTex(), uvN.mul(0.21)).g);
  return mix(a, texture(t.map, uvB).rgb, k) as V3;
}

/** Triplanar sample in world space (`scale` = tiles per metre), for meshes without useful UVs (rocks). */
export function pbrTriplanar(name: PbrName, scale: number): PbrSample {
  const p = positionWorld.mul(scale);
  const w = abs(normalWorld).pow(vec3(4, 4, 4));
  const ws = w.div(w.x.add(w.y).add(w.z));
  const sx = pbrSample(name, p.zy as unknown as V2, false), sy = pbrSample(name, p.xz as unknown as V2, false), sz = pbrSample(name, p.xy as unknown as V2, false);
  const blend = (k: keyof PbrSample) => sx[k].mul(ws.x).add(sy[k].mul(ws.y)).add(sz[k].mul(ws.z)) as V3;
  // normal: whiteout-free cheap approach — treat the blended tangent normal as if all planes shared the dominant frame
  return { albedo: blend('albedo'), normal: blend('normal'), arm: blend('arm') };
}

export type PbrOpts = {
  /** UV multiplier on the geometry's own uv() (default 1), or an explicit uv node */
  uvScale?: number | [number, number];
  uvNode?: V2;
  /** colour multiplier (vertex colours multiply on top) */
  tint?: THREE.ColorRepresentation;
  /** albedo multiplier (Poly Haven albedos are calibrated dark; scenes here are sun-lit) */
  gain?: number;
  /** use albedo luminance (normalised to `lumMean`) instead of its colour, then tint: for repainting a set */
  lum?: number;
  /** compress the luminance contrast when repainting (1 = as photographed, 0.5 = half) */
  lumPow?: number;
  normalScale?: number;
  roughMul?: number;
  roughAdd?: number;
  metalness?: number;
  /** strength of world-space macro brightness variation (0 = off) */
  macro?: number;
  untile?: boolean | 'shift';
  triplanar?: number;
  side?: THREE.Side;
  aoStrength?: number;
};

/** MeshStandardNodeMaterial from a PBR set (vertexColors on: per-part tint keeps working). */
export function pbrMaterial(label: string, name: PbrName, o: PbrOpts = {}): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, side: o.side ?? THREE.FrontSide });
  m.name = label;
  const sc = o.uvScale ?? 1;
  const uvN = o.uvNode ?? (Array.isArray(sc) ? uv().mul(vec2(sc[0], sc[1])) : uv().mul(sc));
  const s = o.triplanar ? pbrTriplanar(name, o.triplanar) : pbrSample(name, uvN as V2, o.untile ?? true);
  applyPbr(m, s, o);
  return m;
}

/** Wire a sample into a material's colour/normal/roughness/metal/AO nodes. */
export function applyPbr(m: THREE.MeshStandardNodeMaterial, s: PbrSample, o: PbrOpts = {}) {
  let col: V3 = s.albedo;
  if (o.lum) col = vec3(luminance(col).div(o.lum).pow(o.lumPow ?? 1));
  if (o.tint !== undefined) {
    const c = new THREE.Color(o.tint);
    col = col.mul(vec3(c.r, c.g, c.b));
  }
  if (o.gain) col = col.mul(o.gain);
  if (o.macro) col = col.mul(mix(float(1 - o.macro), float(1 + o.macro * 0.6), worldNoise(0.025)));
  m.colorNode = col;
  m.normalNode = normalMap(s.normal, vec2(o.normalScale ?? 1, o.normalScale ?? 1));
  m.roughnessNode = max(float(0.04), s.arm.g.mul(o.roughMul ?? 1).add(o.roughAdd ?? 0)).min(1);
  m.metalnessNode = o.metalness !== undefined ? float(o.metalness) : s.arm.b;
  m.aoNode = mix(float(1), s.arm.r, o.aoStrength ?? 1);
}
