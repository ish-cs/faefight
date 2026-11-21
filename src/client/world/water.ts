import * as THREE from 'three/webgpu';
import {
  abs, cameraPosition, color, cos, dot, exp, float, max, min, mix, normalize, positionGeometry, positionLocal, positionWorld, pow,
  reflect, sign, sin, smoothstep, sqrt, texture, transformNormalToView, uniform, uniformArray, varying, vec2, vec3,
} from 'three/tsl';
import type { MapDef } from '../../sim/map';
import type { PieceState } from '../../sim/types';
import { noiseTex } from './pbr';
import { SUN_DIR } from './sky';
import { seaState, setWaveField, stepWaves, TRAINS, waveSum, type WaveOps, waveTime } from './waves';

const NORMALS_URL = `${import.meta.env.BASE_URL}assets/textures/waternormals.jpg`;

type F = THREE.Node<'float'>;

/** TSL backend for the shared wave sum (waves.ts): the shader evaluates exactly what `waveHeight` does on the CPU. */
const TSL: WaveOps<F> = {
  c: (n) => float(n),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  sin: (a) => sin(a),
  cos: (a) => cos(a),
  smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
  sqrt: (a) => sqrt(a),
};

/** Backdrop quay channel (islands.ts CHANNEL) and the harbor beach (decor.ts BACKDROP_DECOR.beaches, detail.ts buildBeach). */
const CHANNEL = 14;
/** Wake slots: scaffold bridges over open water nearest the camera. */
const WAKES = 6;

