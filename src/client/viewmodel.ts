import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { PLAYER, WEAPONS } from '../sim/constants';
import type { MatchEvent, PlayerState, WeaponKind } from '../sim/types';
import { buildMuzzleFlash, buildWeapon } from './characters/weapons';
import {
  angleDelta, approach, bobOffset, bobRate, idleSway, recoilKick, reloadDip, toggleMode, type CameraMode,
} from './firstPerson';
import { activeKeymap, bindingLabel, isAction } from './keymap';
import { settings } from './settings/store';
import { ISLAND_COLORS, type Renderer } from './render';
import { SUN_DIR } from './world/sky';

/**
 * First-person view: the V toggle, the eye camera, and the viewmodel (arms + equipped weapon).
 * The viewmodel lives in its own tiny scene, drawn after the world with only depth cleared, so it
 * never clips into walls and never casts or receives world shadows.
 */

const VM_FOV = 58; // the viewmodel keeps its own (narrower) FOV so it doesn't stretch at 75°
const FLASH_MS = 55;
const PUNCH_S = 0.32;
const RAISE_RATE = 7; // 1/s, weapon-switch raise
const LAG_RATE = 12;

/** Where the grip sits in view space (camera looks -Z), plus where the support hand holds. */
const HOLD: Record<Exclude<WeaponKind, 'fists'>, { grip: [number, number, number]; left: [number, number, number]; elbowL: [number, number, number] }> = {
  pistol: { grip: [0.17, -0.155, -0.46], left: [-0.035, -0.02, 0.015], elbowL: [-0.16, -0.26, 0.32] },
  smg: { grip: [0.19, -0.2, -0.48], left: [0, 0.02, -0.2], elbowL: [-0.2, -0.24, 0.1] },
  shotgun: { grip: [0.2, -0.21, -0.52], left: [0, 0.015, -0.33], elbowL: [-0.22, -0.24, 0.0] },
  rifle: { grip: [0.2, -0.21, -0.52], left: [0, 0.02, -0.32], elbowL: [-0.22, -0.24, 0.0] },
};

const gloveMat = new THREE.MeshStandardNodeMaterial({ color: 0x45484d, roughness: 0.85, metalness: 0 });
const v3 = (a: [number, number, number]) => new THREE.Vector3(...a);
const _a = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/** A capsule-ish limb from a to b (local coords of the parent). */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 10), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, _a.copy(b).sub(a).normalize());
  return m;
}

function glove(size: [number, number, number], pos: THREE.Vector3, rx = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), gloveMat);
  m.position.copy(pos);
  m.rotation.x = rx;
  return m;
}

type Rig = { root: THREE.Group; flash: THREE.Mesh | null; fistR?: THREE.Group; fistL?: THREE.Group };

function buildGunRig(kind: Exclude<WeaponKind, 'fists'>, sleeve: THREE.Material): Rig {
  const h = HOLD[kind];
  const root = new THREE.Group();
  root.name = `viewmodel:${kind}`;
  const grip = new THREE.Group();
  grip.position.set(...h.grip);
  grip.rotation.y = 0.012; // toe the muzzle in toward the crosshair
  root.add(grip);
  const gun = buildWeapon(kind)!;
  grip.add(gun);
  // Right hand around the grip, forearm running back and down out of frame.
  grip.add(glove([0.055, 0.085, 0.075], new THREE.Vector3(0.004, -0.005, 0.012), -0.25));
  grip.add(limb(new THREE.Vector3(0.01, -0.035, 0.05), new THREE.Vector3(0.09, -0.2, 0.42), 0.034, 0.042, sleeve));
  // Support hand.
  const l = v3(h.left);
  grip.add(glove(kind === 'pistol' ? [0.05, 0.07, 0.07] : [0.075, 0.05, 0.09], l, kind === 'pistol' ? -0.25 : 0));
  grip.add(limb(l.clone().add(new THREE.Vector3(-0.012, -0.03, 0.04)), v3(h.elbowL), 0.032, 0.042, sleeve));
  const flash = buildMuzzleFlash();
  flash.position.copy(gun.userData.muzzle as THREE.Vector3);
  gun.add(flash);
  return { root, flash };
}

function buildFistsRig(sleeve: THREE.Material): Rig {
  const root = new THREE.Group();
  root.name = 'viewmodel:fists';
  const fist = (side: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(0.16 * side, -0.14, -0.42);
    g.rotation.set(0.25, -0.15 * side, 0.2 * side);
    g.add(glove([0.06, 0.055, 0.075], new THREE.Vector3(0, 0, 0)));
    g.add(limb(new THREE.Vector3(0, -0.01, 0.04), new THREE.Vector3(0.05 * side, -0.1, 0.42), 0.036, 0.044, sleeve));
    root.add(g);
    return g;
  };
  return { root, flash: null, fistR: fist(1), fistL: fist(-1) };
}

