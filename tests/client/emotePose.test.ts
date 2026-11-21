import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, test } from 'vitest';
import { EMOTE_IDS, EMOTES, type EmoteId } from '../../src/sim/emotes';
import { EMOTE_BONES, emoteClip, emotePose, emoteWeight } from '../../src/client/characters/emotePose';

// Poses checked against the real rig (public/assets/characters/swat/swat.glb): the clip is sampled, the
// procedural turns applied exactly as Avatar.turn does, and hand / head positions measured in the body
// frame (cm: r = right, u = up, f = forward of the avatar's facing).

let model: THREE.Object3D, group: THREE.Group, clips: Map<string, THREE.AnimationClip>;
const YAW = 0.7; // any facing: the turns are about the body's own axes
const R = new THREE.Vector3(Math.cos(YAW), 0, -Math.sin(YAW)), U = new THREE.Vector3(0, 1, 0), F = new THREE.Vector3(-Math.sin(YAW), 0, -Math.cos(YAW));

beforeAll(async () => {
  // (No @types/node in this project: node:fs is typed by hand.)
  const fs = (await import('node:fs' as string)) as { readFileSync(path: string): Uint8Array };
  const buf = fs.readFileSync('public/assets/characters/swat/swat.glb');
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  clips = new Map(gltf.animations.map((c) => [c.name.replace(/^CharacterArmature\|/, ''), c]));
  model = gltf.scene;
  model.rotation.y = Math.PI; // as Avatar.buildModel: the rig faces +Z
  group = new THREE.Group();
  group.rotation.y = YAW;
  group.add(model);
});

const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
function pose(id: EmoteId, t = 1) {
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clips.get(emoteClip(id))!).play();
  mixer.update(t);
  group.updateMatrixWorld(true);
  for (const turn of emotePose(id, t)) {
    const bone = model.getObjectByName(turn.bone)!;
    bone.parent!.getWorldQuaternion(q);
    q2.setFromAxisAngle(turn.axis === 'right' ? R : turn.axis === 'up' ? U : F, turn.angle);
    bone.quaternion.premultiply(q).premultiply(q2).premultiply(q.clone().invert());
    bone.updateMatrixWorld(true);
  }
  group.updateMatrixWorld(true);
  const at = (name: string) => {
    const p = new THREE.Vector3().setFromMatrixPosition(model.getObjectByName(name)!.matrixWorld);
    return { r: p.dot(R) * 100, u: p.dot(U) * 100, f: p.dot(F) * 100 };
  };
  const out = { head: at('Head'), wristR: at('WristR'), wristL: at('WristL'), tipR: at('Index4R_end'), elbowR: at('LowerArmR') };
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return out;
}

describe('emote poses on the soldier rig', () => {
  test('every clip and bone the emotes use exists', () => {
    for (const id of EMOTE_IDS) expect(clips.has(emoteClip(id))).toBe(true);
    for (const b of EMOTE_BONES) expect(model.getObjectByName(b)).toBeTruthy();
  });

  test('wave: a hand up by the head', () => {
    const p = pose('wave');
    expect(Math.max(p.wristL.u, p.wristR.u)).toBeGreaterThan(p.head.u - 10);
  });

  test('salute: elbow out at shoulder height, fingertips at the right brow', () => {
    const p = pose('salute');
    expect(p.elbowR.r).toBeGreaterThan(25);
    expect(p.elbowR.u).toBeGreaterThan(128);
    expect(Math.hypot(p.tipR.r - 6, p.tipR.u - (p.head.u + 5), p.tipR.f - 13)).toBeLessThan(12);
    expect(p.wristL.u).toBeLessThan(110); // other arm stays down
  });

  test('dance: both hands up over the shoulders, apart', () => {
    const p = pose('dance', 0.9);
    expect(p.wristR.u).toBeGreaterThan(p.head.u);
    expect(p.wristL.u).toBeGreaterThan(p.head.u);
    expect(p.wristR.r).toBeGreaterThan(15);
    expect(p.wristL.r).toBeLessThan(-15);
  });

  test('laugh: leans back, hands on the belly', () => {
    const p = pose('laugh');
    expect(p.head.f).toBeLessThan(4); // standing straight the head is ~6 cm forward
    for (const w of [p.wristR, p.wristL]) {
      expect(Math.abs(w.r)).toBeLessThan(15);
      expect(w.u).toBeGreaterThan(95);
      expect(w.u).toBeLessThan(120);
      expect(w.f).toBeGreaterThan(10);
    }
  });

  test('point: index finger well out in front at chest height', () => {
    const p = pose('point');
    expect(p.tipR.f).toBeGreaterThan(50);
    expect(p.tipR.u).toBeGreaterThan(125);
  });

  test('the overlay eases in and out and is off outside the emote', () => {
    for (const id of EMOTE_IDS) {
      expect(emoteWeight(id, -0.1)).toBe(0);
      expect(emoteWeight(id, 0)).toBe(0);
      expect(emoteWeight(id, 0.1)).toBeGreaterThan(0);
      expect(emoteWeight(id, 0.1)).toBeLessThan(1);
      expect(emoteWeight(id, EMOTES[id].sec / 2)).toBe(1);
      expect(emoteWeight(id, EMOTES[id].sec)).toBe(0);
      expect(emotePose(id, EMOTES[id].sec + 1)).toEqual([]);
    }
  });
});
