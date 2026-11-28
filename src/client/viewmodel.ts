import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { PLAYER, WEAPONS } from '../sim/constants';
import type { MatchEvent, PlayerState, Vec3, WeaponKind } from '../sim/types';
import { bodyMaterial } from './characters/charMaterials';
import { handGeometry } from './characters/hands';
import { buildMuzzleFlash, buildWeapon } from './characters/weapons';
import {
  adsFov, angleDelta, approach, blastShake, bobOffset, bobRate, cameraBob, heavyHit, HIT_STOP, hitStopScale, idleSway, PUNCH_SCALE, recoilKick,
  reloadClock, reloadPose, toggleMode, type CameraMode,
} from './firstPerson';
import { activeKeymap, bindingLabel, isAction } from './keymap';
import { settings } from './settings/store';
import type { Renderer } from './render';
import { islandColor } from './colors';
import { SUN_DIR } from './world/sky';
import { dayNightState, lightU } from './world/lightUniforms';

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

type V = [number, number, number];
/**
 * Where the grip sits in view space (camera looks -Z), where the support hand holds, and the grip
 * position that puts the sights on the eye line when aiming down sights.
 */
const HOLD: Record<Exclude<WeaponKind, 'fists'>, { grip: V; left: V; elbowL: V; ads: V }> = {
  pistol: { grip: [0.17, -0.155, -0.46], left: [-0.035, -0.02, 0.015], elbowL: [-0.16, -0.26, 0.32], ads: [0, -0.088, -0.36] },
  smg: { grip: [0.19, -0.2, -0.48], left: [0, 0.02, -0.2], elbowL: [-0.2, -0.24, 0.1], ads: [0, -0.125, -0.42] },
  shotgun: { grip: [0.2, -0.21, -0.52], left: [0, 0.015, -0.33], elbowL: [-0.22, -0.24, 0.0], ads: [0, -0.112, -0.62] },
  rifle: { grip: [0.2, -0.21, -0.52], left: [0, 0.02, -0.32], elbowL: [-0.22, -0.24, 0.0], ads: [0, -0.15, -0.46] },
  rocket: { grip: [0.21, -0.2, -0.36], left: [0, 0.01, -0.27], elbowL: [-0.2, -0.26, 0.05], ads: [0.07, -0.16, -0.3] },
  sniper: { grip: [0.2, -0.2, -0.5], left: [0, 0.02, -0.36], elbowL: [-0.22, -0.24, -0.02], ads: [0, -0.155, -0.38] },
};
/** Recoil feel: viewmodel kick-back (m) and muzzle climb (rad) per unit of kick. */
const VM_KICK: Record<WeaponKind, { back: number; climb: number }> = {
  fists: { back: 0, climb: 0 }, pistol: { back: 0.045, climb: 0.16 }, smg: { back: 0.025, climb: 0.06 },
  shotgun: { back: 0.09, climb: 0.22 }, rifle: { back: 0.04, climb: 0.08 }, rocket: { back: 0.12, climb: 0.12 },
  sniper: { back: 0.1, climb: 0.1 },
};

const v3 = (a: [number, number, number]) => new THREE.Vector3(...a);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _qi = new THREE.Quaternion();
const _bob = { x: 0, y: 0, roll: 0 }, _sway = { x: 0, y: 0 }, _cbob = { x: 0, y: 0, roll: 0 };
/** Hit-stop zoom punch (fraction of the view) at full screen-shake intensity. */
const HIT_ZOOM = 0.03;

/** Gripped cylinder per gun, in the grip frame: the pistol grip (right hand) and where the support hand holds. */
const GRIPS: Record<Exclude<WeaponKind, 'fists'>, { tilt: number; left: { center: V; axis: V; radius: number; palm: V; wrist: V; thumbWrap?: boolean } }> = {
  pistol: { tilt: -0.25, left: { center: [-0.004, -0.02, 0.006], axis: [0, -0.97, 0.25], radius: 0.036, palm: [-1, 0, -0.35], wrist: [-0.06, -0.07, 0.05] } },
  smg: { tilt: -0.3, left: { center: [0, 0.062, -0.19], axis: [0, 0, 1], radius: 0.034, palm: [-0.6, -1, 0], wrist: [-0.05, 0.0, -0.13] } },
  shotgun: { tilt: -0.35, left: { center: [0, 0.064, -0.33], axis: [0, 0, 1], radius: 0.031, palm: [-0.6, -1, 0], wrist: [-0.05, 0.0, -0.27] } },
  rifle: { tilt: -0.3, left: { center: [0, 0.074, -0.32], axis: [0, 0, 1], radius: 0.031, palm: [-0.6, -1, 0], wrist: [-0.05, 0.005, -0.26] } },
  rocket: { tilt: -0.3, left: { center: [0, 0.01, -0.27], axis: [0, -0.98, 0.2], radius: 0.019, palm: [-0.8, 0, 0.6], wrist: [-0.035, -0.07, -0.2], thumbWrap: true } },
  sniper: { tilt: -0.3, left: { center: [0, 0.045, -0.36], axis: [0, 0, 1], radius: 0.033, palm: [-0.6, -1, 0], wrist: [-0.05, -0.02, -0.3] } },
};

