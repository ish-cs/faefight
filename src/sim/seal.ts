import { MAP, PIECES, PLAYER, SEAL } from './constants';
import { bunkerWallBoxes, type Bunker } from './map';
import type { PieceState, Vec3 } from './types';
import { rotateY, v3 } from './vec';

type Footprint = { center: Vec3; hx: number; hz: number; rotY: number };

/** Body-height band a piece must cover to stop a player (can't jump over, can't walk under). */
const BODY_TOP = 1.8;

const inside = (f: Footprint, x: number, z: number) => {
  const l = rotateY(v3(x - f.center.x, 0, z - f.center.z), -f.rotY);
  return Math.abs(l.x) <= f.hx && Math.abs(l.z) <= f.hz;
};

/** Could this piece stop a player anywhere on this bunker's seal grid? (Walkable kinds, out-of-reach and off-band pieces can't.) */
function blocksNear(bunker: Bunker, p: PieceState): boolean {
  if (p.kind === 'ramp' || p.kind === 'scaffold') return false;
  const s = PIECES[p.kind];
  // Skip pieces whose footprint can't reach the grid around this bunker.
  const reach = SEAL.half + Math.hypot(s.w, s.d) / 2 + PLAYER.radius;
  if (Math.abs(p.pos.x - bunker.center.x) > reach || Math.abs(p.pos.z - bunker.center.z) > reach) return false;
  const bottom = p.pos.y - bunker.center.y, top = bottom + s.h;
  return top >= SEAL.blockHeight && bottom < BODY_TOP;
}

type Grid = { n: number; blocked: Uint8Array; cx: (i: number) => number; cz: (j: number) => number };

/** The seal grid around a bunker: 1 where a player's center can't stand (walls and blocking pieces, grown by the body radius). */
function sealGrid(bunker: Bunker, pieces: Iterable<PieceState>): Grid {
  const r = PLAYER.radius;
  const blockers: Footprint[] = [];
  for (const b of bunkerWallBoxes(bunker, false)) { // slits never count: whole walls
    if (b.center.y - b.half.y >= bunker.center.y + BODY_TOP) continue;
    blockers.push({ center: b.center, hx: b.half.x + r, hz: b.half.z + r, rotY: b.rotY });
  }
  for (const p of pieces) {
    if (!blocksNear(bunker, p)) continue;
    const s = PIECES[p.kind];
    blockers.push({ center: p.pos, hx: s.w / 2 + r, hz: s.d / 2 + r, rotY: p.rotY });
  }
  const n = Math.round((2 * SEAL.half) / SEAL.cell);
  const x0 = bunker.center.x - SEAL.half, z0 = bunker.center.z - SEAL.half;
  const cx = (i: number) => x0 + (i + 0.5) * SEAL.cell;
  const cz = (j: number) => z0 + (j + 0.5) * SEAL.cell;
  const blocked = new Uint8Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = cx(i), z = cz(j);
      if (Math.hypot(x - bunker.center.x, z - bunker.center.z) > SEAL.half) continue;
      for (const f of blockers) if (inside(f, x, z)) { blocked[i * n + j] = 1; break; }
    }
  return { n, blocked, cx, cz };
}

/** Flood fill from the bunker interior: true when no free path reaches open ground past SEAL.exitRadius. */
function trapped(bunker: Bunker, g: Grid, blocked: Uint8Array): boolean {
  const { n, cx, cz } = g;
  // Seed from every free cell inside the bunker so a piece covering the spawn point itself
  // doesn't count as a seal (the respawning player is pushed into a free spot).
  const seen = new Uint8Array(n * n);
  const queue: number[] = [];
  const seedR = MAP.bunker.interior / 2 - PLAYER.radius;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      const l = rotateY(v3(cx(i) - bunker.center.x, 0, cz(j) - bunker.center.z), -bunker.facingYaw);
      if (blocked[k] || Math.abs(l.x) > seedR || Math.abs(l.z) > seedR) continue;
      seen[k] = 1;
      queue.push(k);
    }
  while (queue.length) {
    const k = queue.pop()!;
    const i = Math.floor(k / n), j = k % n;
    if (Math.hypot(cx(i) - bunker.center.x, cz(j) - bunker.center.z) > SEAL.exitRadius) return false;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const kk = a * n + b;
      if (seen[kk] || blocked[kk]) continue;
      seen[kk] = 1;
      queue.push(kk);
    }
  }
  return true;
}

/**
 * True when no walkable path leads from the bunker's spawn to open ground more than
 * SEAL.exitRadius from the bunker center. Ramps and scaffold are walkable; a piece blocks
 * only if its top is at least SEAL.blockHeight above ground and it reaches body height.
 */
export function isSealed(bunker: Bunker, pieces: PieceState[]): boolean {
  const g = sealGrid(bunker, pieces);
  return trapped(bunker, g, g.blocked);
}

/** Half-depth of the virtual plug filling a doorway opening (thicker than the wall so a 4-connected fill can't slip past). */
const PLUG_HALF_DEPTH = MAP.bunker.wall / 2 + 0.15;

/**
 * Per doorway: true when there is no way out through it. Same grid and fill as isSealed, run once per
 * doorway with the other openings virtually plugged. All blocked ⇔ sealed.
 */
export function doorwaysBlocked(bunker: Bunker, pieces: Iterable<PieceState>): boolean[] {
  const g = sealGrid(bunker, pieces);
  const plugs = bunker.doorways.map((d) => ({ center: d.center, hx: d.width / 2 + 0.05, hz: PLUG_HALF_DEPTH, rotY: d.yaw }));
  return bunker.doorways.map((_, di) => {
    const blocked = g.blocked.slice();
    for (let i = 0; i < g.n; i++)
      for (let j = 0; j < g.n; j++) {
        const k = i * g.n + j;
        if (blocked[k]) continue;
        for (let pi = 0; pi < plugs.length; pi++)
          if (pi !== di && inside(plugs[pi], g.cx(i), g.cz(j))) { blocked[k] = 1; break; }
      }
    return trapped(bunker, g, blocked);
  });
}

/**
 * Blocked-doorway count per bunker, recomputed only when the set of pieces that could block near that
 * bunker changes. Pieces never move and ids only grow, so (count, id sum) of the nearby blockers identifies the set.
 */
export class DoorwayTracker {
  private readonly keys: string[];
  private readonly counts: number[];
  /** Per-bunker recomputes so far (tests check the cache). */
  recomputes = 0;

  constructor(private readonly bunkers: Bunker[]) {
    this.counts = bunkers.map(() => 0);
    this.keys = bunkers.map(() => '0:0'); // no pieces: nothing blocked
  }

  /** Call after the piece set changed; returns the blocked-doorway count per bunker index. */
  update(pieces: Iterable<PieceState>): readonly number[] {
    const list = [...pieces];
    this.bunkers.forEach((b, i) => {
      const near: PieceState[] = [];
      let sum = 0;
      for (const p of list) if (blocksNear(b, p)) { near.push(p); sum += p.id; }
      const key = `${near.length}:${sum}`;
      if (key === this.keys[i]) return;
      this.keys[i] = key;
      this.recomputes++;
      this.counts[i] = near.length ? doorwaysBlocked(b, near).filter(Boolean).length : 0;
    });
    return this.counts;
  }

  count(i: number): number {
    return this.counts[i] ?? 0;
  }
}