export class FirstPersonView {
  /** Persisted in Settings → Gameplay (V toggles it). */
  get mode(): CameraMode { return settings.get().gameplay.cameraMode; }
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(VM_FOV, 1, 0.01, 10);
  /** Motion offsets (sway/bob/recoil/lag) applied on top of each rig's rest pose. */
  private motion = new THREE.Group();
  private rigs = new Map<WeaponKind, Rig>();
  private rig: Rig | null = null;
  private kind: WeaponKind | null = null;
  private sleeve = new THREE.MeshStandardNodeMaterial({ color: 0x3a4048, roughness: 0.9, metalness: 0 });
  private sleeveIsland = -1;
  private active = false;
  private quad: THREE.QuadMesh | null = null;
  private clearColor = new THREE.Color();
  private toastEl: HTMLDivElement | null = null;
  private toastHide = 0;
  // animation state
  private t = 0;
  private phase = 0;
  private moveK = 0;
  private shotAt = -1e9;
  private punchSide: 1 | -1 = 1;
  private reloadStart = -1;
  private dip = 0;
  private raise = 1;
  private lastYaw = 0;
  private lastPitch = 0;
  private lagYaw = 0;
  private lagPitch = 0;

  constructor(private renderer: Renderer, private enabled: () => boolean) {
    this.scene.add(this.cam);
    this.cam.add(this.motion);
    const sun = new THREE.DirectionalLight(0xffe6c2, 3.4);
    sun.position.copy(SUN_DIR).multiplyScalar(5);
    this.scene.add(sun, new THREE.HemisphereLight(0xcfe8ff, 0x8a7a58, 0.9));
    window.addEventListener('keydown', (e) => {
      if (!isAction('camera', e.code) || e.repeat || !this.enabled()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.setMode(toggleMode(this.mode));
    });
  }

  setMode(mode: CameraMode) {
    settings.update((s) => { s.gameplay.cameraMode = mode; });
    console.info(`[firstPerson] camera → ${mode}`);
    const key = bindingLabel(activeKeymap(), 'camera');
    this.toast(mode === 'first' ? `FIRST PERSON  (${key})` : `THIRD PERSON  (${key})`);
  }

  private toast(text: string) {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.dataset.testid = 'camera-toast';
      this.toastEl.style.cssText = 'position:fixed;left:50%;top:84px;transform:translateX(-50%);padding:6px 14px;border-radius:8px;'
        + 'background:rgba(15,20,26,.72);color:#fff;font:600 13px "Helvetica Neue",Arial,sans-serif;letter-spacing:.06em;z-index:50;pointer-events:none';
      document.body.append(this.toastEl);
    }
    this.toastEl.textContent = text;
    this.toastEl.style.display = 'block';
    this.toastHide = performance.now() + 1500;
    setTimeout(() => { if (this.toastEl && performance.now() >= this.toastHide) this.toastEl.style.display = 'none'; }, 1600);
  }

  /** True while the first-person camera drives the view (FP mode and alive; dead falls back to third person). */
  get isActive() { return this.active; }

  /**
   * Place the world camera at the eye if first person applies; returns false (and restores the
   * third-person FOV / own avatar) otherwise, so the caller runs the third-person camera instead.
   */
  updateCamera(feet: THREE.Vector3, yaw: number, pitch: number, me: PlayerState, humanId: number): boolean {
    const cam = this.renderer.camera;
    this.active = this.mode === 'first' && me.alive;
    const v = settings.get().video;
    const fov = this.active ? v.fovFirst : v.fovThird;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.renderer.characters.hiddenId = this.active ? humanId : -1;
    if (!this.active) return false;
    cam.position.set(feet.x, feet.y + PLAYER.eyeHeight, feet.z);
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
    return true;
  }

  onEvents(events: MatchEvent[], humanId: number) {
    for (const e of events) {
      if (e.type !== 'shot' || e.data.by !== humanId) continue;
      this.shotAt = performance.now();
      this.punchSide = this.punchSide === 1 ? -1 : 1;
      if (this.rig?.flash) {
        this.rig.flash.rotation.z = Math.random() * Math.PI;
        this.rig.flash.scale.setScalar(0.8 + Math.random() * 0.5);
      }
    }
  }

  private setWeapon(kind: WeaponKind, island: number) {
    if (island !== this.sleeveIsland) {
      this.sleeveIsland = island;
      this.sleeve.color.set(ISLAND_COLORS[island % 8]).multiplyScalar(0.45).lerp(new THREE.Color(0x3a4048), 0.35);
    }
    if (kind === this.kind) return;
    if (this.rig) this.motion.remove(this.rig.root);
    let rig = this.rigs.get(kind);
    if (!rig) {
      rig = kind === 'fists' ? buildFistsRig(this.sleeve) : buildGunRig(kind, this.sleeve);
      rig.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
      this.rigs.set(kind, rig);
    }
    this.motion.add(rig.root);
    this.rig = rig;
    if (this.kind !== null) this.raise = 0; // switching: bring the new weapon up from below
    this.kind = kind;
    this.reloadStart = -1;
  }

