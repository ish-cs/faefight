/**
 * Visual-only neighbour detection for player-built pieces, so adjacent pieces render as one structure.
 * Pure (no three.js): the PieceLayer packs each piece's 6-bit edge mask into a per-instance attribute and the
 * piece shaders hide doubled trim/frames/poles, show end caps on open ends and brackets on joints.
 *
 * Ends are in the piece's local frame (local +X = world (cos rotY, 0, -sin rotY), local +Z = (sin rotY, 0, cos rotY)):
 *   L = -X end, R = +X end: 2 bits each — OPEN (nothing there), MERGED (same kind, parallel, in line), JOINT
 *     (anything else touching that end: a corner, a T, or a different material).
 *   D / U: 1 bit each. Walls (sandbags, wood, metal, steel, container): same kind stacked directly below / above.
 *     Scaffold: another scaffold continuing off the -Z / +Z end (a bridge). Ramp: the bottom (-Z) end starts from a
 *     deck/top surface; the top (+Z) end runs into a wall, deck or the next ramp.
 * mask = L | R << 2 | D << 4 | U << 5.
 *
 * Never touches the sim: collision, support and seal logic are unaffected.
 */
import { PIECES } from '../../sim/constants';
import type { PieceKind, PieceState } from '../../sim/types';

export const END_OPEN = 0;
export const END_MERGED = 1;
export const END_JOINT = 2;

export type EdgeState = { l: number; r: number; d: number; u: number };
export const encodeMask = (e: EdgeState) => (e.l & 3) | ((e.r & 3) << 2) | ((e.d & 1) << 4) | ((e.u & 1) << 5);
export const decodeMask = (m: number): EdgeState => ({ l: m & 3, r: (m >> 2) & 3, d: (m >> 4) & 1, u: (m >> 5) & 1 });

type Item = { id: number; kind: PieceKind; x: number; y: number; z: number; rotY: number; c: number; s: number; cells: number[] };

const CELL = 4;
/** Max gap at an end that still counts as touching (pieces snap flush; leaves room for snap jitter). */
const TOL = 0.14;
/** Bases within this height count as the same course (beside-placement adds +0.05 before the sim settles it). */
const LEVEL = 0.22;
const PAR = 0.1; // |sin Δyaw| below this = parallel

const cellKey = (cx: number, cz: number) => ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);

/** Incremental neighbour graph: `update` with the full piece list each snapshot; only changed pieces and their neighbours are recomputed. */
export class ConnectGraph {
  private items = new Map<number, Item>();
  private grid = new Map<number, Set<number>>();
  private masks = new Map<number, number>();
  /** Pieces whose masks were recomputed on the last update (for tests / stats). */
  lastRecomputed = 0;

  mask(id: number): number { return this.masks.get(id) ?? 0; }
  edges(id: number): EdgeState { return decodeMask(this.mask(id)); }
  get size() { return this.items.size; }

  /** Diff against the previous call; returns ids whose mask changed (new pieces included). */
  update(pieces: readonly PieceState[]): Set<number> {
    const dirty = new Set<number>(); // ids whose surroundings changed (their region needs a recompute)
    const regions: Item[] = [];
    const seen = new Set<number>();
    for (const p of pieces) {
      seen.add(p.id);
      const cur = this.items.get(p.id);
      if (cur && cur.kind === p.kind && cur.x === p.pos.x && cur.y === p.pos.y && cur.z === p.pos.z && cur.rotY === p.rotY) continue;
      if (cur) { this.unindex(cur); regions.push(cur); }
      const it: Item = { id: p.id, kind: p.kind, x: p.pos.x, y: p.pos.y, z: p.pos.z, rotY: p.rotY, c: Math.cos(p.rotY), s: Math.sin(p.rotY), cells: [] };
      this.items.set(p.id, it);
      this.index(it);
      regions.push(it);
      dirty.add(p.id);
    }
    for (const it of this.items.values()) {
      if (seen.has(it.id)) continue;
      this.unindex(it);
      this.items.delete(it.id);
      this.masks.delete(it.id);
      regions.push(it);
    }
    const affected = new Set<number>(dirty);
    for (const r of regions) for (const id of this.near(r.x, r.z, radiusOf(r.kind) + 1)) affected.add(id);
    const changed = new Set<number>();
    for (const id of affected) {
      const it = this.items.get(id);
      if (!it) continue;
      const m = encodeMask(this.compute(it));
      if (this.masks.get(id) !== m || dirty.has(id)) changed.add(id);
      this.masks.set(id, m);
    }
    this.lastRecomputed = affected.size;
    return changed;
  }

  private index(it: Item) {
    const r = radiusOf(it.kind) + TOL;
    for (let cx = Math.floor((it.x - r) / CELL); cx <= Math.floor((it.x + r) / CELL); cx++)
      for (let cz = Math.floor((it.z - r) / CELL); cz <= Math.floor((it.z + r) / CELL); cz++) {
        const k = cellKey(cx, cz);
        let s = this.grid.get(k);
        if (!s) { s = new Set(); this.grid.set(k, s); }
        s.add(it.id);
        it.cells.push(k);
      }
  }

