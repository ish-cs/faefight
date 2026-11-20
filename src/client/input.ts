import { BUILD } from '../sim/constants';
import type { PieceKind, PlayerInput, WeaponKind } from '../sim/types';

export const PIECE_ORDER: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
export const SLOT_ORDER: WeaponKind[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle'];

const SENS_KEY = 'faefight.sensitivity';
const BASE_RAD_PER_PX = 0.0022;
const PITCH_LIMIT = 1.35;
const ROT_STEP = (BUILD.rotStepDeg * Math.PI) / 180;

export function loadSensitivity(): number {
  const v = Number(localStorage.getItem(SENS_KEY));
  return Number.isFinite(v) && v > 0 ? v : 1;
}
export function saveSensitivity(v: number) {
  localStorage.setItem(SENS_KEY, String(v));
}

export type InputHooks = {
  /** E outside build mode (main decides: shop panel, vault panel, or generator collect). */
  interact(): void;
  /** Left click while in build mode. */
  place(): void;
  /** Pointer lock gained/lost. */
  lockChange(locked: boolean): void;
};

/** Keyboard + mouse/trackpad → PlayerInput. Held controls are sampled; taps are queued as one-shots. */
export class InputController {
  yaw = 0;
  pitch = 0;
  buildMode = false;
  buildKind: PieceKind = 'sandbags';
  buildRot = 0;
  /** False while a menu or panel is open: game keys and mouse are ignored. */
  enabled = false;
  sensitivity = loadSensitivity();
  private keys = new Set<string>();
  private fireHeld = false;
  private oneShot: Partial<PlayerInput> = {};

  constructor(private canvas: HTMLCanvasElement, private hooks: InputHooks) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.fireHeld = false; });
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.fireHeld = false; });
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled || !this.buildMode) return;
      e.preventDefault();
      this.rotate(Math.sign(e.deltaY) * -1);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => this.hooks.lockChange(this.locked));
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  get free() {
    return this.keys.has('AltLeft') || this.keys.has('AltRight');
  }

  requestLock() {
    if (this.locked) return;
    // Some browsers return a promise that rejects (e.g. too soon after Esc); that's not an error for us.
    const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    r?.catch?.(() => {});
  }

  setSensitivity(v: number) {
    this.sensitivity = v;
    saveSensitivity(v);
  }

  queue(p: Partial<PlayerInput>) {
    Object.assign(this.oneShot, p);
  }

  private rotate(steps: number) {
    this.buildRot = (this.buildRot + steps * ROT_STEP) % (Math.PI * 2);
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.enabled) return;
    if (!this.locked) this.requestLock();
    if (e.button !== 0) return;
    if (this.buildMode) { this.hooks.place(); return; }
    this.fireHeld = true;
    this.oneShot.fire = true; // a click shorter than a frame still fires once
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.enabled || !this.locked) return;
    const k = BASE_RAD_PER_PX * this.sensitivity;
    this.yaw -= e.movementX * k;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * k));
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    if (!down) { this.keys.delete(e.code); return; }
    if (!this.enabled) return;
    const first = !e.repeat;
    this.keys.add(e.code);
    if (!first) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const i = Number(digit[1]) - 1;
      if (this.buildMode) { if (i < PIECE_ORDER.length) this.buildKind = PIECE_ORDER[i]; }
      else if (i < SLOT_ORDER.length) this.oneShot.slot = SLOT_ORDER[i];
      return;
    }
    switch (e.code) {
      case 'KeyB': this.buildMode = !this.buildMode; this.fireHeld = false; break;
      case 'KeyQ': if (this.buildMode) this.rotate(-1); break;
      case 'KeyE': if (this.buildMode) this.rotate(1); else this.hooks.interact(); break;
      case 'KeyR': this.oneShot.reload = true; break;
      case 'KeyG': this.oneShot.throwGrenade = true; break;
      case 'KeyC': this.oneShot.placeCharge = true; break;
      case 'Space': this.oneShot.jump = true; break;
    }
  }

  /** Current input; one-shot actions are included once and then cleared. */
  sample(): PlayerInput {
    const on = (c: string) => (this.enabled && this.keys.has(c) ? 1 : 0);
    const input: PlayerInput = {
      moveX: on('KeyD') - on('KeyA'),
      moveZ: on('KeyW') - on('KeyS'),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: on('Space') === 1,
      sprint: on('ShiftLeft') === 1 || on('ShiftRight') === 1,
      fire: this.enabled && this.fireHeld && !this.buildMode,
      reload: false, interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null,
      ...this.oneShot,
    };
    this.oneShot = {};
    return input;
  }
}
