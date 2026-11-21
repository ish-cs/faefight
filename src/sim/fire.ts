import * as dm from './dmath';
import { ISLAND_DECOR } from '../client/world/decor';
import { applyPlayerDamage, type CombatCtx } from './combat';
import { damagePiece } from './building';
import { FIRE, PIECES, PLAYER } from './constants';
import type { Cosmetics } from './cosmetics';
import { COSMETIC, type MapDef } from './map';
import type { FirePatch, MatchEvent, PieceKind, PieceState, PlayerState, Vec3 } from './types';
import { mulberry32, type Rng } from './rng';
import { add, dist2D, rotateY, v3 } from './vec';

/**
 * Fire: explosions set flammable things alight; burning pieces lose HP over time, spread to touching flammable
 * pieces and burn out; ground patches (grass beds, crates, palms) burn and creep through the grass. Everything
 * resolves on a fixed beat (FIRE.stepSec) and every chance comes from a seeded stream, so the same seed and
 * inputs always burn the same way. Snapshot cost: `burning: true` on lit pieces and a short `fires` list.
 */

export const isFlammable = (kind: PieceKind) => FIRE.pieces[kind] !== undefined;

type Burn = { since: number; until: number; by: number | null };
type Patch = FirePatch & { since: number; until: number; by: number | null; r: number; prop?: number; bed: number; dps: number };
/** A grass bed in world space (island-local ellipse rotated with its island). */
type Bed = { cx: number; cz: number; rx: number; rz: number; c: number; s: number; y: number };

export type FireCtx = CombatCtx & { cosmetics: Cosmetics };

const center = (p: PieceState) => v3(p.pos.x, p.pos.y + PIECES[p.kind].h / 2, p.pos.z);

/** Box-to-box gap test for two yaw-rotated pieces (separating axes in XZ, interval in Y). */
export function piecesTouch(a: PieceState, b: PieceState, eps: number): boolean {
  const sa = PIECES[a.kind], sb = PIECES[b.kind];
  const ca = center(a), cb = center(b);
  if (Math.abs(ca.y - cb.y) > sa.h / 2 + sb.h / 2 + eps) return false;
  const axes = (r: number) => [[dm.cos(r), -dm.sin(r)], [dm.sin(r), dm.cos(r)]];
  const ua = axes(a.rotY), ub = axes(b.rotY);
  const dx = cb.x - ca.x, dz = cb.z - ca.z;
  const ext = (u: number[][], w: number, d: number, ax: number[]) => (w / 2) * Math.abs(u[0][0] * ax[0] + u[0][1] * ax[1]) + (d / 2) * Math.abs(u[1][0] * ax[0] + u[1][1] * ax[1]);
  for (const ax of [...ua, ...ub]) {
    const gap = Math.abs(dx * ax[0] + dz * ax[1]) - ext(ua, sa.w, sa.d, ax) - ext(ub, sb.w, sb.d, ax);
    if (gap > eps) return false;
  }
  return true;
}

/** Horizontal distance from (x, z) to a piece's footprint (0 inside). */
function footprintDist(p: PieceState, x: number, z: number): number {
  const s = PIECES[p.kind];
  const l = rotateY(v3(x - p.pos.x, 0, z - p.pos.z), -p.rotY);
  return Math.hypot(Math.max(0, Math.abs(l.x) - s.w / 2), Math.max(0, Math.abs(l.z) - s.d / 2));
}

/** Is a player's body in or against the flames of this burning piece? */
export function touchesBurningPiece(pl: { pos: Vec3 }, p: PieceState): boolean {
  const s = PIECES[p.kind];
  if (pl.pos.y + PLAYER.height < p.pos.y - FIRE.playerReach || pl.pos.y > p.pos.y + s.h + FIRE.playerReach) return false;
  return footprintDist(p, pl.pos.x, pl.pos.z) <= PLAYER.radius + FIRE.playerReach;
}

export function touchesPatch(pl: { pos: Vec3 }, f: { pos: Vec3; kind: FirePatch['kind'] }, r = patchRadius(f.kind)): boolean {
  const tall = f.kind === 'palm' ? 6 : 1;
  if (pl.pos.y < f.pos.y - 1 || pl.pos.y > f.pos.y + tall) return false;
  return dist2D(pl.pos, f.pos) <= r + PLAYER.radius * 0.5;
}

