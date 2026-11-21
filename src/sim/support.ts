import { PIECES } from './constants';
import type { Physics } from './physics';
import type { PieceState } from './types';
import { add, rotateY, v3 } from './vec';

/** How close (m) a piece's base must be to the island/bunker to count as resting on it, and how far pieces may be apart to count as touching. */
const GROUND_EPS = 0.12;
const TOUCH_EPS = 0.06;

function grounded(physics: Physics, p: PieceState): boolean {
  const s = PIECES[p.kind];
  const hx = s.w / 2 - 0.05, hz = s.d / 2 - 0.05;
  for (const local of [v3(0, 0, 0), v3(-hx, 0, -hz), v3(hx, 0, -hz), v3(-hx, 0, hz), v3(hx, 0, hz)]) {
    const w = add(p.pos, rotateY(local, p.rotY));
    // Skip the piece's own collider: the probe starts inside it and can report its own base first.
    const below = physics.probeDown(w.x, p.pos.y + GROUND_EPS, w.z, 2 * GROUND_EPS, p.id);
    if (below?.hit.type === 'world') return true;
  }
  return false;
}

/**
 * Pieces with no chain of touching pieces down to solid ground (island, bunker): these must collapse.
 * Run after a piece is removed.
 */
export function unsupportedPieces(physics: Physics, pieces: Map<number, PieceState>): number[] {
  const reached = new Set<number>();
  const queue: number[] = [];
  for (const p of pieces.values()) if (grounded(physics, p)) { reached.add(p.id); queue.push(p.id); }
  while (queue.length) {
    const p = pieces.get(queue.pop()!)!;
    const s = PIECES[p.kind];
    const center = v3(p.pos.x, p.pos.y + s.h / 2, p.pos.z);
    const half = v3(s.w / 2 + TOUCH_EPS, s.h / 2 + TOUCH_EPS, s.d / 2 + TOUCH_EPS);
    for (const t of physics.overlapsBox(center, half, p.rotY)) {
      if (t.type !== 'piece' || reached.has(t.id) || !pieces.has(t.id)) continue;
      reached.add(t.id);
      queue.push(t.id);
    }
  }
  return [...pieces.keys()].filter((id) => !reached.has(id));
}
