import { PLAYER, WEAPONS } from '../sim/constants';
import { reloadBeats, type ReloadBeat } from '../sim/gunplay';
import type { PlayerState, Vec3, WeaponKind } from '../sim/types';

/**
 * Pure first-person maths (no three.js): camera-mode persistence, eye position and the viewmodel's
 * sway / bob / recoil / reload curves. viewmodel.ts turns these numbers into transforms.
 */

export type CameraMode = 'third' | 'first';
export const CAMERA_MODE_KEY = 'faefight.cameraMode';
export const FP_FOV = 75;

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

/** Stored camera mode; anything missing/invalid (or blocked storage) → third person. */
export function loadCameraMode(store: KV | null = defaultStore()): CameraMode {
  try {
    const v = store?.getItem(CAMERA_MODE_KEY);
    return v === 'first' ? 'first' : 'third';
  } catch { return 'third'; }
}

export function saveCameraMode(mode: CameraMode, store: KV | null = defaultStore()) {
  try { store?.setItem(CAMERA_MODE_KEY, mode); } catch (err) { console.warn('[firstPerson] could not persist camera mode', err); }
}

export const toggleMode = (m: CameraMode): CameraMode => (m === 'first' ? 'third' : 'first');

/** Camera position in first person: the sim's eye (feet + eye height). */
export function eyePosition(feet: Vec3): Vec3 {
  return { x: feet.x, y: feet.y + PLAYER.eyeHeight, z: feet.z };
}

/** Unit view direction for three.js look angles (yaw about +Y, 0 = -Z; pitch up positive). */
export function viewDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Walk/run bob: figure-eight offset (metres, view space) for a stride phase in radians. */
export function bobOffset(phase: number, speed: number, out = { x: 0, y: 0, roll: 0 }): { x: number; y: number; roll: number } {
  const k = Math.min(1, speed / PLAYER.sprint);
  const amp = 0.011 + 0.013 * k; // run bobs harder than walk
  out.x = Math.sin(phase) * amp; out.y = -Math.abs(Math.cos(phase)) * amp * 0.9; out.roll = Math.sin(phase) * 0.02 * k;
  return out;
}

/** Stride phase rate (rad/s) for a horizontal speed: a step every ~0.8 m. */
export const bobRate = (speed: number) => (speed < 0.3 ? 0 : (speed / 0.8) * Math.PI);

/** Slow breathing sway while standing still, in metres. */
export function idleSway(t: number, out = { x: 0, y: 0 }): { x: number; y: number } {
  out.x = Math.sin(t * 0.9) * 0.0035; out.y = Math.sin(t * 1.8) * 0.0025;
  return out;
}

/**
 * First-person camera bob (the eye itself, on top of the viewmodel's own bob): metres sideways / up and a
 * roll in radians, written into `out`. Much subtler than the gun's, and position + roll only, so the
 * crosshair (screen centre) stays on the aim. Zero standing still.
 */
export function cameraBob(phase: number, speed: number, out: { x: number; y: number; roll: number }) {
  if (speed < 0.3) { out.x = 0; out.y = 0; out.roll = 0; return out; }
  const k = Math.min(1, speed / PLAYER.sprint);
  const amp = (0.004 + 0.008 * k) * Math.min(1, speed / 1.5);
  out.x = Math.sin(phase) * amp * 0.6;
  out.y = (0.5 - Math.abs(Math.cos(phase))) * amp; // dips on each footfall, centred on the eye
  out.roll = Math.sin(phase) * 0.0035 * k;
  return out;
}

// ---- impact feel: hit-stop and screen shake (client visuals only) --------------------------------

/**
 * Hit-stop lengths (s): a few frames of near-frozen camera/viewmodel animation on a kill or a heavy hit.
 * Purely visual: the sim, input sampling and look angles never pause.
 */
export const HIT_STOP = { kill: 0.075, heavy: 0.04 };

/** Visual time scale with `left` of a `dur` second hit-stop to go: held near zero, eased back over the last 30%. */
export function hitStopScale(left: number, dur: number): number {
  if (left <= 0 || dur <= 0) return 1;
  const k = left / dur;
  return k > 0.3 ? 0.08 : 0.08 + 0.92 * (1 - k / 0.3);
}

/** A hit worth a short hit-stop: a big chunk of damage or a headshot. */
export const heavyHit = (amount: number, part: unknown) => amount >= 40 || part === 'head';

/** Camera shake (rad) from an explosion `d` metres away: quadratic falloff, nothing past 30 m. */
export function blastShake(d: number, grenade: boolean): number {
  if (d >= 30) return 0;
  return 0.03 * (1 - d / 30) ** 2 * (grenade ? 0.7 : 1);
}

/** Recoil kick 0..1 (`since` = seconds after a shot): snaps up, settles over ~0.18 s. */
export function recoilKick(since: number): number {
  if (since < 0 || since > 0.25) return 0;
  const attack = 0.025;
  return since < attack ? since / attack : Math.exp(-(since - attack) * 22);
}

/** Reload dip 0..1 over the reload (`t` = 0..1 progress): eases down, holds, eases back up. */
export function reloadDip(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (t < 0.2) return ease(t / 0.2);
  if (t > 0.8) return ease((1 - t) / 0.2);
  return 1;
}

/** Shortest signed angle a - b, in (-π, π]. */
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Exponential approach factor for a rate (1/s) over dt seconds (frame-rate independent). */
export const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

