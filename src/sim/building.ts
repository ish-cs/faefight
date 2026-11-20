import { BUILD, PIECES, PIECE_DMG_MULT, type DamageSource } from './constants';
import type { Physics } from './physics';
import type { PieceKind, PieceState, Vec3 } from './types';
import { add, dist2D, rotateY, v3 } from './vec';

const ROT_STEP = (BUILD.rotStepDeg * Math.PI) / 180;
const snap = (n: number, step: number) => Math.round(n / step) * step;

export function snapPlacement(pos: Vec3, rotY: number, free: boolean): { pos: Vec3; rotY: number } {
  if (free) return { pos: { ...pos }, rotY };
  return { pos: v3(snap(pos.x, BUILD.gridStep), pos.y, snap(pos.z, BUILD.gridStep)), rotY: snap(rotY, ROT_STEP) };
}

export type Placement = { ok: true; pos: Vec3 } | { ok: false; reason: string };

/** How far above the requested point we look for a support surface, and how far down. */
const PROBE_UP = 1.5;
const PROBE_DOWN = 4;
/** How far past a scaffold's near end we look for what it attaches to. */
const ATTACH_PROBE = 0.2;

export function validatePlacement(
  physics: Physics, kind: PieceKind, pos: Vec3, rotY: number, playerPos: Vec3,
): Placement {
  if (dist2D(pos, playerPos) > BUILD.reach || Math.abs(pos.y - playerPos.y) > BUILD.reach)
    return { ok: false, reason: 'too far' };
  const s = PIECES[kind];
  const below = (local: Vec3) => {
    const w = add(pos, rotateY(local, rotY));
    return physics.surfaceBelow(w.x, pos.y + PROBE_UP, w.z, PROBE_UP + PROBE_DOWN);
  };

  let restY: number;
  if (kind === 'scaffold') {
    // Attach at the end nearer the player: probe just past that end. Land → rest on it; another
    // scaffold deck → sit level with that deck so bridges stay flat. The far end may hang over water.
    const ends = [v3(0, 0, -s.d / 2 - ATTACH_PROBE), v3(0, 0, s.d / 2 + ATTACH_PROBE)];
    const dists = ends.map((e) => dist2D(add(pos, rotateY(e, rotY)), playerPos));
    const w = add(pos, rotateY(ends[dists[0] <= dists[1] ? 0 : 1], rotY));
    const sup = physics.probeDown(w.x, pos.y + PROBE_UP, w.z, PROBE_UP + PROBE_DOWN);
    if (!sup || Math.abs(sup.y - pos.y) > PROBE_UP) return { ok: false, reason: 'scaffold needs a support at the near end' };
    const onDeck = sup.hit.type === 'piece' && physics.pieceKind(sup.hit.id) === 'scaffold';
    restY = onDeck ? sup.y - s.h : sup.y;
  } else {
    const hx = s.w / 2 - 0.1, hz = s.d / 2 - 0.1;
    const samples = [v3(0, 0, 0), v3(-hx, 0, -hz), v3(hx, 0, -hz), v3(-hx, 0, hz), v3(hx, 0, hz)];
    const ys = samples.map(below);
    if (ys[0] === null) return { ok: false, reason: 'nothing to build on' };
    restY = Math.max(...ys.filter((y): y is number => y !== null));
  }

  const half = v3(s.w / 2 - 0.02, s.h / 2 - 0.02, s.d / 2 - 0.02);
  const center = v3(pos.x, restY + s.h / 2 + 0.01, pos.z);
  if (physics.overlapsBox(center, half, rotY).length > 0) return { ok: false, reason: 'blocked' };
  return { ok: true, pos: v3(pos.x, restY, pos.z) };
}

/** Applies damage with material multipliers. Returns true if the piece is destroyed. */
export function damagePiece(piece: PieceState, amount: number, source: DamageSource): boolean {
  const mult = source === 'explosive' ? 1 : PIECE_DMG_MULT[piece.kind][source];
  piece.hp -= amount * mult;
  return piece.hp <= 0;
}
