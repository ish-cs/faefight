import { BUILD } from '../sim/constants';
import { HOTBAR_SIZE, isPieceItem } from '../sim/hotbar';
import type { HotbarItem, PieceKind, PlayerInput } from '../sim/types';

export const PIECE_ORDER: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
/** Wheel travel (px) per hotbar step: one mouse notch is ~100, trackpads send many small deltas. */
const WHEEL_STEP = 50;

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
  /** I: hotbar edit mode (pointer released to drag slots) opened/closed. */
  inventoryChange(open: boolean): void;
};

/** Keyboard + mouse/trackpad → PlayerInput. Held controls are sampled; taps are queued as one-shots. */
export class InputController {
  yaw = 0;
  pitch = 0;
  /** Selected hotbar slot; sent with every input (the sim derives what's in hand from it). */
  selected = 0;
  /** What sits in the selected slot, per the latest snapshot (set by main each frame). */
  held: HotbarItem | null = null;
  /** I (inventory) mode: pointer released so hotbar slots can be dragged. */
  inventory = false;
  buildRot = 0;
  /** False while a menu or panel is open: game keys and mouse are ignored. */
  enabled = false;
  sensitivity = loadSensitivity();
  private keys = new Set<string>();
  private fireHeld = false;
  private oneShot: Partial<PlayerInput> = {};
  private wheelAcc = 0;

  constructor(private canvas: HTMLCanvasElement, private hooks: InputHooks) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.fireHeld = false; });
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.fireHeld = false; });
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      while (Math.abs(this.wheelAcc) >= WHEEL_STEP) {
        const dir = Math.sign(this.wheelAcc);
        this.wheelAcc -= dir * WHEEL_STEP;
        this.select((this.selected + dir + HOTBAR_SIZE) % HOTBAR_SIZE);
      }
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => this.hooks.lockChange(this.locked));
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  /** Holding a piece = build mode: the ghost shows and a click places it. */
  get buildMode(): boolean {
    return isPieceItem(this.held);
  }

  get buildKind(): PieceKind | null {
    return isPieceItem(this.held) ? this.held : null;
  }

  select(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= HOTBAR_SIZE) throw new Error(`InputController.select: bad slot ${i}`);
    if (i !== this.selected) this.fireHeld = false;
    this.selected = i;
  }

  /** I: release the pointer to drag hotbar slots; I again (or a click on the game) recaptures. */
  setInventory(open: boolean) {
    if (open === this.inventory) return;
    this.inventory = open;
    this.fireHeld = false;
    if (open) { if (document.pointerLockElement) document.exitPointerLock(); }
    else this.requestLock();
    this.hooks.inventoryChange(open);
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
    if (this.inventory) { this.setInventory(false); return; }
    if (!this.locked) this.requestLock();
    if (e.button !== 0) return;
    if (this.buildMode) { this.hooks.place(); return; }
    if (this.held === 'grenade') { this.oneShot.throwGrenade = true; return; }
    if (this.held === 'charge') { this.oneShot.placeCharge = true; return; }
    if (this.held === 'medkit') { this.oneShot.useMedkit = true; return; }
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
    if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
    // Space/Tab are ours in game (jump, scoreboard); with a panel open they press/move between buttons as usual.
    if ((e.code === 'Space' || e.code === 'Tab') && this.enabled) e.preventDefault();
    if (!down) { this.keys.delete(e.code); return; }
    if (!this.enabled) return;
    const first = !e.repeat;
    this.keys.add(e.code);
    if (!first) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) { this.select(Number(digit[1]) - 1); return; }
    switch (e.code) {
      case 'KeyQ':
        // Ctrl+Q (or Shift+Q, Mac-friendly) drops the whole stack.
        if (e.ctrlKey) e.preventDefault();
        this.oneShot.drop = e.ctrlKey || e.shiftKey ? 'stack' : 'one';
        break;
      case 'KeyZ': this.rotate(-1); break;
      case 'KeyX': this.rotate(1); break;
      case 'KeyE': this.hooks.interact(); break;
      case 'KeyR': this.oneShot.reload = true; break;
      case 'KeyI': this.setInventory(!this.inventory); break;
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
      select: this.selected, drop: null, moveSlot: null, useMedkit: false,
      ...this.oneShot,
    };
    this.oneShot = {};
    return input;
  }
}
