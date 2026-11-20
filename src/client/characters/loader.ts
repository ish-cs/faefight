import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLAYER } from '../../sim/constants';

/**
 * Loads the CC0 Quaternius SWAT rig (see public/assets/characters/CREDITS.md) once; avatars clone it.
 */

export type CharacterVariant = {
  /** Original glTF scene (never added to the world; avatars clone it with SkeletonUtils.clone). */
  scene: THREE.Object3D;
  /** Name of the uniform material that gets tinted with the island colour. */
  uniformMaterial: string;
};

export type CharacterAssets = {
  variants: CharacterVariant[];
  clips: Map<string, THREE.AnimationClip>;
  /** Uniform scale that makes the model PLAYER.height tall. */
  scale: number;
  /** Model-space Y of the soles (subtract so feet sit at y=0). */
  footY: number;
  /** Gun holder transform relative to the right wrist bone (grip frame → bone local). */
  gripLocal: THREE.Matrix4;
};

const BASE = `${import.meta.env.BASE_URL}assets/characters/`;
// Only CC0-licensed rigs (the pack's other soldier is listed CC-BY on poly.pizza, so it's left out).
// More variants with the same skeleton can be appended; clips are taken from the first.
const FILES: { url: string; uniformMaterial: string }[] = [
  { url: `${BASE}swat/swat.glb`, uniformMaterial: 'Swat' },
];
// GLTFLoader sanitises node names (drops '.'), so the rig's "Wrist.R" is "WristR" here.
export const HAND_BONE = 'WristR';
const CLIP_PREFIX = /^CharacterArmature\|/;

let pending: Promise<CharacterAssets> | null = null;
const bytes = FILES.map(() => ({ loaded: 0, total: 0 }));
const progressFns = new Set<(frac: number) => void>();
let lastFrac = 0;

/** Model download progress 0..1 (fires now with the current value, then as bytes arrive). Returns unsubscribe. */
export function onCharacterProgress(fn: (frac: number) => void): () => void {
  progressFns.add(fn);
  fn(lastFrac);
  return () => progressFns.delete(fn);
}
function reportProgress(frac: number) {
  lastFrac = Math.max(lastFrac, Math.min(1, frac));
  for (const fn of progressFns) fn(lastFrac);
}

export function loadCharacters(): Promise<CharacterAssets> {
  pending ??= load();
  return pending;
}

async function load(): Promise<CharacterAssets> {
  const t0 = performance.now();
  const loader = new GLTFLoader();
  const gltfs = await Promise.all(FILES.map((f, i) => loader.loadAsync(f.url, (e) => {
    bytes[i] = { loaded: e.loaded, total: e.lengthComputable ? e.total : 0 };
    const total = bytes.reduce((n, b) => n + b.total, 0), loaded = bytes.reduce((n, b) => n + b.loaded, 0);
    if (total > 0) reportProgress(0.95 * (loaded / total)); // the last 5% is parsing + measuring
  })));
  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of gltfs[0].animations) {
    c.name = c.name.replace(CLIP_PREFIX, '');
    clips.set(c.name, c);
  }
  for (const need of ['Idle', 'Walk', 'Run', 'Death', 'Idle_Gun', 'Idle_Gun_Pointing', 'Run_Shoot', 'HitRecieve']) {
    if (!clips.has(need)) throw new Error(`[characters] clip "${need}" missing from ${FILES[0].url}`);
  }

  const variants: CharacterVariant[] = gltfs.map((g, i) => {
    g.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.castShadow = true;
      m.receiveShadow = false;
      // Flat-coloured low-poly materials: matte cloth/skin reads more natural than the exported gloss.
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
        mat.roughness = Math.max(mat.roughness, 0.75);
        mat.metalness = 0;
      }
    });
    if (!g.scene.getObjectByName(HAND_BONE)) throw new Error(`[characters] ${FILES[i].url} has no ${HAND_BONE} bone`);
    return { scene: g.scene, uniformMaterial: FILES[i].uniformMaterial };
  });

  // Measure in a standing pose (bind pose has arms out, legs fine).
  const probe = variants[0].scene;
  const mixer = new THREE.AnimationMixer(probe);
  mixer.clipAction(clips.get('Idle')!).play();
  mixer.update(0);
  probe.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  probe.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) { m.computeBoundingBox(); bounds.union(m.boundingBox!.clone().applyMatrix4(m.matrixWorld)); }
  });
  const height = bounds.max.y - bounds.min.y;
  if (!(height > 0.01)) throw new Error(`[characters] bad model height ${height}`);
  const scale = PLAYER.height / height;

  // Grip: pose the aim clip, then express "gun pointing along the model's facing (+Z), level, at the
  // palm" in the wrist bone's local frame. Model space is unscaled, so the gun (built in metres) is
  // scaled by 1/scale here and ends up the right size once the avatar root applies `scale`.
  mixer.stopAllAction();
  mixer.clipAction(clips.get('Idle_Gun_Pointing')!).play();
  mixer.update(0.4);
  probe.updateMatrixWorld(true);
  const wrist = probe.getObjectByName(HAND_BONE)!;
  const wristPos = new THREE.Vector3().setFromMatrixPosition(wrist.matrixWorld);
  const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // grip -Z → model +Z
  const palm = wristPos.clone().add(new THREE.Vector3(0, -0.035 / scale, 0.045 / scale));
  const desired = new THREE.Matrix4().compose(palm, facing, new THREE.Vector3().setScalar(1 / scale));
  const gripLocal = wrist.matrixWorld.clone().invert().multiply(desired);
  mixer.stopAllAction();
  mixer.uncacheRoot(probe);

  reportProgress(1);
  console.info(`[characters] loaded ${FILES.length} rigs, ${clips.size} clips, h=${height.toFixed(3)} → scale ${scale.toFixed(3)} in ${Math.round(performance.now() - t0)} ms`);
  return { variants, clips, scale, footY: bounds.min.y, gripLocal };
}
