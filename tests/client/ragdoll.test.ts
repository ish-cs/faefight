import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareAssets, type CharacterAssets } from '../../src/client/characters/loader';
import { Ragdoll } from '../../src/client/characters/ragdoll';
import { RP } from '../../src/client/characters/ragdollSim';

// The ragdoll poses the real rig (public/assets/characters/swat/swat.glb) built the way Avatar.buildModel builds it.
let assets: CharacterAssets;
beforeAll(async () => {
  const fsMod = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsMod)) as { readFileSync(p: string): Uint8Array };
  const buf = readFileSync('public/assets/characters/swat/swat.glb');
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  assets = prepareAssets(gltf as unknown as { scene: THREE.Object3D; animations: THREE.AnimationClip[] });
});

function soldier(clip: string, yaw: number) {
  const group = new THREE.Group();
  const model = assets.template.clone(true);
  model.scale.setScalar(assets.scale);
  model.position.y = -assets.footY * assets.scale;
  model.rotation.y = Math.PI;
  group.add(model);
  group.position.set(12, 3, -7);
  group.rotation.y = yaw;
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(assets.clips.get(clip)!).play();
  mixer.update(0.3);
  group.updateMatrixWorld(true);
  return { group, model };
}
const at = (m: THREE.Object3D, n: string) => new THREE.Vector3().setFromMatrixPosition(m.getObjectByName(n)!.matrixWorld);
const pt = (r: Ragdoll, i: number) => new THREE.Vector3().fromArray(r.sim.pos, i * 3);

describe('ragdoll on the rig', () => {
  for (const [clip, yaw] of [['Idle', 0], ['Run', 2.1]] as const) {
    it(`bones follow the simulated points (${clip}, yaw ${yaw})`, () => {
      const { group, model } = soldier(clip, yaw);
      const r = new Ragdoll(model, { x: -Math.sin(yaw), z: -Math.cos(yaw) }, 3);
      r.sim.kick(RP.chest, 1.5, 0.5, 2);
      for (let t = 0; t < 3; t += 1 / 60) r.step(1 / 60);
      group.updateMatrixWorld(true);
      const pairs: [string, number][] = [['Hips', RP.pelvis], ['Neck', RP.chest], ['LowerArmL', RP.elL], ['WristL', RP.haL], ['WristR', RP.haR],
        ['LowerLegL', RP.knL], ['LowerLegR', RP.knR], ['FootL', RP.anL], ['FootR', RP.anR], ['UpperLegL', RP.hipL], ['UpperArmR', RP.shR]];
      for (const [bone, i] of pairs) expect(at(model, bone).distanceTo(pt(r, i)), bone).toBeLessThan(0.03);
      expect(at(model, 'Hips').y).toBeLessThan(3.4); // lying down
    });
  }

  it('restore() puts the starting local pose back', () => {
    const { model } = soldier('Idle', 0.5);
    const before = new Map<string, number[]>();
    model.traverse((o) => { before.set(o.name, [...o.position.toArray(), ...o.quaternion.toArray()]); });
    const r = new Ragdoll(model, { x: 0, z: -1 }, 3);
    for (let t = 0; t < 1; t += 1 / 60) r.step(1 / 60);
    r.restore();
    model.traverse((o) => {
      const b = before.get(o.name)!;
      [...o.position.toArray(), ...o.quaternion.toArray()].forEach((x, k) => expect(x).toBeCloseTo(b[k], 6));
    });
  });
});
