import * as THREE from 'three/webgpu';
import type { Vec3 } from '../sim/types';
import { PLAYER } from '../sim/constants';
import { type Action, isHeld, slotForCode } from './keymap';
import { ThirdPersonCamera } from './camera';

/** Free-fly speeds (m/s) and height limits for the spectator camera. */
export const SPECTATE = { speed: 14, fastMul: 3, minY: -20, maxY: 250 };

export type FlyKeys = { fwd: boolean; back: boolean; left: boolean; right: boolean; up: boolean; down: boolean; fast: boolean };

/** One free-fly step: W/S along the look direction (pitch included), A/D strafe, up/down world-vertical. No collision. */
export function flyStep(pos: Vec3, yaw: number, pitch: number, k: FlyKeys, dt: number): Vec3 {
  const f = (k.fwd ? 1 : 0) - (k.back ? 1 : 0);
  const r = (k.right ? 1 : 0) - (k.left ? 1 : 0);
  const u = (k.up ? 1 : 0) - (k.down ? 1 : 0);
  if (!f && !r && !u) return { ...pos };
  const cp = Math.cos(pitch);
  // three.js convention: yaw 0 looks toward -Z; right = (cos yaw, 0, -sin yaw).
  let dx = -Math.sin(yaw) * cp * f + Math.cos(yaw) * r;
  let dy = Math.sin(pitch) * f + u;
  let dz = -Math.cos(yaw) * cp * f - Math.sin(yaw) * r;
  const len = Math.hypot(dx, dy, dz);
  if (len > 1) { dx /= len; dy /= len; dz /= len; }
  const step = SPECTATE.speed * (k.fast ? SPECTATE.fastMul : 1) * dt;
  return {
    x: pos.x + dx * step,
    y: Math.max(SPECTATE.minY, Math.min(SPECTATE.maxY, pos.y + dy * step)),
    z: pos.z + dz * step,
  };
}

/** Who number keys / clicks cycle through: living players other than you, by id. */
export function followOrder(players: { id: number; alive: boolean }[], humanId: number): number[] {
  return players.filter((p) => p.alive && p.id !== humanId).map((p) => p.id).sort((a, b) => a - b);
}

type Frame = {
  cam: THREE.PerspectiveCamera;
  yaw: number;
  pitch: number;
  dt: number;
  humanId: number;
  players: { id: number; name: string; alive: boolean }[];
  posOf(id: number, out: THREE.Vector3): THREE.Vector3 | null;
  /** The followed player's own look angles (interpolated); absent/null = use the spectator's mouse look. */
  lookOf?(id: number): { yaw: number; pitch: number } | null;
  /** Follow from their eyes (first person) instead of over their shoulder; toggled with the camera key (V). */
  firstPerson?: boolean;
};

/**
 * Invisible spectator camera (client-side only; the sim ignores a dead player's inputs). Free fly with
 * WASD + mouse look (Space up, C/Ctrl down, Shift faster), or follow a living player: 1–9 picks one,
 * a click cycles, 0 or any movement key goes back to free fly.
 */
export class Spectator {
  active = false;
  mode: 'free' | 'follow' = 'free';
  followId: number | null = null;
  /** Following from the player's eyes this frame (hide their avatar). */
  firstPerson = false;
  readonly pos = new THREE.Vector3();
  private keys = new Set<string>();
  private pendingDigit: number | null = null;
  private pendingCycle = false;
  private follow: ThirdPersonCamera;
  private tmp = new THREE.Vector3();
  private banner = document.createElement('div');

  constructor(parent: HTMLElement, cam: THREE.PerspectiveCamera, blockers: () => THREE.Object3D[], canvas: HTMLElement, private enabled: () => boolean) {
    this.follow = new ThirdPersonCamera(cam, blockers);
    this.banner.className = 'spectate-banner glass';
    this.banner.dataset.testid = 'spectate-banner';
    this.banner.style.display = 'none';
    parent.append(this.banner);
    const typing = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    window.addEventListener('keydown', (e) => {
      if (!this.active || !this.enabled() || typing(e)) return;
      this.keys.add(e.code);
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') e.preventDefault();
      // Hotbar slot keys follow player 1–9; Digit0 = free fly.
      const slot = slotForCode(e.code);
      if (!e.repeat && (slot >= 0 || e.code === 'Digit0')) this.pendingDigit = slot >= 0 ? slot + 1 : 0;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (this.active && this.enabled() && e.button === 0 && document.pointerLockElement === canvas) this.pendingCycle = true;
    });
  }

