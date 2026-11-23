// Snapshot → sound cues. Pure (no Web Audio) so the decisions can be unit-tested.

import { insideBunker } from '../../sim/bots/nav';
import { MAP, PIECES, PLAYER, WEAPONS } from '../../sim/constants';
import type { DockDef, IslandLayout } from '../../sim/map';
import { overDock } from '../../sim/docks';
import type { PieceKind, PieceState, PlayerState, Snapshot, Vec3, WeaponKind } from '../../sim/types';
import { beatsBetween } from '../../sim/gunplay';
import { reloadClock } from '../firstPerson';

/** 'wet': grass/sand in the rain; 'gravel' and 'water' are for callers (docks, shallows) and bullet impacts. */
export type Surface = 'grass' | 'sand' | 'concrete' | 'wood' | 'hollow' | 'metal' | 'wet' | 'gravel' | 'water';

export type SoundId =
  | 'shot' | 'impact' | 'hurt' | 'hitmarker' | 'splash'
  | 'explosion' | 'placed' | 'destroyed'
  | 'coin' | 'loot' | 'purchase' | 'vault'
  | 'kill' | 'death' | 'eliminated' | 'elimination' | 'win' | 'lose' | 'draw'
  | 'alarm' | 'ping' | 'tick' | 'escaped' | 'horn' | 'footstep'
  | 'shieldHit' | 'shieldBreak' | 'drink' | 'potionDone'
  | 'reload' | 'dry' | 'ads' | 'thunder'
  | 'headshot' | 'shieldCrack' | 'land'
  /** Barrels / tanks / crates: kind 'hiss' (fuse), 'clang' (bullet on a drum), 'crateHit', 'crate' (breaks). */
  | 'hazard'
  /** Drawing a weapon (kind = WeaponKind); pushing off the ground (kind = Surface); a UI button click. */
  | 'equip' | 'jump' | 'click'
  // Hooks for round-11 features (playSfx in api.ts). kind = Surface where it says so.
  | 'grappleFire' | 'grappleAttach' | 'grappleReel' | 'grappleRelease'
  | 'spikeArm' | 'spikeTrigger'
  | 'shellCasing' | 'ragdollThud'
  | 'dockCreak' | 'dockBreak'
  /** An island beacon shutting down (its owner is out of the game). */
  | 'beaconDown';

export type Cue = {
  sound: SoundId;
  /** World position for 3D cues; null = 2D (UI / your own body). */
  pos: Vec3 | null;
  /** Base loudness 0..~1.5 before distance falloff. */
  gain: number;
  /** Weapon / piece kind / surface / 'urgent' — selects the recipe variant. */
  kind?: string;
  /** Your own action: closer, punchier variant. */
  own?: boolean;
};

/** Where the listener's player is, for ambience and the low-health muffle. */
export type Env = { alive: boolean; hp: number; inBunker: boolean; shoreDist: number; inWater: boolean; storm?: boolean };

export const LOW_HP = 30;
const STRIDE = 1.7; // metres between footsteps
const STEP_MIN_SPEED = 0.8; // m/s
const TELEPORT = 4; // metres in one snapshot = respawn/teleport, not walking
const LOOT_PICKUP_RADIUS = 3.5;
/** Someone else's footstep loudness (yours: 0.4). */
export const ENEMY_STEP_GAIN = 0.75;
/** Falling faster than this (m/s down) and then grounded = a landing thud. */
export const LAND_MIN_FALL = 4.5;

/** Was falling (vy below -LAND_MIN_FALL), now on the ground (|vy| small), not a teleport, not into water. */
export function isLanding(prevVy: number, vy: number, moved: number, aboveWater: boolean): boolean {
  return prevVy < -LAND_MIN_FALL && Math.abs(vy) < 0.5 && moved <= TELEPORT && aboveWater;
}

/** Landing loudness by fall speed (m/s, negative = down). */
export function landGain(prevVy: number, own: boolean): number {
  return Math.min(own ? 0.7 : 1.1, (own ? 0.35 : 0.55) + (-prevVy - LAND_MIN_FALL) / 20);
}

