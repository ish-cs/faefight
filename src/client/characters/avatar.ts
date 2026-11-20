import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER } from '../../sim/constants';
import type { MatchEvent, PlayerState, WeaponKind } from '../../sim/types';
import { reloadClock, reloadPose, type ReloadPose } from '../firstPerson';
import { chooseClip } from './animState';
import { HAND_BONE, loadCharacters, type CharacterAssets } from './loader';
import { buildMuzzleFlash, buildWeapon } from './weapons';

const AIM_HOLD_S = 0.6; // keep the aim pose this long after a shot
const FLINCH_S = 0.32;
const PUNCH_S = 0.45;
const DEATH_SHOW_S = 1.9; // play the death animation, then hide (as the capsule did)
const FADE = 0.16;
const FLASH_MS = 55;
const SPINE = ['Abdomen', 'Torso', 'Chest'] as const;
const SPINE_SHARE = [0.25, 0.35, 0.4];
const UPPER_ARM = 'UpperArmR'; // GLTFLoader-sanitised "UpperArm.R"
const UPPER_ARM_L = 'UpperArmL';
const LOW_READY_RAD = 0.7; // armed idle: aim pose with the gun arm lowered this much
const LOW_READY_RATE = 8; // 1/s easing in/out of low ready

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _right = new THREE.Vector3();

/** Display-rate motion of one player (render.ts fills it: predicted locally, interpolated for others). */
export type Motion = { pos: THREE.Vector3; vel: THREE.Vector3; yaw: number; pitch: number };

/** 1/s: how quickly the animation's velocity follows the real one (blends locomotion clips smoothly). */
const VEL_SMOOTH_RATE = 12;

export type AvatarFrame = {
  pos: THREE.Vector3; // interpolated feet
  vel: THREE.Vector3; // interpolated velocity
  yaw: number;
  pitch: number;
  alive: boolean;
  equipped: WeaponKind;
  blinkHidden: boolean; // invulnerability blink
  /** Shield 0..100, drawn as a thin blue bar over the name tag (everyone's is visible). */
  shield: number;
  /** Sights up (holds the aim pose). */
  ads?: boolean;
  /** Reload choreography for this frame (null when not reloading). */
  reload?: ReloadPose | null;
};

/** Name tag sprite (white text on the island colour), drawn above remote players. */
function nameTag(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  const col = new THREE.Color(color);
  g.fillStyle = `rgba(${Math.round(col.r * 160)},${Math.round(col.g * 160)},${Math.round(col.b * 160)},1)`;
  g.beginPath(); g.roundRect(8, 10, 240, 44, 22); g.fill();
  g.fillStyle = '#fff';
  g.font = '600 26px "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text.slice(0, 16), 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Constant on-screen size so it stays readable across the map; no fog so distance doesn't wash it out.
  const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false });
  mat.color.setScalar(1.8); // pre-boost against tone mapping (same as render.ts labels)
  const s = new THREE.Sprite(mat);
  s.scale.set(0.12, 0.03, 1);
  s.renderOrder = 6;
  return s;
}

/** Thin shield bar sprite over a name tag: dark track always, blue fill for the shield, 4 × 25 ticks. */
function shieldBar(): { sprite: THREE.Sprite; draw(shield: number): void } {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 16;
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false });
  mat.color.setScalar(1.8);
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.1, 0.009, 1);
  sprite.renderOrder = 6;
  const draw = (shield: number) => {
    g.clearRect(0, 0, 256, 16);
    g.fillStyle = 'rgba(10,14,22,0.75)';
    g.beginPath(); g.roundRect(0, 2, 256, 12, 6); g.fill();
    const w = Math.max(0, Math.min(1, shield / 100)) * 252;
    if (w > 0) { g.fillStyle = '#4aa8ff'; g.beginPath(); g.roundRect(2, 4, w, 8, 4); g.fill(); }
    g.fillStyle = 'rgba(10,14,22,0.9)';
    for (const x of [64, 128, 192]) g.fillRect(x - 1, 2, 2, 12);
    tex.needsUpdate = true;
  };
  draw(0);
  return { sprite, draw };
}

