import { BUILD, PIECES, PIECE_DMG_MULT, type DamageSource } from './constants';
import type { Physics } from './physics';
import type { PieceKind, PieceState, Vec3 } from './types';
import type { IslandLayout } from './map';
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

/** How much a new piece may sink into neighbours (per side, m) and how far it may be nudged to fit. */
const OVERLAP_SLACK = 0.12;
const NUDGES = [0.25, 0.5];

/**
 * Forgiving placement: pieces may touch or slightly overlap neighbours, and a spot that's a little
 * blocked is nudged (≤ 0.5 m along the piece's own axes) to the nearest free spot. Never inside a player.
 */
export function validatePlacement(
  physics: Physics, kind: PieceKind, pos: Vec3, rotY: number, playerPos: Vec3,
): Placement {
  const first = placeAt(physics, kind, pos, rotY, playerPos);
  if (first.ok || first.reason !== 'blocked') return first;
  // Only nudge when the piece's middle is clear (it just clips something at its edges).
  const s = PIECES[kind];
  const core = v3(s.w / 4, s.h / 4, Math.max(0.05, s.d / 4));
  const coreCenter = v3(pos.x, pos.y + s.h / 2, pos.z);
  if (physics.overlapsBox(coreCenter, core, rotY).some((h) => h.type !== 'world')) return first;
  const tries: Vec3[] = [];
  for (const d of NUDGES)
    for (const [x, z] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, d], [d, -d], [-d, -d]])
      tries.push(add(pos, rotateY(v3(x, 0, z), rotY)));
  for (const t of tries) {
    const r = placeAt(physics, kind, t, rotY, playerPos);
    if (r.ok) return r;
  }
  return first;
}

function placeAt(physics: Physics, kind: PieceKind, pos: Vec3, rotY: number, playerPos: Vec3): Placement {
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
    const chained = kind === 'ramp' ? rampChainY(physics, pos, rotY) : null;
    if (chained !== null) return finish(physics, kind, pos, rotY, chained); // low edge on a piece top; may hang
    const hx = s.w / 2 - 0.1, hz = s.d / 2 - 0.1;
    const samples = [v3(0, 0, 0), v3(-hx, 0, -hz), v3(hx, 0, -hz), v3(-hx, 0, hz), v3(hx, 0, hz)];
    const ys = samples.map(below);
    if (ys[0] === null) return { ok: false, reason: 'nothing to build on' };
    restY = Math.max(...ys.filter((y): y is number => y !== null));
  }
  return finish(physics, kind, pos, rotY, restY);
}

/** Zone and overlap checks for a piece resting at restY. */
function finish(physics: Physics, kind: PieceKind, pos: Vec3, rotY: number, restY: number): Placement {
  const s = PIECES[kind];
  const center = v3(pos.x, restY + s.h / 2 + 0.01, pos.z);
  const strict = v3(s.w / 2 - 0.02, s.h / 2 - 0.02, s.d / 2 - 0.02);
  const zone = physics.noBuildZones().find((z) => boxesOverlap(center, strict, rotY, z));
  if (zone) return { ok: false, reason: zone.reason };
  if (physics.overlapsBox(center, strict, rotY).some((h) => h.type === 'player')) return { ok: false, reason: 'blocked' };
  const slack = (n: number) => Math.max(0.02, n / 2 - OVERLAP_SLACK);
  const loose = v3(slack(s.w), s.h / 2 - 0.02, slack(s.d));
  if (physics.overlapsBox(center, loose, rotY).some((h) => h.type !== 'player')) return { ok: false, reason: 'blocked' };
  return { ok: true, pos: v3(pos.x, restY, pos.z) };
}

/**
 * No-build zones: the volume of an NPC stall or station (generator, vault) plus a little clearance, so
 * pieces can't clip through them and they stay reachable. An oriented box (Y rotation only); its base
 * sits at `center.y - half.y`. Bunkers have none: sealing a doorway with walls is the win condition.
 */
export type NoBuildZone = { center: Vec3; half: Vec3; rotY: number; reason: string };

/** Side clearance (m) kept free around stations and NPCs. */
export const ZONE_CLEARANCE = 0.75;

/** Box in a prop's local frame (origin at its base centre, rotated by yaw): x/z extents and height. */
function localZone(base: Vec3, yaw: number, x0: number, x1: number, z0: number, z1: number, h: number, reason: string): NoBuildZone {
  const c = add(base, rotateY(v3((x0 + x1) / 2, 0, (z0 + z1) / 2), yaw));
  return { center: v3(c.x, base.y + h / 2, c.z), half: v3((x1 - x0) / 2, h / 2, (z1 - z0) / 2), rotY: yaw, reason };
}