/** Ground the player stands on: a piece top under their feet, else the island (bunker floor / shore sand / grass). */
export function surfaceAt(p: Vec3, pieces: PieceState[], map: IslandLayout[], docks: readonly DockDef[] = [], broken: readonly number[] = []): Surface {
  for (const pc of pieces) {
    const s = PIECES[pc.kind];
    const dx = p.x - pc.pos.x, dz = p.z - pc.pos.z;
    // World → piece-local (inverse of sim's rotateY).
    const c = Math.cos(pc.rotY), sn = Math.sin(pc.rotY);
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    if (Math.abs(lx) > s.w / 2 + 0.2 || Math.abs(lz) > s.d / 2 + 0.2) continue;
    if (p.y < pc.pos.y + 0.05 || p.y > pc.pos.y + s.h + 0.35) continue;
    return pieceSurface(pc.kind);
  }
  // Pier planks (standing sections only: a broken one is water).
  for (const d of docks) if (overDock(d, p, 0.2) && Math.abs(p.y - (d.center.y + d.half.y)) < 0.4 && !broken.includes(d.id)) return 'wood';
  for (const isl of map) {
    const d = Math.hypot(p.x - isl.center.x, p.z - isl.center.z);
    if (d > isl.radius + 2) continue;
    if (insideBunker(isl.bunker, p)) return 'concrete';
    return d > isl.radius - 5 ? 'sand' : 'grass';
  }
  return 'sand';
}

export function pieceSurface(kind: PieceKind): Surface {
  switch (kind) {
    case 'sandbags': return 'sand';
    case 'wood': case 'ramp': return 'wood';
    case 'scaffold': return 'hollow';
    default: return 'metal';
  }
}

/** Horizontal distance to the nearest shoreline (0 = at the waterline). */
export function shoreDistance(p: Vec3, map: IslandLayout[]): number {
  let best = Infinity;
  for (const isl of map) best = Math.min(best, Math.abs(Math.hypot(p.x - isl.center.x, p.z - isl.center.z) - isl.radius));
  return best;
}

export function inAnyBunker(p: Vec3, map: IslandLayout[]): boolean {
  return map.some((isl) => p.y < isl.groundY + MAP.bunker.height && insideBunker(isl.bunker, p));
}

/** Where a bullet that hit no player or piece landed: water below the surface line, else the ground there. */
export function impactSurface(p: Vec3, waterY: number, map: IslandLayout[], docks: readonly DockDef[] = [], broken: readonly number[] = []): Surface {
  if (p.y < waterY + 0.25) return 'water';
  if (docks.some((d) => !broken.includes(d.id) && overDock(d, p))) return 'wood'; // pier planks
  for (const isl of map) {
    const d = Math.hypot(p.x - isl.center.x, p.z - isl.center.z);
    if (d > isl.radius + 2) continue;
    if (insideBunker(isl.bunker, p)) return 'concrete';
    return d > isl.radius - 5 ? 'sand' : 'grass';
  }
  return 'concrete'; // harbor quays and seawalls around the islands
}

/**
 * How many solid walls stand between `a` (listener) and `b` (source): built pieces the straight line
 * crosses (scaffold floors are open), plus one when exactly one end is inside a bunker. 0 = clear.
 * Per cue, not per frame: a 2D slab test per piece, then the line's height where it crosses.
 */
