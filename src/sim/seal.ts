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

/**
 * True when no walkable path leads from the bunker's spawn to open ground more than
 * SEAL.exitRadius from the bunker center. Ramps and scaffold are walkable; a piece blocks
 * only if its top is at least SEAL.blockHeight above ground and it reaches body height.
 */
export function isSealed(bunker: Bunker, pieces: PieceState[]): boolean {
  const g = bunker.center.y;
  const r = PLAYER.radius;
  const blockers: Footprint[] = [];
  for (const b of bunkerWallBoxes(bunker)) {
    if (b.center.y - b.half.y >= g + BODY_TOP) continue;
    blockers.push({ center: b.center, hx: b.half.x + r, hz: b.half.z + r, rotY: b.rotY });
  }
  for (const p of pieces) {
    if (p.kind === 'ramp' || p.kind === 'scaffold') continue;
    const s = PIECES[p.kind];
    // Skip pieces whose footprint can't reach the grid around this bunker.
    const reach = SEAL.half + Math.hypot(s.w, s.d) / 2 + r;
    if (Math.abs(p.pos.x - bunker.center.x) > reach || Math.abs(p.pos.z - bunker.center.z) > reach) continue;
    const bottom = p.pos.y - g, top = bottom + s.h;
    if (top < SEAL.blockHeight || bottom >= BODY_TOP) continue;
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
