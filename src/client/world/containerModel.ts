import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Baked 20 ft shipping container (scripts/blender/container/build_container.py): LOD0 (shell + frame + locking bars,
 * ~170 tris) and LOD1 (outer box, 10 tris) sharing one UV atlas, textured by the `container` PBR set (albedo / normal /
 * ARM with baked AO). Loaded once before the world builds; props.ts merges them into the static batches like any part.
 * If the model can't load, props.ts falls back to the old procedural boxes. `?nocontainer` forces that (A/B).
 */
const URL = `${import.meta.env.BASE_URL}assets/models/container.glb`;
let lods: [THREE.BufferGeometry, THREE.BufferGeometry] | null = null;
export const containerStats = { ms: 0, ok: false };

/** Geometry in the props' frame: base at the origin, long axis X, doors at +X (glTF: Blender X, Z-up → Y-up). */
function take(root: THREE.Object3D, name: string): THREE.BufferGeometry {
  const mesh = root.getObjectByName(name) as THREE.Mesh | undefined;
  if (!mesh?.isMesh) throw new Error(`${URL} has no mesh "${name}"`);
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv || !g.getAttribute('normal')) throw new Error(`${URL} "${name}" lacks uv/normal`);
  // glTF stores v flipped; the atlas is sampled like the other PBR sets (flipY textures, Blender's v-up convention)
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

/** Both LODs from a parsed glTF scene (also used by the unit test on the committed .glb). */
export function containerLodsFrom(root: THREE.Object3D): [THREE.BufferGeometry, THREE.BufferGeometry] {
  return [take(root, 'container_lod0'), take(root, 'container_lod1')];
}

export async function preloadContainerModel() {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocontainer')) return;
  const t0 = performance.now();
  try {
    const gltf = await new GLTFLoader().loadAsync(URL);
    lods = containerLodsFrom(gltf.scene);
    Object.assign(containerStats, { ms: Math.round(performance.now() - t0), ok: true });
    console.info(`[world/container] baked model in ${containerStats.ms} ms`);
  } catch (err) {
    lods = null;
    console.error('[world/container] baked container model failed to load: procedural fallback', err);
  }
}

/** The baked container's geometry (0 = near, 1 = far field), or null (not loaded: use the procedural boxes). */
export function containerLod(k: 0 | 1): THREE.BufferGeometry | null {
  return lods ? lods[k] : null;
}
