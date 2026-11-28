import { FLASH, PLAYER, SMOKE } from './constants';
import { cos as cosD, sin as sinD } from './dmath';
import type { Physics } from './physics';
import type { Inventory, MatchEvent, PlayerState, SmokeCloud, UtilityKind, Vec3 } from './types';
import { add, dist, norm, scale, sub, v3 } from './vec';

/**
 * Smoke grenades and flashbangs: thrown like a grenade (combat.ts throwUtility / tickExplosives), then
 * - smoke: a cloud (SmokeCloud, in Snapshot.smokes) that blocks sight lines for bots (smokeBlocks) and hides
 *   whatever is in it on screen (client smokeFx);
 * - flash: everyone but the thrower with a clear line to it is blinded (PlayerState.blind) by distance and how
 *   squarely they faced it. Bots can't see while blinded; for humans the client whites out the screen.
 * Everything here is plain arithmetic (+ - * / sqrt), so it is deterministic for replays and bot training.
 */

/** How many of `kind` the inventory holds. */
export const utilCount = (inv: Inventory, kind: UtilityKind): number => (kind === 'smoke' ? inv.smokes ?? 0 : inv.flashes ?? 0);

/** Sets how many of `kind` the inventory holds, dropping the key at 0 (an inventory without any has none). */
export function setUtil(inv: Inventory, kind: UtilityKind, n: number): void {
  const key = kind === 'smoke' ? 'smokes' : 'flashes';
  if (n > 0) inv[key] = n; else delete inv[key];
}

/** Stack limit per kind. */
export const utilMax = (kind: UtilityKind): number => (kind === 'smoke' ? SMOKE.maxCarry : FLASH.maxCarry);

// ---- Smoke ----

/** Cloud radius (m, horizontal) at sim time `now`: blooms from 30% to full over SMOKE.bloomSec (ease-out). */
export function smokeRadius(c: SmokeCloud, now: number): number {
  const u = Math.min(1, Math.max(0, (now - c.t0) / SMOKE.bloomSec));
  const ease = 1 - (1 - u) * (1 - u);
  return SMOKE.radius * (0.3 + 0.7 * ease);
}

/** Cloud density 0..1 at `now`: thick until the last SMOKE.thinSec, then thinning to nothing. */
export function smokeDensity(c: SmokeCloud, now: number): number {
  const age = now - c.t0;
  if (age < 0 || age >= SMOKE.lifeSec) return 0;
  const thinFrom = SMOKE.lifeSec - SMOKE.thinSec;
  return age <= thinFrom ? 1 : 1 - (age - thinFrom) / SMOKE.thinSec;
}

/** Vertical half-size over horizontal radius: the cloud is a squashed ball from below ground to SMOKE.height. */
const SQUASH = (SMOKE.height + 1.5) / 2 / SMOKE.radius;
/** Cloud centre height over where it popped. */
const LIFT = SMOKE.height - (SMOKE.height + 1.5) / 2;

/** The cloud's centre (the ellipsoid's middle). */
export const smokeCenter = (c: SmokeCloud): Vec3 => v3(c.pos.x, c.pos.y + LIFT, c.pos.z);
/** Vertical half-size of the cloud at `now`. */
export const smokeHalfHeight = (c: SmokeCloud, now: number): number => smokeRadius(c, now) * SQUASH;

/**
 * Length (m) of the segment a→b inside the cloud at `now` (ray–ellipsoid: y is stretched by 1/SQUASH so the
 * cloud becomes a ball, and the chord's fraction of the segment is the same in both spaces).
 */
export function smokeChord(c: SmokeCloud, a: Vec3, b: Vec3, now: number): number {
  const r = smokeRadius(c, now);
  const cy = c.pos.y + LIFT;
  const ox = a.x - c.pos.x, oy = (a.y - cy) / SQUASH, oz = a.z - c.pos.z;
  const dx = b.x - a.x, dy = (b.y - a.y) / SQUASH, dz = b.z - a.z;
  const A = dx * dx + dy * dy + dz * dz;
  if (A < 1e-12) return 0;
  const B = ox * dx + oy * dy + oz * dz;
  const C = ox * ox + oy * oy + oz * oz - r * r;
  const disc = B * B - A * C;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - s) / A), t1 = Math.min(1, (-B + s) / A);
  if (t1 <= t0) return 0;
  const L = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
  return (t1 - t0) * L;
}

/** Whether smoke hides b from a at `now`: the smoke the line crosses (chord × density, all clouds) reaches SMOKE.blockM. */
export function smokeBlocks(clouds: readonly SmokeCloud[], a: Vec3, b: Vec3, now: number): boolean {
  let thick = 0;
  for (const c of clouds) {
    const den = smokeDensity(c, now);
    if (den <= 0) continue;
    thick += smokeChord(c, a, b, now) * den;
    if (thick >= SMOKE.blockM) return true;
  }
  return false;
}

