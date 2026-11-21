import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { K } from '../../src/client/characters/body';
import { prepareAssets, type CharacterAssets } from '../../src/client/characters/loader';

let assets: CharacterAssets;
beforeAll(async () => {
  const fsMod = 'node:fs'; // no @types/node in this repo
  const { readFileSync } = (await import(/* @vite-ignore */ fsMod)) as { readFileSync(p: string): Uint8Array };
  const buf = readFileSync('public/assets/characters/swat/swat.glb');
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  assets = prepareAssets(gltf as unknown as { scene: THREE.Object3D; animations: THREE.AnimationClip[] });
});
const kinds = (g: THREE.BufferGeometry) => new Set(Array.from({ length: g.getAttribute('surf').count }, (_, i) => g.getAttribute('surf').getX(i)));

describe('first-person hands', () => {
  it('builds a gloved hand + camo sleeve with the body material channels and no skinning', async () => {
    const { handGeometry } = await import('../../src/client/characters/hands');
    const g = handGeometry({
      center: new THREE.Vector3(0, 0, 0), axis: new THREE.Vector3(0, 1, 0), radius: 0.02, palm: new THREE.Vector3(1, 0, 0),
      wrist: new THREE.Vector3(0.03, -0.05, 0.07), elbow: new THREE.Vector3(0.09, -0.2, 0.42), thumbWrap: true,
    });
    const ks = kinds(g);
    expect(ks.has(K.leather)).toBe(true);
    expect(ks.has(K.camo)).toBe(true);
    expect(g.getAttribute('skinIndex')).toBeUndefined();
    g.computeBoundingBox();
    expect(g.boundingBox!.max.z).toBeGreaterThan(0.35); // sleeve reaches back toward the elbow
  });
});

describe('stride IK', () => {
  it('lengthens the stride: feet move further along the travel axis and the shins still reach them', async () => {
    const { StrideIK, strideFor, STRIDE_MAX, CADENCE_MAX } = await import('../../src/client/characters/locomotion');
    const model = assets.template.clone();
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(assets.clips.get('Run')!).play();
    mixer.update(0.15);
    model.updateMatrixWorld(true);
    const foot = model.getObjectByName('FootL')!, end = model.getObjectByName('LowerLegL_end')!, body = model.getObjectByName('Body')!;
    const fwd = new THREE.Vector3(0, 0, 1);
    const before = foot.getWorldPosition(new THREE.Vector3()).sub(body.getWorldPosition(new THREE.Vector3())).dot(fwd);
    const ik = new StrideIK(model);
    expect(ik.ok).toBe(true);
    ik.apply(1.25, fwd);
    model.updateMatrixWorld(true);
    const after = foot.getWorldPosition(new THREE.Vector3()).sub(body.getWorldPosition(new THREE.Vector3())).dot(fwd);
    expect(Math.abs(after)).toBeGreaterThan(Math.abs(before) * 1.15);
    expect(end.getWorldPosition(new THREE.Vector3()).distanceTo(foot.getWorldPosition(new THREE.Vector3()))).toBeLessThan(0.02);
    // stride × cadence covers the speed (no skating) until both are capped
    const s = strideFor(5, 2.9);
    expect(s.ts * s.stride * 2.9).toBeCloseTo(5, 3);
    expect(s.stride).toBeLessThanOrEqual(STRIDE_MAX);
    expect(strideFor(50, 2.9).ts).toBe(CADENCE_MAX);
  });
});

describe('locomotion clip speeds', () => {
  it('measures ground speed from the planted foot: walk slower than run, both plausible', async () => {
    const { measureClipSpeeds } = await import('../../src/client/characters/locomotion');
    const sp = measureClipSpeeds(assets.template, assets.clips, assets.scale);
    expect(sp.get('Walk')).toBeGreaterThan(0.6);
    expect(sp.get('Run')).toBeGreaterThan(sp.get('Walk')!);
    expect(sp.get('Run')).toBeLessThan(9);
  });
});

describe('body LOD', () => {
  it('picks detail by distance with hysteresis, scaled by the shared LOD manager', async () => {
    const { bodyLod } = await import('../../src/client/characters/avatar');
    expect(bodyLod(5, -1, 1)).toBe(0);
    expect(bodyLod(25, -1, 1)).toBe(1);
    expect(bodyLod(80, -1, 1)).toBe(2);
    expect(bodyLod(25, -1, 2)).toBe(0); // a larger preset scale keeps detail further out
    expect(bodyLod(14.5, 0, 1)).toBe(0); // inside the hysteresis band: stays
    expect(bodyLod(14.5, 1, 1)).toBe(1);
  });
});
