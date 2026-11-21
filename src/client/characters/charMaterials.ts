import * as THREE from 'three/webgpu';
import {
  abs, attribute, cross, dFdx, dFdy, dot, faceDirection, float, fwidth, mix, normalGeometry, normalize, normalView, positionGeometry,
  positionView, sign, sin, smoothstep, step, texture, uniform, vec3,
} from 'three/tsl';
import { noiseTex } from '../world/pbr';
import { K } from './body';

/**
 * The one material every body uses (a few instances: one per team colour × detail tier, cached and shared by all
 * avatars). Procedural TSL surfaces chosen per vertex by `surf.x` (body.ts K): camo / plain fabric with a weave and
 * seams, skin with tone variation, stubble and a warm subsurface lift, worn leather, scuffed metal, polymer, hair,
 * glossy eyes. Dirt and wear build up toward the feet. Patterns live in bind-pose space (positionGeometry), so they
 * stick to the clothes while the skeleton moves.
 */

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

const lin = (hex: number) => new THREE.Color(hex);
/** Colours are uniforms, not constants: every team's material compiles to the same shader (one pipeline). */
const c3 = (c: THREE.Color) => uniform(c) as unknown as V3;

/** Triplanar sample of the shared tileable noise in bind-pose space (`scale` = tiles per metre). */
function tri(scale: number) {
  const p = positionGeometry.mul(scale);
  const w = abs(normalGeometry).pow(vec3(3, 3, 3));
  const ws = w.div(w.x.add(w.y).add(w.z));
  const t = noiseTex();
  return texture(t, p.zy).mul(ws.x).add(texture(t, p.xz).mul(ws.y)).add(texture(t, p.xy).mul(ws.z));
}

/** View-space normal perturbed by a procedural height (metres), Mikkelsen's surface-gradient bump. */
function bumpNormal(h: F): V3 {
  const dpdx = dFdx(positionView), dpdy = dFdy(positionView);
  const n = normalView;
  const r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  const det = dot(dpdx, r1).mul(faceDirection);
  const grad = sign(det).mul(r1.mul(dFdx(h)).add(r2.mul(dFdy(h))));
  return normalize(abs(det).mul(n).sub(grad)) as V3;
}

export type CamoPalette = { base: THREE.Color; dark: THREE.Color; light: THREE.Color; black: THREE.Color; team: THREE.Color };

/** Team-tinted woodland palette: stays clearly in the team's hue (readability) but reads as printed camo up close. */
export function camoPalette(team: number | null): CamoPalette {
  const t = lin(team ?? 0x6b6b58);
  const olive = lin(0x4f5236), khaki = lin(0x9a8a66);
  return {
    base: t.clone().lerp(olive, 0.38).multiplyScalar(0.6),
    dark: t.clone().lerp(olive, 0.5).multiplyScalar(0.4),
    light: t.clone().lerp(khaki, 0.45).multiplyScalar(0.72),
    black: t.clone().lerp(lin(0x2a2620), 0.75).multiplyScalar(0.8),
    team: t.clone().multiplyScalar(0.9),
  };
}

const cache = new Map<string, THREE.MeshStandardNodeMaterial>();

/**
 * Body material for a team colour (null = civilians: no camo tint, team kind falls back to vertex colour) at a
 * detail tier: 'full' (procedural detail, bump) or 'far' (flat per-kind colours, no textures but one noise fetch).
 * `dirt` = 0 turns off the ground-up grime (first-person hands, which have no feet).
 */
export function bodyMaterial(team: number | null, tier: 'full' | 'far' = 'full', dirt = 1): THREE.MeshStandardNodeMaterial {
  const key = `${team ?? 'civ'}:${tier}:${dirt}`;
  let m = cache.get(key);
  if (m) return m;
  m = tier === 'full' ? fullMaterial(team, dirt) : farMaterial(team);
  m.name = `body:${key}`;
  cache.set(key, m);
  return m;
}

/** Materials created so far (tests: sharing). */
export function bodyMaterialCount() { return cache.size; }

const surf = attribute('surf', 'vec2');
const kind = surf.x;
const is = (k: number) => float(1).sub(step(0.5, abs(kind.sub(k))));

