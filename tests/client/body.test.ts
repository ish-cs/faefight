import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { K, buildBody, npcLook, soldierLook, type Look } from '../../src/client/characters/body';
import { bodyGeometry, makeBody, prepareAssets, type CharacterAssets } from '../../src/client/characters/loader';
import { bodyMaterial } from '../../src/client/characters/charMaterials';

let assets: CharacterAssets;
beforeAll(async () => {
  const fsMod = 'node:fs'; // no @types/node in this repo
  const { readFileSync } = (await import(/* @vite-ignore */ fsMod)) as { readFileSync(p: string): Uint8Array };
  const buf = readFileSync('public/assets/characters/swat/swat.glb');
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
  assets = prepareAssets(gltf as unknown as { scene: THREE.Object3D; animations: THREE.AnimationClip[] });
});

const J = () => (n: string) => assets.rig.joints.get(n)!;
const kinds = (g: THREE.BufferGeometry) => new Set(Array.from({ length: g.getAttribute('surf').count }, (_, i) => g.getAttribute('surf').getX(i)));
const tris = (g: THREE.BufferGeometry) => g.index!.count / 3;
const bonesUsed = (g: THREE.BufferGeometry, names: string[]) => {
  const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
  const used = new Set<string>();
  for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.01) used.add(names[si.getComponent(i, k)]);
  return used;
};

describe('character rig', () => {
  it('keeps only bones in the template and reads a T-pose skeleton in character space', () => {
    let meshes = 0;
    assets.template.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    expect(meshes).toBe(0);
    const j = J();
    expect(j('Head').y).toBeGreaterThan(1.5);
    expect(j('FootL').y).toBeLessThan(0.1);
    expect(j('WristL').x).toBeGreaterThan(0.5); // arms out
    expect(j('WristR').x).toBeLessThan(-0.5);
  });
});

describe('procedural body', () => {
  const soldier = soldierLook(3);
  it('has the parts: skin, camo uniform, leather boots/gloves, gear, eyes with a glint, team accents', () => {
    const g = buildBody(soldier, 0, J(), assets.rig.boneNames);
    const ks = kinds(g);
    for (const k of [K.skin, K.camo, K.leather, K.polymer, K.metal, K.eye, K.glint, K.team, K.cloth]) expect(ks.has(k)).toBe(true);
    // skinned to the limbs, fingers and head
    const used = bonesUsed(g, assets.rig.boneNames);
    for (const b of ['Hips', 'Chest', 'Head', 'UpperArmL', 'LowerArmR', 'WristL', 'Index3L', 'Thumb2R', 'UpperLegR', 'LowerLegL', 'FootR']) expect(used.has(b)).toBe(true);
    // weights normalised, attributes finite
    const sw = g.getAttribute('skinWeight'), p = g.getAttribute('position');
    for (let i = 0; i < sw.count; i += 7) {
      expect(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i)).toBeCloseTo(1, 4);
      expect(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))).toBe(true);
    }
    // human-sized: soles near 0, helmet top under 1.85 m, about shoulder-to-fingertip wide
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(bb.max.y).toBeGreaterThan(1.74);
    expect(bb.max.y).toBeLessThan(1.86);
  });

  it('builds three LODs with falling triangle counts; far LOD has no face details or fingers', () => {
    const [g0, g1, g2] = ([0, 1, 2] as const).map((l) => buildBody(soldier, l, J(), assets.rig.boneNames));
    expect(tris(g0)).toBeGreaterThan(tris(g1) * 1.5);
    expect(tris(g1)).toBeGreaterThan(tris(g2) * 1.5);
    expect(tris(g0)).toBeLessThan(18000);
    expect(tris(g2)).toBeLessThan(2500);
    expect(kinds(g2).has(K.glint)).toBe(false);
    expect(kinds(g2).has(K.eye)).toBe(false);
    expect(bonesUsed(g2, assets.rig.boneNames).has('Index3L')).toBe(false);
    expect(bonesUsed(g1, assets.rig.boneNames).has('Index3L')).toBe(false); // mittens
  });

  it('dresses NPCs by shop: hi-vis dock worker vs aproned potion seller, no team colour', () => {
    const shop = buildBody(npcLook('shop', 1), 0, J(), assets.rig.boneNames);
    const potion = buildBody(npcLook('potion', 1), 0, J(), assets.rig.boneNames);
    expect(kinds(shop).has(K.hivis)).toBe(true);
    expect(kinds(potion).has(K.hivis)).toBe(false);
    expect(kinds(potion).has(K.hair)).toBe(true); // beard
    for (const g of [shop, potion]) { expect(kinds(g).has(K.team)).toBe(false); expect(kinds(g).has(K.camo)).toBe(false); }
  });

  it('varies looks deterministically per seed', () => {
    const looks: Look[] = Array.from({ length: 16 }, (_, i) => soldierLook(i));
    expect(new Set(looks.map((l) => l.skin)).size).toBeGreaterThan(2);
    expect(soldierLook(5)).toEqual(soldierLook(5));
    expect(looks.every((l) => l.head === 'helmet')).toBe(true);
  });
});

describe('sharing', () => {
  it('shares geometry per look+LOD and materials per team colour across bodies', () => {
    const look = soldierLook(7);
    const a = makeBody(assets, look, 0xe0533d), b = makeBody(assets, look, 0xe0533d), c = makeBody(assets, soldierLook(8), 0x3d84e0);
    expect(a.lods).toHaveLength(3);
    a.lods.forEach((m, i) => { expect(m.geometry).toBe(b.lods[i].geometry); expect(m.material).toBe(b.lods[i].material); });
    expect(a.lods[0].material).not.toBe(c.lods[0].material);
    expect(a.lods[0].material).toBe(a.lods[1].material); // near tiers share the full material
    expect(a.lods[2].material).toBe(bodyMaterial(0xe0533d, 'far'));
    expect(bodyGeometry(assets.rig, look, 0)).toBe(a.lods[0].geometry);
    // one skeleton per body, separate bones per body
    expect(a.lods[0].skeleton).toBe(a.lods[2].skeleton);
    expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0]);
    // only one LOD visible at a time
    expect(a.lods.filter((m) => m.visible)).toHaveLength(1);
  });

  it('binds so the bind pose reproduces the authored vertices', () => {
    const body = makeBody(assets, soldierLook(1), null);
    const m = body.lods[0];
    // put the bones in bind pose (world = inverse bind; the root bone's parent is a scaled armature node) and skin on the CPU
    body.model.updateMatrixWorld(true);
    body.skeleton.bones.forEach((b, i) => {
      const world = body.skeleton.boneInverses[i].clone().invert();
      b.matrix.copy(b.parent!.matrixWorld).invert().multiply(world);
      b.matrix.decompose(b.position, b.quaternion, b.scale);
      b.updateMatrixWorld(true);
    });
    const v = new THREE.Vector3(), p = m.geometry.getAttribute('position');
    for (const i of [0, 100, 2000, p.count - 1]) {
      m.getVertexPosition(i, v);
      expect(v.distanceTo(new THREE.Vector3().fromBufferAttribute(p, i))).toBeLessThan(1e-3);
    }
  });
});

