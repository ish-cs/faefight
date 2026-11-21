import * as THREE from 'three/webgpu';
import { atan, attribute, cameraPosition, float, floor, max, mod, normalize, positionLocal, PI2, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import { lodScale } from './lod';
import type { LodPart } from './chunked';

/**
 * Billboard impostors: a model is rendered once from `views` azimuths into a small atlas (lit by the same sun and
 * environment as the world: the sun never moves), then drawn far away as one camera-facing quad per instance that
 * picks the atlas view nearest the viewing angle. One draw per chunk instead of the model's parts × triangles.
 *
 * Baking is queued and done one model per frame (ImpostorBaker.step from World.render), so it spreads over the
 * loading/reveal frames instead of stalling the load. Until a model is baked its impostors draw nothing (the full
 * model level still shows near the camera).
 */

export type ImpostorAtlas = {
  texture: THREE.Texture | null;
  /** bounding sphere of the model in its local frame */
  center: THREE.Vector3;
  radius: number;
  views: number;
  /** cross-fade: impostors grow in between 85 % and 100 % of this distance (× lodScale); 0 = always full size */
  fadeIn: number;
  ready: boolean;
  material: THREE.MeshBasicNodeMaterial;
  onReady: (() => void)[];
};

type Job = { parts: LodPart[]; atlas: ImpostorAtlas; cell: number };

export const SUN_FOR_BAKE = { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(0xffe9cc), intensity: 6 };

/**
 * Impostor material: quad corners come in as `position.xy` (−1..1); per-instance `impCenter` (xyz world, w yaw) and
 * `impTint` (rgb, a = scale; 0 hides it). Cylindrical billboard (stays upright).
 */
function impostorMaterial(atlas: ImpostorAtlas): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.name = 'impostor';
  m.alphaTest = 0.5;
  const C = attribute('impCenter', 'vec4'), T = attribute('impTint', 'vec4');
  // grows in across the cross-fade band while the full model shrinks out (chunked.ts)
  const dist = C.xz.sub(cameraPosition.xz).length();
  const F = lodScale.mul(atlas.fadeIn);
  const scale = atlas.fadeIn > 0 ? T.w.mul(smoothstep(F.mul(0.85), F, dist)) : T.w;
  const R = uniform(atlas.radius), off = uniform(atlas.center);
  const center = C.xyz.add(off.mul(scale));
  const toCam = normalize(cameraPosition.xz.sub(center.xz).add(vec2(1e-5, 0)));
  const right = vec3(toCam.y, 0, toCam.x.negate());
  const q = positionLocal.xy;
  m.positionNode = center.add(right.mul(q.x.mul(R).mul(scale))).add(vec3(0, q.y.mul(R).mul(scale), 0));
  // atlas view: azimuth of the camera around the instance, in the model's frame
  const N = float(atlas.views);
  const az = mod(atan(toCam.x, toCam.y).sub(C.w).add(PI2.mul(4)), PI2);
  const cell = mod(floor(az.div(PI2).mul(N).add(0.5)), N);
  const u = q.x.mul(0.5).add(0.5), v = q.y.mul(0.5).add(0.5);
  const tex = texture(atlas.texture ?? new THREE.Texture(), vec2(cell.add(u).div(N), v));
  // the atlas is cleared to transparent black, so mip levels / filtering blend black into silhouette edges:
  // un-premultiply, or far impostors get dark halos
  m.colorNode = tex.rgb.div(max(tex.a, 0.02)).mul(T.rgb);
  m.opacityNode = tex.a;
  return m;
}

export class ImpostorBaker {
  private queue: Job[] = [];
  private rt: THREE.RenderTarget[] = [];
  baked = 0;

  /** Register a model for baking; returns its atlas (texture/material filled in when baked). */
  request(parts: LodPart[], views = 8, cell = 128, fadeIn = 0): ImpostorAtlas {
    const box = new THREE.Box3();
    for (const p of parts) { if (!p.geometry.boundingBox) p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox!); }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const atlas: ImpostorAtlas = { texture: null, center: sphere.center, radius: sphere.radius, views, fadeIn, ready: false, material: null!, onReady: [] };
    this.queue.push({ parts, atlas, cell });
    return atlas;
  }

  get pending() { return this.queue.length; }

  /** Bake at most one queued model (call once per frame). */
  step(gpu: THREE.WebGPURenderer, environment: THREE.Texture | null) {
    const job = this.queue.shift();
    if (!job) return;
    try {
      this.bake(gpu, environment, job);
    } catch (err) {
      console.error('[world/impostor] bake failed; far instances of this model will not draw', err);
    }
  }

  private bake(gpu: THREE.WebGPURenderer, environment: THREE.Texture | null, { parts, atlas, cell }: Job) {
    const N = atlas.views;
    const rt = new THREE.RenderTarget(cell * N, cell, { type: THREE.HalfFloatType });
    rt.texture.generateMipmaps = true;
    rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.rt.push(rt);
    const scene = new THREE.Scene();
    scene.environment = environment;
    scene.environmentIntensity = 0.8;
    const sun = new THREE.DirectionalLight(SUN_FOR_BAKE.color, SUN_FOR_BAKE.intensity);
    sun.position.copy(SUN_FOR_BAKE.dir);
    scene.add(sun, sun.target);
    for (const p of parts) scene.add(new THREE.Mesh(p.geometry, p.material));
    const R = atlas.radius, c = atlas.center;
    const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01, R * 4);
    const prev = { target: gpu.getRenderTarget(), autoClear: gpu.autoClear, clear: gpu.getClearColor(new THREE.Color()), alpha: gpu.getClearAlpha() };
    gpu.setRenderTarget(rt);
    gpu.setClearColor(0x000000, 0);
    gpu.clear();
    gpu.autoClear = false;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      cam.position.set(c.x + Math.sin(a) * R * 2, c.y, c.z + Math.cos(a) * R * 2);
      cam.lookAt(c);
      cam.updateMatrixWorld();
      rt.viewport.set(k * cell, 0, cell, cell); // render targets use their own viewport
      gpu.render(scene, cam);
    }
    rt.viewport.set(0, 0, cell * N, cell);
    gpu.setRenderTarget(prev.target);
    gpu.autoClear = prev.autoClear;
    gpu.setClearColor(prev.clear, prev.alpha);
    atlas.texture = rt.texture;
    atlas.material = impostorMaterial(atlas);
    atlas.ready = true;
    this.baked++;
    for (const f of atlas.onReady) f();
    atlas.onReady.length = 0;
  }
}

/** The world's impostor baker (World.render steps it). */
export const impostors = new ImpostorBaker();

/** Quad (−1..1 in x and y) for impostor instances. */
export function impostorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