  private flyKeys(): FlyKeys {
    const k = (...c: string[]) => c.some((x) => this.keys.has(x));
    const held = (a: Action) => isHeld(a, this.keys);
    return {
      fwd: held('forward'), back: held('back'), left: held('left'), right: held('right'), up: held('jump'),
      down: k('KeyC', 'ControlLeft', 'ControlRight'), fast: held('sprint'),
    };
  }

  /** Start spectating from where the camera is now (free fly). */
  enter(from: THREE.Vector3) {
    if (this.active) return;
    this.active = true;
    this.mode = 'free';
    this.followId = null;
    this.pos.copy(from);
    this.banner.style.display = '';
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    this.pendingDigit = null;
    this.pendingCycle = false;
    this.firstPerson = false;
    this.banner.style.display = 'none';
  }

  /** Per render frame while active: drive the camera and the banner. */
  frame(f: Frame) {
    const order = followOrder(f.players, f.humanId);
    if (this.pendingDigit !== null) {
      const n = this.pendingDigit;
      if (n === 0) this.mode = 'free';
      else if (order[n - 1] !== undefined) { this.mode = 'follow'; this.followId = order[n - 1]; }
      this.pendingDigit = null;
    }
    if (this.pendingCycle) {
      this.pendingCycle = false;
      if (order.length) {
        const i = this.mode === 'follow' && this.followId !== null ? order.indexOf(this.followId) : -1;
        this.mode = 'follow';
        this.followId = order[(i + 1) % order.length];
      }
    }
    const keys = this.flyKeys();
    if (this.mode === 'follow' && (keys.fwd || keys.back || keys.left || keys.right || keys.up || keys.down)) {
      this.mode = 'free';
      this.pos.copy(f.cam.position); // take off from where the follow camera was
    }
    if (this.mode === 'follow' && (this.followId === null || !order.includes(this.followId))) {
      // The followed player died: next living one, else free fly from here.
      if (order.length) this.followId = order[0];
      else { this.mode = 'free'; this.pos.copy(f.cam.position); }
    }

    const target = this.mode === 'follow' && this.followId !== null ? f.posOf(this.followId, this.tmp) : null;
    this.firstPerson = !!target && !!f.firstPerson;
    if (target) {
      // Their view: their own aim, from their eyes (V) or over their shoulder.
      const look = f.lookOf?.(this.followId!) ?? { yaw: f.yaw, pitch: f.pitch };
      if (this.firstPerson) {
        f.cam.position.set(target.x, target.y + PLAYER.eyeHeight, target.z);
        f.cam.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      } else this.follow.update(target, look.yaw, look.pitch, f.dt);
    } else {
      const p = flyStep(this.pos, f.yaw, f.pitch, keys, f.dt);
      this.pos.set(p.x, p.y, p.z);
      f.cam.position.copy(this.pos);
      f.cam.rotation.set(f.pitch, f.yaw, 0, 'YXZ');
    }
    const who = target ? f.players.find((p) => p.id === this.followId)?.name ?? `#${this.followId}` : null;
    const text = who
      ? `SPECTATING — following ${who}  ·  click next · V ${this.firstPerson ? 'over the shoulder' : 'first person'} · 0 free fly`
      : 'SPECTATING — free fly  ·  WASD + mouse · Space up · C down · Shift fast · 1–9/click follow';
    if (this.banner.textContent !== text) this.banner.textContent = text;
  }

  /** Who the camera follows right now (null: free fly or not spectating). */
  get following(): number | null {
    return this.active && this.mode === 'follow' ? this.followId : null;
  }

  /** Debug/e2e view of the spectator. */
  info() {
    return { active: this.active, mode: this.mode, followId: this.followId, firstPerson: this.firstPerson, pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z } };
  }
}