type Rig = {
  root: THREE.Group; flash: THREE.Mesh | null; fistR?: THREE.Group; fistL?: THREE.Group;
  grip?: THREE.Group; gun?: THREE.Group; mag?: THREE.Mesh; magHome?: THREE.Vector3; left?: THREE.Group; leftHome?: THREE.Vector3;
};

const handMesh = (g: Parameters<typeof handGeometry>[0], mat: THREE.Material) => {
  const m = new THREE.Mesh(handGeometry(g), mat);
  m.name = 'viewmodel:hand';
  return m;
};

function buildGunRig(kind: Exclude<WeaponKind, 'fists'>, mat: THREE.Material): Rig {
  const h = HOLD[kind], gp = GRIPS[kind];
  const root = new THREE.Group();
  root.name = `viewmodel:${kind}`;
  const grip = new THREE.Group();
  grip.position.set(...h.grip);
  grip.rotation.y = 0.012; // toe the muzzle in toward the crosshair
  root.add(grip);
  const gun = buildWeapon(kind)!;
  grip.add(gun);
  // Right hand closed round the grip, forearm running back and down out of frame.
  grip.add(handMesh({
    center: new THREE.Vector3(0, -0.005, 0.008), axis: new THREE.Vector3(0, Math.cos(gp.tilt), Math.sin(gp.tilt)), radius: 0.02,
    palm: new THREE.Vector3(0.8, 0, 0.6), wrist: new THREE.Vector3(0.026, -0.055, 0.07), elbow: new THREE.Vector3(0.09, -0.2, 0.42), thumbWrap: true,
  }, mat));
  // Support hand: its own group so a reload can take it to the magazine (hand geometry relative to the group).
  const l = v3(h.left);
  const left = new THREE.Group();
  left.position.copy(l);
  const L = gp.left;
  const rel = (v: V) => v3(v).sub(l);
  left.add(handMesh({
    center: rel(L.center), axis: v3(L.axis), radius: L.radius, palm: v3(L.palm), wrist: rel(L.wrist), elbow: v3(h.elbowL).sub(l), left: true, thumbWrap: L.thumbWrap,
  }, mat));
  grip.add(left);
  const flash = buildMuzzleFlash();
  flash.position.copy(gun.userData.muzzle as THREE.Vector3);
  gun.add(flash);
  return { root, flash, grip, gun, mag: gun.userData.mag, magHome: gun.userData.magHome, left, leftHome: l.clone() };
}

