import * as THREE from 'three/webgpu';
import { float, mix, positionLocal, positionWorld, smoothstep, sin, cos, texture, time, uv, vec2, vec3 } from 'three/tsl';
import { MAP } from '../../sim/constants';
import { applyPbr, pbrMaterial, pbrSample, worldNoise } from './pbr';
import { awningTex, barkTex, frondTex, leafBlobTex, seawallTex } from './textures';

type Opts = ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0];
const std = (name: string, o: Opts) => {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, ...o });
  m.name = name;
  return m;
};

/**
 * Quay / harbor wall: concrete PBR (u from the wall's own uv in 6 m units, v from world height) tinted by the old
 * seawall gradient so the algae + tide band sits at the waterline, wet and glossy right above the water.
 */
function quayWall() {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
  m.name = 'quayWall';
  const y = positionWorld.y;
  const s = pbrSample('concrete_wall', vec2(uv().x, y.div(6)), 'shift');
  applyPbr(m, s, { lum: 0.237, tint: 0xa8a49c, macro: 0.18, normalScale: 1.2 });
  const top = MAP.groundY;
  const band = texture(seawallTex(), vec2(0.5, y.sub(top - 16).div(16))).rgb.div(vec3(0.7, 0.67, 0.61));
  const wet = float(1).sub(smoothstep(0.1, 0.9, y.sub(MAP.waterY))); // splash zone above the waterline
  m.colorNode = (m.colorNode as THREE.Node<'vec3'>).mul(band).mul(mix(float(1), float(0.62), wet));
  m.roughnessNode = mix(m.roughnessNode as THREE.Node<'float'>, float(0.32), wet.mul(0.85));
  return m;
}

/** Palm fronds sway: tip displacement grows with uv.y² (frond geometry runs base → tip along v). */
function frondMaterial() {
  const m = std('frond', { map: frondTex(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 });
  const p = positionLocal; // merged static geometry: local = world
  const ph = p.x.mul(0.23).add(p.z.mul(0.19));
  const gust = sin(time.mul(0.37).add(p.x.mul(0.01))).mul(0.5).add(0.6);
  const k = uv().y.mul(uv().y).mul(gust);
  m.positionNode = p.add(vec3(sin(time.mul(1.7).add(ph)).mul(0.16), sin(time.mul(2.3).add(ph.mul(1.3))).mul(0.12), cos(time.mul(1.3).add(ph)).mul(0.14)).mul(k));
  return m;
}

let M: ReturnType<typeof make> | null = null;
function make() {
  return {
    /** bunker walls, coping, cast concrete */
    concrete: pbrMaterial('concrete', 'concrete_wall', { lum: 0.237, tint: 0xb4b0a8, macro: 0.15, untile: 'shift' }),
    /** flat paving (quay slab) */
    slab: pbrMaterial('slab', 'concrete', { tint: 0xf2ede4, gain: 3.6, macro: 0.2, uvScale: 1 }),
    asphalt: pbrMaterial('asphalt', 'asphalt', { tint: 0xe6e2da, gain: 1.7, macro: 0.2, uvScale: 1 }),
    seawall: quayWall(),
    dark: std('dark', { color: 0x222426, roughness: 0.55, metalness: 0.3 }),
    rubber: std('rubber', { color: 0x262624, roughness: 0.92 }),
    galv: std('galv', { color: 0xa4abb0, metalness: 0.85, roughness: 0.38 }),
    wood: pbrMaterial('wood', 'planks', { macro: 0.12, untile: false }),
    burlap: pbrMaterial('burlap', 'linen', { lum: 0.4, tint: 0xc4a874, uvScale: 2, normalScale: 1.5, roughAdd: 0.1, metalness: 0, untile: false }),
    steel: pbrMaterial('steel', 'steel_plate', { tint: 0xe0e4e8, gain: 4, metalness: 0.7, roughMul: 0.9, untile: 'shift' }),
    frond: frondMaterial(),
    bark: std('bark', { map: barkTex(), roughness: 0.95 }),
    /** painted steel (crane, drums, trims): repainted rusty-paint set, triplanar (the plain boxes have 0..1 UVs) */
    paint: pbrMaterial('paint', 'painted_metal', { lum: 0.069, lumPow: 0.3, triplanar: 0.35, normalScale: 0.1, roughMul: 0.9, metalness: 0.2 }),
    matte: std('matte', { roughness: 0.9 }),
    corr: pbrMaterial('corr', 'corrugated', { lum: 0.44, uvScale: [2, 1], normalScale: 1.2, metalness: 0.35, roughMul: 0.95, macro: 0.12, untile: 'shift' }),
    awning: std('awning', { map: awningTex(), roughness: 0.8, side: THREE.DoubleSide }),
    leaf: std('leaf', { map: leafBlobTex(), roughness: 0.95 }),
    /** hills / distant islands: vertex-coloured, grass-ground detail in world xz */
    terrain: pbrMaterial('terrain', 'grass', { uvNode: positionWorld.xz.mul(0.22), lum: 0.121, untile: true, roughAdd: 0.1, metalness: 0 }),
    rock: rockMaterial(),
    glow: std('glow', { color: 0x0c2a10, emissive: 0x2bff5a, emissiveIntensity: 2.2, roughness: 0.4 }),
  };
}

/** Riprap / boulders: triplanar rock, dark + glossy below the tide line, a touch of algae green near the water. */
function rockMaterial() {
  const m = pbrMaterial('rock', 'rock', { triplanar: 0.45, tint: 0xd8d0c4, gain: 2.6, normalScale: 1.3 });
  const y = positionWorld.y.sub(MAP.waterY);
  const wet = float(1).sub(smoothstep(0.15, 0.8, y));
  const algae = float(1).sub(smoothstep(-0.2, 0.35, y)).mul(worldNoise(0.3, 'g').mul(0.8).add(0.2));
  let c = (m.colorNode as THREE.Node<'vec3'>).mul(mix(float(1), float(0.55), wet));
  c = mix(c, vec3(0.13, 0.17, 0.08), algae.mul(0.6));
  m.colorNode = c;
  m.roughnessNode = mix(m.roughnessNode as THREE.Node<'float'>, float(0.22), wet);
  return m;
}

/** Shared static-world materials. All use vertex colours as a per-part tint (white = untinted). */
export function mats() {
  if (!M) M = make();
  return M;
}

/** Shipping-container palette (faded, realistic liveries). */
export const CONTAINER_COLORS = [0x9a3b2a, 0x1f4e79, 0x2f6b3a, 0xc8641e, 0xd6d4cc, 0x2a7f86, 0x7d2430, 0x46505a, 0x8a8f2e];
