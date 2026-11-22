import { MAP, PIECES, PIECE_DMG_MULT, PLAYER, SEAL } from '../constants';
import { bunkerWallBoxes, type Bunker } from '../map';
import type { PieceState, Vec3, WeaponKind } from '../types';
import { dist2D, rotateY, v3 } from '../vec';

/**
 * Walking out of a bunker: an occupancy grid over the bunker and its surroundings (same cells and blocking rules as
 * seal.ts), with bunker walls and placed pieces grown by the player radius. Lets a bot path around anything
 * standing inside or across a doorway, and, when nothing gets out, pick the cheapest piece to break.
 */

const CELL = SEAL.cell;
const N = Math.round((2 * SEAL.half) / CELL);
/** Body-height band a piece must cover to stop a player (as in seal.ts). */
const BODY_TOP = 1.8;
/** Out means beyond the escape-countdown radius, with a little margin. */
const OUT = SEAL.exitRadius + 0.4;
/** A piece this close to a doorway's center stands in or right against it. */
const DOOR_ZONE = 1.8;
const STEPS: [number, number][] =[[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

type Box = { center: Vec3; hx: number; hz: number; rotY: number; piece: PieceState | null };

const covers = (b: Box, x: number, z: number) => {
  const l = rotateY(v3(x - b.center.x, 0, z - b.center.z), -b.rotY);
  return Math.abs(l.x) <= b.hx && Math.abs(l.z) <= b.hz;
};

/** Pieces that stand in a player's way near this bunker (walkable ramps/scaffold and high or low ones excluded). */
export function blockingPieces(bunker: Bunker, pieces: PieceState[]): PieceState[] {
  const g = bunker.center.y;
  return pieces.filter((p) => {
    if (p.kind === 'ramp' || p.kind === 'scaffold') return false;
    const s = PIECES[p.kind];
    const reach = SEAL.half + Math.hypot(s.w, s.d) / 2 + PLAYER.radius;
    if (Math.abs(p.pos.x - bunker.center.x) > reach || Math.abs(p.pos.z - bunker.center.z) > reach) return false;
    const bottom = p.pos.y - g, top = bottom + s.h;
    if (bottom >= BODY_TOP) return false;
    if (top >= SEAL.blockHeight) return true;
    // Low pieces can be stepped over in the open, but not in a doorway: standing on one there puts my head above
    // the lintel (a lone sandbag plugs a doorway for good, though it isn't a seal).
    return top > MAP.bunker.doorHeight - PLAYER.height && bunker.doorways.some((d) => dist2D(p.pos, d.center) < DOOR_ZONE);
  });
}

export class BunkerGrid {
  private readonly x0: number;
  private readonly z0: number;
  /** Per cell: 0 free, 1 wall, 2+i blocked by blockers[i] (first match). */
  private readonly cells: Int32Array;

  constructor(readonly bunker: Bunker, readonly blockers: PieceState[]) {
    this.x0 = bunker.center.x - SEAL.half;
    this.z0 = bunker.center.z - SEAL.half;
    const r = PLAYER.radius;
    const boxes: Box[] = [];
    for (const b of bunkerWallBoxes(bunker, false)) {
      if (b.center.y - b.half.y >= bunker.center.y + BODY_TOP) continue;
      boxes.push({ center: b.center, hx: b.half.x + r, hz: b.half.z + r, rotY: b.rotY, piece: null });
    }
    for (const p of blockers) boxes.push({ center: p.pos, hx: PIECES[p.kind].w / 2 + r, hz: PIECES[p.kind].d / 2 + r, rotY: p.rotY, piece: p });
    this.cells = new Int32Array(N * N);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const x = this.cx(i), z = this.cz(j);
        // Walls first, so a cell under a wall never counts as "this piece's".
        for (const b of boxes) if (covers(b, x, z)) { this.cells[i * N + j] = b.piece ? 2 + blockers.indexOf(b.piece) : 1; break; }
      }
  }

  private cx(i: number) { return this.x0 + (i + 0.5) * CELL; }
  private cz(j: number) { return this.z0 + (j + 0.5) * CELL; }
  center(k: number): Vec3 { return v3(this.cx(Math.floor(k / N)), this.bunker.center.y, this.cz(k % N)); }

  private cellOf(p: Vec3): number {
    const i = Math.floor((p.x - this.x0) / CELL), j = Math.floor((p.z - this.z0) / CELL);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : i * N + j;
  }

  /** Nearest free cell to p (p's own when free), within ~1 m. */
  private startCell(p: Vec3, ignore: number): number {
    const k = this.cellOf(p);
    if (k < 0) return -1;
    if (this.free(k, ignore)) return k;
    let best = -1, bestD = Infinity;
    const i0 = Math.floor(k / N), j0 = k % N;
    for (let di = -4; di <= 4; di++)
      for (let dj = -4; dj <= 4; dj++) {
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= N || j >= N || !this.free(i * N + j, ignore)) continue;
        const d = di * di + dj * dj;
        if (d < bestD) { bestD = d; best = i * N + j; }
      }
    return best;
  }

  private free(k: number, ignore: number) { const c = this.cells[k]; return c === 0 || (ignore >= 0 && c === 2 + ignore); }

  /**
   * Breadth-first from `from`: the path (cell centers) to the nearest cell beyond the countdown radius, or null when
   * there is none; plus every cell reachable from here. `ignore`: pretend blockers[ignore] is gone.
   */
  search(from: Vec3, ignore = -1): { path: Vec3[] | null; reach: number[] } {
    const start = this.startCell(from, ignore);
    if (start < 0) return { path: null, reach: [] };
    const prev = new Int32Array(N * N).fill(-1);
    prev[start] = start;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q];
      const i = Math.floor(k / N), j = k % N;
      if (dist2D(this.center(k), this.bunker.center) > OUT) {
        const path: Vec3[] = [];
        for (let c = k; c !== start; c = prev[c]) path.push(this.center(c));
        return { path: path.reverse(), reach: queue };
      }
      for (const [di, dj] of STEPS) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) continue;
        const kk = a * N + b;
        if (prev[kk] >= 0 || !this.free(kk, ignore)) continue;
        // No cutting corners diagonally past a blocked cell.
        if (di && dj && (!this.free(i * N + b, ignore) || !this.free(a * N + j, ignore))) continue;
        prev[kk] = k;
        queue.push(kk);
      }
    }
    return { path: null, reach: queue };
  }
}

/** Seconds of shooting (or punching) to destroy a piece with this weapon; Infinity if it can't. */
export function breakCost(p: PieceState, weapon: WeaponKind, dps: number): number {
  const mult = PIECE_DMG_MULT[p.kind][weapon === 'fists' ? 'fist' : 'bullet'];
  return mult > 0 && dps > 0 ? p.hp / (mult * dps) : Infinity;
}

/**
 * The piece to break to get out: of those whose removal opens a way out, the cheapest by `cost`
 * (doorway plugs preferred on a near tie). Null when no single piece opens a way.
 */
export function pieceToBreak(grid: BunkerGrid, from: Vec3, cost: (p: PieceState) => number, nearDoor: (p: PieceState) => boolean): PieceState | null {
  let best: PieceState | null = null, bestCost = Infinity;
  grid.blockers.forEach((p, i) => {
    const c = cost(p) * (nearDoor(p) ? 1 : 1.25);
    if (c >= bestCost || !grid.search(from, i).path) return;
    best = p; bestCost = c;
  });
  return best;
}
