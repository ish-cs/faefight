import { BURST_RESET_SEC, PLAYER, WEAPONS } from './constants';
import type { PlayerState, WeaponKind } from './types';

/**
 * Pure gun maths shared by the sim (authoritative) and the client (crosshair, camera kick):
 * spread cone, bloom, recoil pattern, damage falloff and reload timing. Everything here is
 * deterministic: the same inputs give the same numbers on the host and every client.
 */

export const DEG = Math.PI / 180;

/** Small deterministic hash → [0, 1). */
export function hash01(a: number, b: number, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

type GunState = Pick<PlayerState, 'ads' | 'bloom' | 'lastShotAt'>;
export type Motion = { speed: number; grounded: boolean };

/** Bloom holds this long after a shot before recovering (so sustained fire builds it). */
export const BLOOM_HOLD_SEC = 0.12;

/** Bloom left now (deg): what the last shots added, minus recovery since. */
export function currentBloom(kind: WeaponKind, s: GunState, now: number): number {
  const g = WEAPONS[kind].spread;
  return Math.max(0, s.bloom - g.recover * Math.max(0, now - s.lastShotAt - BLOOM_HOLD_SEC));
}

/**
 * Spread cone half-angle (deg) for the next shot: base (hip or aimed) + bloom + a movement penalty
 * (scaled by walk speed, larger sprinting, largest airborne). Aiming halves the movement penalty.
 */
export function spreadDeg(kind: WeaponKind, s: GunState, now: number, m: Motion): number {
  const g = WEAPONS[kind].spread;
  const bloom = currentBloom(kind, s, now) * (s.ads ? 0.6 : 1);
  let move: number;
  if (!m.grounded) move = g.air;
  else if (m.speed > PLAYER.walk + 0.5) move = g.sprint;
  else move = g.move * Math.min(1, m.speed / PLAYER.walk);
  return (s.ads ? g.ads : g.base) + bloom + move * (s.ads ? 0.5 : 1);
}

/** Bloom after firing one more shot now. */
export function bloomAfterShot(kind: WeaponKind, s: GunState, now: number): number {
  const g = WEAPONS[kind].spread;
  return Math.min(g.max, currentBloom(kind, s, now) + g.perShot);
}

/** Index of the next shot in the current burst (0 = first shot after a pause). */
export function nextBurst(kind: WeaponKind, s: Pick<PlayerState, 'burst' | 'lastShotAt'>, now: number): number {
  const gap = 1 / WEAPONS[kind].rps + BURST_RESET_SEC;
  return now - s.lastShotAt > gap ? 0 : s.burst;
}

/**
 * Recoil kick (radians) for shot `n` of a burst: a climb that grows with the burst plus a horizontal
 * drift (a fixed per-weapon sway + per-shot jitter from `seed`). Pitch is always up (positive).
 */
export function recoilKick(kind: WeaponKind, n: number, seed: number): { pitch: number; yaw: number } {
  const r = WEAPONS[kind].recoil;
  if (r.up === 0 && r.side === 0) return { pitch: 0, yaw: 0 };
  const pitch = r.up * (1 + r.upGrow * Math.min(n, 10)) * (0.9 + 0.2 * hash01(seed, n, 1));
  const sway = Math.sin(n * 0.9 + 0.6) * 0.6;
  const jitter = (hash01(seed, n, 2) * 2 - 1) * 0.4;
  const yaw = r.side * (r.sideBias / Math.max(r.side, 1e-6) + sway + jitter);
  return { pitch: pitch * DEG, yaw: yaw * DEG };
}

/** Damage multiplier at range `d` metres. */
export function falloff(kind: WeaponKind, d: number): number {
  const f = WEAPONS[kind].falloff;
  if (d <= f.start) return 1;
  if (d >= f.end) return f.minMult;
  return 1 - (1 - f.minMult) * ((d - f.start) / (f.end - f.start));
}

/** Rounds a full reload leaves in the gun: a tactical reload keeps one in the chamber. */
export function magCap(kind: WeaponKind, magNow: number): number {
  const w = WEAPONS[kind];
  return w.mag + (w.chamber && magNow > 0 ? 1 : 0);
}

/** Reload duration (s): tactical vs empty; the shotgun loads shell by shell (plus a short start). */
export function reloadTime(kind: WeaponKind, magNow: number, spare = Infinity): number {
  const w = WEAPONS[kind];
  if (kind === 'shotgun') return 0.4 + w.reloadSec * Math.max(1, Math.min(w.mag - magNow, spare)) + (magNow === 0 ? 0.35 : 0);
  return magNow > 0 ? w.reloadSec : w.reloadEmptySec;
}

/**
 * Deterministic point inside a cone of half-angle `coneDeg`: returns yaw/pitch offsets (radians).
 * Centre-weighted (radius ∝ u, not √u) like a real shot group.
 */
export function coneOffset(coneDeg: number, u1: number, u2: number): { yaw: number; pitch: number } {
  const r = coneDeg * DEG * u1;
  const a = u2 * Math.PI * 2;
  return { yaw: Math.cos(a) * r, pitch: Math.sin(a) * r };
}

// ---- reload choreography -------------------------------------------------------------------------

export type ReloadBeatKind = 'release' | 'magOut' | 'magIn' | 'rack' | 'shell' | 'pump' | 'load';
/** A moment in a reload (seconds from its start) that the animation and the sound both hit. */
export type ReloadBeat = { t: number; beat: ReloadBeatKind };

const SHELL_LIFT = 0.4;
const PUMP_SEC = 0.35;

/** Shells a shotgun reload loads, starting from `magStart` with `spare` left. */
const shellsToLoad = (magStart: number, spare: number) => Math.max(1, Math.min(WEAPONS.shotgun.mag - magStart, spare));

/**
 * The beats of a reload, in order. Box-magazine guns: release, mag out, mag in, and a slide/bolt rack only
 * when reloading from empty (that's why an empty reload takes longer). Shotgun: one beat per shell, then a
 * pump if it was empty. Rocket: one heavy load at the rear. The last beat lands before the reload ends.
 */
export function reloadBeats(kind: WeaponKind, magStart: number, spare = Infinity): ReloadBeat[] {
  if (kind === 'fists') return [];
  if (kind === 'shotgun') {
    const n = shellsToLoad(magStart, spare);
    const out: ReloadBeat[] = [];
    for (let k = 1; k <= n; k++) out.push({ t: SHELL_LIFT + WEAPONS.shotgun.reloadSec * k - 0.12, beat: 'shell' });
    if (magStart === 0) out.push({ t: SHELL_LIFT + WEAPONS.shotgun.reloadSec * n + PUMP_SEC * 0.5, beat: 'pump' });
    return out;
  }
  const d = reloadTime(kind, magStart, spare);
  if (kind === 'rocket') return [{ t: d * 0.2, beat: 'magOut' }, { t: d * 0.7, beat: 'load' }];
  if (magStart > 0) return [{ t: d * 0.1, beat: 'release' }, { t: d * 0.2, beat: 'magOut' }, { t: d * 0.7, beat: 'magIn' }];
  return [{ t: d * 0.08, beat: 'release' }, { t: d * 0.16, beat: 'magOut' }, { t: d * 0.55, beat: 'magIn' }, { t: d * 0.82, beat: 'rack' }];
}

/** Shotgun shells that should be in by `elapsed` seconds into a reload from `magStart`. */
export function shellsLoadedBy(magStart: number, spare: number, elapsed: number): number {
  return reloadBeats('shotgun', magStart, spare).filter((b) => b.beat === 'shell' && b.t <= elapsed).length;
}

/** Beats crossed in (from, to] seconds of a reload (for sounds fired as snapshots arrive). */
export function beatsBetween(beats: ReloadBeat[], from: number, to: number): ReloadBeat[] {
  return beats.filter((b) => b.t > from && b.t <= to);
}
