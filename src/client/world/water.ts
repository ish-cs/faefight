import * as THREE from 'three/webgpu';
import {
  cameraPosition, color, cos, dot, float, max, min, mix, normalize, positionLocal, positionWorld, pow, reflect, sin, smoothstep, texture, time,
  transformNormalToView, uniform, vec2, vec3,
} from 'three/tsl';
import type { IslandLayout } from '../../sim/map';
import { noiseTex } from './pbr';
import { SUN_DIR } from './sky';

const NORMALS_URL = `${import.meta.env.BASE_URL}assets/textures/waternormals.jpg`;

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

/** Gerstner wave train: direction (deg), wavelength (m), amplitude (m), steepness 0..1. Sheltered-harbor chop. */
const WAVES: [number, number, number, number][] = [
  [20, 23, 0.11, 0.55],
  [-15, 14, 0.075, 0.6],
  [55, 9.5, 0.05, 0.65],
  [-50, 6.2, 0.03, 0.7],
  [80, 3.7, 0.015, 0.7],
];
const G = 9.81;

/** Sum of the wave train at world xz: displacement (dx, dy, dz) + analytic normal, faded by `amp` (0..1). */
function gerstner(p: V2, amp: F) {
  let dx: F = float(0), dy: F = float(0), dz: F = float(0), nx: F = float(0), ny: F = float(0), nz: F = float(0);
  for (const [deg, L, A, Q] of WAVES) {
    const a = THREE.MathUtils.degToRad(deg);
    const d = new THREE.Vector2(Math.cos(a), Math.sin(a));
    const k = (2 * Math.PI) / L, w = Math.sqrt(G * k);
    const f = dot(p, vec2(d.x, d.y)).mul(k).sub(time.mul(w));
    const c = cos(f), s = sin(f);
    const Aa = amp.mul(A);
    dx = dx.add(c.mul(Aa.mul(Q * d.x)));
    dz = dz.add(c.mul(Aa.mul(Q * d.y)));
    dy = dy.add(s.mul(Aa));
    nx = nx.add(c.mul(Aa.mul(k * d.x)));
    nz = nz.add(c.mul(Aa.mul(k * d.y)));
    ny = ny.add(s.mul(Aa.mul(Q * k)));
  }
  return { disp: vec3(dx, dy, dz), normal: normalize(vec3(nx.negate(), float(1).sub(ny), nz.negate())), height: dy };
}

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

export type Ocean = { mesh: THREE.Mesh; update(cam: THREE.Vector3, waterY: number): void };

/**
 * Ocean: Gerstner swell displaced on a camera-following polar grid, per-pixel analytic wave normals + three scrolling
 * samples of the three.js water normal map (MIT), fake depth colour from distance to the nearest quay (turquoise
 * shallows → deep blue), subsurface glow through crests when looking toward the sun, crest whitecaps, foam lines
 * breaking against the quay walls, and emissive sun glints that catch bloom. Opaque on purpose: a transparent
 * pass would blend against the sky and wash out.
 */