export const patchRadius = (kind: FirePatch['kind']) => (kind === 'grass' ? FIRE.patch.r : FIRE.props[kind].r);

/** Danger zones for bots: burning pieces and ground fires as circles (centre on the ground, radius m). */
export function fireZones(pieces: Iterable<PieceState>, fires: readonly FirePatch[]): { pos: Vec3; r: number }[] {
  const out: { pos: Vec3; r: number }[] = [];
  for (const p of pieces) if (p.burning) out.push({ pos: v3(p.pos.x, p.pos.y, p.pos.z), r: Math.max(PIECES[p.kind].w, PIECES[p.kind].d) / 2 + 0.7 });
  for (const f of fires) out.push({ pos: f.pos, r: patchRadius(f.kind) + 0.5 });
  return out;
}

/**
 * Bot steering: a walk direction that does not lead into fire (slides along the edge, pushing outward), or a
 * way out when standing in it. `dir` null = standing still. Returns the (unit or null) direction to use.
 */
export function steerFromFire(pos: Vec3, dir: Vec3 | null, zones: readonly { pos: Vec3; r: number }[]): Vec3 | null {
  const near = (p: Vec3) => zones.find((z) => Math.abs(z.pos.y - p.y) < 2.5 && dist2D(p, z.pos) < z.r);
  const inside = near(pos);
  if (inside) {
    const out = v3(pos.x - inside.pos.x, 0, pos.z - inside.pos.z);
    const l = Math.hypot(out.x, out.z);
    return l < 1e-3 ? (dir ?? v3(1, 0, 0)) : v3(out.x / l, 0, out.z / l);
  }
  if (!dir) return null;
  const probe = add(pos, v3(dir.x * 1.2, 0, dir.z * 1.2));
  const z = near(probe);
  if (!z) return dir;
  const away = v3(probe.x - z.pos.x, 0, probe.z - z.pos.z);
  const al = Math.hypot(away.x, away.z) || 1;
  away.x /= al; away.z /= al;
  // Slide around it on the side the walk was already leaning to.
  const t1 = v3(-away.z, 0, away.x);
  const t = t1.x * dir.x + t1.z * dir.z >= 0 ? t1 : v3(away.z, 0, -away.x);
  const nx = t.x + away.x * 0.6, nz = t.z + away.z * 0.6;
  const nl = Math.hypot(nx, nz);
  return v3(nx / nl, 0, nz / nl);
}

export class Fire {
  private burns = new Map<number, Burn>();
  /** Burnt out: spread can't relight these (another explosion can). */
  private charred = new Set<number>();
  private patches: Patch[] = [];
  private beds: Bed[] = [];
  private nextStep = 0;
  private rng: Rng; // seeded, state on the function: fork and checkpoints carry it
  /** Player burn ticks owed this step: id → who lit the fire they stand in. */
  private scorched = new Map<number, number | null>();

  /** `nextId` is re-bound when the match is forked or restored from a checkpoint (Match.rebind). */
  constructor(private readonly def: MapDef, seed: number, public nextId: () => number) {
    // Own stream: fire never shifts the bots' (or anything else's) random choices.
    this.rng = mulberry32((seed * 0x9e3779b1) ^ 0xf12e);
    if (def.template === 'harbor') {
      for (const isl of def.islands) {
        const c = dm.cos(isl.bunker.facingYaw), s = dm.sin(isl.bunker.facingYaw);
        for (const e of ISLAND_DECOR.grassBeds) {
          const w = add(isl.center, rotateY(v3(e.x, 0, e.z), isl.bunker.facingYaw));
          this.beds.push({ cx: w.x, cz: w.z, rx: e.rx, rz: e.rz, c, s, y: isl.groundY });
        }
      }
    }
  }

  isBurning(pieceId: number) { return this.burns.has(pieceId); }
  get burningCount() { return this.burns.size; }
  get patchCount() { return this.patches.length; }

  /** The `fires` snapshot list (copies). */
  snapshotFires(): FirePatch[] {
    return this.patches.map((p) => ({ id: p.id, kind: p.kind, pos: { ...p.pos } }));
  }