/** One player's visual: skinned soldier (or the capsule fallback), gun, flash, name tag, hitbox. */
let _contact: { geo: THREE.BufferGeometry; mat: THREE.MeshBasicNodeMaterial } | null = null;
function contact() {
  if (_contact) return _contact;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('[characters] 2D canvas context unavailable');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  mat.name = 'contactShadow';
  _contact = { geo: new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2), mat };
  return _contact;
}
const contactGeo = () => contact().geo;
const contactMat = () => contact().mat;

export class Avatar {
  readonly group = new THREE.Group();
  /** Invisible capsule the crosshair ray hits (raycasting skinned meshes is slow and pose-dependent). */
  readonly hitbox: THREE.Mesh;
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private spine: (THREE.Bone | undefined)[] = [];
  /** Spine rotations as the mixer left them, before the aim bend (unkeyed bones would otherwise accumulate it). */
  private spineBase: THREE.Quaternion[] = [];
  private upperArm: THREE.Bone | undefined;
  private upperArmL: THREE.Bone | undefined;
  private gun: THREE.Group | null = null;
  private lowReady = 0;
  private hand: THREE.Object3D | null = null;
  private gripLocal: THREE.Matrix4 | null = null;
  private weaponKind: WeaponKind | null = null;
  private weapon: THREE.Group | null = null;
  private flash: THREE.Mesh;
  private flashUntil = 0;
  private tag: THREE.Sprite | null = null;
  private shieldTag: ReturnType<typeof shieldBar> | null = null;
  private shownShield = 0;
  private aimUntil = 0;
  private flinchUntil = 0;
  private punchUntil = 0;
  private wasAlive = true;
  alive = true;
  private diedAt = -1;
  private lastPos = new THREE.Vector3();
  private smoothVel = new THREE.Vector3();
  private materials: THREE.Material[] = [];

  /** soft ambient-occlusion contact blob under the feet (hidden while airborne) */
  private blob: THREE.Mesh | null = null;