export function buildWater(map: IslandLayout[]): Ocean {
  const tex = new THREE.TextureLoader().load(NORMALS_URL, undefined, undefined, (err) => console.error(`[world/water] failed to load ${NORMALS_URL}`, err));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const origin = uniform(new THREE.Vector3());

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0 });
  mat.name = 'ocean';

  // vertex: displace by the swell, faded out with distance (the outer rings are too coarse to carry it)
  const wp = positionLocal.xz.add(origin.xz);
  const vAmp = float(1).sub(smoothstep(70, 160, positionLocal.xz.length()));
  mat.positionNode = positionLocal.add(gerstner(wp, vAmp).disp);

  // fragment
  const p = positionWorld.xz;
  const camDist = p.sub(cameraPosition.xz).length();
  const fAmp = float(1).sub(smoothstep(120, 600, camDist)).mul(0.85).add(0.15);
  const gw = gerstner(p, fAmp);
  const t = time;
  const s1 = texture(tex, p.mul(0.045).add(vec2(t.mul(0.011), t.mul(0.007)))).xyz;
  const s2 = texture(tex, p.mul(0.13).sub(vec2(t.mul(0.009), t.mul(-0.013)))).xyz;
  const s3 = texture(tex, p.mul(0.012).add(vec2(t.mul(-0.003), t.mul(0.004)))).xyz;
  const n = s1.add(s2).add(s3).mul(2 / 3).sub(1);
  const detail = float(0.32).mul(float(1).sub(smoothstep(60, 500, camDist)).mul(0.6).add(0.4));
  const nWorld = normalize(gw.normal.add(vec3(n.x.mul(detail), 0, n.y.mul(detail))));
  mat.normalNode = transformNormalToView(nWorld);

  // distance to the nearest island quay wall (stand-in for depth)
  const rim = map.map((isl) => p.sub(uniform(new THREE.Vector2(isl.center.x, isl.center.z))).length().sub(isl.radius));
  const near = max(rim.slice(1).reduce((a, b) => min(a, b), rim[0]), float(0));
  const shallow = color(0x0e8f88), mid = color(0x086c86), deep = color(0x043b5e);
  let base = mix(mix(shallow, mid, smoothstep(0, 10, near)), deep, smoothstep(8, 60, near));
  // troughs a touch darker, crests lighter
  const h = gw.height;
  base = base.mul(smoothstep(-0.25, 0.25, h).mul(0.3).add(0.85));

  // subsurface glow through thin crests, strongest looking toward the sun
  const view = normalize(positionWorld.sub(cameraPosition));
  const sunFlat = new THREE.Vector2(SUN_DIR.x, SUN_DIR.z).normalize();
  const toSun = max(dot(normalize(view.xz), vec2(sunFlat.x, sunFlat.y)), 0);
  const sss = smoothstep(0.02, 0.2, h).mul(toSun.pow(2).mul(0.8).add(0.2)).mul(fAmp);
  base = mix(base, color(0x22b8a4), sss.mul(0.5));

  // foam: whitecaps on the highest crests + lines breaking against the quays
  const nz = texture(noiseTex(), p.mul(0.09).add(vec2(t.mul(0.02), 0))).r;
  const fine = s2.x.add(s1.y).mul(0.5);
  const cap = smoothstep(0.17, 0.27, h.add(nz.sub(0.5).mul(0.12))).mul(smoothstep(0.35, 0.65, fine)).mul(0.75);
  const wallFoam = float(1).sub(smoothstep(0.1, 0.9, near.add(fine.mul(0.5))));
  const bands = smoothstep(0.55, 0.95, sin(near.mul(2.4).sub(t.mul(1.3)).add(nz.mul(5)))).mul(float(1).sub(smoothstep(0.4, 4.5, near))).mul(smoothstep(0.3, 0.7, fine));
  const foam = max(max(cap, wallFoam.mul(0.9)), bands.mul(0.55)).clamp(0, 1);
  mat.colorNode = mix(base, color(0xeef7f5), foam);
  mat.roughnessNode = mix(float(0.05), float(0.65), foam);

  // Sun glints: a very tight lobe around the sun's mirror direction written as emissive, so the sparkle on the wave
  // facets catches bloom (the regular GGX highlight stays as the broad sheen).
  const toEye = view.negate();
  const r = reflect(toEye.negate(), nWorld);
  const glint = pow(max(dot(r, uniform(SUN_DIR.clone())), 0), 1400).mul(float(1).sub(foam));
  mat.emissiveNode = color(0xfff0d8).mul(glint.mul(60));

  const mesh = new THREE.Mesh(oceanGeometry(), mat);
  mesh.name = 'ocean';
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return {
    mesh,
    update(cam, waterY) {
      mesh.position.set(Math.round(cam.x), waterY, Math.round(cam.z));
      origin.value.copy(mesh.position);
    },
  };
}