  /** Grass bed index containing (x, z) at ground height y, or -1. */
  private bedAt(x: number, z: number, y: number): number {
    for (let i = 0; i < this.beds.length; i++) {
      const b = this.beds[i];
      if (Math.abs(y - b.y) > 1.5) continue;
      const dx = x - b.cx, dz = z - b.cz;
      // world → island-local (inverse of rotateY by the island yaw)
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      if ((lx / b.rx) * (lx / b.rx) + (lz / b.rz) * (lz / b.rz) <= 1) return i;
    }
    return -1;
  }

  /** Set a piece alight (no-op for metal/steel/containers or one already burning). */
  ignite(p: PieceState, now: number, by: number | null): boolean {
    const spec = FIRE.pieces[p.kind];
    if (!spec || this.burns.has(p.id)) return false;
    const [a, b] = spec.burnSec;
    this.burns.set(p.id, { since: now, until: now + a + (b - a) * this.rng(), by });
    this.charred.delete(p.id);
    p.burning = true;
    return true;
  }

  private addPatch(kind: FirePatch['kind'], pos: Vec3, now: number, by: number | null, bed: number, prop?: number): void {
    if (this.patches.length >= FIRE.patch.max) return;
    const sec = kind === 'grass' ? FIRE.patch.grassSec[0] + (FIRE.patch.grassSec[1] - FIRE.patch.grassSec[0]) * this.rng() : FIRE.props[kind].sec;
    this.patches.push({
      id: this.nextId(), kind, pos: v3(Math.round(pos.x * 100) / 100, Math.round(pos.y * 100) / 100, Math.round(pos.z * 100) / 100),
      since: now, until: now + sec, by, r: patchRadius(kind), bed, prop, dps: kind === 'grass' ? 0 : FIRE.props[kind].dps,
    });
  }

  /** Explosions this tick ignite what's inside their blast: flammable pieces, crates, palms, grass. */
  onEvents(events: readonly MatchEvent[], now: number, ctx: FireCtx): void {
    for (const e of events) {
      if (e.type !== 'explosion') continue;
      const kind = e.data.kind as 'rocket' | 'grenade' | 'charge';
      const pos = e.data.pos as Vec3 | undefined;
      const R = FIRE.igniteRadius[kind];
      if (!pos || R === undefined) continue;
      const by = (e.data.by as number | null) ?? null;
      for (const p of ctx.pieces.values()) {
        if (!isFlammable(p.kind)) continue;
        const s = PIECES[p.kind];
        const dy = Math.max(0, p.pos.y - pos.y, pos.y - (p.pos.y + s.h));
        if (Math.hypot(footprintDist(p, pos.x, pos.z), dy) < R) this.ignite(p, now, by);
      }
      for (const d of this.def.cosmetics) {
        if ((d.kind !== 'crate' && d.kind !== 'palm') || ctx.cosmetics.hpOf(d.id) === null) continue;
        if (this.patches.some((p) => p.prop === d.id)) continue;
        const c = COSMETIC[d.kind];
        const dy = Math.max(0, d.pos.y - pos.y, pos.y - (d.pos.y + c.h));
        if (Math.hypot(Math.max(0, dist2D(d.pos, pos) - c.r), dy) < R) this.addPatch(d.kind, d.pos, now, by, -1, d.id);
      }
      const bed = this.bedAt(pos.x, pos.z, pos.y);
      if (bed >= 0 && pos.y - this.beds[bed].y < 1.5 && !this.patches.some((p) => p.kind === 'grass' && dist2D(p.pos, pos) < 1.2))
        this.addPatch('grass', v3(pos.x, this.beds[bed].y, pos.z), now, by, bed);
    }
  }