export function occlusion(a: Vec3, b: Vec3, pieces: PieceState[], map: IslandLayout[]): number {
  let n = 0;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const pc of pieces) {
    if (pc.kind === 'scaffold') continue;
    const s = PIECES[pc.kind];
    const c = Math.cos(pc.rotY), sn = Math.sin(pc.rotY);
    const ax = a.x - pc.pos.x, az = a.z - pc.pos.z;
    // World → piece-local (as surfaceAt).
    const lx0 = ax * c - az * sn, lz0 = ax * sn + az * c;
    const ldx = dx * c - dz * sn, ldz = dx * sn + dz * c;
    let t0 = 0, t1 = 1;
    const clip = (p0: number, d: number, h: number) => {
      if (Math.abs(d) < 1e-9) return Math.abs(p0) <= h;
      let ta = (-h - p0) / d, tb = (h - p0) / d;
      if (ta > tb) { const x = ta; ta = tb; tb = x; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      return t0 <= t1;
    };
    if (!clip(lx0, ldx, s.w / 2) || !clip(lz0, ldz, s.d / 2)) continue;
    // An end inside the piece's footprint (standing on/against it) doesn't count as through it.
    if (t0 <= 0.001 || t1 >= 0.999) continue;
    const y = a.y + (b.y - a.y) * (t0 + t1) / 2;
    if (y >= pc.pos.y && y <= pc.pos.y + s.h) n++;
  }
  if (inAnyBunker(a, map) !== inAnyBunker(b, map)) n++;
  return n;
}

type StepTrack = { x: number; z: number; acc: number };

/** Bullet impact cues per shot at most (a shotgun blast would otherwise be 10 identical ticks). */
const MAX_IMPACTS_PER_SHOT = 3;
/** An endpoint this close to a player/piece/hazard hit point is that hit, voiced by its own event. */
const SAME_POINT = 0.8;

export class SoundDirector {
  private map: IslandLayout[] = [];
  private docks: readonly DockDef[] = [];
  /** Grappling hook: last winch-rattle time per player (reel cue every 0.6 s while reeling in). */
  private reelAt = new Map<number, number>();
  private humanId = -1;
  private prev: Snapshot | null = null;
  private steps = new Map<number, StepTrack>();
  private lastTickSec: number | null = null;
  /** Per player: the reload being voiced (its end time) and how far into it we've played. */
  private reloads = new Map<number, { until: number; heard: number }>();
  env: Env = { alive: false, hp: 100, inBunker: false, shoreDist: 50, inWater: false };

  /** A new match (also a rematch): forget the previous match's snapshot so nothing is diffed across them. */
  setMap(map: IslandLayout[], humanId: number, docks: readonly DockDef[] = []) {
    this.map = map;
    this.docks = docks;
    this.humanId = humanId;
    this.prev = null;
    this.steps.clear();
    this.lastTickSec = null;
  }

  /** Spectating: hear the game as the viewed player (their hits, footsteps and gun as "own"). */
  setViewed(id: number) { this.humanId = id; }

