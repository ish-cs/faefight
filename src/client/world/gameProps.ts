import * as THREE from 'three/webgpu';
import { PROP_KIND_LIST, type PropKind, type PropPose, type PropSpawn } from '../../sim/props';
import { boxUV, mat, StaticBatch } from './geo';
import { barrelModel } from './mapProps';
import { mats } from './materials';

/**
 * Tier A gameplay props (sim/props.ts), drawn from the snapshot: one InstancedMesh per (kind, material), shared
 * materials, every geometry for a kind built in one place below (MODELS) so a LOD API can swap it later.
 * Poses come from `sync` (snapshot: displaced props) and ease toward it each frame; unlisted props sit at spawn.
 */

const lid = (b: StaticBatch, y: number) => b.add(mats().dark, new THREE.CylinderGeometry(0.28, 0.28, 0.01, 14), mat(0, y, 0), 0x555555);

/** Each model is centred on the body origin, matching PROP_KINDS[kind].shape (cylinders stand along local Y). */
const MODELS: Record<PropKind, (b: StaticBatch) => void> = {
  crate: (b) => {
    const M = mats();
    b.add(M.wood, boxUV(0.86, 0.86, 0.86, 0.8), null, 0xc9a676);
    for (const s of [-1, 1]) for (const t of [-1, 1]) {
      b.add(M.wood, boxUV(0.9, 0.08, 0.08, 0.8), mat(0, s * 0.41, t * 0.41), 0x8f6e47);
      b.add(M.wood, boxUV(0.08, 0.9, 0.08, 0.8), mat(s * 0.41, 0, t * 0.41), 0x8f6e47);
      b.add(M.wood, boxUV(0.08, 0.08, 0.9, 0.8), mat(s * 0.41, t * 0.41, 0), 0x8f6e47);
    }
  },
  drum: (b) => {
    const inner = new StaticBatch();
    barrelModel(inner); // 0.3 m radius, 0.9 m tall, base at y = 0
    for (const { material, geometry } of inner.take()) b.add(material, geometry, mat(0, -0.45, 0));
    lid(b, -0.448);
  },
  pallet: (b) => {
    const M = mats();
    for (const z of [-0.45, 0, 0.45]) b.add(M.wood, boxUV(1.2, 0.09, 0.1, 0.8), mat(0, -0.03, z), 0xb59c72);
    for (let i = 0; i < 7; i++) b.add(M.wood, boxUV(0.14, 0.022, 1.0, 0.8), mat(-0.54 + i * 0.18, 0.064, 0), 0xd8c49c);
  },
  ibc: (b) => {
    const M = mats();
    b.add(M.matte, new THREE.BoxGeometry(1.1, 0.96, 0.9), mat(0, 0.06, 0), 0xe8e6dc); // HDPE tank
    b.add(M.dark, new THREE.BoxGeometry(1.2, 0.14, 1.0), mat(0, -0.51, 0), 0x3a3c3e); // steel pallet base
    const bar = 0x9aa1a6;
    for (const x of [-0.58, -0.29, 0, 0.29, 0.58]) for (const z of [-0.48, 0.48]) b.add(M.galv, new THREE.BoxGeometry(0.025, 1.02, 0.025), mat(x, 0.07, z), bar, false);
    for (const z of [-0.48, 0, 0.48]) for (const x of [-0.58, 0.58]) b.add(M.galv, new THREE.BoxGeometry(0.025, 1.02, 0.025), mat(x, 0.07, z), bar, false);
    for (const y of [-0.42, 0.07, 0.56]) {
      for (const z of [-0.48, 0.48]) b.add(M.galv, new THREE.BoxGeometry(1.18, 0.025, 0.025), mat(0, y, z), bar, false);
      for (const x of [-0.58, 0.58]) b.add(M.galv, new THREE.BoxGeometry(0.025, 0.025, 0.98), mat(x, y, 0), bar, false);
    }
    b.add(M.dark, new THREE.CylinderGeometry(0.075, 0.075, 0.05, 12), mat(0, 0.56, 0), 0x222222); // filler cap
  },
  reel: (b) => {
    const M = mats();
    for (const s of [-1, 1]) b.add(M.wood, new THREE.CylinderGeometry(0.6, 0.6, 0.06, 20), mat(0, s * 0.32, 0), 0xb08a5a);
    b.add(M.rubber, new THREE.CylinderGeometry(0.44, 0.44, 0.58, 20), null, 0x1c1c1c); // wound cable
    b.add(M.galv, new THREE.CylinderGeometry(0.06, 0.06, 0.72, 8), null, 0x8a8f92);
  },
  tire: (b) => {
    b.add(mats().rubber, new THREE.TorusGeometry(0.36, 0.14, 10, 20).rotateX(Math.PI / 2), null, 0xffffff);
  },
};
const DRUM_COLORS = [0x1f5fa8, 0xb23a26, 0x2f6b3a, 0xc8641e];

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _m = new THREE.Matrix4();