// ---- reloads -------------------------------------------------------------------------------------

/**
 * Where a reload is at, from the sim's own clock (so remote players animate in step with their sounds):
 * seconds in, total length, the rounds the gun held at the start, and its beats. Null when not reloading.
 */
export function reloadClock(p: Pick<PlayerState, 'equipped' | 'reloadUntil' | 'reloadSec' | 'reloadMag'>, simNow: number):
  { elapsed: number; duration: number; magStart: number; beats: ReloadBeat[] } | null {
  if (p.reloadUntil <= 0 || p.reloadSec <= 0 || p.equipped === 'fists') return null;
  const elapsed = Math.min(p.reloadSec, Math.max(0, p.reloadSec - (p.reloadUntil - simNow)));
  return { elapsed, duration: p.reloadSec, magStart: p.reloadMag, beats: reloadBeats(p.equipped, p.reloadMag, 99) };
}

/**
 * Reload pose (no three.js): `tilt` 0..1 rolls the gun toward you; the mag/shell/rocket sits at
 * (magY, magZ) metres from its home along the gun (−Y = out the bottom, +Z = behind) and is drawn when
 * `magShow`; `hand` 0..1 = support hand on the mag; `jolt` 0..1 = seat/rack/pump snap.
 */
export type ReloadPose = { tilt: number; magY: number; magZ: number; magShow: boolean; hand: number; jolt: number };
export const REST_POSE: ReloadPose = { tilt: 0, magY: 0, magZ: 0, magShow: true, hand: 0, jolt: 0 };

const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const pulse = (e: number, at: number) => (e >= at && e < at + 0.25 ? Math.exp(-(e - at) * 18) : 0);
const at = (beats: ReloadBeat[], b: ReloadBeat['beat']) => beats.find((x) => x.beat === b)?.t;

export function reloadPose(kind: WeaponKind, elapsed: number, duration: number, magStart: number, beats = reloadBeats(kind, magStart, 99)): ReloadPose {
  if (kind === 'fists' || duration <= 0) return REST_POSE;
  const e = elapsed;
  const ramp = Math.min(0.28, duration * 0.2);
  const tilt = Math.min(smooth(e / ramp), smooth((duration - e) / ramp));
  let jolt = 0;
  for (const b of beats) if (b.beat === 'magIn' || b.beat === 'rack' || b.beat === 'pump' || b.beat === 'load' || b.beat === 'shell') jolt = Math.max(jolt, pulse(e, b.t) * (b.beat === 'shell' ? 0.5 : 1));

  if (kind === 'shotgun') {
    // Each shell: picked up below the loading port, pushed in on its beat.
    const shells = beats.filter((b) => b.beat === 'shell');
    const cur = shells.find((b) => e > b.t - 0.38 && e <= b.t + 0.02);
    if (!cur) return { tilt, magY: -0.12, magZ: 0, magShow: false, hand: shells.some((b) => e < b.t) ? 0.6 : 0, jolt };
    const k = smooth((e - (cur.t - 0.38)) / 0.38);
    return { tilt, magY: -0.12 * (1 - k), magZ: 0, magShow: e < cur.t, hand: 1, jolt };
  }
  if (kind === 'rocket') {
    // The tube is empty after the shot; a fresh rocket slides in at the rear.
    const load = at(beats, 'load') ?? duration * 0.7;
    const from = load - 0.7;
    const k = smooth((e - from) / 0.7);
    return { tilt, magY: -0.05 * (1 - k), magZ: 0.95 * (1 - k), magShow: e >= from, hand: e >= from - 0.3 && e < load + 0.15 ? 1 : 0, jolt };
  }
  const out = at(beats, 'magOut') ?? duration * 0.2;
  const inn = at(beats, 'magIn') ?? duration * 0.65;
  const newFrom = out + (inn - out) * 0.4;
  let magY = 0, magShow = true;
  if (e >= out && e < newFrom) { const f = (e - out) / Math.max(0.01, newFrom - out); magY = -0.4 * f * f; magShow = f < 0.8; }
  else if (e >= newFrom && e < inn) magY = -0.16 * (1 - smooth((e - newFrom) / (inn - newFrom)));
  const rel = at(beats, 'release') ?? out;
  if (e >= rel && e < out) magY = -0.006;
  const hand = e >= out - 0.15 && e < inn + 0.12 ? 1 : 0;
  return { tilt, magY, magZ: 0, magShow, hand, jolt };
}

// ---- aiming --------------------------------------------------------------------------------------

/** Field of view while aiming (the weapon's zoom), eased by `ads` 0..1. */
export function adsFov(baseFov: number, kind: WeaponKind, ads: number): number {
  const zoom = 1 + (WEAPONS[kind].adsZoom - 1) * Math.min(1, Math.max(0, ads));
  // Zoom divides the tangent of the half-angle (what a real magnification does), not the angle.
  const half = Math.atan(Math.tan((baseFov * Math.PI) / 360) / zoom);
  return (half * 360) / Math.PI;
}

/** Recoil kick in view (camera punch) for `since` s after a shot: snappier, larger for big guns. */
export const PUNCH_SCALE: Record<WeaponKind, number> = { fists: 0, pistol: 1, smg: 0.55, shotgun: 2.2, rifle: 0.9, rocket: 2.8 };
