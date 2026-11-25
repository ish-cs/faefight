import { MAP, PIECES, PLAYER } from './constants';
import type { Physics } from './physics';
import type { Box, Bunker, IslandLayout } from './map';
import type { MatchEvent, PieceState, PlayerState } from './types';
import { add, forward, rotateY, scale, sub, v3 } from './vec';

/**
 * Sudden-death barriers: when sudden death seals every bunker for good, a cast-concrete slab drops over each
 * doorway of every bunker. They are static `world` colliders like the bunker walls (block movement, bullets,
 * sight and blasts; nothing can damage them) and never pieces (building can't remove or overlap them). Their
 * geometry follows from the map alone, so the sim state is just when they dropped (`Match.barrierAt`, sent in
 * snapshots as `barrierAt`); the colliders live in the Rapier world (checkpoints and forks carry them).
 *
 * Shape: `width` along the wall (overlapping the jambs by (width - doorWidth) / 2 each side), `height` from the
 * floor (covers the 2.2 m opening, stays under the team plate above the door), and through the wall from
 * `inset` inside the room's wall face to `proud` outside the outer face.
 */
export const BARRIER = { width: 1.9, height: 2.25, inset: 0.02, proud: 0.12 } as const;

/** One barrier per doorway of this bunker (doorway order), as oriented boxes (local -Z = out through the doorway). */
export function bunkerBarrierBoxes(b: Bunker): Box[] {
  const wall = MAP.bunker.wall;
  const inner = -(wall / 2 - BARRIER.inset), outer = wall / 2 + BARRIER.proud; // along forward from the wall's mid-plane
  const halfZ = (outer - inner) / 2, mid = (outer + inner) / 2;
  return b.doorways.map((d) => {
    const c = add(d.center, scale(forward(d.yaw), mid));
    return { center: v3(c.x, d.center.y + BARRIER.height / 2, c.z), half: v3(BARRIER.width / 2, BARRIER.height / 2, halfZ), rotY: d.yaw };
  });
}

/** Every barrier on the map (island order, then doorway order). */
export const barrierBoxes = (map: IslandLayout[]): Box[] => map.flatMap((isl) => bunkerBarrierBoxes(isl.bunker));

/**
 * Drop the barriers: colliders in, anything built where a slab lands is crushed, and anyone standing in a doorway is
 * shoved clear to whichever side of the slab they were already on (inside stays inside: the sudden-death rules for
 * whoever is in a bunker apply unchanged). Returns the events: one 'destroyed' per crushed piece, then 'allSealed'.
 * Deterministic: plain arithmetic over players and pieces in id order.
 */
export function dropBarriers(
  physics: Physics, map: IslandLayout[], players: Iterable<PlayerState>, pieces: Map<number, PieceState>,
  removePiece: (id: number) => void, now: number,
): MatchEvent[] {
  const boxes = barrierBoxes(map);
  const out: MatchEvent[] = [];
  // Crush pieces first (their colliders would otherwise sit inside the slabs).
  const crushed = new Set<number>();
  for (const b of boxes)
    for (const h of physics.overlapsBox(b.center, v3(b.half.x - 0.02, b.half.y - 0.02, b.half.z - 0.02), b.rotY))
      if (h.type === 'piece') crushed.add(h.id);
  for (const id of [...crushed].sort((a, b) => a - b)) {
    const p = pieces.get(id);
    if (!p) continue;
    removePiece(id);
    out.push({ t: now, type: 'destroyed', data: { piece: id, kind: p.kind, pos: v3(p.pos.x, p.pos.y + PIECES[p.kind].h / 2, p.pos.z), rotY: p.rotY, crushed: true } });
  }
  physics.addBarriers(boxes);
  const r = PLAYER.radius + 0.02;
  for (const p of [...players].sort((a, b) => a.id - b.id)) {
    if (!p.alive) continue;
    for (const b of boxes) {
      if (p.pos.y >= b.center.y + b.half.y || p.pos.y + PLAYER.height <= b.center.y - b.half.y) continue;
      const l = rotateY(sub(p.pos, b.center), -b.rotY);
      if (Math.abs(l.x) >= b.half.x + PLAYER.radius || Math.abs(l.z) >= b.half.z + PLAYER.radius) continue;
      // Local +Z points into the room. On the slab's centre line (or outside it): out into the open.
      const z = l.z > 0 ? b.half.z + r : -(b.half.z + r);
      const w = add(b.center, rotateY(v3(l.x, 0, z), b.rotY));
      p.pos = v3(w.x, p.pos.y, w.z);
      physics.setPlayerPos(p.id, p.pos);
    }
  }
  out.push({ t: now, type: 'allSealed', data: { barriers: boxes.length } });
  return out;
}
