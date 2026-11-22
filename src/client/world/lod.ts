import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, float, positionLocal, smoothstep, uniform } from 'three/tsl';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { LOD_QUALITY_SCALE, type QualityName, selectLod } from './lodMath';

/**
 * Engine-level LOD + distance culling. Anything that wants levels of detail registers a `LodTarget` with the
 * shared `lods` manager; World.render calls `lods.update(camera)` once per frame. Distances given at
 * registration are "high preset" metres: the manager scales them by the preset (LOD_QUALITY_SCALE) and by the
 * frame-time governor's bias, with hysteresis between levels (lodMath.selectLod). See docs/perf.md.
 */

/** Small shadow casters live on this layer: they cast into the near cascades only (sky.ts sets the far masks). */
export const SMALL_CASTER_LAYER = 4;
/** Tiny moving casters (gameplay props, debris): drawn by the camera, cast into the first shadow cascade only. */
export const TINY_CASTER_LAYER = 5;
/**
 * Shadow-only casters (never drawn by the camera) for the first shadow cascade: one merged shadow batch can
 * stand in for several camera meshes (gameProps.ts: one shadow draw for every prop material).
 */
export const SHADOW_ONLY_FIRST_LAYER = 6;
/**
 * Materials whose static parts never cast shadows (StaticBatch.add drops `cast`): self-lit panels, LEDs and lamp
 * lenses sit on or inside other surfaces, so their shadow is invisible but each is one more draw per cascade.
 */
export const NO_SHADOW = new WeakSet<THREE.Material>();

export interface LodTarget {
  /** Re-pick levels for a camera at `cam`; `scale` multiplies every registered distance. */
  updateLod(cam: THREE.Vector3, scale: number): void;
  /** Frames between refreshes (default 1); far, static things can use 2–4 to spread the cost. */
  readonly lodEvery?: number;
}

/** The manager's current distance scale, for shaders (updated every frame). */
export const lodScale = uniform(1);

export class LodManager {
  private targets: LodTarget[] = [];
  private frame = 0;
  private quality: QualityName = 'high';
  /** Frame-time governor's multiplier on every LOD distance (1 = full, lower = coarser sooner). */
  bias = 1;
  /** Whole-scene force (debug): -1 = off, else every LodObject shows this level. */
  force = -1;

  register<T extends LodTarget>(t: T): T {
    this.targets.push(t);
    return t;
  }

  unregister(t: LodTarget) {
    const i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
  }

  setQuality(q: QualityName) { this.quality = q; }

  get scale(): number { return LOD_QUALITY_SCALE[this.quality] * this.bias; }

  update(cam: THREE.Vector3) {
    const s = this.scale;
    lodScale.value = s;
    this.frame++;
    const ts = this.targets;
    for (let i = 0; i < ts.length; i++) {
      const every = ts[i].lodEvery ?? 1;
      if (every > 1 && (this.frame + i) % every !== 0) continue; // staggered: spread over frames
      ts[i].updateLod(cam, s);
    }
  }

  get count() { return this.targets.length; }
}

/** The world's LOD manager (one per page; content modules register here directly). */
export const lods = new LodManager();

const _c = new THREE.Vector3();

/**
 * One object with discrete levels: `levels[i]` shows between thresholds[i-1] and thresholds[i] metres (null =
 * nothing, i.e. culled). Distance is from the camera to the object's bounding sphere surface.
 */
export class LodObject implements LodTarget {
  current = -1;
  readonly lodEvery: number;
  constructor(
    readonly levels: (THREE.Object3D | null)[],
    readonly thresholds: number[],
    readonly center: THREE.Vector3,
    readonly radius: number,
    every = 1,
  ) {
    if (levels.length !== thresholds.length + 1) throw new Error(`[world/lod] ${levels.length} levels need ${levels.length - 1} thresholds, got ${thresholds.length}`);
    this.lodEvery = every;
  }

  updateLod(cam: THREE.Vector3, scale: number) {
    const d = Math.max(0, cam.distanceTo(this.center) - this.radius);
    const l = lods.force >= 0 ? Math.min(lods.force, this.levels.length - 1) : selectLod(d, this.thresholds, this.current, scale);
    if (l === this.current) return;
    this.current = l;
    this.levels.forEach((o, i) => { if (o) o.visible = i === l; });
  }
}