  constructor(assets: CharacterAssets | null, p: PlayerState, color: number, isLocal: boolean) {
    const r = PLAYER.radius;
    this.hitbox = new THREE.Mesh(new THREE.CapsuleGeometry(r, PLAYER.height - 2 * r, 6, 12),
      new THREE.MeshStandardNodeMaterial({ color, roughness: 0.55 }));
    this.hitbox.position.y = PLAYER.height / 2;
    this.group.add(this.hitbox);
    this.flash = buildMuzzleFlash();

    if (assets) {
      this.buildModel(assets, p, color);
      this.blob = new THREE.Mesh(contactGeo(), contactMat());
      this.blob.position.y = 0.012;
      this.blob.renderOrder = 1;
      this.group.add(this.blob);
    } else {
      // Fallback look (model failed to load): the original capsule with a visor.
      this.hitbox.castShadow = true;
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.12), new THREE.MeshStandardNodeMaterial({ color: 0x15181c, roughness: 0.2, metalness: 0.4 }));
      visor.position.set(0, PLAYER.eyeHeight, -r + 0.02);
      this.group.add(visor);
    }
    if (!isLocal) {
      this.tag = nameTag(p.name, color);
      this.tag.position.y = PLAYER.height + 0.42;
      this.group.add(this.tag);
      this.shieldTag = shieldBar();
      this.shieldTag.sprite.position.y = PLAYER.height + 0.42;
      // Just above the tag on screen (sizeAttenuation off: offset in screen-space units via center).
      this.shieldTag.sprite.center.set(0.5, -1.85);
      this.group.add(this.shieldTag.sprite);
    }
    this.materials.push(this.hitbox.material as THREE.Material);
  }

  private buildModel(assets: CharacterAssets, p: PlayerState, color: number) {
    this.hitbox.visible = false; // still raycastable: Raycaster ignores .visible
    const variant = assets.variants[(p.isBot ? 1 : 0) % assets.variants.length];
    const model = cloneSkinned(variant.scene);
    model.scale.setScalar(assets.scale);
    model.position.y = -assets.footY * assets.scale;
    model.rotation.y = Math.PI; // Quaternius rigs face +Z; yaw 0 faces -Z
    // Team colour: tint this avatar's uniform (one cloned material; everything else stays shared).
    const team = new THREE.Color(color);
    let uniform: THREE.MeshStandardMaterial | null = null;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.frustumCulled = false; // bind-pose bounds don't follow the animation (death, lean)
      const swap = (mat: THREE.Material) => {
        if (mat.name !== variant.uniformMaterial) return mat;
        if (!uniform) {
          uniform = (mat as THREE.MeshStandardMaterial).clone();
          uniform.color.copy(team).multiplyScalar(0.55).lerp((mat as THREE.MeshStandardMaterial).color, 0.25);
          this.materials.push(uniform);
        }
        return uniform;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
    });
    if (!uniform) console.warn(`[characters] uniform material "${variant.uniformMaterial}" not found; team colour only on name tag`);
    this.group.add(model);
    this.model = model;

    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of assets.clips) this.actions.set(name, this.mixer.clipAction(clip));
    for (const once of ['Death', 'HitRecieve', 'Punch_Right']) {
      const a = this.actions.get(once);
      if (a) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    }
    // Airborne pose: the run cycle frozen mid-stride (the rig has no jump clip).
    const air = this.mixer.clipAction(assets.clips.get('Run')!.clone());
    air.time = 0.18;
    air.timeScale = 0;
    this.actions.set('Air', air);

    this.spine = SPINE.map((n) => model.getObjectByName(n) as THREE.Bone | undefined);
    this.upperArm = model.getObjectByName(UPPER_ARM) as THREE.Bone | undefined;
    if (this.upperArm) this.spine.push(this.upperArm); // restored each frame like the spine
    this.upperArmL = model.getObjectByName(UPPER_ARM_L) as THREE.Bone | undefined;
    if (this.upperArmL) this.spine.push(this.upperArmL);
    this.spineBase = this.spine.map((b) => (b ? b.quaternion.clone() : new THREE.Quaternion()));
    this.hand = model.getObjectByName(HAND_BONE)!;
    this.gripLocal = assets.gripLocal;
    this.current = this.actions.get('Idle')!;
    this.current.play();
  }

  onShot(weapon: WeaponKind, now: number) {
    if (weapon === 'fists') { this.punchUntil = now + PUNCH_S * 1000; return; }
    this.aimUntil = now + AIM_HOLD_S * 1000;
    this.flashUntil = now + FLASH_MS;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
  }

  onHit(now: number) { this.flinchUntil = now + FLINCH_S * 1000; }

  /** World position of this avatar's muzzle or ejection port (null with fists / hidden). */
  gunPoint(which: 'muzzle' | 'eject', out: THREE.Vector3): THREE.Vector3 | null {
    const local = this.gun?.userData[which] as THREE.Vector3 | undefined;
    if (!this.gun || !local || !this.group.visible) return null;
    this.gun.updateWorldMatrix(true, false);
    return out.copy(local).applyMatrix4(this.gun.matrixWorld);
  }

  private setWeapon(kind: WeaponKind) {
    if (kind === this.weaponKind) return;
    this.weaponKind = kind;
    if (this.weapon) { this.weapon.parent?.remove(this.weapon); this.weapon = null; }
    this.flash.parent?.remove(this.flash);
    const gun = buildWeapon(kind);
    this.gun = gun;
    if (!gun) return;
    const holder = new THREE.Group();
    if (this.hand && this.gripLocal) {
      this.gripLocal.decompose(holder.position, holder.quaternion, holder.scale);
      this.hand.add(holder);
    } else {
      // Capsule fallback: gun stub at the right side, pointing forward.
      holder.position.set(PLAYER.radius + 0.04, 1.2, -0.15);
      this.group.add(holder);
    }
    holder.add(gun);
    this.flash.position.copy(gun.userData.muzzle as THREE.Vector3);
    gun.add(this.flash);
    this.weapon = holder;
  }

  private fadeTo(name: string, ts: number) {
    const next = this.actions.get(name) ?? this.actions.get('Idle')!;
    if (name !== 'Air') next.timeScale = ts;
    if (next === this.current) return;
    const once = next.loop === THREE.LoopOnce;
    if (once || !next.isRunning()) next.reset();
    if (name === 'Air') { next.time = 0.18; next.timeScale = 0; }
    if (this.blob) this.blob.visible = name !== 'Air' && name !== 'Death';
    next.setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(next, name === 'Death' ? 0.1 : FADE, false);
    this.current = next;
  }

  update(f: AvatarFrame, dt: number, now: number) {
    if (f.alive && !this.wasAlive) { this.diedAt = -1; this.smoothVel.set(0, 0, 0); } // respawned
    if (!f.alive && this.wasAlive) this.diedAt = now;
    this.wasAlive = f.alive;
    this.alive = f.alive;

    const showDead = !f.alive && this.mixer !== null && this.diedAt >= 0 && now - this.diedAt < DEATH_SHOW_S * 1000;
    this.group.visible = f.alive || showDead;
    if (!this.group.visible) return;

    // Dead: stay where we fell (the sim may move the body to the respawn point).
    if (f.alive) { this.lastPos.copy(f.pos); this.group.rotation.y = f.yaw; }
    this.group.position.copy(this.lastPos);
    if (this.model) this.model.visible = !f.blinkHidden;
    else this.hitbox.visible = !f.blinkHidden;

    this.setWeapon(f.alive ? f.equipped : this.weaponKind ?? 'fists');
    this.flash.visible = now < this.flashUntil;
    if (f.ads) this.aimUntil = Math.max(this.aimUntil, now + 100);
    // Reload: tilt the gun in the hand, swap the visible mag/shell/rocket on the sim's beats.
    const r = f.alive ? f.reload ?? null : null;
    if (this.gun) {
      this.gun.rotation.set(r ? -r.tilt * 0.35 : 0, 0, r ? r.tilt * 0.7 : 0);
      const mag = this.gun.userData.mag as THREE.Mesh | undefined, home = this.gun.userData.magHome as THREE.Vector3 | undefined;
      if (mag && home) {
        mag.position.copy(home);
        if (r) { mag.position.y += r.magY; mag.position.z += r.magZ; }
        mag.visible = r ? r.magShow : f.equipped !== 'shotgun';
      }
    }
    if (this.tag) this.tag.visible = f.alive;
    if (this.shieldTag) {
      this.shieldTag.sprite.visible = f.alive;
      const sh = Math.ceil(f.shield);
      if (sh !== this.shownShield) { this.shownShield = sh; this.shieldTag.draw(sh); }
    }

    if (!this.mixer) return;
    this.smoothVel.lerp(f.vel, 1 - Math.exp(-VEL_SMOOTH_RATE * dt));
    const { name, ts } = chooseClip({
      alive: f.alive, vel: this.smoothVel, yaw: f.yaw, equipped: f.equipped,
      flinching: now < this.flinchUntil, punching: now < this.punchUntil, aiming: now < this.aimUntil && !r,
    });
    this.fadeTo(name, ts);
    this.spine.forEach((b, i) => b?.quaternion.copy(this.spineBase[i]));
    this.mixer.update(dt);
    this.spine.forEach((b, i) => b && this.spineBase[i].copy(b.quaternion));

    // Aim: bend the spine with the look pitch (up/down), split across three bones, about the body's
    // right axis in world space so it works whatever the bones' local axes are.
    if (f.alive && this.spine.length) {
      this.group.updateMatrixWorld(true);
      _right.set(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
      const pitch = THREE.MathUtils.clamp(f.pitch, -1.1, 1.1);
      SPINE.forEach((_, i) => this.bend(this.spine[i], pitch * SPINE_SHARE[i]));
      const wantLow = name === 'Idle_Gun_Pointing' && now >= this.aimUntil ? 1 : 0;
      this.lowReady += (wantLow - this.lowReady) * Math.min(1, LOW_READY_RATE * dt);
      if (this.lowReady > 0.01) this.bend(this.upperArm, -LOW_READY_RAD * this.lowReady);
      // Off hand drops to the magazine during the swap.
      if (r && r.hand > 0) this.bend(this.upperArmL, -0.45 * r.hand);
    }
  }

  /** Rotate a bone by `angle` about the body's right axis (_right, world space), whatever its local axes. */
  private bend(bone: THREE.Bone | undefined, angle: number) {
    if (!bone?.parent) return;
    // local' = parentWorld⁻¹ · R(world) · parentWorld · local
    bone.parent.getWorldQuaternion(_q);
    _q2.setFromAxisAngle(_right, angle);
    const inv = _q.clone().invert();
    bone.quaternion.premultiply(_q).premultiply(_q2).premultiply(inv);
    bone.updateMatrixWorld(true);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    for (const m of this.materials) m.dispose();
    this.hitbox.geometry.dispose();
    if (this.tag) { (this.tag.material as THREE.SpriteNodeMaterial).map?.dispose(); this.tag.material.dispose(); }
    if (this.shieldTag) { (this.shieldTag.sprite.material as THREE.SpriteNodeMaterial).map?.dispose(); this.shieldTag.sprite.material.dispose(); }
  }
}

