import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLAYER } from '../../sim/constants';
import { buildBody, lookKey, type Look, type Lod } from './body';
import { bodyMaterial } from './charMaterials';
import { measureClipSpeeds } from './locomotion';

/**
 * Loads the CC0 Quaternius SWAT rig (see public/assets/characters/CREDITS.md) once, for its skeleton and animation
 * clips. Its own low-poly meshes are dropped: bodies are built procedurally (body.ts) and skinned to the same bones.
 */

/** The skeleton in bind pose, re-expressed so procedural geometry can be authored in character space. */
export type Rig = {
  /** Skeleton bone names in skinIndex order. */
  boneNames: string[];
  /** Inverse bind matrices for character-space vertices (shared, never mutated). */
  inverses: THREE.Matrix4[];
  /** Bind-pose (T-pose) joint positions in character space (metres, Y up, facing +Z, soles at y≈0). */
  joints: Map<string, THREE.Vector3>;
};

export type CharacterAssets = {
  /** Bones only (the glTF scene minus its meshes); every body clones it. */
  template: THREE.Object3D;
  rig: Rig;
  clips: Map<string, THREE.AnimationClip>;
  /** Uniform scale that makes the model PLAYER.height tall. */
  scale: number;
  /** Model-space Y of the soles (subtract so feet sit at y=0). */
  footY: number;
  /** Gun holder transform relative to the right wrist bone (grip frame → bone local). */
  gripLocal: THREE.Matrix4;
  /** Ground speed (m/s, on screen) each locomotion clip's feet imply (locomotion.ts), for no-skate playback. */
  speeds: Map<string, number>;
};

const BASE = `${import.meta.env.BASE_URL}assets/characters/`;
// Only CC0-licensed rigs (the pack's other soldier is listed CC-BY on poly.pizza, so it's left out).
const FILES: { url: string }[] = [{ url: `${BASE}swat/swat.glb` }];
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
  const assets = prepareAssets(gltfs[0], FILES[0].url);
  reportProgress(1);
  console.info(`[characters] loaded rig: ${assets.rig.boneNames.length} bones, ${assets.clips.size} clips → scale ${assets.scale.toFixed(3)} in ${Math.round(performance.now() - t0)} ms`);
  return assets;
}

/** Everything after the download (also used by unit tests on a parsed glTF). */
export function prepareAssets(gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }, url = 'rig'): CharacterAssets {
  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of gltf.animations) {
    c.name = c.name.replace(CLIP_PREFIX, '');
    clips.set(c.name, c);
  }
  for (const need of ['Idle', 'Walk', 'Run', 'Death', 'Idle_Gun', 'Idle_Gun_Pointing', 'Run_Shoot', 'HitRecieve', 'Wave', 'Idle_Neutral']) {
    if (!clips.has(need)) throw new Error(`[characters] clip "${need}" missing from ${url}`);
  }

  const probe = gltf.scene;
  if (!probe.getObjectByName(HAND_BONE)) throw new Error(`[characters] ${url} has no ${HAND_BONE} bone`);
  probe.updateMatrixWorld(true);
  const rig = rigOf(probe);

  // Measure in a standing pose with the original meshes (keeps the on-screen size the game was tuned with).
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

  // Drop the rig's own meshes: the template keeps only the bone hierarchy.
  const meshes: THREE.Object3D[] = [];
  probe.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
  const holders = new Set<THREE.Object3D>();
  for (const m of meshes) { if (m.parent && m.parent !== probe) holders.add(m.parent); m.removeFromParent(); (m as THREE.Mesh).geometry.dispose(); }
  for (const h of holders) if (!h.children.length && !(h as THREE.Bone).isBone) h.removeFromParent(); // the emptied mesh groups (bone-end nodes stay)
  const speeds = measureClipSpeeds(probe, clips, scale);
  return { template: probe, rig, clips, scale, footY: bounds.min.y, gripLocal, speeds };
}

/**
 * Reads the skeleton off the glTF's first skinned mesh: bind-pose joints in character space (the scene root's frame)
 * and inverse bind matrices that take character-space vertices (instead of the exporter's armature space).
 */
export function rigOf(root: THREE.Object3D): Rig {
  let sk: THREE.SkinnedMesh | null = null;
  root.traverse((o) => { if (!sk && (o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
  if (!sk) throw new Error('[characters] rig has no skinned mesh');
  const mesh = sk as THREE.SkinnedMesh;
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const A = mesh.matrixWorld.clone().premultiply(rootInv); // armature space → character space
  const Ainv = A.clone().invert();
  const joints = new Map<string, THREE.Vector3>();
  const boneNames = mesh.skeleton.bones.map((b) => b.name);
  const inverses = mesh.skeleton.boneInverses.map((inv, i) => {
    joints.set(boneNames[i], new THREE.Vector3().setFromMatrixPosition(inv.clone().invert().premultiply(A)));
    return inv.clone().multiply(Ainv);
  });
  return { boneNames, inverses, joints };
}

const bodyGeo = new Map<string, THREE.BufferGeometry>();
const noRaycast = () => {};

/** One look's skinned geometry at a detail level, built once and shared by everyone wearing it. */
export function bodyGeometry(rig: Rig, look: Look, lod: Lod): THREE.BufferGeometry {
  const key = `${lookKey(look)}#${lod}`;
  let g = bodyGeo.get(key);
  if (!g) {
    const J = (n: string) => { const v = rig.joints.get(n); if (!v) throw new Error(`[characters] rig has no joint "${n}"`); return v; };
    g = buildBody(look, lod, J, rig.boneNames);
    bodyGeo.set(key, g);
  }
  return g;
}

/** Character-detail distances (m): LOD0 (full: fingers, face, small gear) inside `lod1`, LOD1 to `lod2`, LOD2 beyond. */
export const BODY_LOD = { lod1: 14, lod2: 40, hysteresis: 1.5 };

export type Body = { model: THREE.Object3D; skeleton: THREE.Skeleton; lods: THREE.SkinnedMesh[] };

/**
 * A new posable body: a clone of the bone template with the look's three LOD meshes skinned to it (one visible at a
 * time; all share one Skeleton). `team` tints the camo (null = civilian).
 */
export function makeBody(assets: CharacterAssets, look: Look, team: number | null): Body {
  const model = assets.template.clone();
  const byName = new Map<string, THREE.Bone>();
  model.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone); });
  const bones = assets.rig.boneNames.map((n) => {
    const b = byName.get(n);
    if (!b) throw new Error(`[characters] cloned rig lost bone "${n}"`);
    return b;
  });
  const skeleton = new THREE.Skeleton(bones, assets.rig.inverses);
  const ident = new THREE.Matrix4();
  const lods = ([0, 1, 2] as const).map((lod) => {
    const m = new THREE.SkinnedMesh(bodyGeometry(assets.rig, look, lod), bodyMaterial(team, lod === 2 ? 'far' : 'full'));
    m.name = `body:lod${lod}`;
    m.bind(skeleton, ident);
    m.castShadow = true;
    m.receiveShadow = true;
    m.visible = lod === 0;
    // Never raycast the skinned triangles (CPU-skinning every vertex: ~1 ms/frame for 8 players). Aim and hover rays
    // hit the avatar's capsule hitbox (Avatar.hitbox); hit detection itself is sim-side.
    m.raycast = noRaycast;
    model.add(m);
    return m;
  });
  return { model, skeleton, lods };
}