type Item = { meshes: THREE.InstancedMesh[]; index: number; spawn: PropSpawn; pos: THREE.Vector3; rot: THREE.Quaternion; tPos: THREE.Vector3; tRot: THREE.Quaternion; moving: boolean };

export class GameProps {
  readonly root = new THREE.Group();
  private items = new Map<number, Item>();
  /** Called with each prop's eased pose whenever it moves (client debris follows these as kinematic obstacles). */
  onPose: ((id: number, pos: THREE.Vector3, rot: THREE.Quaternion) => void) | null = null;

  constructor(spawns: PropSpawn[]) {
    this.root.name = 'gameProps';
    for (const kind of PROP_KIND_LIST) {
      const list = spawns.filter((s) => s.kind === kind);
      if (!list.length) continue;
      const b = new StaticBatch();
      MODELS[kind](b);
      const meshes = b.take().map(({ material, geometry }) => {
        const m = new THREE.InstancedMesh(geometry, material, list.length);
        m.name = `gameProp:${kind}:${material.name || 'mat'}`;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false; // ~40 instances across the map: one draw each, no per-frame bounds
        this.root.add(m);
        return m;
      });
      const c = new THREE.Color();
      list.forEach((s, i) => {
        const pos = new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), rot = new THREE.Quaternion(...s.rot);
        const it: Item = { meshes, index: i, spawn: s, pos, rot, tPos: pos.clone(), tRot: rot.clone(), moving: false };
        this.items.set(s.id, it);
        for (const m of meshes) {
          const painted = kind === 'drum' && m.material === mats().paint;
          m.setColorAt(i, painted ? c.setHex(DRUM_COLORS[s.id % DRUM_COLORS.length]) : c.setScalar(kind === 'crate' ? 0.82 + ((s.id * 37) % 7) * 0.04 : 1));
        }
        this.write(it);
      });
      for (const m of meshes) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    }
  }

  /** A snapshot's displaced props; every other prop is (back) at its spawn. */
  sync(poses: PropPose[] | undefined) {
    const listed = new Set<number>();
    for (const x of poses ?? []) {
      const it = this.items.get(x.id);
      if (!it) continue;
      listed.add(x.id);
      it.tPos.set(x.p[0], x.p[1], x.p[2]);
      it.tRot.set(x.q[0], x.q[1], x.q[2], x.q[3]).normalize();
      it.moving = true;
    }
    for (const [id, it] of this.items) if (!listed.has(id) && (it.tPos.x !== it.spawn.pos.x || it.tPos.y !== it.spawn.pos.y || it.tPos.z !== it.spawn.pos.z)) {
      it.tPos.set(it.spawn.pos.x, it.spawn.pos.y, it.spawn.pos.z);
      it.tRot.set(...it.spawn.rot);
      it.moving = true;
    }
  }

  /** Per frame: ease each moving prop toward its latest pose (snapshots arrive at 15–30 Hz). */
  update(dt: number) {
    const k = 1 - Math.exp(-dt / 0.05);
    const touched = new Set<THREE.InstancedMesh>();
    for (const it of this.items.values()) {
      if (!it.moving) continue;
      // a respawn (or anything that jumps more than 3 m) snaps instead of flying across the map
      if (it.pos.distanceToSquared(it.tPos) > 9) { it.pos.copy(it.tPos); it.rot.copy(it.tRot); }
      else { it.pos.lerp(it.tPos, k); it.rot.slerp(it.tRot, k); }
      if (it.pos.distanceToSquared(it.tPos) < 1e-6 && Math.abs(it.rot.dot(it.tRot)) > 0.999999) { it.pos.copy(it.tPos); it.rot.copy(it.tRot); it.moving = false; }
      this.write(it);
      this.onPose?.(it.spawn.id, it.pos, it.rot);
      for (const m of it.meshes) touched.add(m);
    }
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
  }

  private write(it: Item) {
    _m.compose(_p.copy(it.pos), _q.copy(it.rot), _s);
    for (const m of it.meshes) m.setMatrixAt(it.index, _m);
  }

  dispose() {
    for (const c of this.root.children) if (c instanceof THREE.InstancedMesh) { c.geometry.dispose(); c.dispose(); }
    this.root.removeFromParent();
  }
}