  /** Advance fire (call every tick; work happens on the FIRE.stepSec beat). Returns events (destroyed pieces, hits, broken props). */
  tick(now: number, waterY: number, ctx: FireCtx, raining = false): MatchEvent[] {
    const out: MatchEvent[] = [];
    // Pieces gone some other way (shot out, collapsed) stop burning.
    for (const id of this.burns.keys()) if (!ctx.pieces.has(id)) this.burns.delete(id);
    for (const id of this.charred) if (!ctx.pieces.has(id)) this.charred.delete(id);
    if (now + 1e-9 < this.nextStep) return out;
    this.nextStep = now + FIRE.stepSec;
    const step = FIRE.stepSec;
    if (raining) {
      // Rain: every fire's remaining burn shrinks faster.
      const wet = step * (FIRE.rainMult - 1);
      for (const b of this.burns.values()) b.until -= wet;
      for (const f of this.patches) f.until -= wet;
    }

    // Burn damage, burn-out, and the sea putting fires out (sudden-death tide).
    for (const [id, b] of [...this.burns]) {
      const p = ctx.pieces.get(id)!;
      if (now >= b.until || p.pos.y < waterY) { this.burns.delete(id); delete p.burning; this.charred.add(id); continue; }
      if (now - b.since < step - 1e-6) continue; // first bite one step after catching
      if (damagePiece(p, FIRE.pieces[p.kind]!.dps * step, 'explosive')) {
        this.burns.delete(id);
        ctx.onPieceDestroyed(id);
        out.push({ t: now, type: 'destroyed', data: { piece: id, kind: p.kind, pos: center(p), rotY: p.rotY, fire: true } });
      }
    }

    // Spread: lit long enough → roll for each touching flammable piece (lit after the loop: one hop per step).
    const lit: [PieceState, number | null][] = [];
    for (const [id, b] of this.burns) {
      if (now - b.since < FIRE.spreadAfterSec) continue;
      const p = ctx.pieces.get(id)!;
      for (const q of ctx.pieces.values()) {
        if (q.id === id || !isFlammable(q.kind) || this.burns.has(q.id) || this.charred.has(q.id)) continue;
        if (!piecesTouch(p, q, FIRE.touchEps)) continue;
        if (this.rng() < FIRE.spreadChance) lit.push([q, b.by]);
      }
    }

    // Ground patches: burn props, creep through the grass bed, catch wooden pieces standing in them, go out.
    const born: Patch[] = [];
    for (const f of this.patches) {
      if (f.prop !== undefined && f.dps > 0) ctx.cosmetics.burn(f.prop, f.dps * step, now, out);
      const age = now - f.since;
      if (age < FIRE.patch.spreadAfterSec) continue;
      if (f.kind === 'grass' && f.bed >= 0 && this.rng() < FIRE.patch.spreadChance) {
        const a = this.rng() * Math.PI * 2;
        const x = f.pos.x + dm.cos(a) * FIRE.patch.spreadStep, z = f.pos.z + dm.sin(a) * FIRE.patch.spreadStep;
        const crowded = [...this.patches, ...born].some((o) => dist2D(o.pos, { x, z }) < 1.2);
        if (!crowded && this.bedAt(x, z, f.pos.y) === f.bed) born.push({ ...f, pos: v3(x, f.pos.y, z) });
      }
      for (const q of ctx.pieces.values()) {
        if (!isFlammable(q.kind) || this.burns.has(q.id) || this.charred.has(q.id)) continue;
        if (Math.abs(q.pos.y - f.pos.y) > 0.6 || footprintDist(q, f.pos.x, f.pos.z) > f.r) continue;
        if (this.rng() < FIRE.patch.pieceChance) lit.push([q, f.by]);
      }
    }
    for (const [q, by] of lit) this.ignite(q, now, by);
    for (const b of born) this.addPatch('grass', b.pos, now, b.by, b.bed);
    this.patches = this.patches.filter((f) => now < f.until && f.pos.y > waterY);

    // Players in or against flames: light damage (shield first), credited to whoever lit it (not yourself).
    this.scorched.clear();
    for (const pl of ctx.players.values()) {
      if (!pl.alive) continue;
      const src = this.sourceAt(pl, ctx);
      if (src !== undefined) this.scorched.set(pl.id, src);
    }
    for (const [id, by] of this.scorched) {
      const pl = ctx.players.get(id)!;
      out.push(...applyPlayerDamage(ctx, pl, FIRE.playerDps * step, by === id ? null : by, now, { weapon: 'fire' }));
    }
    return out;
  }

  /** Who lit the fire this player touches (undefined = not touching any). */
  private sourceAt(pl: PlayerState, ctx: FireCtx): number | null | undefined {
    for (const [id, b] of this.burns) if (touchesBurningPiece(pl, ctx.pieces.get(id)!)) return b.by;
    for (const f of this.patches) if (touchesPatch(pl, f, f.r)) return f.by;
    return undefined;
  }
}

/** Seconds a fully healthy piece of this kind takes to burn down (Infinity = never: it burns out first or can't burn). */
export function burnDownSec(kind: PieceKind): number {
  const s = FIRE.pieces[kind];
  return s ? PIECES[kind].hp / s.dps : Infinity;
}