function buildFistsRig(mat: THREE.Material): Rig {
  const root = new THREE.Group();
  root.name = 'viewmodel:fists';
  const fist = (side: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(0.16 * side, -0.14, -0.42);
    g.rotation.set(0.25, -0.15 * side, 0.2 * side);
    g.add(handMesh({
      center: new THREE.Vector3(0, 0, -0.012), axis: new THREE.Vector3(-1, 0, 0), radius: 0.007, palm: new THREE.Vector3(0, 0.15, 1),
      wrist: new THREE.Vector3(0.004 * side, -0.012, 0.07), elbow: new THREE.Vector3(0.05 * side, -0.1, 0.42), wrap: 3.6, thumbWrap: true, left: side < 0,
    }, mat));
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
  private dip = 0;
  private raise = 1;
  private lastYaw = 0;
  private lastPitch = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  /** 0..1 eased aim-down-sights (drives FOV, viewmodel pose, sensitivity). */
  adsK = 0;
  private kickKind: WeaponKind = 'pistol';
  // Camera shake (visual only: applied after the aim ray is taken).
  private readonly sun = new THREE.DirectionalLight(0xffe6c2, 3.4);
  private readonly hemi = new THREE.HemisphereLight(0xcfe8ff, 0x8a7a58, 0.9);
  private shakeAmp = 0;
  private punch = 0;
  private punchVel = 0;
  private shakeT = 0;
  // Hit-stop (visual only): seconds left / length / strength; `vnow` is the visual clock (ms) it slows.
  private stopLeft = 0;
  private stopDur = 0;
  private stopK = 0;
  private timeScale = 1;
  private vnow = 0;
  private zoomSet = 1;
  // Camera bob (first person, own or spectated).
  private camPhase = 0;
  private camBobK = 0;

  constructor(private renderer: Renderer, private enabled: () => boolean) {
    this.scene.add(this.cam);
    this.cam.add(this.motion);
    const sun = this.sun;
    sun.position.copy(SUN_DIR).multiplyScalar(5);
    this.scene.add(sun, this.hemi);
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
    // An emote is meant to be seen: third person while it plays, whatever the camera setting.
    this.active = this.mode === 'first' && me.alive && !me.emote;
    const v = settings.get().video;
    // Aiming zooms both views (rifle 2x, others less).
    const fov = adsFov(this.active ? v.fovFirst : v.fovThird, me.equipped, me.alive ? this.adsK : 0);
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.renderer.characters.hiddenId = this.active ? humanId : -1;
    if (!this.active) return false;
    cam.position.set(feet.x, feet.y + PLAYER.eyeHeight, feet.z);
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
    return true;
  }

  /** Ease aiming in/out (call every frame; `want` = sights up per the local input). */
  setAds(want: boolean, dt: number) {
    this.adsK += ((want ? 1 : 0) - this.adsK) * approach(want ? 14 : 10, dt);
    if (this.adsK < 1e-3) this.adsK = 0;
  }

  /**
   * Visual shake (both camera modes): `amp` rad of jitter that settles, scaled by Settings → Screen shake;
   * `kick` rad of upward recoil punch (weapon feel, not scaled).
   */
  shake(amp: number, kick = 0) {
    this.shakeAmp = Math.min(0.05, this.shakeAmp + amp * settings.get().gameplay.screenShake);
    this.punchVel += kick * 30;
  }

  /** Hit-stop: `sec` of near-frozen camera / viewmodel animation (never the sim, input or look). Off at 0% shake. */
  hitStop(sec: number) {
    const k = settings.get().gameplay.screenShake;
    if (k <= 0 || sec <= this.stopLeft) return;
    this.stopLeft = this.stopDur = sec;
    this.stopK = k * (sec / HIT_STOP.kill);
  }

  /**
   * Add the visual camera motion to the world camera: recoil punch, shake, hit-stop zoom and (first person,
   * `bobSpeed` ≥ 0 = the viewed player's ground speed) camera bob. Call after the aim ray was taken, before
   * rendering: none of it moves the aim. Everything is added on top of a camera pose set fresh each frame.
   */
  applyShake(dt: number, bobSpeed = -1) {
    const cam = this.renderer.camera;
    this.timeScale = hitStopScale(this.stopLeft, this.stopDur);
    this.stopLeft = Math.max(0, this.stopLeft - dt);
    const sdt = dt * this.timeScale; // visual time: slowed during a hit-stop
    this.vnow += sdt * 1000;
    // Hit-stop zoom: a small punch in that eases out with it.
    const zoom = this.stopLeft > 0 ? 1 + HIT_ZOOM * this.stopK * (this.stopLeft / this.stopDur) : 1;
    if (zoom !== this.zoomSet) { this.zoomSet = zoom; cam.zoom = zoom; cam.updateProjectionMatrix(); }
    // Camera bob: position + roll only, so the screen centre (the aim) doesn't move.
    const bobOn = bobSpeed >= 0 && settings.get().gameplay.cameraBob;
    this.camBobK += ((bobOn ? Math.min(1, bobSpeed / PLAYER.walk) : 0) - this.camBobK) * approach(8, sdt);
    if (this.camBobK > 1e-3) {
      this.camPhase += bobRate(Math.max(0, bobSpeed)) * sdt;
      const b = cameraBob(this.camPhase, Math.max(0, bobSpeed), _cbob);
      const k = this.camBobK * (1 - this.adsK * 0.8);
      cam.translateX(b.x * k);
      cam.translateY(b.y * k);
      cam.rotation.z += b.roll * k;
    }
    // Punch: a critically damped spring back to rest.
    this.punchVel += (-this.punch * 260 - this.punchVel * 2 * Math.sqrt(260)) * sdt;
    this.punch += this.punchVel * sdt;
    this.shakeT += sdt;
    this.shakeAmp *= Math.exp(-9 * sdt);
    if (this.shakeAmp < 1e-4 && Math.abs(this.punch) < 1e-5) return;
    const a = this.shakeAmp, t = this.shakeT * 37;
    cam.rotation.x += this.punch + Math.sin(t * 1.3) * a;
    cam.rotation.y += Math.sin(t * 0.9 + 1.7) * a;
    cam.rotation.z += Math.sin(t * 1.1 + 0.3) * a * 0.6;
  }

  /**
   * World position of a point on the first-person gun ('muzzle' or 'eject'), as seen from the world camera
   * (the viewmodel has its own FOV, so its view-space offsets are rescaled to land on the same pixels).
   */
  gunPoint(which: 'muzzle' | 'eject', out: THREE.Vector3): THREE.Vector3 | null {
    const rig = this.rig;
    if (!this.active || !rig?.gun) return null;
    const local = rig.gun.userData[which] as THREE.Vector3 | undefined;
    if (!local) return null;
    rig.root.updateWorldMatrix(true, true);
    out.copy(local).applyMatrix4(rig.gun.matrixWorld); // in the viewmodel scene: camera at origin
    out.applyQuaternion(_qi.copy(this.cam.quaternion).invert()); // → view space
    const k = Math.tan((this.renderer.camera.fov * Math.PI) / 360) / Math.tan((this.cam.fov * Math.PI) / 360);
    out.x *= k; out.y *= k;
    out.applyQuaternion(this.renderer.camera.quaternion).add(this.renderer.camera.position);
    return out;
  }

  /**
   * Camera feel from match events, for the player whose view we show (`humanId`: us, or whoever we spectate):
   * blasts near them, damage they take, their shots (punch + shake), and a hit-stop on their kills and heavy hits.
   */
  onEvents(events: MatchEvent[], humanId: number, myPos: Vec3 | null) {
    for (const e of events) {
      if (e.type === 'explosion' && myPos) {
        const p = e.data.pos as Vec3;
        const s = blastShake(Math.hypot(p.x - myPos.x, p.y - myPos.y, p.z - myPos.z), e.data.kind === 'grenade');
        if (s > 0) this.shake(s);
      }
      if (e.type === 'hit' && e.data.target === humanId) this.shake(0.004 + Math.min(0.01, Number(e.data.amount) / 4000));
      if (e.type === 'hit' && e.data.by === humanId && e.data.target !== humanId && heavyHit(Number(e.data.amount), e.data.part)) this.hitStop(HIT_STOP.heavy);
      if (e.type === 'kill' && e.data.killer === humanId && e.data.victim !== humanId) this.hitStop(HIT_STOP.kill);
      if (e.type !== 'shot' || e.data.by !== humanId || e.data.echo) continue; // echo: kicked when predicted
      const weapon = (e.data.weapon as WeaponKind) ?? 'pistol';
      this.kickKind = weapon;
      const s = PUNCH_SCALE[weapon] ?? 1;
      this.shake(0.0012 * s, 0.006 * s * (this.adsK > 0.5 ? 0.6 : 1));
      this.shotAt = this.vnow;
      this.punchSide = this.punchSide === 1 ? -1 : 1;
      if (this.rig?.flash) {
        this.rig.flash.rotation.z = Math.random() * Math.PI;
        this.rig.flash.scale.setScalar(0.8 + Math.random() * 0.5);
      }
    }
  }

  private setWeapon(kind: WeaponKind, island: number) {
    if (island !== this.sleeveIsland) {
      // Team camo sleeves: the bodies' material (no ground grime) in this team's colours, on every cached rig.
      this.sleeveIsland = island;
      const mat = bodyMaterial(islandColor(island), 'full', 0);
      for (const r of this.rigs.values()) r.root.traverse((o) => { if (o.name === 'viewmodel:hand') (o as THREE.Mesh).material = mat; });
    }
    if (kind === this.kind) return;
    if (this.rig) this.motion.remove(this.rig.root);
    let rig = this.rigs.get(kind);
    if (!rig) {
      const mat = bodyMaterial(islandColor(island), 'full', 0);
      rig = kind === 'fists' ? buildFistsRig(mat) : buildGunRig(kind, mat);
      rig.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
      this.rigs.set(kind, rig);
    }
    this.motion.add(rig.root);
    this.rig = rig;
    if (this.kind !== null) this.raise = 0; // switching: bring the new weapon up from below
    this.kind = kind;
  }

  /** Animate and draw the viewmodel over the already-rendered frame. Call after Renderer.render. */
  /** vel = the local player's predicted velocity (smoother than the sim's 30 Hz one), when known; simNow = sim clock (reloads). */
  render(me: PlayerState | undefined, yaw: number, pitch: number, dt: number, vel?: Vec3, simNow = 0) {
    if (this.warmFrames > 0) { this.warmFrames--; this.drawWarm(); return; }
    if (!this.active || !me) return;
    const now = this.vnow; // visual clock: holds still during a hit-stop
    this.setWeapon(me.equipped, me.island);
    const rig = this.rig!;
    const adt = dt * this.timeScale; // animation time (look velocity below still uses the real dt)
    this.t += adt;

    // Walk / run bob, faded in with speed and suppressed in the air.
    const v = vel ?? me.vel;
    const speed = Math.hypot(v.x, v.z);
    const grounded = Math.abs(v.y) < 0.8;
    this.moveK += ((grounded ? Math.min(1, speed / PLAYER.walk) : 0) - this.moveK) * approach(8, adt);
    this.phase += bobRate(speed) * adt;
    const bob = bobOffset(this.phase, speed, _bob);
    const sway = idleSway(this.t, _sway);

    // Turn lag: the weapon trails the view a little, springing back.
    const yawVel = angleDelta(yaw, this.lastYaw) / Math.max(dt, 1e-3);
    const pitchVel = (pitch - this.lastPitch) / Math.max(dt, 1e-3);
    this.lastYaw = yaw; this.lastPitch = pitch;
    const clampV = (v: number) => THREE.MathUtils.clamp(v, -6, 6);
    this.lagYaw += (clampV(yawVel) - this.lagYaw) * approach(LAG_RATE, adt);
    this.lagPitch += (clampV(pitchVel) - this.lagPitch) * approach(LAG_RATE, adt);

    // Reload: the sim's clock drives a per-gun choreography (mag out / in, rack, shells, rocket).
    const clock = reloadClock(me, simNow);
    const pose = clock ? reloadPose(me.equipped, clock.elapsed, clock.duration, clock.magStart, clock.beats) : null;
    this.dip += ((pose ? pose.tilt : 0) - this.dip) * approach(14, adt);
    this.raise += (1 - this.raise) * approach(RAISE_RATE, adt);
    if (rig.mag && rig.magHome) {
      const empty = me.equipped === 'rocket' && !pose && (me.inv.weapons.rocket?.mag ?? 0) === 0;
      rig.mag.position.copy(rig.magHome);
      if (pose) { rig.mag.position.y += pose.magY; rig.mag.position.z += pose.magZ; }
      rig.mag.visible = pose ? pose.magShow : me.equipped !== 'shotgun' && !empty;
    }
    if (rig.left && rig.leftHome && rig.mag && rig.magHome) {
      // Support hand to the mag (just below it) while it's being swapped.
      const h = pose ? pose.hand : 0;
      const tgt = _a.copy(rig.mag.position);
      tgt.y -= me.equipped === 'shotgun' ? 0.02 : 0.06;
      rig.left.position.copy(rig.leftHome).lerp(tgt, h * 0.85);
    }

    const since = (now - this.shotAt) / 1000;
    const kick = me.equipped === 'fists' || this.kickKind !== me.equipped ? 0 : recoilKick(since);
    const vk = VM_KICK[me.equipped];
    const jolt = pose ? pose.jolt : 0;
    const lowered = (1 - this.raise);
    const ads = this.adsK * (pose ? 0 : 1);
    const steady = 1 - ads * 0.85; // sights up: bob/sway mostly gone

    // Aim down sights: slide the grip from the hip hold onto the eye line.
    if (rig.grip && me.equipped !== 'fists') {
      const h = HOLD[me.equipped];
      rig.grip.position.set(...h.grip).lerp(_b.set(...h.ads), ads);
      // Reload tilt: roll the gun about the hand so the magazine well turns toward you.
      // The launcher instead swings across the body so its rear (where the rocket goes in) comes into view.
      if (me.equipped === 'rocket') rig.grip.rotation.set(this.dip * 0.1, 0.012 + this.dip * 1.1, this.dip * 0.15);
      else rig.grip.rotation.set(this.dip * 0.18, 0.012 + this.dip * 0.22, this.dip * 0.5);
    }
    this.cam.fov = VM_FOV - ads * 8;
    this.cam.updateProjectionMatrix();

    // Rocket: the launcher comes off the shoulder and forward so the rear (where the rocket goes in) is in view.
    const rocketLoad = me.equipped === 'rocket' ? this.dip : 0;
    const m = this.motion;
    m.position.set(
      (sway.x * (1 - this.moveK) + bob.x * this.moveK + this.lagYaw * 0.006) * steady - this.dip * 0.06,
      (sway.y * (1 - this.moveK) + bob.y * this.moveK - this.lagPitch * 0.005) * steady + kick * vk.climb * 0.08
        + this.dip * 0.01 - rocketLoad * 0.1 - lowered * 0.22 + jolt * 0.012,
      kick * vk.back + jolt * 0.015 - rocketLoad * 0.32,
    );
    m.rotation.set(
      kick * vk.climb - this.lagPitch * 0.012 * steady + this.dip * 0.06 - lowered * 0.6 + jolt * 0.04,
      -this.lagYaw * 0.014 * steady,
      bob.roll * this.moveK * steady + this.dip * 0.08,
    );
    // Looking through the rifle scope: the overlay is the view; the gun would only block it.
    const scoped = (me.equipped === 'rifle' || me.equipped === 'sniper') && this.adsK > 0.9 && !pose;
    rig.root.visible = !scoped;
    if (scoped) return;

    if (rig.flash) rig.flash.visible = since * 1000 < FLASH_MS;
    if (rig.fistR && rig.fistL) {
      const punch = since < PUNCH_S ? Math.sin((since / PUNCH_S) * Math.PI) : 0;
      const [hit, rest] = this.punchSide === 1 ? [rig.fistR, rig.fistL] : [rig.fistL, rig.fistR];
      const side = this.punchSide;
      hit.position.set(0.16 * side - 0.12 * side * punch, -0.14 + 0.06 * punch, -0.42 - 0.22 * punch);
      rest.position.set(-0.16 * side, -0.14, -0.42);
    }
    this.draw();
  }

  /**
   * Loading warm-up: for the next `frames` frames draw every weapon rig (fists too, flashes lit) in the
   * viewmodel pass whatever the camera mode, so the first switch to first person or first shot in it
   * compiles nothing. The rigs stay cached for the match.
   */
  warmUp(frames: number) {
    // Body materials share one shader whatever the team colour (uniforms), so any island warms the right pipelines.
    const island = Math.max(0, this.sleeveIsland);
    for (const kind of Object.keys(WEAPONS) as WeaponKind[]) {
      let rig = this.rigs.get(kind);
      if (!rig) {
        const mat = bodyMaterial(islandColor(island), 'full', 0);
        rig = kind === 'fists' ? buildFistsRig(mat) : buildGunRig(kind, mat);
        rig.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
        this.rigs.set(kind, rig);
      }
    }
    this.warmFrames = frames;
  }
  private warmFrames = 0;

  /** The warm-up frame: all rigs side by side in front of the viewmodel camera, then back to the current one. */
  private drawWarm() {
    const all = [...this.rigs.values()];
    const keep = all.map((r) => ({ r, parent: r.root.parent, x: r.root.position.x, vis: r.root.visible, flash: r.flash?.visible ?? false }));
    all.forEach((r, i) => {
      r.root.position.x = (i - (all.length - 1) / 2) * 0.12;
      r.root.visible = true;
      if (r.flash) r.flash.visible = true;
      this.motion.add(r.root);
    });
    try { this.draw(); } finally {
      for (const k of keep) {
        k.r.root.position.x = k.x;
        k.r.root.visible = k.vis;
        if (k.r.flash) k.r.flash.visible = k.flash;
        if (k.parent) k.parent.add(k.r.root); else this.motion.remove(k.r.root);
      }
    }
  }

  private draw() {
    // Draw: same orientation as the world camera (world-space sun lighting), own FOV + near plane.
    const gpu = this.renderer.gpu;
    this.scene.environment = this.renderer.scene.environment;
    this.scene.environmentIntensity = this.renderer.scene.environmentIntensity;
    // follow the day/night cycle: the same key light (sun → moon) and ambient the world has now
    this.sun.intensity = 3.4 * dayNightState.key;
    this.sun.color.copy(dayNightState.keyColor);
    this.sun.position.copy(lightU.keyDir.value as THREE.Vector3).multiplyScalar(5);
    this.hemi.intensity = 0.9 * dayNightState.env;
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