/** Owns every player's avatar; render.ts feeds it snapshots each frame. */
export class CharacterSystem {
  private avatars = new Map<number, Avatar>();
  private assets: CharacterAssets | null = null;
  private lastNow = performance.now();
  private tmpMotion: Motion = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0 };
  private snapTime = -1;
  private snapAt = 0;
  /** Player whose avatar is hidden (the local player in first person); -1 = none. */
  hiddenId = -1;
  /** Resolves once the models are in (or failed — then the capsule fallback is used). */
  readonly ready: Promise<void>;

  constructor(private scene: THREE.Scene, private colorFor: (island: number) => number) {
    this.ready = loadCharacters().then(
      (a) => {
        this.assets = a;
        // Rebuild any capsule views made while loading.
        for (const av of this.avatars.values()) av.dispose();
        this.avatars.clear();
      },
      (err) => console.error('[characters] FAILED to load player models — falling back to capsules', err),
    );
  }

  get loaded() { return this.assets !== null; }

  private avatar(p: PlayerState, humanId: number): Avatar {
    let a = this.avatars.get(p.id);
    if (!a) {
      a = new Avatar(this.assets, p, this.colorFor(p.island), p.id === humanId);
      this.scene.add(a.group);
      this.avatars.set(p.id, a);
    }
    return a;
  }

  gunPoint(id: number, which: 'muzzle' | 'eject', out: THREE.Vector3): THREE.Vector3 | null {
    return this.avatars.get(id)?.gunPoint(which, out) ?? null;
  }

  onEvent(e: MatchEvent) {
    const now = performance.now();
    if (e.type === 'shot') this.avatars.get(e.data.by as number)?.onShot((e.data.weapon as WeaponKind) ?? 'pistol', now);
    else if (e.type === 'hit') this.avatars.get(e.data.target as number)?.onHit(now);
  }

  /**
   * players = current snapshot, prevOf(id) = same player in the previous snapshot, t = interpolation
   * alpha, posOf = render.ts's interpolated feet (handles teleports), localYaw = camera yaw for the
   * local player (smoother than the 30 Hz sim yaw). Pitch is the sim's aim pitch for everyone.
   */
  sync(players: PlayerState[], humanId: number, localYaw: number, simTime: number,
    motionOf: (id: number, out: Motion) => Motion | null) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (simTime !== this.snapTime) { this.snapTime = simTime; this.snapAt = now; }
    const m = this.tmpMotion;
    for (const p of players) {
      const a = this.avatar(p, humanId);
      m.yaw = p.yaw;
      m.pitch = p.pitch;
      if (!motionOf(p.id, m)) { m.pos.set(p.pos.x, p.pos.y, p.pos.z); m.vel.set(p.vel.x, p.vel.y, p.vel.z); }
      a.update({
        pos: m.pos, vel: m.vel, yaw: p.id === humanId ? localYaw : m.yaw, pitch: m.pitch, alive: p.alive, equipped: p.equipped,
        blinkHidden: simTime < p.invulnUntil && Math.floor(now / 120) % 2 === 0, shield: p.shield ?? 0,
        ads: p.ads,
        reload: (() => {
          const c = reloadClock(p, simTime + Math.min(0.1, (now - this.snapAt) / 1000));
          return c ? reloadPose(p.equipped, c.elapsed, c.duration, c.magStart, c.beats) : null;
        })(),
      }, dt, now);
      if (p.id === this.hiddenId) a.group.visible = false;
    }
    for (const [id, a] of this.avatars) if (!players.some((p) => p.id === id)) { a.dispose(); this.avatars.delete(id); }
  }

  /** Hitboxes the aim ray may hit: other players that are alive. */
  aimTargets(humanId: number, out: THREE.Object3D[]) {
    for (const [id, a] of this.avatars) if (id !== humanId && a.alive && a.group.visible) out.push(a.hitbox);
  }
}

