import * as THREE from 'three/webgpu';
import { TRAP } from '../../sim/constants';
import type { MatchEvent, TrapNet, Vec3 } from '../../sim/types';
import { merge, part, mat } from './geo';
import type { Particles } from './particles';

/**
 * Spike traps (sim/traps.ts; snapshot `traps`): a weathered steel plate with a bolted rim and a 5×5 grid
 * of steel spikes whose tips just poke out. When it springs (`fired`, sim time) the spikes shoot out
 * (~60 ms), hold, then sink back. Floor traps lie flat; wall traps are the same model turned so the spikes
 * point along forward(rotY). Two InstancedMeshes (plate, spikes) for every trap; matrices are rewritten
 * only when the set changes or a trap is animating. Plus one translucent ghost for placing.
 */

/** Spike travel (0 retracted .. 1 out) `dt` seconds after the trap fired: snap out, hold, ease back. */
export function spikeExtension(dt: number): number {
  if (!(dt >= 0)) return 0;
  if (dt < OUT_SEC) return dt / OUT_SEC;
  if (dt < OUT_SEC + HOLD_SEC) return 1;
  const k = (dt - OUT_SEC - HOLD_SEC) / BACK_SEC;
  if (k >= 1) return 0;
  return 1 - k * k * (3 - 2 * k);
}
const OUT_SEC = 0.06, HOLD_SEC = 0.4, BACK_SEC = 0.5;
/** Animation length: past this a fired trap is at rest again. */
export const SPIKE_ANIM_SEC = OUT_SEC + HOLD_SEC + BACK_SEC;

const CAP = 32;
const H = TRAP.half, T = TRAP.thick;
/** Spike length when fully out; retracted they are scaled to just their tips. */
const SPIKE_LEN = 0.36;
const REST = 0.06;

/** Plate (local frame: base at y 0, spikes point +Y). */
function plateGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(new THREE.BoxGeometry(2 * H - 0.06, T * 0.7, 2 * H - 0.06), mat(0, T * 0.35, 0), 0x4a4843));
  // Raised rim (four bars) and corner bolts.
  for (const s of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(2 * H, T, 0.05), mat(0, T / 2, s * (H - 0.025)), 0x3a3936));
    parts.push(part(new THREE.BoxGeometry(0.05, T, 2 * H - 0.1), mat(s * (H - 0.025), T / 2, 0), 0x3a3936));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    parts.push(part(new THREE.CylinderGeometry(0.022, 0.022, 0.02, 6), mat(sx * (H - 0.025), T + 0.008, sz * (H - 0.025)), 0x6b665c));
  // Holes the spikes come through: dark rings.
  for (const [x, z] of grid()) parts.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.004, 8), mat(x, T * 0.7 + 0.001, z), 0x141414));
  return merge(parts);
}

/** Spikes (local frame: base at y 0, tips at SPIKE_LEN): instance-scaled along Y to retract. */
function spikeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, z] of grid()) parts.push(part(new THREE.ConeGeometry(0.022, SPIKE_LEN, 6), mat(x, SPIKE_LEN / 2, z), 0xffffff));
  return merge(parts);
}

function grid(): [number, number][] {
  const out: [number, number][] = [];
  const step = (2 * H - 0.24) / 4;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) out.push([-H + 0.12 + i * step, -H + 0.12 + j * step]);
  return out;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3();
const _x = new THREE.Vector3(1, 0, 0), _y = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** Orientation of a trap: floor = turn about Y; wall = turn, then tip local +Y onto forward (-Z). */
function orient(rotY: number, wall: boolean, out: THREE.Quaternion): THREE.Quaternion {
  out.setFromAxisAngle(_y, rotY);
  if (wall) out.multiply(_q2.setFromAxisAngle(_x, -Math.PI / 2));
  return out;
}