  update(s: Snapshot): Cue[] {
    const out: Cue[] = [];
    const me = s.players.find((p) => p.id === this.humanId) ?? null;
    const prev = this.prev;
    const prevMe = prev?.players.find((p) => p.id === this.humanId) ?? null;
    const byId = new Map<number, PlayerState>();
    for (const p of s.players) byId.set(p.id, p);
    const chest = (id: unknown): Vec3 | null => {
      const p = byId.get(id as number);
      return p ? { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z } : null;
    };
    // Points where a bullet hit a player, piece or hazard: those events voice them (flesh, material, clang).
    const struck: Vec3[] = [];
    for (const e of s.events) {
      if ((e.type === 'hit' || e.type === 'pieceHit' || e.type === 'hazard') && e.data.pos) struck.push(e.data.pos as Vec3);
    }

    for (const e of s.events) {
      const d = e.data;
      switch (e.type) {
        case 'shot': {
          // The echo of your predicted shot (shotPredict.ts) already played its bang; its impacts still sound.
          const own = d.by === this.humanId;
          if (!d.echo) out.push({ sound: 'shot', kind: d.weapon as WeaponKind, pos: own ? null : (d.from as Vec3), gain: own ? 1 : 0.9, own });
          this.impacts(d, struck, s, out);
          break;
        }
        case 'pieceHit':
          if (d.pos && d.source !== 'explosive') out.push({ sound: 'impact', kind: pieceSurface(d.kind as PieceKind), pos: d.pos as Vec3, gain: d.source === 'fist' ? 0.5 : 0.6 });
          break;
        case 'hit': {
          const amount = Number(d.amount) || 0;
          const shield = Number(d.shieldAmount) || 0;
          const flesh = amount - shield;
          // The shield part rings (shieldHit), a break shatters, the rest is the usual flesh hit.
          if (d.target === this.humanId) {
            if (shield > 0) out.push({ sound: 'shieldHit', pos: null, gain: 0.8, own: true });
            if (d.broke) out.push({ sound: 'shieldBreak', pos: null, gain: 1, own: true });
            if (flesh > 0) out.push({ sound: 'hurt', pos: null, gain: Math.min(1.2, 0.55 + flesh / 60) });
          } else {
            const at = chest(d.target);
            if (at && shield > 0) out.push({ sound: 'shieldHit', pos: at, gain: 0.7 });
            if (at && d.broke) out.push({ sound: 'shieldBreak', pos: at, gain: 1 });
            if (at && flesh > 0) out.push({ sound: 'impact', pos: at, gain: 0.7 });
            if (d.by === this.humanId && !d.echo) {
              // Your hit: tick, plus a ding for a headshot and a crack when it broke their shield.
              out.push({ sound: 'hitmarker', pos: null, gain: 0.6 });
              if (d.part === 'head') out.push({ sound: 'headshot', pos: null, gain: 0.7 });
            }
            if (d.by === this.humanId && d.broke) out.push({ sound: 'shieldCrack', pos: null, gain: 0.75 });
          }
          break;
        }
        case 'kill':
          if (d.victim === this.humanId) out.push({ sound: 'death', pos: null, gain: 1 });
          else if (d.killer === this.humanId) out.push({ sound: 'kill', pos: null, gain: 0.9 });
          if (d.inWater) { const at = chest(d.victim); if (at) out.push({ sound: 'splash', pos: at, gain: 0.8 }); }
          break;
        case 'grapple': {
          const own = d.by === this.humanId || d.target === this.humanId;
          const phase = String(d.phase);
          const at = chest(d.by);
          if (!own && !at) break;
          const pos = own ? null : at;
          if (phase === 'fire') out.push({ sound: 'grappleFire', pos, gain: own ? 0.7 : 0.6, own });
          else if (phase === 'latch' || phase === 'yank') {
            // The claw bites where the hook is (PlayerState.hook), else at the shooter.
            const h = s.players.find((p) => p.id === d.by)?.hook as { x?: number; y?: number; z?: number } | undefined;
            const hp = h && h.x !== undefined ? { x: h.x, y: h.y ?? 0, z: h.z ?? 0 } : pos;
            out.push({ sound: 'grappleAttach', pos: hp, gain: own ? 0.7 : 0.6, own });
          } else out.push({ sound: 'grappleRelease', pos, gain: own ? 0.6 : 0.5, own });
          break;
        }
        case 'dry': {
          const own = d.by === this.humanId;
          const at = chest(d.by);
          if (own || at) out.push({ sound: 'dry', kind: String(d.weapon), pos: own ? null : at, gain: own ? 0.7 : 0.5, own });
          break;
        }
        case 'explosion':
          out.push({ sound: 'explosion', kind: String(d.kind), pos: d.pos as Vec3, gain: d.kind === 'barrel' || d.kind === 'propane' ? 1.6 : 1.4 });
          break;
        case 'hazard': {
          const at = d.pos as Vec3 | undefined;
          if (!at) break;
          const crate = d.kind === 'crate';
          if (d.what === 'fuse') out.push({ sound: 'hazard', kind: 'hiss', pos: at, gain: 1.1 });
          else if (d.what === 'hit') out.push({ sound: 'hazard', kind: crate ? 'crateHit' : 'clang', pos: at, gain: 0.7 });
          else if (d.what === 'break') out.push({ sound: 'hazard', kind: 'crate', pos: at, gain: 1 });
          break;
        }
        case 'trap': {
          // Spike trap: snaps out with a steel clang; set down / broken sound like a metal piece.
          const at = d.pos as Vec3 | undefined;
          if (!at) break;
          if (d.what === 'fired') out.push({ sound: 'spikeTrigger', pos: at, gain: 1 });
          else if (d.what === 'placed') out.push({ sound: 'spikeArm', pos: at, gain: 0.8 });
          else if (d.what === 'broken') out.push({ sound: 'destroyed', kind: 'metal', pos: at, gain: 0.6 });
          break;
        }
        case 'placed': {
          const pc = s.pieces.find((p) => p.id === d.piece);
          const at = pc?.pos ?? chest(d.by);
          if (at) out.push({ sound: 'placed', kind: String(d.kind), pos: at, gain: 0.8, own: d.by === this.humanId });
          break;
        }
        case 'destroyed': {
          const pc = prev?.pieces.find((p) => p.id === d.piece) ?? s.pieces.find((p) => p.id === d.piece);
          if (pc) out.push({ sound: 'destroyed', kind: String(d.kind), pos: { x: pc.pos.x, y: pc.pos.y + 1, z: pc.pos.z }, gain: 1 });
          break;
        }
        case 'dockBroken': {
          // A pier section giving way: the wooden-piece break, a little heavier.
          const at = d.pos as { x: number; y: number; z: number } | undefined;
          if (at) out.push({ sound: 'dockBreak', pos: at, gain: 1.2 });
          break;
        }
        case 'sealed':
          // Every seal is a big moment: a heavy non-positional boom for everyone, plus the alarm if it's yours.
          out.push({ sound: 'explosion', kind: 'charge', pos: null, gain: 1.6 });
          if (me && d.island === me.island) out.push({ sound: 'alarm', pos: null, gain: 0.8 });
          break;
        case 'eliminated':
          if (d.player === this.humanId) out.push({ sound: 'eliminated', pos: null, gain: 0.9 });
          break;
        case 'elimination':
          // Glory sting for everyone on a credited elimination; brighter (kind 'mine') for the eliminator.
          if (d.by !== null) out.push({ sound: 'elimination', kind: d.by === this.humanId ? 'mine' : undefined, pos: null, gain: d.by === this.humanId ? 1.0 : 0.7 });
          break;
        case 'win':
          if (me) out.push({ sound: d.winner === this.humanId ? 'win' : d.winner === -1 ? 'draw' : 'lose', pos: null, gain: 0.9 });
          break;
        case 'suddenDeath':
          out.push({ sound: 'horn', pos: null, gain: 0.9 });
          break;
        case 'lightning':
          // The engine delays it by distance (sound travels ~343 m/s) and sets crack vs rumble.
          if (d.pos) out.push({ sound: 'thunder', pos: d.pos as Vec3, gain: 1.2 });
          break;
        case 'escaped':
          if (d.player === this.humanId) out.push({ sound: 'escaped', pos: null, gain: 0.8 });
          break;
        // 'trapped' is voiced by the countdown below; 'unsealed' is silent.
      }
    }

    if (me && prevMe && me.alive && prevMe.alive) this.economy(me, prevMe, prev!, s, out);
    this.potions(s, prev, out);
    this.countdown(me, s, out);
    this.footsteps(s, prev, out);
    this.landings(s, prev, out);
    // Grappling hook reeling in (st 1): a winch rattle every 0.6 s at the user.
    for (const p of s.players) {
      if (p.hook?.st !== 1) { this.reelAt.delete(p.id); continue; }
      const last = this.reelAt.get(p.id);
      if (last !== undefined && s.time - last < 0.6) continue;
      this.reelAt.set(p.id, s.time);
      const own = p.id === this.humanId;
      out.push({ sound: 'grappleReel', pos: own ? null : { ...p.pos }, gain: own ? 0.5 : 0.45, own });
    }
    // Pier planks stressed by a blast (newly scorched sections): a creak where they stand.
    for (const id of s.dockHurt ?? []) {
      if (prev?.dockHurt?.includes(id)) continue;
      const d = this.docks.find((x) => x.id === id);
      if (d) out.push({ sound: 'dockCreak', pos: { ...d.center }, gain: 0.6 });
    }
    this.equipsAndJumps(s, prev, out);
    this.reloadBeats(s, out);

    if (me) {
      this.env = {
        alive: me.alive,
        hp: me.hp,
        inBunker: me.alive && inAnyBunker(me.pos, this.map),
        shoreDist: shoreDistance(me.pos, this.map),
        inWater: me.pos.y < s.waterY + 0.2,
        storm: s.suddenDeath,
      };
    }
    this.prev = s;
    return out;
  }

