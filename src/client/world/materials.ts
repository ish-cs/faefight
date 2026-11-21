import * as THREE from 'three/webgpu';
import { color, cos, float, mix, positionLocal, positionWorld, sin, smoothstep, step, texture, time, uv, vec2, vec3, vertexColor } from 'three/tsl';
import { MAP } from '../../sim/constants';
import { lightU } from './lightUniforms';
import { applyPbr, pbrMaterial, pbrSample, worldNoise } from './pbr';
import { weather } from './weathering';
import { awningTex, barkTex, chainTex, frondTex, leafBlobTex, seawallTex } from './textures';

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
    concrete: weather(mossyBase(pbrMaterial('concrete', 'concrete_wall', { lum: 0.237, tint: 0xb4b0a8, macro: 0.15, untile: 'shift' })), { grime: 0.35, streaks: 0.55, vary: 0.1 }),
    /** flat paving (quay slab) */
    slab: pbrMaterial('slab', 'concrete', { tint: 0xf2ede4, gain: 3.6, macro: 0.2, uvScale: 1 }),
    asphalt: pbrMaterial('asphalt', 'asphalt', { tint: 0xe6e2da, gain: 1.7, macro: 0.2, uvScale: 1 }),
    seawall: quayWall(),
    /** dark painted iron (bitts, cleats, chains, frames): repainted paint set + rust, chips, grime */
    dark: weather(pbrMaterial('dark', 'painted_metal', { lum: 0.069, lumPow: 0.3, tint: 0x2a2c2e, normalScale: 0.5, roughMul: 0.8, metalness: 0.35, untile: false }), { rust: 0.4, edge: 0.6, grime: 0.6, streaks: 0.3 }),
    /** rubber (fenders, tyres): asphalt grain repainted near-black, dusty + scuffed */
    rubber: weather(pbrMaterial('rubber', 'asphalt', { lum: 0.35, lumPow: 0.4, tint: 0x2c2c2a, uvScale: 2.5, normalScale: 0.8, roughAdd: 0.15, metalness: 0, untile: false }), { grime: 0.5, edge: 0.35, chip: 'light', vary: 0.12 }),
    /** galvanised steel (posts, rails, ladders): steel plate repainted grey-silver, dull zinc patches + grime */
    galv: weather(pbrMaterial('galv', 'steel_plate', { lum: 0.3, lumPow: 0.5, tint: 0xa4abb0, metalness: 0.8, roughMul: 1.1, normalScale: 0.6, untile: false }), { rust: 0.12, grime: 0.55, streaks: 0.4, vary: 0.1 }),
    wood: weather(pbrMaterial('wood', 'planks', { macro: 0.12, untile: false }), { grime: 0.6, edge: 0.4, chip: 'wood', vary: 0.25, streaks: 0.25 }),
    burlap: pbrMaterial('burlap', 'linen', { lum: 0.4, tint: 0xc4a874, uvScale: 2, normalScale: 1.5, roughAdd: 0.1, metalness: 0, untile: false }),
    steel: weather(pbrMaterial('steel', 'steel_plate', { tint: 0xe0e4e8, gain: 4, metalness: 0.7, roughMul: 0.9, untile: 'shift' }), { rust: 0.22, grime: 0.5, streaks: 0.35 }),
    frond: frondMaterial(),
    bark: std('bark', { map: barkTex(), roughness: 0.95 }),
    /** painted steel (crane, drums, trims): repainted rusty-paint set, triplanar (the plain boxes have 0..1 UVs) */
    paint: weather(pbrMaterial('paint', 'painted_metal', { lum: 0.069, lumPow: 0.3, triplanar: 0.35, normalScale: 0.1, roughMul: 0.9, metalness: 0.2 }), { rust: 0.6, edge: 0.75, grime: 0.6, streaks: 0.55 }),
    /** tarps, plates, generic painted parts: fine canvas weave + grime */
    matte: weather(pbrMaterial('matte', 'linen', { lum: 0.4, lumPow: 0.35, uvScale: 3, normalScale: 0.45, roughAdd: 0.15, metalness: 0, untile: false }), { grime: 0.45, streaks: 0.3, edge: 0.25, chip: 'light' }),
    corr: weather(pbrMaterial('corr', 'corrugated', { lum: 0.44, uvScale: [2, 1], normalScale: 1.2, metalness: 0.35, roughMul: 0.95, macro: 0.12, untile: 'shift' }), { rust: 0.35, edge: 0.4, streaks: 0.75, grime: 0.45 }),
    awning: std('awning', { map: awningTex(), roughness: 0.8, side: THREE.DoubleSide }),
    leaf: std('leaf', { map: leafBlobTex(), roughness: 0.95 }),
    /** hills / distant islands: vertex-coloured, grass-ground detail in world xz */
    terrain: pbrMaterial('terrain', 'grass', { uvNode: positionWorld.xz.mul(0.22), lum: 0.121, untile: true, roughAdd: 0.1, metalness: 0 }),
    rock: rockMaterial(),
    /** loose gravel patches (world-space xz) */
    gravel: pbrMaterial('gravel', 'gravel', { uvNode: positionWorld.xz.div(1.6), tint: 0xe2ddd5, macro: 0.15 }),
    glow: std('glow', { color: 0x0c2a10, emissive: 0x2bff5a, emissiveIntensity: 2.2, roughness: 0.4 }),
    chain: std('chain', { map: chainTex(), alphaTest: 0.4, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 }),
    /** Self-lit parts whose light colour is the vertex colour (gold bars, potions, lamp heads, LEDs). */
    lit: (() => {
      const m = std('lit', { roughness: 0.35 });
      m.emissiveNode = vertexColor().mul(1.6);
      return m;
    })(),
    /**
     * Lamp lenses (street lamps, floodlights): the vertex colour reads as a pale lens by day and glows (bloom) as the
     * lamps switch on at dusk (lightU.lamps, the day/night cycle).
     */
    lamp: (() => {
      const m = std('lamp', { roughness: 0.3 });
      m.emissiveNode = vertexColor().mul(lightU.lamps.mul(lightU.lamps).mul(5));
      return m;
    })(),
    /** Shield well ring: cyan, slowly pulsing. */
    shield: (() => {
      const m = std('shield', { color: 0x0a2a33, roughness: 0.3 });
      m.emissiveNode = color(0x46d8ff).mul(sin(time.mul(2.2)).mul(0.35).add(1.6)).mul(vertexColor());
      return m;
    })(),
    /** Faint additive light column over the shield well (v=0 bottom → fades out at the top). */
    beam: (() => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      m.name = 'beam';
      const fade = float(1).sub(uv().y);
      m.colorNode = color(0x46c8ff).mul(float(0.22).add(sin(time.mul(2.2)).mul(0.05))).mul(fade.mul(fade));
      return m;
    })(),
  };
}

/** Moss + damp grime creeping up the first ~30 cm of cast concrete from the quay deck (bunkers, kerbs). */
function mossyBase(m: THREE.MeshStandardNodeMaterial) {
  const h = positionWorld.y.sub(MAP.groundY);
  const n = worldNoise(0.9, 'g');
  const moss = float(1).sub(smoothstep(0.02, n.mul(0.35).add(0.08), h)).mul(step(-0.05, h)).mul(smoothstep(0.25, 0.6, worldNoise(0.35)).mul(0.6).add(0.4));
  m.colorNode = mix(m.colorNode as THREE.Node<'vec3'>, vec3(0.07, 0.1, 0.035).mul(n.mul(0.6).add(0.7)), moss.mul(0.85));
  m.roughnessNode = mix(m.roughnessNode as THREE.Node<'float'>, float(0.95), moss);
  return m;
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
