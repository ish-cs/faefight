import { BUILD } from '../sim/constants';
import { HOTBAR_SIZE, isGunItem, isPieceItem, isPotionItem } from '../sim/hotbar';
import type { HotbarItem, PieceKind, PlayerInput, TrapRequest } from '../sim/types';
import { ClickGate } from './clickGate';
import { RecoilRecovery } from './recoil';
import { type Action, isAction, isHeld, keymapSuspended, slotForCode } from './keymap';
import { settings } from './settings/store';

export const PIECE_ORDER: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
/** Wheel travel (px) per hotbar step: one mouse notch is ~100, trackpads send many small deltas. */
const WHEEL_STEP = 50;

const BASE_RAD_PER_PX = 0.0022;
const PITCH_LIMIT = 1.35;
const ROT_STEP = (BUILD.rotStepDeg * Math.PI) / 180;

/** Mouse sensitivity multiplier (Settings → Controls). */
export function loadSensitivity(): number {
  return settings.get().controls.sensitivity;
}
export function saveSensitivity(v: number) {
  settings.update((s) => { s.controls.sensitivity = v; });
}

export type InputHooks = {
  /** E outside build mode (main decides: shop panel, vault panel, or generator collect). */
  interact(): void;
  /** Quick-bank key (H): everything above the restock loadout into the vault (main checks you can reach it). */
  bank?(): void;
  /** Left click while in build mode. */
  place(): void;
  /** Pointer lock gained/lost. */
  lockChange(locked: boolean): void;
  /** Reorder key (I by default): hotbar edit mode (pointer released to drag slots) opened/closed. */
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
  /** Holding a spike trap: the validated spot under the crosshair (main sets it each frame), null when it can't go there. */
  trapReq: TrapRequest | null = null;
  /** Called when a click places a trap from `trapReq` (ghost pulse). */
  onTrapPlaced: (() => void) | null = null;
  /** Reorder mode: pointer released so hotbar slots can be dragged. */
  inventory = false;
  buildRot = 0;
  /** False while a menu or panel is open: game keys and mouse are ignored. */
  enabled = false;
  /** Mouse look multiplier on top of the sensitivity setting (main sets it to the zoom while aiming). */
  lookScale = 1;
  /** Emote wheel open: the mouse picks a slot instead of looking around or firing. */
  lookLocked = false;
  private keys = new Set<string>();
  private fireHeld = false;
  /** Recoil still to be applied to the look angles (rad), and its recovery after a burst (recoil.ts). */
  private recoil = new RecoilRecovery();
  private oneShot: Partial<PlayerInput> = {};
  private wheelAcc = 0;
  /** Presses that only re-capture the pointer never act (see ClickGate). */
  private gate = new ClickGate();
  /** The game wants the pointer locked but the browser hasn't granted it yet (or refused, e.g. right after Esc). */
  private wantLock = false;
  private lockPending = false;
  /** Raw mouse movement (no OS acceleration); turned off if the browser doesn't support it. */
  private unadjusted = true;

  constructor(private canvas: HTMLCanvasElement, private hooks: InputHooks) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.fireHeld = false; this.gate.reset(); });
    // A lock request refused (Chrome: for ~1 s after Esc, or without a user activation) is retried on
    // the next user activation anywhere on the page. Esc is not an activation, so it doesn't retry.
    const retry = (e: Event) => {
      if (!this.wantLock || !this.enabled || this.locked) return;
      if (e instanceof KeyboardEvent && e.code === 'Escape') return;
      this.requestLock();
    };
    window.addEventListener('keydown', retry, { capture: true });
    window.addEventListener('mousedown', retry, { capture: true });
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => {
      if (this.gate.release(e.button)) return; // the release of a re-capture click: nothing to undo
      if (e.button === 0) this.fireHeld = false;
      if (e.button !== 0) this.keys.delete(`Mouse${e.button}`);
    });
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
    document.addEventListener('pointerlockchange', () => {
      const locked = this.locked;
      console.info(`[input] pointer lock ${locked ? 'gained' : 'lost'}`);
      if (locked && !this.enabled) {
        // A retried request landed after a panel opened: the panel needs the cursor.
        this.wantLock = false; this.lockPending = false;
        document.exitPointerLock();
        return;
      }
      this.gate.lockChange(locked, performance.now());
      if (locked) { this.wantLock = false; this.lockPending = false; }
      this.hooks.lockChange(locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockPending = false;
      console.info('[input] pointer lock error; will retry on the next click or key press');
    });
  }

  get locked() {
    return this.debugLocked || document.pointerLockElement === this.canvas;
  }
  /** Test hook (?debug=1 latency probe): treat the pointer as locked without a real pointer lock. */
  debugLocked = false;
  /** event.timeStamp of the oldest look (mouse) event not yet drawn; main's latency probe consumes it */
  lookEventT: number | null = null;

  /** Holding a piece = build mode: the ghost shows and a click places it. */
  get buildMode(): boolean {
    return isPieceItem(this.held);
  }

  get buildKind(): PieceKind | null {
    return isPieceItem(this.held) ? this.held : null;
  }

  select(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= HOTBAR_SIZE) throw new Error(`InputController.select: bad slot ${i}`);
    if (i !== this.selected) { this.fireHeld = false; this.recoil.reset(); }
    this.selected = i;
  }

  /** Reorder key: release the pointer to drag hotbar slots; the key again (or a click on the game) recaptures. */
  setInventory(open: boolean) {
    if (open === this.inventory) return;
    this.inventory = open;
    this.fireHeld = false;
    if (open) { if (document.pointerLockElement) document.exitPointerLock(); }
    else this.requestLock();
    this.hooks.inventoryChange(open);
  }

  /** Left button held (in build mode: keep placing along the ghost = drag-build). */
  get clickHeld() {
    return this.enabled && this.fireHeld;
  }

  /** Aim key (right mouse by default) held with a gun in hand: aim down sights. */
  get ads(): boolean {
    return this.enabled && isHeld('aim', this.keys) && isGunItem(this.held);
  }

  /**
   * Recoil from one of my shots (the sim reports it with the shot): it moves my real aim, so a spray climbs
   * and I pull down against it. Applied over ~50 ms so it reads as a kick, not a teleport; after the burst
   * part of the climb recovers by itself (recoil.ts: just my own look input, the sim is unchanged).
   */
  addKick(pitch: number, yaw: number) {
    this.recoil.kick(pitch, yaw);
  }

  /** Per frame: feed pending recoil (and its recovery) into the look angles. */
  applyKick(dt: number) {
    const r = this.recoil;
    r.step(dt);
    if (r.dPitch === 0 && r.dYaw === 0) return;
    this.yaw += r.dYaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + r.dPitch));
  }

  get free() {
    return this.enabled && isHeld('freePlace', this.keys);
  }

  /** Live from Settings → Controls. */
  get sensitivity() {
    return settings.get().controls.sensitivity;
  }

  /** Grab the pointer. Call it from the user-gesture handler that closes a UI so play resumes at once. */
  requestLock() {
    if (this.locked) return;
    this.wantLock = true;
    if (this.lockPending) return;
    this.lockPending = true;
    let r: Promise<void> | undefined;
    try {
      r = this.canvas.requestPointerLock(this.unadjusted ? { unadjustedMovement: true } : undefined) as unknown as Promise<void> | undefined;
    } catch (err) {
      r = Promise.reject(err);
    }
    Promise.resolve(r).then(() => { this.lockPending = false; }, (err: unknown) => {
      this.lockPending = false;
      const name = (err as { name?: string } | null)?.name ?? String(err);
      if (this.unadjusted && name === 'NotSupportedError') {
        console.info('[input] unadjustedMovement unsupported; using plain pointer lock');
        this.unadjusted = false;
        this.requestLock();
        return;
      }
      // Too soon after Esc / no user activation: the next click or key press retries.
      console.info(`[input] pointer lock refused (${name}); will retry on the next click or key press`);
    });
  }

  setSensitivity(v: number) {
    saveSensitivity(v);
  }

  queue(p: Partial<PlayerInput>) {
    Object.assign(this.oneShot, p);
  }

  private rotate(steps: number) {
    this.buildRot = (this.buildRot + steps * ROT_STEP) % (Math.PI * 2);
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.enabled || this.lookLocked) return;
    if (this.inventory) { this.gate.press(e.button, false, performance.now()); this.setInventory(false); return; }
    // The gate: a press while unlocked only re-captures; it and the grace right after never act.
    if (!this.gate.press(e.button, this.locked, performance.now())) { if (!this.locked) this.requestLock(); return; }
    // Other buttons act like keys ('Mouse2' = right button), so the keymap can bind them (aim by default).
    if (e.button !== 0) { this.keys.add(`Mouse${e.button}`); return; }
    if (this.buildMode) { this.fireHeld = true; this.hooks.place(); return; } // held = drag-build
    if (this.held === 'grenade') { this.oneShot.throwGrenade = true; return; }
    if (this.held === 'charge') { this.oneShot.placeCharge = true; return; }
    if (this.held === 'trap') { if (this.trapReq) { this.oneShot.trap = this.trapReq; this.onTrapPlaced?.(); } return; }
    if (this.held === 'medkit') { this.oneShot.useMedkit = true; return; }
    if (isPotionItem(this.held)) { this.oneShot.drink = true; return; }
    if (this.held === 'grapple') { this.oneShot.grapple = true; return; } // fires, or lets go of the one that's out
    this.fireHeld = true;
    this.oneShot.fire = true; // a click shorter than a frame still fires once
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.enabled || !this.locked || this.lookLocked) return;
    const c = settings.get().controls;
    const k = BASE_RAD_PER_PX * c.sensitivity * this.lookScale;
    if (this.lookEventT === null && (e.movementX || e.movementY)) this.lookEventT = e.timeStamp;
    const dYaw = -e.movementX * k, dPitch = -e.movementY * k * (c.invertY ? -1 : 1);
    this.yaw += dYaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
    this.recoil.mouse(dPitch, dYaw); // pulling against the climb pays its recovery off
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!down) this.keys.delete(e.code); // releases always count, even with the settings panel open
    if (keymapSuspended()) return; // settings panel open / capturing a key
    if (isAction('freePlace', e.code)) e.preventDefault();
    // Jump/scoreboard keys (Space/Tab by default) are ours in game; with a panel open they press/move between buttons as usual.
    if ((isAction('jump', e.code) || isAction('scoreboard', e.code) || e.code === 'Tab') && this.enabled) e.preventDefault();
    if (!down) { this.keys.delete(e.code); return; }
    if (!this.enabled) return;
    const first = !e.repeat;
    this.keys.add(e.code);
    if (!first) return;
    const slot = slotForCode(e.code);
    if (slot >= 0 && slot < HOTBAR_SIZE) { this.select(slot); return; }
    if (isAction('drop', e.code)) {
      // Ctrl+drop (or Shift+drop, Mac-friendly) drops the whole stack.
      if (e.ctrlKey) e.preventDefault();
      this.oneShot.drop = e.ctrlKey || e.shiftKey ? 'stack' : 'one';
    }
    if (isAction('rotateLeft', e.code)) this.rotate(-1);
    if (isAction('rotateRight', e.code)) this.rotate(1);
    if (isAction('interact', e.code)) this.hooks.interact();
    if (isAction('bank', e.code)) this.hooks.bank?.();
    if (isAction('reload', e.code)) this.oneShot.reload = true;
    if (isAction('inventory', e.code)) this.setInventory(!this.inventory);
    if (isAction('jump', e.code)) this.oneShot.jump = true;
  }

  /** Current input; one-shot actions are included once and then cleared. */
  sample(): PlayerInput {
    const on = (a: Action) => (this.enabled && isHeld(a, this.keys) ? 1 : 0);
    const input: PlayerInput = {
      moveX: on('right') - on('left'),
      moveZ: on('forward') - on('back'),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: on('jump') === 1,
      sprint: on('sprint') === 1,
      fire: this.enabled && this.fireHeld && !this.buildMode,
      ads: this.ads,
      reload: false, interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null,
      select: this.selected, drop: null, moveSlot: null, useMedkit: false, drink: false,
      ...this.oneShot,
    };
    this.oneShot = {};
    return input;
  }
}