const C = ZONE_CLEARANCE;
/** Shopkeeper + pole + cantilevered awning (x ±1.2, z -0.3..1.7, top ~2.85 m; see client shopProp), clear 1 m above. */
export const shopZone = (base: Vec3, yaw: number) => localZone(base, yaw, -1.2 - C, 1.2 + C, -0.3 - C, 1.7 + C, 3.85, 'too close to shop');
/** Generator body 1.2 × 1.4 × 1.2; a piece may sit 0.6 m above it. */
export const generatorZone = (base: Vec3, yaw: number) => localZone(base, yaw, -0.6 - C, 0.6 + C, -0.6 - C, 0.6 + C, 2.0, 'too close to generator');
/** Vault body 1.2 × 2.0 × 1.0: sides kept clear, but pieces may rest on top of it or bridge over it. */
export const vaultZone = (base: Vec3, yaw: number) => localZone(base, yaw, -0.6 - C, 0.6 + C, -0.5 - C, 0.5 + C, 2.02, 'too close to vault');
/** Potion seller stall (counter x ±0.8 z 0.3..0.9, robe z ≥ -0.52, flask top ~2.7 m; see client potionSeller). */
export const potionZone = (base: Vec3) => localZone(base, 0, -0.8 - C, 0.8 + C, -0.52 - C, 0.9 + C, 3.2, 'too close to potion seller');

export const islandNoBuildZones = (isl: IslandLayout): NoBuildZone[] => {
  const y = isl.bunker.facingYaw;
  return [generatorZone(isl.generator, y), vaultZone(isl.vault, y), shopZone(isl.shop, y)];
};

/** Oriented box (Y rotation) vs zone: Y intervals, then 2D separating axes. */
export function boxesOverlap(center: Vec3, half: Vec3, rotY: number, z: NoBuildZone): boolean {
  if (Math.abs(center.y - z.center.y) >= half.y + z.half.y) return false;
  const axes = (r: number) => [rotateY(v3(1, 0, 0), r), rotateY(v3(0, 0, 1), r)];
  const [ax, az] = axes(rotY), [bx, bz] = axes(z.rotY);
  const dx = z.center.x - center.x, dz = z.center.z - center.z;
  for (const n of [ax, az, bx, bz]) {
    const ra = Math.abs(n.x * ax.x + n.z * ax.z) * half.x + Math.abs(n.x * az.x + n.z * az.z) * half.z;
    const rb = Math.abs(n.x * bx.x + n.z * bx.z) * z.half.x + Math.abs(n.x * bz.x + n.z * bz.z) * z.half.z;
    if (Math.abs(n.x * dx + n.z * dz) >= ra + rb) return false;
  }
  return true;
}

/** Where behind a ramp's low edge (local z offsets from that edge) we look for a piece to chain onto. */
const CHAIN_PROBES = [-0.2, -0.05, 0.1];
/** A chain snap only applies when the requested height is near the support top (aimed up there). */
const CHAIN_AIM_TOL = 0.75;
/** How close to the top edge of a ramp a probe must land to chain onto that ramp. */
const RAMP_TOP_TOL = 0.35;

/**
 * Ramp staircases: if the ramp's low edge (local -Z, the end toward the player) is over the top of a
 * piece and the request was aimed up there, the ramp rests its low edge on that top and the rest may
 * hang. On another ramp it continues from that ramp's top edge, flush. Null = normal ground placement.
 */
function rampChainY(physics: Physics, pos: Vec3, rotY: number): number | null {
  const s = PIECES.ramp;
  let best: number | null = null;
  for (const dz of CHAIN_PROBES) {
    const w = add(pos, rotateY(v3(0, 0, -s.d / 2 + dz), rotY));
    const sup = physics.probeDown(w.x, pos.y + PROBE_UP, w.z, PROBE_UP + PROBE_DOWN);
    if (!sup || sup.hit.type !== 'piece') continue;
    const top = physics.pieceTop(sup.hit.id);
    if (top === undefined) continue;
    let y = sup.y;
    if (physics.pieceKind(sup.hit.id) === 'ramp') {
      if (sup.y < top - RAMP_TOP_TOL) continue; // mid-slope: not a chain
      y = top;
    }
    if (Math.abs(y - pos.y) > CHAIN_AIM_TOL) continue;
    if (best === null || y > best) best = y;
  }
  return best;
}

/** Applies damage with material multipliers. Returns true if the piece is destroyed. */
export function damagePiece(piece: PieceState, amount: number, source: DamageSource): boolean {
  const mult = source === 'explosive' ? 1 : PIECE_DMG_MULT[piece.kind][source];
  piece.hp -= amount * mult;
  return piece.hp <= 0;
}
