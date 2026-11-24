import * as THREE from 'three/webgpu';
import { lods } from '../world/lod';
import { npcLook } from './body';
import { lookTurn } from './npcLook';
import { bodyLod, CHAR_LOD } from './avatar';
import { loadCharacters, makeBody, type Body, type CharacterAssets } from './loader';
import { npcSpots, npcSpotsVersion, type NpcSpot as Spot } from './npcSpots';

/**
 * Shop keepers: the island shops' dock workers and the centre's potion seller, as animated bodies (same rig and
 * material system as the players, civilian outfits). The static map art registers where they stand (world/props.ts,
 * mapProps.ts); NpcSystem builds them once the rig is loaded. Idle behaviour: alternate idle clips (weight shifts),
 * turn the head toward the nearest player in range, wave when someone walks up.
 */


const LOOK_RANGE = 9; // m: heads turn toward players closer than this
const WAVE_RANGE = 4.5; // m: walking up this close gets a wave
const WAVE_COOLDOWN_S = 9;
const ACTIVE_RANGE = 70; // m: beyond this (or off screen) the keeper is not animated
const NECK_SHARE = 0.35;

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _sphere = new THREE.Sphere(), _frustum = new THREE.Frustum(), _proj = new THREE.Matrix4();

class Npc {
  readonly root = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private idle: THREE.AnimationAction[];
  private wave: THREE.AnimationAction;
  private current: THREE.AnimationAction;
  private head: THREE.Bone | undefined;
  private neck: THREE.Bone | undefined;
  /** head / neck rest pose: restored before the mixer runs, so a bone the clips don't animate never keeps the look */
  private headRest = new THREE.Quaternion();
  private neckRest = new THREE.Quaternion();
  /** this frame's clip pose of head / neck: the look turn is set relative to it */
  private headBase = new THREE.Quaternion();
  private neckBase = new THREE.Quaternion();
  private yaw = 0;
  private pitch = 0;
  private nextIdleSwap: number;
  private waveReadyAt = 0;
  private wasNear = false;
  private lod = -1;
  private body: Body;
  private skipped = 0;
  readonly pos = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(assets: CharacterAssets, spot: Spot, seed: number) {
    this.body = makeBody(assets, npcLook(spot.role, seed), null);
    const model = this.body.model;
    model.scale.setScalar(assets.scale);
    model.position.y = -assets.footY * assets.scale;
    this.root.add(model);
    spot.matrix.decompose(this.root.position, this.root.quaternion, this.root.scale);
    this.root.updateMatrixWorld(true);
    this.pos.copy(this.root.position);
    this.fwd.set(0, 0, 1).applyQuaternion(this.root.quaternion).setY(0).normalize();
    const inv = new THREE.Matrix4();
    for (const m of this.body.lods) {
      inv.copy(m.matrixWorld).invert();
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0).applyMatrix4(this.root.matrixWorld).applyMatrix4(inv), 1.6 / (m.matrixWorld.getMaxScaleOnAxis() || 1));
    }
    this.mixer = new THREE.AnimationMixer(model);
    const clip = (n: string) => { const c = assets.clips.get(n); if (!c) throw new Error(`[npcs] clip ${n} missing`); return c; };
    this.idle = ['Idle', 'Idle_Neutral'].map((n) => this.mixer.clipAction(clip(n)));
    this.wave = this.mixer.clipAction(clip('Wave'));
    this.wave.setLoop(THREE.LoopOnce, 1);
    this.wave.clampWhenFinished = false;
    const r = (seed * 0.618) % 1;
    this.current = this.idle[seed % 2];
    this.current.time = r * this.current.getClip().duration; // keepers don't breathe in sync
    this.current.timeScale = 0.9 + r * 0.2;
    this.current.play();
    this.nextIdleSwap = 5 + r * 6;
    this.head = model.getObjectByName('Head') as THREE.Bone | undefined;
    this.neck = model.getObjectByName('Neck') as THREE.Bone | undefined;
    if (this.head) this.headRest.copy(this.head.quaternion);
    if (this.neck) this.neckRest.copy(this.neck.quaternion);
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.wave) this.fadeTo(this.idle[0], 0.45);
    });
  }

  private fadeTo(next: THREE.AnimationAction, s: number) {
    if (next === this.current) return;
    next.reset().setEffectiveWeight(1).play();
    this.current.crossFadeTo(next, s, false);
    this.current = next;
  }

  relod() { this.lod = -1; }

  /** `target` = nearest player's head position in range (null = none); `near` = someone within WAVE_RANGE. */
  update(dt: number, t: number, camDist: number, onScreen: boolean, target: THREE.Vector3 | null, near: boolean) {
    const lod = bodyLod(camDist, this.lod);
    if (lod !== this.lod) { this.lod = lod; this.body.lods.forEach((m, i) => { m.visible = i === lod; }); }
    for (const m of this.body.lods) m.castShadow = camDist < CHAR_LOD.shadowBodyM * lods.scale;
    if (!onScreen || camDist > ACTIVE_RANGE) { this.skipped += dt; return; }
    dt += this.skipped;
    this.skipped = 0;

    if (near && !this.wasNear && t >= this.waveReadyAt && this.current !== this.wave) {
      this.waveReadyAt = t + WAVE_COOLDOWN_S;
      this.fadeTo(this.wave, 0.25);
    }
    this.wasNear = near;
    if (this.current !== this.wave && t >= this.nextIdleSwap) {
      this.nextIdleSwap = t + 6 + Math.random() * 7;
      this.fadeTo(this.current === this.idle[0] ? this.idle[1] : this.idle[0], 1.2);
    }
    // Head look is set from the clip pose each frame. It used to be premultiplied onto the bone's current rotation,
    // and the clips don't animate Head/Neck, so the turn compounded every frame: the keeper's head spun.
    this.head?.quaternion.copy(this.headRest);
    this.neck?.quaternion.copy(this.neckRest);
    this.mixer.update(dt);
    if (this.head) this.headBase.copy(this.head.quaternion);
    if (this.neck) this.neckBase.copy(this.neck.quaternion);

    // head follow: yaw toward the target (clamped to a natural neck turn), a little pitch
    let wantYaw = 0, wantPitch = 0;
    if (target) {
      _v.copy(target).sub(this.pos);
      const flat = Math.hypot(_v.x, _v.z) || 1;
      const ang = Math.atan2(this.fwd.x * _v.z - this.fwd.z * _v.x, this.fwd.x * _v.x + this.fwd.z * _v.z); // + = to the keeper's left? (handled by axis sign)
      wantYaw = THREE.MathUtils.clamp(-ang, -1.15, 1.15);
      wantPitch = THREE.MathUtils.clamp(Math.atan2(_v.y - 1.6, flat), -0.45, 0.35);
    }
    const k = 1 - Math.exp(-4 * dt);
    this.yaw += (wantYaw - this.yaw) * k;
    this.pitch += (wantPitch - this.pitch) * k;
    if (Math.abs(this.yaw) + Math.abs(this.pitch) > 1e-3) {
      this.root.updateMatrixWorld(true);
      if (this.neck) lookTurn(this.neck, this.neckBase, this.yaw * NECK_SHARE, this.pitch * NECK_SHARE, this.fwd);
      if (this.head) lookTurn(this.head, this.headBase, this.yaw * (1 - NECK_SHARE), this.pitch * (1 - NECK_SHARE), this.fwd);
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.body.model);
  }
}