function fullMaterial(team: number | null, dirtAmt: number) {
  const m = new THREE.MeshStandardNodeMaterial();
  const vc = attribute('color', 'vec3') as V3;
  const pal = camoPalette(team);
  const P = positionGeometry;
  const nA = tri(2.6), nB = tri(5.5), nC = tri(11);

  // --- camo (woodland blobs at three sizes)
  let camo = mix(c3(pal.base), c3(pal.dark), smoothstep(0.5, 0.53, nA.x)) as V3;
  camo = mix(camo, c3(pal.light), smoothstep(0.6, 0.63, nA.y)) as V3;
  camo = mix(camo, c3(pal.black), smoothstep(0.68, 0.71, nB.x)) as V3;
  // --- weave: a fine plain weave, faded out before it can alias
  const a = P.x.add(P.z).mul(1300), b = P.y.mul(1300);
  const weave = sin(a).mul(sin(b));
  const fade = float(1).sub(smoothstep(0.7, 2.2, fwidth(a).add(fwidth(b))));
  const seam = surf.y;
  const fabricK = is(K.camo).add(is(K.cloth)).add(is(K.team));
  const fabricShade = float(1).add(weave.mul(0.025).mul(fade)).sub(seam.mul(0.32)).mul(float(0.94).add(nC.x.mul(0.12)));
  const stitch = step(0.55, sin(P.x.add(P.y).add(P.z).mul(900))).mul(seam).mul(0.18);

  // --- skin: tone variation, a touch of redness, stubble from surf.y
  const skinTone = vc.mul(float(0.8).add(nB.y.mul(0.14))).mul(mix(vec3(1, 1, 1), vec3(1.07, 0.93, 0.9), smoothstep(0.4, 0.7, nA.y)));
  const skin = mix(skinTone, vc.mul(0.42).add(vec3(0.012, 0.01, 0.009)), seam.mul(float(0.55).add(nC.y.mul(0.45))));
  // --- leather: grain + lighter scuffs
  const scuff = smoothstep(0.6, 0.72, nB.y);
  const leather = mix(vc.mul(float(0.85).add(nC.x.mul(0.3))), vc.mul(1.7).add(vec3(0.03, 0.025, 0.02)), scuff.mul(0.55));
  // --- metal: gunmetal with bright worn edges where the noise peaks
  const wear = smoothstep(0.66, 0.74, nC.y);
  const metal = mix(vc.mul(float(0.9).add(nB.x.mul(0.2))), vec3(0.42, 0.42, 0.43), wear);
  const hair = vc.mul(float(0.75).add(nC.y.mul(0.5)));

  let col = vc.mul(fabricShade) as V3; // cloth
  col = mix(col, camo.mul(fabricShade), is(K.camo)) as V3;
  const civ = uniform(team === null ? 1 : 0); // civilians: "team" parts keep their vertex colour
  col = mix(col, mix(c3(pal.team), vc, civ).mul(fabricShade), is(K.team)) as V3;
  col = col.add(stitch.mul(fabricK)) as V3;
  col = mix(col, skin, is(K.skin)) as V3;
  col = mix(col, leather, is(K.leather)) as V3;
  col = mix(col, metal, is(K.metal)) as V3;
  col = mix(col, vc.mul(float(0.94).add(nB.x.mul(0.12))), is(K.polymer)) as V3;
  col = mix(col, hair, is(K.hair)) as V3;
  col = mix(col, vc, is(K.eye).add(is(K.glint)).add(is(K.hivis))) as V3;
  // dirt toward the feet (and a little everywhere on fabric/leather), not on eyes/metal
  const dirtable = float(1).sub(is(K.eye)).sub(is(K.glint)).sub(is(K.metal).mul(0.5));
  const dirtK = float(1).sub(smoothstep(0.06, 0.7, P.y)).mul(float(0.35).add(nA.y.mul(0.65))).mul(uniform(0.75 * dirtAmt)).mul(dirtable);
  col = mix(col, vec3(0.16, 0.12, 0.08), dirtK.mul(0.6)) as V3;
  m.colorNode = col;

  let rough = float(0.86) as F; // fabric
  rough = mix(rough, float(0.6).add(nB.x.mul(0.12)), is(K.skin)) as F;
  rough = mix(rough, float(0.55).add(scuff.mul(0.25)).add(nC.x.mul(0.1)), is(K.leather)) as F;
  rough = mix(rough, float(0.34).add(nB.y.mul(0.2)).sub(wear.mul(0.12)), is(K.metal)) as F;
  rough = mix(rough, float(0.62).add(nB.x.mul(0.12)), is(K.polymer)) as F;
  rough = mix(rough, float(0.7), is(K.hair)) as F;
  rough = mix(rough, float(0.06), is(K.eye).add(is(K.glint))) as F;
  rough = mix(rough, float(0.32), is(K.hivis)) as F;
  m.roughnessNode = rough.add(dirtK.mul(0.15)).min(1);
  m.metalnessNode = is(K.metal).mul(float(0.75).add(wear.mul(0.25))).add(is(K.hivis).mul(0.45));
  // warm subsurface lift on skin, the eye glint, retro-reflective tape catching light
  m.emissiveNode = skin.mul(vec3(0.5, 0.16, 0.1)).mul(0.03).mul(is(K.skin))
    .add(vec3(1.6, 1.6, 1.6).mul(is(K.glint)))
    .add(vc.mul(0.12).mul(is(K.hivis)));

  // micro relief: weave + seams on fabric, grain on leather, pores on skin
  const h = weave.mul(0.00022).mul(fade).mul(fabricK)
    .sub(seam.mul(0.0007).mul(fabricK))
    .add(nC.x.mul(0.0012).mul(is(K.leather).add(is(K.polymer).mul(0.4))))
    .add(nC.y.mul(0.0004).mul(is(K.skin)));
  m.normalNode = bumpNormal(h as F);
  return m;
}

function farMaterial(team: number | null) {
  const m = new THREE.MeshStandardNodeMaterial();
  const vc = attribute('color', 'vec3') as V3;
  const pal = camoPalette(team);
  const P = positionGeometry;
  const n = texture(noiseTex(), P.xy.mul(1.35).add(P.z.mul(0.7)));
  const camo = mix(c3(pal.base), c3(pal.dark), smoothstep(0.52, 0.56, n.x));
  let col = mix(vc, camo, is(K.camo)) as V3;
  col = mix(col, mix(c3(pal.team), vc, uniform(team === null ? 1 : 0)), is(K.team)) as V3;
  col = mix(col, vc.mul(0.45), surf.y.mul(is(K.skin)).mul(0.5)) as V3;
  m.colorNode = col;
  m.roughnessNode = mix(mix(float(0.85), float(0.55), is(K.skin)), float(0.4), is(K.metal).add(is(K.eye)));
  m.metalnessNode = is(K.metal).mul(0.7);
  return m;
}
