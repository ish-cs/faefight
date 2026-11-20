import * as THREE from 'three/webgpu';
import { color, float, sin, time, uv, vertexColor } from 'three/tsl';
import { awningTex, chainTex, barkTex, burlapTex, concreteTex, corrNormal, corrTex, frondTex, leafBlobTex, seawallTex, steelTex, woodTex } from './textures';

type Opts = ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0];
const std = (name: string, o: Opts) => {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, ...o });
  m.name = name;
  return m;
};

let M: ReturnType<typeof make> | null = null;
function make() {
  return {
    concrete: std('concrete', { map: concreteTex(), roughness: 0.92 }),
    seawall: std('seawall', { map: seawallTex(), roughness: 0.9 }),
    dark: std('dark', { color: 0x222426, roughness: 0.55, metalness: 0.3 }),
    rubber: std('rubber', { color: 0x262624, roughness: 0.92 }),
    galv: std('galv', { color: 0xa4abb0, metalness: 0.85, roughness: 0.38 }),
    wood: std('wood', { map: woodTex(), roughness: 0.82 }),
    burlap: std('burlap', { map: burlapTex(), roughness: 0.97 }),
    steel: std('steel', { map: steelTex(), metalness: 0.75, roughness: 0.42 }),
    frond: std('frond', { map: frondTex(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 }),
    bark: std('bark', { map: barkTex(), roughness: 0.95 }),
    paint: std('paint', { roughness: 0.55, metalness: 0.25 }),
    matte: std('matte', { roughness: 0.9 }),
    corr: std('corr', { map: corrTex(), normalMap: corrNormal(), normalScale: new THREE.Vector2(1.1, 1.1), metalness: 0.45, roughness: 0.55 }),
    awning: std('awning', { map: awningTex(), roughness: 0.8, side: THREE.DoubleSide }),
    leaf: std('leaf', { map: leafBlobTex(), roughness: 0.95 }),
    terrain: std('terrain', { roughness: 1 }),
    glow: std('glow', { color: 0x0c2a10, emissive: 0x2bff5a, emissiveIntensity: 2.2, roughness: 0.4 }),
    chain: std('chain', { map: chainTex(), alphaTest: 0.4, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 }),
    /** Self-lit parts whose light colour is the vertex colour (gold bars, potions, lamp heads, LEDs). */
    lit: (() => {
      const m = std('lit', { roughness: 0.35 });
      m.emissiveNode = vertexColor().mul(1.6);
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
/** Shared static-world materials. All use vertex colours as a per-part tint (white = untinted). */
export function mats() {
  if (!M) M = make();
  return M;
}

/** Shipping-container palette (faded, realistic liveries). */
export const CONTAINER_COLORS = [0x9a3b2a, 0x1f4e79, 0x2f6b3a, 0xc8641e, 0xd6d4cc, 0x2a7f86, 0x7d2430, 0x46505a, 0x8a8f2e];