/**
 * Register LOD for objects already in the scene. `levels` share one centre; pass the full-detail object first.
 * Example: registerLod([palmFull, palmLow, null], [35, 120]) → full < 35 m, low < 120 m, culled beyond.
 */
export function registerLod(levels: (THREE.Object3D | null)[], thresholds: number[], opts: { center?: THREE.Vector3; radius?: number; every?: number } = {}): LodObject {
  let center = opts.center, radius = opts.radius;
  if (!center || radius === undefined) {
    const box = new THREE.Box3();
    for (const o of levels) if (o) box.expandByObject(o);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    center ??= sphere.center;
    radius ??= sphere.radius;
  }
  // a passed-in centre is kept by reference (e.g. an object's live .position)
  return lods.register(new LodObject(levels, thresholds, opts.center ? center : center.clone(), radius, opts.every));
}

/** Distance-only cull: `obj` hidden beyond `far` metres (preset/bias scaled, with hysteresis). */
export function registerDistanceCull(obj: THREE.Object3D, far: number, opts: { center?: THREE.Vector3; radius?: number; every?: number } = {}): LodObject {
  return registerLod([obj, null], [far], { every: 2, ...opts });
}

const simplifier = new SimplifyModifier();

/**
 * Auto-generated low level: three's SimplifyModifier (meshoptimizer, async) down to `ratio` of the vertices.
 * Resolves to the input geometry on failure (logged), so callers can swap it in blindly.
 */
export async function simplifyGeometry(geo: THREE.BufferGeometry, ratio: number): Promise<THREE.BufferGeometry> {
  try {
    const n = geo.getAttribute('position').count;
    const remove = Math.floor(n * (1 - Math.min(1, Math.max(0.05, ratio))));
    if (remove <= 0) return geo;
    const out = await simplifier.modify(geo, remove);
    if (!out.getAttribute('position')?.count || !out.index?.count) throw new Error('empty result');
    if (!out.getAttribute('normal')) out.computeVertexNormals();
    return out;
  } catch (err) {
    console.warn('[world/lod] simplify failed, keeping full geometry', err);
    return geo;
  }
}

/** Sphere centre of a geometry after `m` (scratch vector: copy it). */
export function centerOf(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null): THREE.Vector3 {
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  _c.copy(geo.boundingSphere!.center);
  return m ? _c.applyMatrix4(m) : _c;
}


/** Unregister every LodObject stored as `userData.lod` under `root` (map teardown). */
export function releaseLods(root: THREE.Object3D) {
  root.traverse((o) => {
    const t = o.userData.lod as LodTarget | undefined;
    if (t) { lods.unregister(t); delete o.userData.lod; }
  });
}

const shrunk = new Map<string, THREE.Material>();

/**
 * Distance fade for merged static chunks: a clone of `base` whose vertices shrink toward their part's centre
 * (`pc` attribute, geo.ts part()) between 70 % and 100 % of `far` × lodScale, so a chunk's parts dwindle away
 * before the CPU hides the chunk at `far`: no pop. Cached per (material, far): one extra pipeline per material.
 */
export function shrinkMaterial(base: THREE.Material, far: number, opts: { attr?: string; from?: number } = {}): THREE.Material {
  const attr = opts.attr ?? 'pc', from = opts.from ?? 0.7;
  const key = `${base.uuid}:${far}:${attr}:${from}`;
  let m = shrunk.get(key);
  if (m) return m;
  const n = base.clone() as THREE.NodeMaterial;
  n.name = `${base.name}~far`;
  // `attr` holds the part/instance centre in world space (instancing is applied before positionNode)
  const pc = attribute(attr, 'vec3');
  const d = pc.xz.sub(cameraPosition.xz).length();
  const f = lodScale.mul(far);
  const keep = float(1).sub(smoothstep(f.mul(from), f, d));
  const p = ((base as THREE.NodeMaterial).positionNode ?? positionLocal) as THREE.Node<'vec3'>;
  n.positionNode = pc.add(p.sub(pc).mul(keep));
  shrunk.set(key, n);
  return n;
}