  /** Cash up → coin jingle (or loot rustle when a bag at your feet vanished); cash down not into the vault → purchase ding. */
  private economy(me: PlayerState, prevMe: PlayerState, prev: Snapshot, s: Snapshot, out: Cue[]) {
    const delta = me.inv.cash - prevMe.inv.cash;
    if (delta > 0) {
      const looted = prev.loot.some((b) =>
        !s.loot.some((x) => x.id === b.id) && Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z) < LOOT_PICKUP_RADIUS);
      out.push({ sound: looted ? 'loot' : 'coin', pos: null, gain: 0.6 });
    } else if (delta < 0) {
      const deposited = me.vault.cash - prevMe.vault.cash;
      if (deposited < -delta) out.push({ sound: 'purchase', pos: null, gain: 0.7 });
    }
  }

  /** Gulp when anyone starts drinking (yours 2D); a chime when your own drink finishes (not when you die mid-drink). */
  private potions(s: Snapshot, prev: Snapshot | null, out: Cue[]) {
    if (!prev) return;
    for (const p of s.players) {
      const was = prev.players.find((q) => q.id === p.id);
      if (!was) continue;
      const own = p.id === this.humanId;
      if (p.alive && p.drinking && !was.drinking) {
        out.push({ sound: 'drink', pos: own ? null : { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z }, gain: own ? 0.7 : 0.6, own });
      } else if (own && p.alive && !p.drinking && was.drinking) {
        out.push({ sound: 'potionDone', kind: was.drinking.kind, pos: null, gain: 0.6 });
      }
    }
  }

  /** One beep per whole second while you're trapped in your sealed bunker; urgent in the last 3. */
  private countdown(me: PlayerState | null, s: Snapshot, out: Cue[]) {
    if (!me || me.breakoutUntil === null || !me.alive) { this.lastTickSec = null; return; }
    const sec = Math.ceil(me.breakoutUntil - s.time);
    if (sec > 0 && sec !== this.lastTickSec) out.push({ sound: 'tick', kind: sec <= 3 ? 'urgent' : 'normal', pos: null, gain: 0.7 });
    this.lastTickSec = sec;
  }

  /**
   * Reload sounds land on the same beats the reload animation uses (from the sim's clock), one cue per
   * beat crossed since the last snapshot: mag release / out / in, rack, each shotgun shell, pump, rocket load.
   */
  private reloadBeats(s: Snapshot, out: Cue[]) {
    for (const p of s.players) {
      const c = p.alive ? reloadClock(p, s.time) : null;
      if (!c) { this.reloads.delete(p.id); continue; }
      let r = this.reloads.get(p.id);
      if (!r || r.until !== p.reloadUntil) { r = { until: p.reloadUntil, heard: -1 }; this.reloads.set(p.id, r); }
      const own = p.id === this.humanId;
      for (const b of beatsBetween(c.beats, r.heard, c.elapsed)) {
        out.push({ sound: 'reload', kind: `${p.equipped}:${b.beat}`, pos: own ? null : { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z }, gain: own ? 0.75 : 0.6, own });
      }
      r.heard = c.elapsed;
    }
  }

  /** Pieces in the latest snapshot (occlusion tests by the engine). */
  get pieces(): PieceState[] { return this.prev?.pieces ?? []; }

  /**
   * Where each bullet of a shot landed when it hit nothing else: the ground's surface or water. Skips
   * misses that flew to max range, rockets (from = to) and points another hit event already voices.
   */
  private impacts(d: Record<string, unknown>, struck: Vec3[], s: Snapshot, out: Cue[]) {
    const from = d.from as Vec3 | undefined;
    if (!from || !d.to) return;
    const range = WEAPONS[d.weapon as WeaponKind]?.range ?? 0;
    const ends = [d.to as Vec3, ...((d.tos as Vec3[] | undefined) ?? [])];
    let n = 0;
    for (const p of ends) {
      if (n >= MAX_IMPACTS_PER_SHOT) break;
      const len = Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z);
      if (len < 0.3 || len >= range - 0.5) continue;
      if (struck.some((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < SAME_POINT)) continue;
      out.push({ sound: 'impact', kind: impactSurface(p, s.waterY, this.map, this.docks, s.docks ?? []), pos: { x: p.x, y: p.y, z: p.z }, gain: 0.55 });
      n++;
    }
  }

  /** Drawing another weapon (a cue per change while alive); leaving the ground upward (a jump push-off). */
  private equipsAndJumps(s: Snapshot, prev: Snapshot | null, out: Cue[]) {
    if (!prev) return;
    for (const p of s.players) {
      const was = prev.players.find((q) => q.id === p.id);
      if (!was || !p.alive || !was.alive || s.hidden?.includes(p.id)) continue;
      const own = p.id === this.humanId;
      if (p.equipped !== was.equipped) {
        out.push({ sound: 'equip', kind: p.equipped, pos: own ? null : { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z }, gain: own ? 0.6 : 0.5, own });
      }
      if (Math.abs(was.vel.y) < 0.5 && p.vel.y > 2.5 && was.pos.y > s.waterY + 0.2) {
        out.push({ sound: 'jump', kind: this.stepSurface(was.pos, s), pos: own ? null : { ...was.pos }, gain: own ? 0.45 : 0.7, own });
      }
    }
  }

  /** Underfoot, with grass and sand turned wet in the storm's rain. */
  private stepSurface(p: Vec3, s: Snapshot): Surface {
    const k = surfaceAt(p, s.pieces, this.map, this.docks, s.docks);
    return s.suddenDeath && (k === 'grass' || k === 'sand') && !inAnyBunker(p, this.map) ? 'wet' : k;
  }

  /** Touching down after a fall: a thud on the surface landed on, heavier the faster the fall. */
  private landings(s: Snapshot, prev: Snapshot | null, out: Cue[]) {
    if (!prev) return;
    for (const p of s.players) {
      const was = prev.players.find((q) => q.id === p.id);
      if (!was || !p.alive || !was.alive || s.hidden?.includes(p.id)) continue;
      if (!isLanding(was.vel.y, p.vel.y, Math.hypot(p.pos.x - was.pos.x, p.pos.z - was.pos.z), p.pos.y > s.waterY + 0.2)) continue;
      const own = p.id === this.humanId;
      out.push({ sound: 'land', kind: this.stepSurface(p.pos, s), pos: own ? null : { ...p.pos }, gain: landGain(was.vel.y, own), own });
    }
  }

  /** A step every STRIDE metres of grounded horizontal movement; surface from what's underfoot. */
  private footsteps(s: Snapshot, prev: Snapshot | null, out: Cue[]) {
    const dt = prev ? s.time - prev.time : 0;
    for (const p of s.players) {
      const t = this.steps.get(p.id);
      if (!t || !p.alive) { this.steps.set(p.id, { x: p.pos.x, z: p.pos.z, acc: 0 }); continue; }
      const d = Math.hypot(p.pos.x - t.x, p.pos.z - t.z);
      t.x = p.pos.x; t.z = p.pos.z;
      const grounded = Math.abs(p.vel.y) < 0.5 && p.pos.y > s.waterY + 0.2;
      if (d > TELEPORT || !grounded || dt <= 0 || d / dt < STEP_MIN_SPEED) { if (d > TELEPORT || !grounded) t.acc = 0; continue; }
      t.acc += d;
      if (t.acc >= STRIDE) {
        t.acc -= STRIDE;
        const own = p.id === this.humanId;
        // Enemy steps are louder than your own: they're information (capped by HEARING.footstep).
        // Speed: a sprint lands harder than a walk, a creep softer.
        const pace = Math.min(1.3, Math.max(0.6, d / dt / PLAYER.walk));
        out.push({ sound: 'footstep', kind: this.stepSurface(p.pos, s), pos: { ...p.pos }, gain: (own ? 0.4 : ENEMY_STEP_GAIN) * pace, own });
      }
    }
  }
}