export class NpcSystem {
  private npcs: Npc[] = [];
  private builtVersion = -1;
  private assets: CharacterAssets | null = null;
  private t = 0;

  constructor(private scene: THREE.Scene) {
    loadCharacters().then((a) => { this.assets = a; this.sync(); }, (err) => console.error('[npcs] rig failed to load — no shop keepers', err));
  }

  /** Build the keepers for the current map now if the rig is in (else when it arrives): before the shader warm-up. */
  sync() {
    if (this.assets && this.builtVersion !== npcSpotsVersion()) this.rebuild(this.assets);
  }

  /** Forget the cached LOD so the next frame re-applies body-mesh visibility (after the warm-up forced it). */
  relod() { for (const n of this.npcs) n.relod(); }

  /** Call each frame: builds keepers when the map's spots change, animates the ones in view. `players` = feet. */
  frame(dt: number, camera: THREE.Camera, players: readonly THREE.Vector3[]) {
    this.t += dt;
    this.sync();
    if (!this.npcs.length) return;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const n of this.npcs) {
      let best: THREE.Vector3 | null = null, bd = LOOK_RANGE;
      for (const p of players) { const d = p.distanceTo(n.pos); if (d < bd) { bd = d; best = p; } }
      const target = best ? _w.copy(best).setY(best.y + 1.6) : null;
      _sphere.center.copy(n.pos).setY(n.pos.y + 0.9);
      _sphere.radius = 1.6;
      n.update(dt, this.t, camera.position.distanceTo(n.pos), _frustum.intersectsSphere(_sphere), target, bd < WAVE_RANGE);
    }
  }

  private rebuild(assets: CharacterAssets) {
    this.builtVersion = npcSpotsVersion();
    for (const n of this.npcs) n.dispose();
    this.npcs = npcSpots().map((s, i) => {
      const n = new Npc(assets, s, i * 7 + (s.role === 'potion' ? 3 : 1));
      this.scene.add(n.root);
      return n;
    });
    if (this.npcs.length) console.info(`[npcs] ${this.npcs.length} shop keepers`);
  }

  get count() { return this.npcs.length; }
}