/** Polar grid centred on the camera: 1 m rings out to 60 m, then geometric rings to the horizon. */
function oceanGeometry(): THREE.BufferGeometry {
  const radii: number[] = [0];
  for (let r = 1; r <= 60; r += 1) radii.push(r);
  while (radii[radii.length - 1] < 3200) radii.push(radii[radii.length - 1] * 1.085);
  const SEG = 192;
  const pos: number[] = [], idx: number[] = [];
  for (const r of radii) for (let k = 0; k <= SEG; k++) {
    const a = (k / SEG) * Math.PI * 2;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  for (let i = 0; i < radii.length - 1; i++) for (let k = 0; k < SEG; k++) {
    const a = i * (SEG + 1) + k, b = a + SEG + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export type Ocean = {
  mesh: THREE.Mesh;
  update(cam: THREE.Vector3, waterY: number, dt: number): void;
  /** Scaffold pieces (bridges): the ones over open water near the camera get ripples + foam underneath. */
  syncPieces(pieces: PieceState[], cam: THREE.Vector3): void;
};

/**
 * Ocean: the shared Gerstner sum (waves.ts) displaced on a camera-following polar grid; long swell out at sea,
 * short chop inside the harbor ring. Per-vertex: displacement, analytic normal, crest pinch (the wave sum runs
 * once per vertex, not per pixel). Per-pixel: three scrolling samples of the three.js water normal map (MIT),
 * absorption colour by distance to the nearest quay and by exposure (turquoise shallows → deep open-sea blue),
 * subsurface glow through thin crests toward the sun, whitecaps on pinched crests, wave-driven lapping foam at the
 * island quays / backdrop quay walls / harbor beach, ripples + foam under scaffold bridges, Fresnel env reflection
 * (scene environment) and emissive sun glints that catch bloom. Opaque: a transparent pass would blend against
 * the sky and wash out.
 */
export function buildWater(def: MapDef): Ocean {
  const tex = new THREE.TextureLoader().load(NORMALS_URL, undefined, undefined, (err) => console.error(`[world/water] failed to load ${NORMALS_URL}`, err));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const origin = uniform(new THREE.Vector3());
  const uTime = uniform(0);
  const uSea = uniform(0);

  // harbor field: calm inside the ring of backdrop quays, open sea beyond
  const isl = def.islands;
  const cx = isl.reduce((a, b) => a + b.center.x, 0) / isl.length, cz = isl.reduce((a, b) => a + b.center.z, 0) / isl.length;
  const r0 = Math.max(...isl.map((i) => Math.hypot(i.center.x - cx, i.center.z - cz) + i.radius + CHANNEL));
  setWaveField({ cx, cz, r0, r1: r0 + 70 });
  const fieldU = { cx: uniform(cx), cz: uniform(cz), r0, r1: r0 + 70 };

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0 });
  mat.name = 'ocean';

  // ---- vertex: the wave sum at the rest position, faded out with distance (outer rings are too coarse for it)
  const rx = positionGeometry.x.add(origin.x), rz = positionGeometry.z.add(origin.z);
  // per-train LOD: a train fades out where the camera-centred rings get too coarse for it (spacing ≈ 0.085 r past
  // 60 m), so long swell carries on to ~3 wavelengths out while short chop stops at 60–90 m
  const ringR = positionGeometry.xz.length();
  const vFade = (L: number) => float(1).sub(smoothstep(Math.max(60, 2.2 * L), Math.max(90, 3.2 * L), ringR));
  const expo = (x: F, z: F) => {
    const ex = x.sub(fieldU.cx), ez = z.sub(fieldU.cz);
    const e = smoothstep(fieldU.r0, fieldU.r1, sqrt(ex.mul(ex).add(ez.mul(ez))));
    return e.add(float(1).sub(e).mul(uSea.mul(0.5)));
  };
  const vExp = expo(rx, rz);
  const ws = waveSum(TSL, rx, rz, uTime, vExp, uSea, float(1), TRAINS, vFade);
  mat.positionNode = positionLocal.add(vec3(ws.dx, ws.dy, ws.dz));
  const vNormal = varying(vec3(ws.nx, ws.ny, ws.nz), 'vWaveN');
  const vHeight = varying(ws.dy, 'vWaveH');
  const vPinch = varying(ws.pinch, 'vWaveP');
  const vExposure = varying(vExp, 'vWaveE');

  // ---- fragment
  const p = positionWorld.xz;
  const camDist = p.sub(cameraPosition.xz).length();
  const t = uTime;
  const s1 = texture(tex, p.mul(0.045).add(vec2(t.mul(0.011), t.mul(0.007)))).xyz;
  const s2 = texture(tex, p.mul(0.13).sub(vec2(t.mul(0.009), t.mul(-0.013)))).xyz;
  const s3 = texture(tex, p.mul(0.012).add(vec2(t.mul(-0.003), t.mul(0.004)))).xyz;
  const n = s1.add(s2).add(s3).mul(2 / 3).sub(1);
  // texture detail: stronger out at sea / in a storm, softer far away (the far swell is mostly texture by then)
  const detail = float(0.3).mul(float(1).sub(smoothstep(60, 500, camDist)).mul(0.55).add(0.45)).mul(vExposure.mul(0.5).add(0.8));

  // distance to the nearest quay wall: island + center discs, and each backdrop quay front (harbor beach set back)
  const discs = [...def.islands, def.center];
  let near: F = discs.map((d) => p.sub(uniform(new THREE.Vector2(d.center.x, d.center.z))).length().sub(d.radius) as F).reduce((a, b) => min(a, b));
  const n8 = isl.length, harbor = def.template === 'harbor';
  for (const i of isl) {
    // island frame: back = (sin yaw, cos yaw), side = (cos yaw, -sin yaw) (grass.ts islandToWorld)
    const y = i.bunker.facingYaw, sy = Math.sin(y), cy = Math.cos(y);
    const ring = Math.hypot(i.center.x, i.center.z), z0 = i.radius + CHANNEL;
    const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n8) - 8));
    const rel = p.sub(vec2(i.center.x, i.center.z));
    const zl = dot(rel, vec2(sy, cy)), xl = dot(rel, vec2(cy, -sy));
    // beach: the waterline sits ~4.1 m in front of the wall across x ∈ [0.58, 0.98]·hw
    const beach = harbor ? smoothstep(0.58 * hw, 0.58 * hw + 2.5, xl).mul(float(1).sub(smoothstep(0.98 * hw - 2.5, 0.98 * hw, xl))).mul(4.1) : float(0);
    const front = float(z0).sub(beach).sub(zl);
    const side = abs(xl).sub(hw);
    // half-plane box SDF: the wall face is front = 0 for |x| < hw
    near = min(near, vec2(max(side, 0), max(front, 0)).length().add(min(max(side, front), 0)));
  }
  near = max(near, float(0));

  // absorption colour: turquoise against the walls, harbor green-blue, deep open-sea blue
  const shallow = color(0x0e8f88), mid = color(0x086c86), deep = color(0x043b5e), ocean = color(0x03304f);
  let base = mix(mix(shallow, mid, smoothstep(0, 10, near)), deep, smoothstep(8, 60, near));
  base = mix(base, ocean, smoothstep(0.3, 1, vExposure));
  const h = vHeight;
  const amp = vExposure.mul(0.55).add(0.25).mul(uSea.mul(0.9).add(1)); // rough crest scale (m) for the colour ramps
  base = base.mul(smoothstep(amp.negate(), amp, h).mul(0.3).add(0.85));

  // ripples under scaffold bridges (6 slots: x, z, rotY, strength)
  const wakes = uniformArray(Array.from({ length: WAKES }, () => new THREE.Vector4()), 'vec4');
  let wakeH: F = float(0), wakeGx: F = float(0), wakeGz: F = float(0), wakeFoam: F = float(0);
  for (let k = 0; k < WAKES; k++) {
    const wv = wakes.element(k) as unknown as THREE.Node<'vec4'>;
    const rel = p.sub(wv.xy), cr = cos(wv.z), sr = sin(wv.z);
    const lx = rel.x.mul(cr).sub(rel.y.mul(sr)), lz = rel.x.mul(sr).add(rel.y.mul(cr));
    // distance outside the 2 × 4 m deck footprint
    const ox = max(abs(lx).sub(1), 0), oz = max(abs(lz).sub(2), 0);
    const d = sqrt(ox.mul(ox).add(oz.mul(oz)).add(1e-4));
    const env = exp(d.mul(-0.45)).mul(wv.w);
    const ph = d.mul(6.5).sub(t.mul(3.4));
    wakeH = wakeH.add(sin(ph).mul(env));
    // gradient of the ring ripple, pointing away from the deck
    const g = cos(ph).mul(env).mul(0.22);
    wakeGx = wakeGx.add(g.mul(ox.mul(sign(lx))).div(d).mul(cr).add(g.mul(oz.mul(sign(lz))).div(d).mul(sr)));
    wakeGz = wakeGz.add(g.mul(oz.mul(sign(lz))).div(d).mul(cr).sub(g.mul(ox.mul(sign(lx))).div(d).mul(sr)));
    // churned foam right under the deck edges
    wakeFoam = wakeFoam.add(float(1).sub(smoothstep(0, 1.6, d)).mul(wv.w));
  }

  const farK = smoothstep(90, 170, camDist);
  const far = waveSum(TSL, p.x, p.y, uTime, vExposure, uSea, farK.mul(0.7), TRAINS.slice(0, 2));
  const nWorld = normalize(normalize(vNormal).add(vec3(far.nx, far.ny.sub(1), far.nz)).add(vec3(n.x.mul(detail).sub(wakeGx), 0, n.y.mul(detail).sub(wakeGz))));
  mat.normalNode = transformNormalToView(nWorld);

  // subsurface glow through thin crests, strongest looking toward the sun
  const view = normalize(positionWorld.sub(cameraPosition));
  const sunFlat = new THREE.Vector2(SUN_DIR.x, SUN_DIR.z).normalize();
  const toSun = max(dot(normalize(view.xz), vec2(sunFlat.x, sunFlat.y)), 0);
  const sss = smoothstep(amp.mul(0.1), amp.mul(0.8), h).mul(toSun.pow(2).mul(0.8).add(0.2)).mul(vExposure.mul(0.4).add(0.6));
  base = mix(base, color(0x22c0aa), sss.mul(0.55));

  // foam: whitecaps on pinched crests, lapping at the walls (surges with the local wave), bands rolling in, wakes
  const nz = texture(noiseTex(), p.mul(0.09).add(vec2(t.mul(0.02), 0))).r;
  const fine = s2.x.add(s1.y).mul(0.5);
  const cap = smoothstep(0.24, 0.42, vPinch.add(nz.sub(0.5).mul(0.16))).mul(smoothstep(0.35, 0.65, fine)).mul(smoothstep(0, 0.4, h));
  // Shoreline foam: a thin lacy line hugging the wall (0.25 m + the surge of the local wave), torn into patches by
  // two drifting noise octaves, with a few thinner lines rolling in and fading out within ~3 m.
  const lace = texture(noiseTex(), p.mul(0.55).add(vec2(t.mul(0.05), t.mul(-0.035)))).r
    .mul(texture(noiseTex(), p.mul(1.7).sub(vec2(t.mul(0.08), t.mul(0.06)))).g.add(0.35)).clamp(0, 1);
  const surge = max(h, 0).mul(0.9).add(sin(t.mul(1.1).add(nz.mul(4))).mul(0.08));
  const wallFoam = float(1).sub(smoothstep(0.05, 0.35, near.sub(surge).add(fine.mul(0.15)))).mul(smoothstep(0.25, 0.55, lace));
  const bands = smoothstep(0.82, 0.97, sin(near.mul(3.1).sub(t.mul(1.3)).add(nz.mul(5))))
    .mul(float(1).sub(smoothstep(0.3, 3, near))).mul(smoothstep(0.45, 0.7, lace));
  const wake = min(wakeFoam, 1).mul(smoothstep(0.4, 0.75, fine.add(wakeH.mul(0.1))));
  const foam = max(max(cap.mul(0.8), wallFoam.mul(0.85)), max(bands.mul(0.4), wake.mul(0.6))).clamp(0, 1);
  mat.colorNode = mix(base, color(0xdfeae8), foam);
  // Roughness by wave slope + distance (the normal detail the texture can't resolve far away becomes roughness),
  // so the sun's GGX highlight is a broken-up streak of sparkle, not a mirror-flat blown-out blob.
  const slope = float(1).sub(normalize(vNormal).y).mul(8).clamp(0, 1);
  const waterRough = float(0.1).add(slope.mul(0.06)).add(smoothstep(20, 400, camDist).mul(0.12)).add(vExposure.mul(0.03));
  mat.roughnessNode = mix(waterRough, float(0.7), foam);

  // Sun glints: tiny clamped sparkles on the facets that face the sun (emissive, so they catch bloom), gated by
  // the fine normal texture so they twinkle instead of merging into one disc.
  const r = reflect(view, nWorld);
  const sparkle = smoothstep(0.62, 0.8, fine);
  const glint = pow(max(dot(r, uniform(SUN_DIR.clone())), 0), 2200).mul(sparkle).mul(float(1).sub(foam));
  mat.emissiveNode = color(0xfff0d8).mul(min(glint.mul(14), 3));

  const mesh = new THREE.Mesh(oceanGeometry(), mat);
  mesh.name = 'ocean';
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const onIsland = (x: number, z: number) => discs.some((d) => Math.hypot(x - d.center.x, z - d.center.z) < d.radius + 0.5);
  const cand: { x: number; z: number; r: number; d: number }[] = [];
  return {
    mesh,
    update(cam, waterY, dt) {
      mesh.position.set(Math.round(cam.x), waterY, Math.round(cam.z));
      origin.value.copy(mesh.position);
      stepWaves(performance.now() / 1000, dt);
      uTime.value = waveTime();
      uSea.value = seaState().current;
    },
    syncPieces(pieces, cam) {
      cand.length = 0;
      for (const pc of pieces) {
        if (pc.kind !== 'scaffold' || onIsland(pc.pos.x, pc.pos.z)) continue;
        const d = Math.hypot(pc.pos.x - cam.x, pc.pos.z - cam.z);
        if (d < 80) cand.push({ x: pc.pos.x, z: pc.pos.z, r: pc.rotY, d });
      }
      cand.sort((a, b) => a.d - b.d);
      const arr = wakes.array as THREE.Vector4[];
      for (let k = 0; k < WAKES; k++) {
        const c = cand[k];
        if (c) arr[k].set(c.x, c.z, c.r, 1 - Math.min(1, Math.max(0, (c.d - 60) / 20)));
        else arr[k].set(0, 0, 0, 0);
      }
    },
  };
}