  /** Animate and draw the viewmodel over the already-rendered frame. Call after Renderer.render. */
  render(me: PlayerState | undefined, yaw: number, pitch: number, dt: number) {
    if (!this.active || !me) return;
    const now = performance.now();
    this.setWeapon(me.equipped, me.island);
    const rig = this.rig!;
    this.t += dt;

    // Walk / run bob, faded in with speed and suppressed in the air.
    const speed = Math.hypot(me.vel.x, me.vel.z);
    const grounded = Math.abs(me.vel.y) < 0.8;
    this.moveK += ((grounded ? Math.min(1, speed / PLAYER.walk) : 0) - this.moveK) * approach(8, dt);
    this.phase += bobRate(speed) * dt;
    const bob = bobOffset(this.phase, speed);
    const sway = idleSway(this.t);

    // Turn lag: the weapon trails the view a little, springing back.
    const yawVel = angleDelta(yaw, this.lastYaw) / Math.max(dt, 1e-3);
    const pitchVel = (pitch - this.lastPitch) / Math.max(dt, 1e-3);
    this.lastYaw = yaw; this.lastPitch = pitch;
    const clampV = (v: number) => THREE.MathUtils.clamp(v, -6, 6);
    this.lagYaw += (clampV(yawVel) - this.lagYaw) * approach(LAG_RATE, dt);
    this.lagPitch += (clampV(pitchVel) - this.lagPitch) * approach(LAG_RATE, dt);

    // Reload: dip the weapon over the sim's reload time.
    if (me.reloadUntil > 0 && me.equipped !== 'fists') {
      if (this.reloadStart < 0) this.reloadStart = now;
      const p = (now - this.reloadStart) / (WEAPONS[me.equipped].reloadSec * 1000);
      this.dip = reloadDip(Math.min(0.999, p));
    } else {
      this.reloadStart = -1;
      this.dip += (0 - this.dip) * approach(10, dt);
    }
    this.raise += (1 - this.raise) * approach(RAISE_RATE, dt);

    const since = (now - this.shotAt) / 1000;
    const kick = me.equipped === 'fists' ? 0 : recoilKick(since);
    const kickScale = me.equipped === 'shotgun' ? 1.6 : me.equipped === 'rifle' ? 1.2 : me.equipped === 'smg' ? 0.6 : 1;
    const k = kick * kickScale;
    const lowered = (1 - this.raise);

    const m = this.motion;
    m.position.set(
      sway.x * (1 - this.moveK) + bob.x * this.moveK + this.lagYaw * 0.006,
      sway.y * (1 - this.moveK) + bob.y * this.moveK - this.lagPitch * 0.005 + k * 0.012 - this.dip * 0.09 - lowered * 0.22,
      k * 0.05,
    );
    m.rotation.set(
      k * 0.1 - this.lagPitch * 0.012 - this.dip * 0.5 - lowered * 0.6,
      -this.lagYaw * 0.014,
      bob.roll * this.moveK + this.dip * 0.35,
    );

    if (rig.flash) rig.flash.visible = since * 1000 < FLASH_MS;
    if (rig.fistR && rig.fistL) {
      const punch = since < PUNCH_S ? Math.sin((since / PUNCH_S) * Math.PI) : 0;
      const [hit, rest] = this.punchSide === 1 ? [rig.fistR, rig.fistL] : [rig.fistL, rig.fistR];
      const side = this.punchSide;
      hit.position.set(0.16 * side - 0.12 * side * punch, -0.14 + 0.06 * punch, -0.42 - 0.22 * punch);
      rest.position.set(-0.16 * side, -0.14, -0.42);
    }

    // Draw: same orientation as the world camera (world-space sun lighting), own FOV + near plane.
    const gpu = this.renderer.gpu;
    this.scene.environment = this.renderer.scene.environment;
    this.scene.environmentIntensity = this.renderer.scene.environmentIntensity;
    const aspect = this.renderer.camera.aspect;
    if (this.cam.aspect !== aspect) { this.cam.aspect = aspect; this.cam.updateProjectionMatrix(); }
    this.cam.quaternion.copy(this.renderer.camera.quaternion);
    // The world's final (tone-mapped, sRGB) image is already in the canvas. Draw the viewmodel pass
    // into its own transparent target, tone-map it in the composite shader, and alpha-blend it over
    // with the renderer's own output transform off (otherwise the renderer would route this draw
    // through its internal framebuffer target and overwrite the world).
    if (!this.quad) {
      const vm = pass(this.scene, this.cam, { samples: 4 });
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = renderOutput(vm, gpu.toneMapping, gpu.outputColorSpace);
      mat.transparent = true;
      mat.depthTest = false;
      mat.depthWrite = false;
      this.quad = new THREE.QuadMesh(mat);
    }
    const keep = { tm: gpu.toneMapping, cs: gpu.outputColorSpace, auto: gpu.autoClear, alpha: gpu.getClearAlpha() };
    gpu.getClearColor(this.clearColor);
    gpu.toneMapping = THREE.NoToneMapping;
    gpu.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    gpu.autoClear = false;
    gpu.setClearColor(0x000000, 0);
    try { this.quad.render(gpu); } finally {
      gpu.toneMapping = keep.tm;
      gpu.outputColorSpace = keep.cs;
      gpu.autoClear = keep.auto;
      gpu.setClearColor(this.clearColor, keep.alpha);
    }
  }
}