export class TrapLayer {
  readonly root = new THREE.Group();
  private plates: THREE.InstancedMesh;
  private spikes: THREE.InstancedMesh;
  private list: TrapNet[] = [];
  private dirty = false;
  private animating = false;
  private ghost: THREE.Group;
  private ghostMat = new THREE.MeshBasicNodeMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.45, depthWrite: false });

  constructor() {
    this.root.name = 'traps';
    const plateMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.55 });
    plateMat.name = 'trap:plate';
    const spikeMat = new THREE.MeshStandardNodeMaterial({ color: 0x8d9296, roughness: 0.32, metalness: 0.9 });
    spikeMat.name = 'trap:spikes';
    const plateGeo = plateGeometry(), spikeGeo = spikeGeometry();
    this.plates = new THREE.InstancedMesh(plateGeo, plateMat, CAP);
    this.spikes = new THREE.InstancedMesh(spikeGeo, spikeMat, CAP);
    for (const m of [this.plates, this.spikes]) {
      m.count = 0;
      m.frustumCulled = false; // instances are spread over the map
      m.receiveShadow = true;
      this.root.add(m);
    }
    this.plates.castShadow = true;
    this.ghost = new THREE.Group();
    const gp = new THREE.Mesh(plateGeo, this.ghostMat), gs = new THREE.Mesh(spikeGeo, this.ghostMat);
    gs.scale.set(1, 0.25, 1);
    gs.position.y = T * 0.7;
    gp.renderOrder = gs.renderOrder = 10;
    this.ghost.add(gp, gs);
    this.ghost.visible = false;
    this.root.add(this.ghost);
  }

  /** Snapshot state (absent = none). */
  sync(traps: TrapNet[] | undefined): void {
    const next = traps ?? [];
    if (next === this.list) return;
    this.list = next;
    this.dirty = true;
  }

  /** Per frame, at the sim time the world is shown at. */
  frame(simT: number): void {
    if (!this.dirty && !this.animating) return;
    this.dirty = false;
    let anim = false;
    const n = Math.min(CAP, this.list.length);
    for (let i = 0; i < n; i++) {
      const t = this.list[i];
      const dt = t.fired < 0 ? -1 : simT - t.fired;
      if (dt >= 0 && dt < SPIKE_ANIM_SEC) anim = true;
      // Scheduled but not yet shown (render time lags the snapshot): keep checking.
      if (t.fired >= 0 && dt < 0) anim = true;
      const e = spikeExtension(dt);
      orient(t.rotY, t.wall, _q);
      _p.set(t.pos.x, t.pos.y, t.pos.z);
      this.plates.setMatrixAt(i, _m.compose(_p, _q, _s.set(1, 1, 1)));
      // Spikes rise from the plate face (local +Y by T*0.7), scaled along their length: at rest only the tips show.
      _m.multiply(_t.makeTranslation(0, T * 0.7, 0)).multiply(_t2.makeScale(1, REST + (1 - REST) * e, 1));
      this.spikes.setMatrixAt(i, _m);
    }
    for (let i = n; i < this.plates.count; i++) { this.plates.setMatrixAt(i, ZERO); this.spikes.setMatrixAt(i, ZERO); }
    this.plates.count = this.spikes.count = n;
    this.plates.instanceMatrix.needsUpdate = this.spikes.instanceMatrix.needsUpdate = true;
    this.animating = anim;
  }

  /** Placement ghost (null hides it). */
  setGhost(pos: Vec3 | null, rotY = 0, wall = false, ok = false): void {
    if (!pos) { this.ghost.visible = false; return; }
    this.ghost.visible = true;
    this.ghost.position.set(pos.x, pos.y + (wall ? 0 : 0.01), pos.z);
    orient(rotY, wall, this.ghost.quaternion);
    if (wall) this.ghost.position.addScaledVector(_p.set(0, 0, -1).applyQuaternion(_q.setFromAxisAngle(_y, rotY)), 0.01);
    this.ghostMat.color.setHex(ok ? 0x3ddc84 : 0xff4d4d).multiplyScalar(2.2);
  }

  /** 'trap' events: a few sparks when it springs, steel bits when it breaks. */
  onEvent(e: MatchEvent, particles: Particles): void {
    if (e.type !== 'trap') return;
    const p = e.data.pos as Vec3 | undefined;
    if (!p) return;
    if (e.data.what === 'fired') {
      for (let i = 0; i < 6; i++)
        particles.sparks.spawn(p.x + rr(-0.4, 0.4), p.y + 0.1, p.z + rr(-0.4, 0.4), rr(-1, 1), rr(1, 2.5), rr(-1, 1), 0.25, 0.05, 0.01, 1, 0.8, 0.5, 1, 6, 1);
    } else if (e.data.what === 'broken') {
      for (let i = 0; i < 10; i++)
        particles.debris.spawn(p.x, p.y + 0.1, p.z, rr(-2.5, 2.5), rr(1.5, 4), rr(-2.5, 2.5), rr(0.03, 0.08), 0.015, rr(0.02, 0.05), 0x55524c, rr(1.2, 2), p.y - 0.05);
      for (let i = 0; i < 8; i++)
        particles.sparks.spawn(p.x, p.y + 0.1, p.z, rr(-2, 2), rr(1, 3), rr(-2, 2), 0.3, 0.05, 0.01, 1, 0.75, 0.4, 1, 6, 1);
    }
  }

  dispose(): void {
    this.plates.geometry.dispose(); this.spikes.geometry.dispose();
    (this.plates.material as THREE.Material).dispose(); (this.spikes.material as THREE.Material).dispose();
    this.ghostMat.dispose();
    this.root.removeFromParent();
  }
}

const _t = new THREE.Matrix4(), _t2 = new THREE.Matrix4();
const rr = (a: number, b: number) => a + (b - a) * Math.random();