  private unindex(it: Item) {
    for (const k of it.cells) {
      const s = this.grid.get(k);
      if (!s) continue;
      s.delete(it.id);
      if (s.size === 0) this.grid.delete(k);
    }
    it.cells = [];
  }

  /** Ids whose indexed footprint circle may reach within `r` of (x, z). */
  private near(x: number, z: number, r: number): Set<number> {
    const out = new Set<number>();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const s = this.grid.get(cellKey(cx, cz));
        if (s) for (const id of s) out.add(id);
      }
    return out;
  }

  private compute(p: Item): EdgeState {
    const sp = PIECES[p.kind];
    const cand: Item[] = [];
    for (const id of this.near(p.x, p.z, radiusOf(p.kind) + TOL)) if (id !== p.id) cand.push(this.items.get(id)!);
    const e: EdgeState = { l: END_OPEN, r: END_OPEN, d: 0, u: 0 };
    if (cand.length === 0) return e;

    // ±X ends: probe just past the end face, at mid-depth, through the piece's height.
    const sideEnd = (sign: number) => {
      const off = sign * (sp.w / 2 + TOL * 0.6);
      const wx = p.x + p.c * off, wz = p.z - p.s * off;
      let st = END_OPEN;
      for (const q of cand) {
        const sq = PIECES[q.kind];
        if (!inFoot(q, wx, wz, TOL)) continue;
        const sameCourse = Math.abs(q.y - p.y) < LEVEL;
        if (!sameCourse && overlapY(p.y, sp.h, q.y, sq.h) < 0.2) continue;
        if (q.kind === p.kind && sameCourse && Math.abs(Math.sin(q.rotY - p.rotY)) < PAR && Math.abs(localZ(q, p.x, p.z)) < 0.15 &&
          Math.abs(Math.abs(localX(p, q.x, q.z)) - (sp.w + sq.w) / 2) < TOL * 2) return END_MERGED;
        if (p.kind === 'scaffold' || p.kind === 'ramp') continue; // only merge with their own kind
        st = END_JOINT;
      }
      return st;
    };
    e.l = sideEnd(-1);
    e.r = sideEnd(1);

    if (p.kind === 'scaffold') {
      const bridge = (sign: number) => cand.some((q) => q.kind === 'scaffold' && Math.abs(q.y - p.y) < LEVEL &&
        Math.abs(Math.sin(q.rotY - p.rotY)) < PAR && Math.abs(localX(p, q.x, q.z)) < 0.3 && Math.abs(localZ(p, q.x, q.z) - sign * sp.d) < 0.3) ? 1 : 0;
      e.d = bridge(-1);
      e.u = bridge(1);
    } else if (p.kind === 'ramp') {
      // top: probe past the high end at deck height; anything whose footprint holds it and whose top is around there
      const tz = sp.d / 2 + TOL, ty = p.y + sp.h;
      const tx = p.x + p.s * tz, tzw = p.z + p.c * tz;
      e.u = cand.some((q) => inFoot(q, tx, tzw, TOL) && ty >= q.y - 0.15 && ty <= q.y + PIECES[q.kind].h + 0.6) ? 1 : 0;
      const bx = p.x - p.s * tz, bz = p.z - p.c * tz;
      e.d = cand.some((q) => inFoot(q, bx, bz, TOL) && Math.abs(q.y + PIECES[q.kind].h - p.y) < 0.3) ? 1 : 0;
    } else {
      const stacked = (dir: number) => cand.some((q) => q.kind === p.kind && Math.abs(Math.sin(q.rotY - p.rotY)) < PAR &&
        Math.hypot(q.x - p.x, q.z - p.z) < 0.2 &&
        Math.abs(dir > 0 ? q.y - (p.y + sp.h) : p.y - (q.y + PIECES[q.kind].h)) < LEVEL) ? 1 : 0;
      e.d = stacked(-1);
      e.u = stacked(1);
    }
    return e;
  }
}

function radiusOf(kind: PieceKind) { const s = PIECES[kind]; return Math.hypot(s.w, s.d) / 2; }
/** World (x, z) → q's local X / Z. */
function localX(q: Item, x: number, z: number) { return (x - q.x) * q.c - (z - q.z) * q.s; }
function localZ(q: Item, x: number, z: number) { return (x - q.x) * q.s + (z - q.z) * q.c; }
function inFoot(q: Item, x: number, z: number, tol: number) {
  const s = PIECES[q.kind];
  return Math.abs(localX(q, x, z)) <= s.w / 2 + tol && Math.abs(localZ(q, x, z)) <= s.d / 2 + tol;
}
function overlapY(y0: number, h0: number, y1: number, h1: number) { return Math.min(y0 + h0, y1 + h1) - Math.max(y0, y1); }
