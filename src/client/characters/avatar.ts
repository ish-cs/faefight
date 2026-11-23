import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER } from '../../sim/constants';
import type { MatchEvent, PlayerState, Vec3, WeaponKind } from '../../sim/types';
import { reloadClock, reloadPose, type ReloadPose } from '../firstPerson';
import { chooseClip } from './animState';
import { EMOTE_BONES, emoteClip, emotePose, type BodyAxis, type EmoteBone } from './emotePose';
import { QUICK_CHAT, QUIP_SHOW_SEC, type EmoteId, type QuipId } from '../../sim/emotes';
import { lods } from '../world/lod';
import { soldierLook } from './body';
import { breath, flinchEnvelope, LOCOMOTION_CLIPS, StrideIK, strideFor } from './locomotion';
import { BODY_LOD, HAND_BONE, loadCharacters, makeBody, type Body, type CharacterAssets } from './loader';
import { buildMuzzleFlash, buildWeapon } from './weapons';
import { Ragdoll } from './ragdoll';
import { deathKick, ragdollBudget, RP, RP_COUNT } from './ragdollSim';

const AIM_HOLD_S = 0.6; // keep the aim pose this long after a shot
const FLINCH_S = 0.32;
const FLINCH_ADD_S = 0.38; // additive flinch (light hits): over whatever the legs are doing
const HEAVY_HIT = 35; // damage from which a hit plays the full-body hit reaction
const LOCO_FADE = 0.24;
const DEATH_TURN_S = 0.22; // turn to face the killer while starting to fall (the clip falls backward)
const PUNCH_S = 0.45;
const DEATH_SHOW_S = 1.9; // play the death animation, then hide (as the capsule did)
const CORPSE_S = 10; // a ragdoll lies this long when nobody respawns into the avatar (eliminated), then sinks away
const SINK_S = 1.2;
const BLAST_S = 0.35; // an explosion this recent and close threw the body
const BLAST_M = 7;
const EXPLOSIVE = new Set(['rocket', 'grenade', 'charge', 'barrel', 'propane']);
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
const _axis = new THREE.Vector3();
const _q3 = new THREE.Quaternion();
const _sphere = new THREE.Sphere();
const _proj = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

/**
 * Level of detail. Each body is ONE skinned draw (all parts merged, see body.ts) in three detail levels (BODY_LOD).
 * - Culling: a sphere around the avatar that also covers its death pose (and its shadow, which at this sun
 *   elevation falls within ~2.5 m) — so the main pass and each shadow cascade cull avatars properly.
 * - Shadows: the body casts out to shadowBodyM; the gun only up close (shadowAllM); nothing far away.
 * - Animation: off-screen avatars skip the mixer (time is kept, so they resume in step); far ones update at half rate.
 */
export const CHAR_LOD = { cullRadius: 2.2, shadowRadius: 2.6, shadowAllM: 30, shadowBodyM: 90, animHalfRateM: 45 };

/** Body detail level for a camera distance, sticky within `hysteresis` of each threshold. */
export function bodyLod(dist: number, current: number, scale = lods.scale): 0 | 1 | 2 {
  // the shared LOD manager's preset × frame-time governor scale (world/lod.ts) stretches/shrinks every distance
  dist /= Math.max(0.1, scale);
  const h = BODY_LOD.hysteresis;
  const lo1 = current >= 1 ? BODY_LOD.lod1 - h : BODY_LOD.lod1 + h;
  const lo2 = current >= 2 ? BODY_LOD.lod2 - h : BODY_LOD.lod2 + h;
  return dist >= lo2 ? 2 : dist >= lo1 ? 1 : 0;
}

/** Stable per-player look seed (skin tone, beard, eyes). */
const lookSeed = (p: PlayerState) => [...p.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, p.id * 977 + p.island * 131);

/** Display-rate motion of one player (render.ts fills it: predicted locally, interpolated for others). */
export type Motion = { pos: THREE.Vector3; vel: THREE.Vector3; yaw: number; pitch: number };