/** Whether `p` is inside a cloud thick enough to hide in (client fog, bot "don't walk in" checks). */
export function inSmoke(clouds: readonly SmokeCloud[], p: Vec3, now: number): boolean {
  for (const c of clouds) {
    if (smokeDensity(c, now) < 0.5) continue;
    const r = smokeRadius(c, now);
    const dx = p.x - c.pos.x, dy = (p.y - c.pos.y - LIFT) / SQUASH, dz = p.z - c.pos.z;
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}

/** A smoke grenade pops: a new cloud (the oldest goes past SMOKE.maxClouds). */
export function popSmoke(clouds: SmokeCloud[], id: number, owner: number, pos: Vec3, now: number): MatchEvent {
  clouds.push({ id, owner, pos: { ...pos }, t0: now });
  while (clouds.length > SMOKE.maxClouds) clouds.shift();
  return { t: now, type: 'smoke', data: { id, pos: { ...pos }, by: owner } };
}

/** Drops clouds that have thinned out. */
export function tickSmokes(clouds: SmokeCloud[], now: number): void {
  if (clouds.length && clouds.some((c) => now - c.t0 >= SMOKE.lifeSec))
    clouds.splice(0, clouds.length, ...clouds.filter((c) => now - c.t0 < SMOKE.lifeSec));
}

// ---- Flash ----

/** How hard a flash hits with `facing` = cos(angle between the view and the flash): full within ~45°, a little looking away. */
export function facingFactor(facing: number): number {
  if (facing >= 0.7) return 1;
  if (facing >= 0) return 0.45 + (0.55 * facing) / 0.7;
  return Math.max(0.1, 0.45 + 0.35 * facing);
}

/** How hard a flash hits at distance `d` (m): full within FLASH.fullRange, nothing past FLASH.range. */
export function distanceFactor(d: number): number {
  if (d <= FLASH.fullRange) return 1;
  if (d >= FLASH.range) return 0;
  const u = (d - FLASH.fullRange) / (FLASH.range - FLASH.fullRange);
  return 1 - u * u;
}

/** Whiteness 0..1 of a blinded player's view at `now` (pure white for holdSec×k, then a linear fade over fadeSec×k). */
export function flashAlpha(blind: PlayerState['blind'], now: number): number {
  if (!blind) return 0;
  const t = now - blind.at;
  if (t < 0) return 0;
  const hold = FLASH.holdSec * blind.k, fade = FLASH.fadeSec * blind.k;
  if (t <= hold) return blind.k >= 0.5 ? 1 : 0.5 + blind.k;
  if (t >= hold + fade) return 0;
  return (blind.k >= 0.5 ? 1 : 0.5 + blind.k) * (1 - (t - hold) / fade);
}

/** When a blind stops affecting anything (sim time). */
export const blindEnd = (blind: { at: number; k: number }): number => blind.at + (FLASH.holdSec + FLASH.fadeSec) * blind.k;

/** Blinded hard enough that a bot can't make anyone out (bots/view). */
export const isBlind = (p: PlayerState, now: number): boolean => flashAlpha(p.blind, now) >= 0.5;

/** Eye height of a standing player. */
const eye = (p: PlayerState): Vec3 => v3(p.pos.x, p.pos.y + PLAYER.eyeHeight, p.pos.z);
const look = (p: PlayerState): Vec3 => {
  // Same as combat.aimDir, without the import cycle (dmath trig).
  const c = cosD(p.pitch);
  return v3(-sinD(p.yaw) * c, sinD(p.pitch), -cosD(p.yaw) * c);
};
/**
 * A flashbang goes off at `pos`: everyone alive but the thrower, within FLASH.range with a clear line from the flash
 * to their eyes (walls and pieces block it, other players don't), gets blinded by distance × facing. A stronger or
 * longer-lasting flash replaces a weaker one already running. Teammates are not spared (they should look away).
 */
export function popFlash(physics: Physics, players: Iterable<PlayerState>, owner: number, pos: Vec3, now: number): MatchEvent {
  const hit: [number, number][] = [];
  const from = add(pos, v3(0, 0.15, 0));
  for (const pl of players) {
    if (!pl.alive || pl.id === owner) continue;
    const e = eye(pl);
    const d = dist(from, e);
    if (d >= FLASH.range) continue;
    if (d > 0.3) {
      const dir = norm(sub(e, from));
      const block = physics.raycast(from, dir, d - 0.2, pl.id, true);
      if (block && block.hit.type !== 'player') continue;
    }
    const to = d > 1e-6 ? scale(sub(from, e), 1 / d) : v3(0, 0, 0);
    const l = look(pl);
    const facing = d > 1e-6 ? to.x * l.x + to.y * l.y + to.z * l.z : 1;
    const k = Math.round(facingFactor(facing) * distanceFactor(d) * 1000) / 1000;
    if (k < FLASH.minK) continue;
    if (!pl.blind || blindEnd({ at: now, k }) > blindEnd(pl.blind) || flashAlpha(pl.blind, now) < (k >= 0.5 ? 1 : 0.5 + k)) pl.blind = { at: now, k };
    hit.push([pl.id, k]);
  }
  return { t: now, type: 'flash', data: { pos: { ...pos }, by: owner, hit } };
}

/** Clears blinds that have worn off (keeps snapshots small). */
export function tickBlind(players: Iterable<PlayerState>, now: number): void {
  for (const p of players) if (p.blind && (now >= blindEnd(p.blind) || !p.alive)) delete p.blind;
}
