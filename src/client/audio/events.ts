// Snapshot → sound cues. Pure (no Web Audio) so the decisions can be unit-tested.

import { insideBunker } from '../../sim/bots/nav';
import { MAP, PIECES } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import type { PieceKind, PieceState, PlayerState, Snapshot, Vec3, WeaponKind } from '../../sim/types';
import { beatsBetween } from '../../sim/gunplay';
import { reloadClock } from '../firstPerson';

export type Surface = 'grass' | 'sand' | 'concrete' | 'wood' | 'hollow' | 'metal';

export type SoundId =
  | 'shot' | 'impact' | 'hurt' | 'hitmarker' | 'splash'
  | 'explosion' | 'placed' | 'destroyed'
  | 'coin' | 'loot' | 'purchase' | 'vault'
  | 'kill' | 'death' | 'eliminated' | 'win' | 'lose' | 'draw'
  | 'alarm' | 'tick' | 'escaped' | 'horn' | 'footstep'
  | 'shieldHit' | 'shieldBreak' | 'drink' | 'potionDone'
  | 'reload' | 'dry' | 'ads';

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
export type Env = { alive: boolean; hp: number; inBunker: boolean; shoreDist: number; inWater: boolean };

export const LOW_HP = 30;
const STRIDE = 1.7; // metres between footsteps
const STEP_MIN_SPEED = 0.8; // m/s
const TELEPORT = 4; // metres in one snapshot = respawn/teleport, not walking
const LOOT_PICKUP_RADIUS = 3.5;

/** Ground the player stands on: a piece top under their feet, else the island (bunker floor / shore sand / grass). */
export function surfaceAt(p: Vec3, pieces: PieceState[], map: IslandLayout[]): Surface {
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

type StepTrack = { x: number; z: number; acc: number };

export class SoundDirector {
  private map: IslandLayout[] = [];
  private humanId = -1;
  private prev: Snapshot | null = null;
  private steps = new Map<number, StepTrack>();
  private lastTickSec: number | null = null;
  /** Per player: the reload being voiced (its end time) and how far into it we've played. */
  private reloads = new Map<number, { until: number; heard: number }>();
  env: Env = { alive: false, hp: 100, inBunker: false, shoreDist: 50, inWater: false };

  /** A new match (also a rematch): forget the previous match's snapshot so nothing is diffed across them. */
  setMap(map: IslandLayout[], humanId: number) {
    this.map = map;
    this.humanId = humanId;
    this.prev = null;
    this.steps.clear();
    this.lastTickSec = null;
  }

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

    for (const e of s.events) {
      const d = e.data;
      switch (e.type) {
        case 'shot': {
          if (d.echo) break; // played when predicted (shotPredict.ts)
          const own = d.by === this.humanId;
          out.push({ sound: 'shot', kind: d.weapon as WeaponKind, pos: own ? null : (d.from as Vec3), gain: own ? 1 : 0.9, own });
          break;
        }
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
            if (d.by === this.humanId && !d.echo) out.push({ sound: 'hitmarker', pos: null, gain: 0.6 });
          }
          break;
        }
        case 'kill':
          if (d.victim === this.humanId) out.push({ sound: 'death', pos: null, gain: 1 });
          else if (d.killer === this.humanId) out.push({ sound: 'kill', pos: null, gain: 0.9 });
          if (d.inWater) { const at = chest(d.victim); if (at) out.push({ sound: 'splash', pos: at, gain: 0.8 }); }
          break;
        case 'dry': {
          const own = d.by === this.humanId;
          const at = chest(d.by);
          if (own || at) out.push({ sound: 'dry', kind: String(d.weapon), pos: own ? null : at, gain: own ? 0.7 : 0.5, own });
          break;
        }
        case 'explosion':
          out.push({ sound: 'explosion', kind: String(d.kind), pos: d.pos as Vec3, gain: 1.4 });
          break;
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
        case 'sealed':
          // Every seal is a big moment: a heavy non-positional boom for everyone, plus the alarm if it's yours.
          out.push({ sound: 'explosion', kind: 'charge', pos: null, gain: 1.6 });
          if (me && d.island === me.island) out.push({ sound: 'alarm', pos: null, gain: 0.8 });
          break;
        case 'eliminated':
          if (d.player === this.humanId) out.push({ sound: 'eliminated', pos: null, gain: 0.9 });
          break;
        case 'win':
          if (me) out.push({ sound: d.winner === this.humanId ? 'win' : d.winner === -1 ? 'draw' : 'lose', pos: null, gain: 0.9 });
          break;
        case 'suddenDeath':
          out.push({ sound: 'horn', pos: null, gain: 0.9 });
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
    this.reloadBeats(s, out);

    if (me) {
      this.env = {
        alive: me.alive,
        hp: me.hp,
        inBunker: me.alive && inAnyBunker(me.pos, this.map),
        shoreDist: shoreDistance(me.pos, this.map),
        inWater: me.pos.y < s.waterY + 0.2,
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
        out.push({ sound: 'footstep', kind: surfaceAt(p.pos, s.pieces, this.map), pos: { ...p.pos }, gain: own ? 0.4 : 0.32, own });
      }
    }
  }
}