/** 1/s: how quickly the animation's velocity follows the real one (blends locomotion clips smoothly). */
const VEL_SMOOTH_RATE = 12;

/** What a death ragdoll needs from the world: the floor under the body, and the blast that threw it (if any). */
export type RagdollEnv = {
  floorAt(x: number, z: number, feetY: number): number;
  blastNear(pos: THREE.Vector3, now: number): THREE.Vector3 | null;
  /** The body hit the floor at `speed` m/s (a thud sound). */
  thud(pos: Vec3, speed: number): void;
};

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
  /** On a grappling hook rope (own hook out): arms up along the aim. */
  grapple?: boolean;
  /** Reload choreography for this frame (null when not reloading). */
  reload?: ReloadPose | null;
  /** Emote playing, `t` s in (sim clock); null/absent = none. */
  emote?: { id: EmoteId; t: number } | null;
  /** Quick-chat line to show in a speech bubble (null/absent = none). */
  quip?: QuipId | null;
};

/** Speech bubble sprite (dark text on a white rounded bubble with a tail), above the name tag. */
function speechBubble(): { sprite: THREE.Sprite; draw(text: string): void } {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 96;
  const g = c.getContext('2d');
  if (!g) throw new Error('[characters] 2D canvas context unavailable');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  mat.color.setScalar(1.6);
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.15, 0.045, 1);
  sprite.center.set(0.5, -0.55); // above the name tag + shield bar
  sprite.renderOrder = 7;
  const draw = (text: string) => {
    g.clearRect(0, 0, 320, 96);
    g.font = '700 34px "Helvetica Neue", Helvetica, Arial, sans-serif';
    const w = Math.min(300, Math.max(90, g.measureText(text).width + 44));
    const x = (320 - w) / 2;
    g.fillStyle = 'rgba(255,255,255,0.96)';
    g.beginPath(); g.roundRect(x, 6, w, 62, 22); g.fill();
    g.beginPath(); g.moveTo(148, 66); g.lineTo(160, 88); g.lineTo(172, 66); g.closePath(); g.fill();
    g.fillStyle = '#10151c';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 160, 38, 280);
    tex.needsUpdate = true;
  };
  return { sprite, draw };
}

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
  private allyTag = false;
  private shieldTag: ReturnType<typeof shieldBar> | null = null;
  private shownShield = 0;
  private bubble: ReturnType<typeof speechBubble> | null = null;
  private shownQuip: QuipId | null = null;
  /** Bones the emote overlay turns, and their pose as the mixer left it (unkeyed bones would accumulate turns). */
  private emoteBones = new Map<EmoteBone, THREE.Bone>();
  private emoteBase = new Map<EmoteBone, THREE.Quaternion>();
  private aimUntil = 0;
  private flinchUntil = 0;
  /** Additive flinch: start time (ms), twist side, and where the last hit came from (death facing). */
  private flinchAt = -1e9;
  private flinchSide = 1;
  private hitFrom: THREE.Vector3 | null = null;
  /** The last hit's detail (ragdoll push): where it landed, head or body, weapon. */
  private hitPos: THREE.Vector3 | null = null;
  private hitPart: string | undefined;
  private hitWeapon: string | undefined;
  /** Death ragdoll (null = alive, or the death clip when over the ragdoll budget). */
  private ragdoll: Ragdoll | null = null;
  private ragdollAwake = false;
  ragdollEnv: RagdollEnv | null = null;
  private deathYaw: number | null = null;
  private deathYaw0 = 0;
  private effort = 0;
  private stride: StrideIK | null = null;
  private speeds: Map<string, number> | null = null;
  private punchUntil = 0;
  private wasAlive = true;
  alive = true;
  private diedAt = -1;
  private lastPos = new THREE.Vector3();
  private smoothVel = new THREE.Vector3();
  private materials: THREE.Material[] = [];
  private body: Body | null = null;
  private lod = -1;
  private shadowTier = -1;
  /** LOD inputs for the next update(): set by CharacterSystem from the camera each frame. */
  lodOnScreen = true;
  lodDist = 0;
  private animSkipped = 0;
  private animFrame = 0;

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

  /** Teams: a teammate's name tag draws through walls (where they are, always). No-op when unchanged. */
  allyMarker(on: boolean) {
    if (!this.tag || this.allyTag === on) return;
    this.allyTag = on;
    for (const sp of [this.tag, this.shieldTag?.sprite]) {
      if (!sp) continue;
      const mat = sp.material as THREE.SpriteNodeMaterial;
      mat.depthTest = !on;
      mat.needsUpdate = true;
      sp.renderOrder = on ? 9 : 6;
    }
  }

  private buildModel(assets: CharacterAssets, p: PlayerState, color: number) {
    this.hitbox.visible = false; // still raycastable: Raycaster ignores .visible
    const body = makeBody(assets, soldierLook(lookSeed(p)), color);
    const model = body.model;
    model.scale.setScalar(assets.scale);
    model.position.y = -assets.footY * assets.scale;
    model.rotation.y = Math.PI; // Quaternius rigs face +Z; yaw 0 faces -Z
    this.group.add(model);
    this.model = model;
    this.body = body;
    this.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4();
    for (const m of body.lods) {
      // Bind-pose bounds don't follow the animation (death, lean): cull against a fixed sphere round the avatar,
      // the avatar-space sphere (centre 0.9 m up, CHAR_LOD.cullRadius) in this mesh's local frame.
      inv.copy(m.matrixWorld).invert();
      const scale = m.matrixWorld.getMaxScaleOnAxis() || 1;
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0).applyMatrix4(this.group.matrixWorld).applyMatrix4(inv), (CHAR_LOD.cullRadius + CHAR_LOD.shadowRadius) / scale);
      m.frustumCulled = true;
    }

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
    for (const n of EMOTE_BONES) {
      const b = model.getObjectByName(n) as THREE.Bone | undefined;
      if (b) { this.emoteBones.set(n, b); this.emoteBase.set(n, b.quaternion.clone()); }
      else console.warn(`[characters] emote bone ${n} missing; that part of the emotes is skipped`);
    }
    this.hand = model.getObjectByName(HAND_BONE)!;
    this.gripLocal = assets.gripLocal;
    this.stride = new StrideIK(model);
    this.speeds = assets.speeds;
    this.chest = model.getObjectByName('Chest') as THREE.Bone | undefined;
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

  /** Took a hit: heavy hits play the full hit reaction, light ones an additive flinch; `from` = shooter's position. */
  onHit(now: number, amount = 0, from: THREE.Vector3 | null = null, info: { pos?: { x: number; y: number; z: number }; part?: string; weapon?: string } = {}) {
    if (amount >= HEAVY_HIT) this.flinchUntil = now + FLINCH_S * 1000;
    this.flinchAt = now;
    this.flinchSide = Math.random() < 0.5 ? -1 : 1;
    if (from) (this.hitFrom ??= new THREE.Vector3()).copy(from);
    if (info.pos) (this.hitPos ??= new THREE.Vector3()).set(info.pos.x, info.pos.y, info.pos.z);
    else this.hitPos = null;
    this.hitPart = info.part;
    this.hitWeapon = info.weapon;
    this.hitAt = now;
  }
  private hitAt = -1e9;

  /**
   * Go limp: a ragdoll from the current pose, thrown by the killing blow (away from the shooter, or out of a blast
   * with some lift) on top of the body's own momentum. False when it can't (capsule fallback, over the budget).
   */
  private startRagdoll(now: number, vel: THREE.Vector3): boolean {
    if (!this.model || !this.mixer || !ragdollBudget.acquire()) return false;
    const pos = this.lastPos;
    this.group.position.copy(pos);
    this.group.updateMatrixWorld(true);
    const yaw = this.group.rotation.y;
    const airborne = Math.abs(vel.y) > 1.5;
    const floor = airborne && this.ragdollEnv ? Math.min(pos.y, this.ragdollEnv.floorAt(pos.x, pos.z, pos.y)) : pos.y;
    let r: Ragdoll;
    try {
      r = new Ragdoll(this.model, { x: -Math.sin(yaw), z: -Math.cos(yaw) }, floor);
    } catch (err) {
      ragdollBudget.release();
      console.error('[characters] ragdoll failed, playing the death clip', err);
      return false;
    }
    const blast = this.ragdollEnv?.blastNear(pos, now) ?? null;
    const fresh = now - this.hitAt < 1000; // the killing blow, not some hit long before
    const weapon = fresh ? this.hitWeapon : undefined;
    const explosive = blast !== null || EXPLOSIVE.has(weapon ?? '');
    const k = deathKick(weapon, explosive);
    const src = blast ?? (fresh ? this.hitFrom : null);
    let dx = src ? pos.x - src.x : Math.sin(yaw), dz = src ? pos.z - src.z : Math.cos(yaw); // no source: fall backward
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    // the point the blow landed on takes it all, the torso most of it, the limbs follow
    const hitIdx = !fresh ? RP.chest : this.hitPart === 'head' ? RP.head : this.hitPos && this.hitPos.y < pos.y + 0.9 ? RP.pelvis : RP.chest;
    const spin = (Math.random() - 0.5) * 1.2;
    for (let i = 0; i < RP_COUNT; i++) {
      const w = i === hitIdx ? 1 : i <= RP.head || i === RP.shL || i === RP.shR ? 0.7 : 0.4;
      const tw = i === RP.shL || i === RP.hipL ? spin : i === RP.shR || i === RP.hipR ? -spin : 0;
      r.sim.kick(i, vel.x * 0.8 + dx * k.push * w - dz * tw, Math.max(0, vel.y) * 0.5 + k.lift * (explosive ? 1 : w), vel.z * 0.8 + dz * k.push * w + dx * tw);
    }
    this.ragdoll = r;
    this.ragdollAwake = true;
    if (this.blob) this.blob.visible = false;
    return true;
  }

  private endRagdoll() {
    if (!this.ragdoll) return;
    if (this.ragdollAwake) ragdollBudget.release();
    this.ragdollAwake = false;
    this.ragdoll.restore();
    this.ragdoll = null;
    if (this.blob) this.blob.visible = true;
  }

  /** World position of the right hand (where a grappling rope starts); null before the model loads or hidden. */
  handPoint(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.hand || !this.group.visible) return null;
    this.hand.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.hand.matrixWorld);
  }

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
    this.weaponDirty = true;
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
    // walk ↔ run ↔ strafe: start the new cycle at the same phase so the feet don't jump mid-blend
    const loco = this.current && LOCOMOTION_CLIPS[name] && LOCOMOTION_CLIPS[this.current.getClip().name];
    if (loco && this.current) next.time = (this.current.time / this.current.getClip().duration) * next.getClip().duration;
    if (this.blob) this.blob.visible = name !== 'Air' && name !== 'Death';
    next.setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(next, name === 'Death' ? 0.1 : loco ? LOCO_FADE : FADE, false);
    this.current = next;
  }

  update(f: AvatarFrame, dt: number, now: number) {
    if (f.alive && !this.wasAlive) { // respawned
      this.diedAt = -1; this.smoothVel.set(0, 0, 0); this.deathYaw = null; this.hitFrom = null; this.hitPos = null;
      this.endRagdoll();
    }
    if (!f.alive && this.wasAlive) {
      this.diedAt = now;
      // fall away from whoever landed the last hit: face them (the death clip falls backward)
      this.deathYaw0 = this.group.rotation.y;
      this.deathYaw = this.hitFrom ? Math.atan2(-(this.hitFrom.x - this.lastPos.x), -(this.hitFrom.z - this.lastPos.z)) : null;
      if (this.wasShown && this.startRagdoll(now, this.smoothVel)) this.deathYaw = null;
    }
    this.wasAlive = f.alive;
    this.alive = f.alive;

    const deadFor = now - this.diedAt;
    const showDead = !f.alive && this.mixer !== null && this.diedAt >= 0 && deadFor < (this.ragdoll ? CORPSE_S : DEATH_SHOW_S) * 1000;
    this.group.visible = f.alive || showDead;
    this.wasShown = this.group.visible;
    if (!this.group.visible) { if (this.ragdoll && !f.alive) this.endRagdoll(); return; }

    // Dead: stay where we fell (the sim may move the body to the respawn point).
    if (f.alive) { this.lastPos.copy(f.pos); this.group.rotation.y = f.yaw; }
    else if (this.deathYaw !== null) {
      const k = Math.min(1, (now - this.diedAt) / (DEATH_TURN_S * 1000));
      const d = Math.atan2(Math.sin(this.deathYaw - this.deathYaw0), Math.cos(this.deathYaw - this.deathYaw0));
      this.group.rotation.y = this.deathYaw0 + d * k * k * (3 - 2 * k);
    }
    this.group.position.copy(this.lastPos);
    if (this.ragdoll) {
      // a corpse nobody respawns into sinks away at the end (bones are frozen by then: the whole body goes down)
      const sink = deadFor - (CORPSE_S - SINK_S) * 1000;
      if (sink > 0) this.group.position.y -= 0.6 * (sink / (SINK_S * 1000));
    }
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
    const quip = f.alive ? f.quip ?? null : null;
    if (quip && !this.bubble) {
      this.bubble = speechBubble();
      this.bubble.sprite.position.y = PLAYER.height + 0.42;
      this.group.add(this.bubble.sprite);
    }
    if (this.bubble) {
      this.bubble.sprite.visible = quip !== null;
      if (quip && quip !== this.shownQuip) { this.shownQuip = quip; this.bubble.draw(QUICK_CHAT[quip]); }
    }
    const emote = f.alive ? f.emote ?? null : null;
    // Hands are busy during an emote: the gun goes away.
    if (this.weapon) this.weapon.visible = !emote;
    if (this.shieldTag) {
      this.shieldTag.sprite.visible = f.alive;
      const sh = Math.ceil(f.shield);
      if (sh !== this.shownShield) { this.shownShield = sh; this.shieldTag.draw(sh); }
    }

    this.applyLod();
    if (!this.mixer) return;
    if (this.ragdoll) {
      if (this.ragdollAwake && !this.ragdoll.step(dt)) { this.ragdollAwake = false; ragdollBudget.release(); }
      const hit = this.ragdoll.sim.takeImpact();
      if (hit > 0 && this.ragdollEnv) {
        const P = this.ragdoll.sim.pos;
        this.ragdollEnv.thud({ x: P[RP.pelvis * 3], y: P[RP.pelvis * 3 + 1], z: P[RP.pelvis * 3 + 2] }, hit);
      }
      return;
    }
    // Animation LOD: nothing to see off screen; far away, half rate. Skipped time is caught up on the next update.
    this.animFrame++;
    if (!this.lodOnScreen || (this.lodDist > CHAR_LOD.animHalfRateM && this.animFrame % 2 === 1)) { this.animSkipped += dt; return; }
    dt += this.animSkipped;
    this.animSkipped = 0;
    this.smoothVel.lerp(f.vel, 1 - Math.exp(-VEL_SMOOTH_RATE * dt));
    const chosen = emote ? { name: emoteClip(emote.id), ts: 1 } : chooseClip({
      alive: f.alive, vel: this.smoothVel, yaw: f.yaw, equipped: f.equipped,
      flinching: now < this.flinchUntil, punching: now < this.punchUntil, aiming: now < this.aimUntil && !r,
    });
    const name = chosen.name;
    // Locomotion: playback rate + stride length from the clip's own ground speed, so planted feet don't skate.
    const speed = Math.hypot(this.smoothVel.x, this.smoothVel.z);
    const gait = LOCOMOTION_CLIPS[name] ? strideFor(speed, this.speeds?.get(name)) : { ts: chosen.ts, stride: 1 };
    this.fadeTo(name, gait.ts);
    this.spine.forEach((b, i) => b?.quaternion.copy(this.spineBase[i]));
    for (const [n, b] of this.emoteBones) b.quaternion.copy(this.emoteBase.get(n)!);
    this.mixer.update(dt);
    this.spine.forEach((b, i) => b && this.spineBase[i].copy(b.quaternion));
    for (const [n, b] of this.emoteBones) this.emoteBase.get(n)!.copy(b.quaternion);

    if (emote && f.alive) {
      // Emote overlay instead of the aim bend (the look pitch would fight the pose).
      this.group.updateMatrixWorld(true);
      for (const turn of emotePose(emote.id, emote.t)) this.turn(this.emoteBones.get(turn.bone), turn.axis, turn.angle, f.yaw);
      return;
    }
    if (gait.stride > 1 && this.stride && this.lodDist < CHAR_LOD.animHalfRateM && this.current === this.actions.get(name)) {
      this.group.updateMatrixWorld(true);
      this.stride.apply(gait.stride, _dir.set(this.smoothVel.x, 0, this.smoothVel.z).normalize());
    }

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
      // Grappling: both arms up along the rope (the spine already carries the look pitch).
      if (f.grapple) { this.bend(this.upperArm, 1.45); this.bend(this.upperArmL, 1.2); }
      // Breathing (deeper after running) and the additive flinch: lean back + twist, springing out.
      this.effort += ((speed > 4 ? 1 : 0) - this.effort) * Math.min(1, dt * (speed > 4 ? 0.5 : 0.15));
      this.bend(this.chest, breath(now / 1000, this.effort));
      const fl = flinchEnvelope((now - this.flinchAt) / 1000, FLINCH_ADD_S);
      if (fl > 0) {
        this.bend(this.chest, -0.22 * fl);
        this.bend(this.spine[1], -0.1 * fl);
        this.rotWorld(this.chest, _up, 0.16 * fl * this.flinchSide);
      }
    }
  }
  private chest: THREE.Bone | undefined;

  /** Forget the cached LOD / shadow tier: the next update re-applies them to the meshes. */
  relod() { this.lod = -1; this.shadowTier = -1; }

  /** Body detail + shadow casting by distance (only touches the meshes when something changes). */
  private applyLod() {
    const d = this.lodDist;
    if (this.body) {
      const lod = bodyLod(d, this.lod);
      if (lod !== this.lod) { this.lod = lod; this.body.lods.forEach((m, i) => { m.visible = i === lod; }); }
    }
    const ls = lods.scale;
    const tier = d < CHAR_LOD.shadowAllM * ls ? 0 : d < CHAR_LOD.shadowBodyM * ls ? 1 : 2;
    if (tier === this.shadowTier && !this.weaponDirty) return;
    this.shadowTier = tier;
    this.weaponDirty = false;
    if (this.body) for (const m of this.body.lods) m.castShadow = tier < 2;
    this.weapon?.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      o.userData.castsShadow ??= o.castShadow; // as built (weapons.ts)
      o.castShadow = tier === 0 && o.userData.castsShadow;
    });
  }
  private weaponDirty = false;
  /** Was drawn last frame (a death while hidden or culled by interest doesn't start a ragdoll from a stale pose). */
  private wasShown = false;

  /** Rotate a bone by `angle` about one of the body's axes (world space, from the facing `yaw`). */
  private turn(bone: THREE.Bone | undefined, axis: BodyAxis, angle: number, yaw: number) {
    if (axis === 'right') _axis.set(Math.cos(yaw), 0, -Math.sin(yaw));
    else if (axis === 'up') _axis.set(0, 1, 0);
    else _axis.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.rotWorld(bone, _axis, angle);
  }

  /** Rotate a bone by `angle` about the body's right axis (_right, world space), whatever its local axes. */
  private bend(bone: THREE.Bone | undefined, angle: number) { this.rotWorld(bone, _right, angle); }

  /** Rotate a bone by `angle` about a world-space axis. */
  private rotWorld(bone: THREE.Bone | undefined, axis: THREE.Vector3, angle: number) {
    if (!bone?.parent) return;
    // local' = parentWorld⁻¹ · R(world) · parentWorld · local
    bone.parent.getWorldQuaternion(_q);
    _q2.setFromAxisAngle(axis, angle);
    const inv = _q3.copy(_q).invert();
    bone.quaternion.premultiply(_q).premultiply(_q2).premultiply(inv);
    bone.updateMatrixWorld(true);
  }

  dispose() {
    this.endRagdoll();
    this.group.parent?.remove(this.group);
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    for (const m of this.materials) m.dispose();
    this.hitbox.geometry.dispose();
    if (this.tag) { (this.tag.material as THREE.SpriteNodeMaterial).map?.dispose(); this.tag.material.dispose(); }
    if (this.shieldTag) { (this.shieldTag.sprite.material as THREE.SpriteNodeMaterial).map?.dispose(); this.shieldTag.sprite.material.dispose(); }
    if (this.bubble) { (this.bubble.sprite.material as THREE.SpriteNodeMaterial).map?.dispose(); this.bubble.sprite.material.dispose(); }
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
  /** The view camera, for LOD (distance shadows, culling-aware animation). */
  camera: THREE.Camera | null = null;
  private frustum = new THREE.Frustum();
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

  /**
   * Re-apply every avatar's LOD visibility on its next update. The loading warm-up shows every hidden mesh and
   * then hides them again; a LOD switch during its frames (e.g. the first frame's far LOD → near) would otherwise
   * leave the cached LOD's mesh hidden, an invisible avatar until the next LOD change.
   */
  relod() { for (const a of this.avatars.values()) a.relod(); }

  private avatar(p: PlayerState, humanId: number): Avatar {
    let a = this.avatars.get(p.id);
    if (!a) {
      a = new Avatar(this.assets, p, this.colorFor(p.island), p.id === humanId);
      a.ragdollEnv = this.ragdollEnv;
      this.scene.add(a.group);
      this.avatars.set(p.id, a);
    }
    return a;
  }

  gunPoint(id: number, which: 'muzzle' | 'eject', out: THREE.Vector3): THREE.Vector3 | null {
    return this.avatars.get(id)?.gunPoint(which, out) ?? null;
  }

  handPoint(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    return this.avatars.get(id)?.handPoint(out) ?? null;
  }

  onEvent(e: MatchEvent) {
    const now = performance.now();
    // echo = the host confirming a shot we already showed (client shot prediction): animated once.
    if (e.type === 'shot') { if (!e.data.echo) this.avatars.get(e.data.by as number)?.onShot((e.data.weapon as WeaponKind) ?? 'pistol', now); }
    else if (e.type === 'hit') {
      const shooter = this.avatars.get(e.data.by as number);
      const d = e.data as { pos?: Vec3; part?: string; weapon?: string };
      this.avatars.get(e.data.target as number)?.onHit(now, Number(e.data.amount) || 0, shooter ? shooter.group.position : null, d);
    } else if (e.type === 'explosion') {
      const pos = e.data.pos as Vec3 | undefined;
      if (!pos) return;
      const b = this.blasts[this.blastAt++ % this.blasts.length];
      b.pos.set(pos.x, pos.y, pos.z);
      b.at = now;
    }
  }

  /** Recent explosions (ring): a body that dies next to one is thrown out of it. */
  private blasts = Array.from({ length: 6 }, () => ({ pos: new THREE.Vector3(), at: -1e9 }));
  private blastAt = 0;
  /** Floor under a ragdoll that died airborne (render.ts sets it from the map); default: where the feet were. */
  floorAt: ((x: number, z: number) => number | null) | null = null;
  /** A ragdoll landed (render.ts plays the thud). */
  onThud: ((pos: Vec3, speed: number) => void) | null = null;
  private readonly ragdollEnv: RagdollEnv = {
    floorAt: (x, z, feetY) => this.floorAt?.(x, z) ?? feetY,
    thud: (pos, speed) => this.onThud?.(pos, speed),
    blastNear: (pos, now) => {
      let best: THREE.Vector3 | null = null, bd = BLAST_M;
      for (const b of this.blasts) {
        const d = b.pos.distanceTo(pos);
        if (now - b.at < BLAST_S * 1000 && d < bd) { bd = d; best = b.pos; }
      }
      return best;
    },
  };

  /**
   * players = current snapshot, prevOf(id) = same player in the previous snapshot, t = interpolation
   * alpha, posOf = render.ts's interpolated feet (handles teleports), localYaw = camera yaw for the
   * local player (smoother than the 30 Hz sim yaw). Pitch is the sim's aim pitch for everyone.
   */
  sync(players: PlayerState[], humanId: number, localYaw: number, simTime: number,
    motionOf: (id: number, out: Motion) => Motion | null, hidden?: readonly number[]) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (simTime !== this.snapTime) { this.snapTime = simTime; this.snapAt = now; }
    const m = this.tmpMotion;
    const cam = this.camera;
    if (cam) {
      cam.updateMatrixWorld();
      this.frustum.setFromProjectionMatrix(_proj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    }
    const simNow = simTime + Math.min(0.1, (now - this.snapAt) / 1000);
    const myTeam = players.find((p) => p.id === humanId)?.team;
    for (const p of players) {
      // Not perceivable (interest management): keep the avatar, just don't show it — rebuilding a skinned
      // model each time someone steps round a corner is a frame hitch.
      if (hidden?.includes(p.id)) { const h = this.avatars.get(p.id); if (h) { h.group.visible = false; h.alive = false; } continue; }
      const a = this.avatar(p, humanId);
      a.allyMarker(myTeam !== undefined && p.team === myTeam && p.id !== humanId);
      m.yaw = p.yaw;
      m.pitch = p.pitch;
      if (!motionOf(p.id, m)) { m.pos.set(p.pos.x, p.pos.y, p.pos.z); m.vel.set(p.vel.x, p.vel.y, p.vel.z); }
      if (cam) {
        // Where it's drawn this frame: alive = this frame's motion; dead = where it fell (a new avatar's
        // group still sits at the origin, which would pick the far LOD for its first frame).
        const pos = p.alive ? m.pos : a.group.position;
        a.lodDist = cam.position.distanceTo(pos);
        _sphere.center.set(pos.x, pos.y + 0.9, pos.z);
        _sphere.radius = CHAR_LOD.cullRadius + CHAR_LOD.shadowRadius;
        a.lodOnScreen = this.frustum.intersectsSphere(_sphere);
      }
      a.update({
        pos: m.pos, vel: m.vel, yaw: p.id === humanId ? localYaw : m.yaw, pitch: m.pitch, alive: p.alive, equipped: p.equipped,
        blinkHidden: simTime < p.invulnUntil && Math.floor(now / 120) % 2 === 0, shield: p.shield ?? 0,
        ads: p.ads,
        grapple: !!p.hook && p.hook.st !== 3,
        emote: p.emote ? { id: p.emote.id, t: simNow - p.emote.at } : null,
        quip: p.quip && simNow - p.quip.at < QUIP_SHOW_SEC ? p.quip.id : null,
        reload: (() => {
          const c = reloadClock(p, simTime + Math.min(0.1, (now - this.snapAt) / 1000));
          return c ? reloadPose(p.equipped, c.elapsed, c.duration, c.magStart, c.beats) : null;
        })(),
      }, dt, now);
      if (p.id === this.hiddenId) a.group.visible = false;
    }
    if (this.avatars.size > players.length)
      for (const [id, a] of this.avatars) if (!players.some((p) => p.id === id)) { a.dispose(); this.avatars.delete(id); }
  }

  /** Hitboxes the aim ray may hit: other players that are alive. */
  /** Which player an aim-ray hit (one of aimTargets) belongs to. */
  playerOf(obj: THREE.Object3D): number | null {
    for (const [id, a] of this.avatars) if (a.hitbox === obj) return id;
    return null;
  }

  aimTargets(humanId: number, out: THREE.Object3D[]) {
    for (const [id, a] of this.avatars) if (id !== humanId && a.alive && a.group.visible) out.push(a.hitbox);
  }
}

