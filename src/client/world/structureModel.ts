import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Baked cast-concrete structures (scripts/blender/structures/build_structures.py), one shared atlas (`structure` PBR set):
 * - `bunker`: the visual mesh of an island bunker in its local frame (front = -Z, base at y = 0), the exact union of
 *   the sim's wall boxes (bunkerWallBoxes) plus the interior floor at +0.045. Collision stays the sim's boxes.
 * - `quay`: one flat module of the island rim (x along the wall, y below the deck, z outward), 8 segments of the
 *   128-gon rim; islands.ts bends it onto the circle (quayRingModule).
 * Loaded once before the world builds; if it can't load, islands.ts keeps the old boxes + quay cylinder.
 * `?nostructures` forces that (A/B).
 */
const URL = `${import.meta.env.BASE_URL}assets/models/structures.glb`;
export type StructureName = 'bunker' | 'quay';
let geos: Record<StructureName, THREE.BufferGeometry> | null = null;
export const structureStats = { ms: 0, ok: false };

function take(root: THREE.Object3D, name: string): THREE.BufferGeometry {
  const mesh = root.getObjectByName(name) as THREE.Mesh | undefined;
  if (!mesh?.isMesh) throw new Error(`${URL} has no mesh "${name}"`);
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv || !g.getAttribute('normal')) throw new Error(`${URL} "${name}" lacks uv/normal`);
  // glTF stores v flipped; the atlas is sampled like the other JPEG-only sets (flipped at decode)
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

/** Both meshes from a parsed glTF scene (also used by the unit test on the committed .glb). */
export function structuresFrom(root: THREE.Object3D): Record<StructureName, THREE.BufferGeometry> {
  return { bunker: take(root, 'bunker'), quay: take(root, 'quay') };
}

export async function preloadStructureModel() {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nostructures')) return;
  const t0 = performance.now();
  try {
    const gltf = await new GLTFLoader().loadAsync(URL);
    geos = structuresFrom(gltf.scene);
    Object.assign(structureStats, { ms: Math.round(performance.now() - t0), ok: true });
    console.info(`[world/structures] baked bunker + quay in ${structureStats.ms} ms`);
  } catch (err) {
    geos = null;
    console.error('[world/structures] baked structures failed to load: procedural fallback', err);
  }
}

/** The baked geometry (shared: clone or transform a copy before merging), or null (not loaded: use the old visuals). */
export function structureGeo(name: StructureName): THREE.BufferGeometry | null {
  return geos ? geos[name] : null;
}

/**
 * The quay module bent onto a rim of radius `R` (island frame before yaw, same angles as CircleGeometry(R, 128)
 * rotated flat: a point at angle θ sits at (R cos θ, −R sin θ)). Module x maps to θ = x / R around θ = 0, z to the
 * radius R + z; normals rotate with the angle. Place module k with a Y rotation of θ_k (its centre angle).
 */
export function bendQuayModule(flat: THREE.BufferGeometry, R: number, y0: number): THREE.BufferGeometry {
  const g = flat.clone();
  const p = g.getAttribute('position') as THREE.BufferAttribute, n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const th = p.getX(i) / R, c = Math.cos(th), s = Math.sin(th), r = R + p.getZ(i);
    p.setXYZ(i, r * c, y0 + p.getY(i), -r * s);
    // local x (along) → tangent (−sin, 0, −cos); local z (out) → (cos, 0, −sin)
    const nx = n.getX(i), nz = n.getZ(i);
    n.setXYZ(i, -nx * s + nz * c, n.getY(i), -nx * c - nz * s);
  }
  p.needsUpdate = n.needsUpdate = true;
  return g;
}
