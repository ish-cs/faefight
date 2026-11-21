import * as dm from '../dmath';
import { PIECES } from '../constants';
import type { Bunker, IslandLayout } from '../map';
import { isSealed } from '../seal';
import type { Difficulty, PieceKind, PieceState, Vec3 } from '../types';
import { add, dist2D, forward, norm, right, rotateY, scale, sub, v3, yawOf } from '../vec';
import { LANE_OFFSET, lane, laneAt, type Lane } from './nav';
import type { Traits } from './personality';

/**
 * How well a player of each skill builds. Same moves for everyone; better players see the need sooner, do it more
 * often, place cleaner and chain pieces with less dithering.
 * - coverChance: odds of throwing down a wall when shot at in the open (before personality).
 * - coverDelay: seconds from the first hit to starting the wall (noticing + choosing the piece).
 * - gap: extra pause between two pieces of a sequence (PRO chains them back to back).
 * - misplace: odds a piece goes somewhere silly (off to the side, skewed).
 * - fort: share of the home fortification plan this player bothers with (before personality).
 * - peekHide / peekOut: seconds behind cover and out shooting when peeking.
 */
export type BuildSkill = {
  coverChance: number; coverDelay: number; gap: number; misplace: number; fort: number;
  peekHide: number; peekOut: number; highGround: boolean; bridgeCover: boolean; altRoute: boolean;
};
export const BUILD_SKILL: Record<Difficulty, BuildSkill> = {
  easy: { coverChance: 0.25, coverDelay: 1.4, gap: 1.6, misplace: 0.35, fort: 0.3, peekHide: 2.0, peekOut: 1.6, highGround: false, bridgeCover: false, altRoute: false },
  medium: { coverChance: 0.55, coverDelay: 0.8, gap: 0.8, misplace: 0.12, fort: 0.55, peekHide: 1.4, peekOut: 1.3, highGround: false, bridgeCover: true, altRoute: false },
  hard: { coverChance: 0.7, coverDelay: 0.5, gap: 0.3, misplace: 0.03, fort: 0.85, peekHide: 1.0, peekOut: 1.2, highGround: false, bridgeCover: true, altRoute: true },
  pro: { coverChance: 0.95, coverDelay: 0.22, gap: 0.05, misplace: 0, fort: 1, peekHide: 0.6, peekOut: 0.9, highGround: true, bridgeCover: true, altRoute: true },
};

/**
 * Every building tunable outside the per-skill table, in one place (candidates for BotParams).
 */
export const BUILD_TUNING = {
  /** Never build anything within this of my own bunker without checking the way out stays open. */
  ownBunkerCheck: 8,
  /** The way out of my bunker must stay ≥ 1.3 m wide: pieces grown by this per side on top of the player radius. */
  clearanceMargin: 0.3,
  /** Keep doorways themselves (where a plug would sit) completely free. */
  doorKeepOut: 2.6,
  /** Cash (carried + banked) kept back before buying fortification pieces: 200 × (1 − builder). */
  fortReserve: 200,
  /** Builders at least this keen fortify before carrying a seal kit and even when a rival is in reach. */
  fortEarlyBuilder: 0.7,
  /** Everyone else fortifies only with at least this many rivals left, carrying a kit, and no rival in walking reach. */
  fortMinRivals: 2,
  /** Combat cover walls carried (× (0.4 + builder), rounded) by skill. */
  coverCarry: { easy: 1, medium: 1, hard: 2, pro: 2 } as Record<Difficulty, number>,
  /** Rich enough (carried + banked) for metal instead of wood cover. */
  metalCoverAt: 500,
  /** Carry a ramp for high ground in fights (skills with highGround) from this much cash. */
  rampAt: 300,
  /** Bridge side walls: one per this many scaffolds of a bridge (× min(1, 0.3 + builder)). */
  scaffoldsPerBridgeWall: 4,
  /** Bridge side walls go up once the deck is this far out over the water, and at least this far apart. */
  bridgeWallFrom: 8, bridgeWallEvery: 7.5,
  /** Shot at: build only when there's no cover spot within this, and stop covering after this long without contact. */
  coverNearSpot: 3, coverForgetSec: 6,
  /** Walls (or bags) one cover episode may use before giving up on it; a failed roll waits this long. */
  coverMaxPieces: 3, coverRetrySec: 5,
  /** Distance from me to the cover wall I throw down. */
  coverDist: [1.3, 1.6, 1.05],
  /** High ground: fight on the same island at this range, for this long, before throwing a ramp down. */
  highGroundRange: [8, 35] as const, highGroundAfter: 2.5, perchSec: 12,
  /** A fortification slot that won't place is left alone this long (repair waits for calm anyway). */
  slotBackoffSec: 30,
  /** Ahead by this much health+shield on the shooter: fight instead of building/hiding. */
  pushLead: 30,
  /** A bridge tip where no deck fits: retry this often; after this long go round (alt lane) or leave it this long. */
  bridgeRetrySec: 0.5, bridgeStuckSec: 4, bridgeHoldSec: 20,
  /** Hotbar slots building never takes (guns, medkits, grenades, potions need room too). */
  freeSlots: 2,
  /** Goal weights: covering under fire beats fighting in the open; fortifying is a calm-time job. */
  coverScore: 1.05, fortifyScore: 0.5,
};
const OWN_BUNKER_CHECK = BUILD_TUNING.ownBunkerCheck;
const CLEARANCE_MARGIN = BUILD_TUNING.clearanceMargin;
const DOOR_KEEP_OUT = BUILD_TUNING.doorKeepOut;

/** A piece as it would stand (for checking a placement before making it). */
export const ghost = (kind: PieceKind, pos: Vec3, rotY: number, owner: number): PieceState =>
  ({ id: -1, kind, owner, pos, rotY, hp: PIECES[kind].hp });

/**
 * Would this piece keep my own bunker open? Anything near it must leave a way out ≥ 1.3 m wide (isSealed with a
 * clearance margin) and stay out of the doorways. Ramps and scaffolds never block; far pieces can't matter.
 */
export function ownBunkerSafe(bunker: Bunker, pieces: PieceState[], piece: PieceState): boolean {
  if (dist2D(piece.pos, bunker.center) > OWN_BUNKER_CHECK) return true;
  if (piece.kind === 'ramp' || piece.kind === 'scaffold') return true;
  const half = Math.hypot(PIECES[piece.kind].w, PIECES[piece.kind].d) / 2;
  if (bunker.doorways.some((d) => dist2D(d.center, piece.pos) < DOOR_KEEP_OUT + half - 1)) return false;
  const near = pieces.filter((p) => dist2D(p.pos, bunker.center) < OWN_BUNKER_CHECK + 4);
  return !isSealed(bunker, [...near, piece], CLEARANCE_MARGIN);
}

/** Does the piece stand between `from` (a shooter's eye) and `to` (my chest), tall enough to stop the shot? */
export function shields(p: PieceState, from: Vec3, to: Vec3): boolean {
  const s = PIECES[p.kind];
  if (p.kind === 'scaffold') return false;
  // Height of the line where it crosses the piece must be under the piece's top.
  const a = rotateY(sub(from, p.pos), -p.rotY), b = rotateY(sub(to, p.pos), -p.rotY);
  const hx = s.w / 2, hz = s.d / 2 + 0.05;
  let t0 = 0, t1 = 1;
  for (const [o, d, h] of [[a.x, b.x - a.x, hx], [a.z, b.z - a.z, hz]]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(o) > h) return false; continue; }
    let ta = (-h - o) / d, tb = (h - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  const y = from.y + (to.y - from.y) * ((t0 + t1) / 2);
  return y < p.pos.y + s.h && y > p.pos.y - 0.05;
}

export type SlotTag = 'post' | 'econ' | 'tower';
/** One piece of the home fortification plan. `pos.y` is the ground (or deck) it stands on. */
export type Slot = { kind: PieceKind; pos: Vec3; rotY: number; tag: SlotTag; /** Index of a slot that must stand first. */ after?: number };

/** Islands nearest to `home` first. */
function neighbours(map: IslandLayout[], home: number): number[] {
  return map.filter((i) => i.index !== home).sort((a, b) => dist2D(a.center, map[home].center) - dist2D(b.center, map[home].center)).map((i) => i.index);
}

/**
 * The home fortification plan, in build order:
 * - a firing position (two sandbags with a gap) set back from where a bridge from each of the two nearest islands
 *   would land (bridges run along fixed lanes, so a player knows where they come in);
 * - sandbag lines on the outward side of the vault, generator and shop;
 * - for long-range players, a watchtower (ramp + scaffold deck) looking at the nearest island.
 * Everything stays far from the bunker (which sits at the back of the island) and off the walking lines.
 */
export function fortPlan(map: IslandLayout[], home: number, t: Traits): Slot[] {
  const isl = map[home];
  const g = isl.groundY;
  const out: Slot[] = [];
  const at = (p: Vec3) => v3(p.x, g, p.z);
  const post = (j: number) => {
    const l = lane(map, j, home);
    const shore = l.length - Math.sqrt(isl.radius * isl.radius - LANE_OFFSET * LANE_OFFSET);
    const c = laneAt(l, shore + 6);
    const face = yawOf(scale(l.dir, -1));
    for (const side of [-1.6, 1.6]) out.push({ kind: 'sandbags', pos: at(add(c, scale(right(face), side))), rotY: face, tag: 'post' });
  };
  const near = neighbours(map, home);
  const inward = forward(isl.bunker.facingYaw);
  const econ = (p: Vec3, sides: number[]) => {
    const c = add(p, scale(inward, 2.6));
    for (const s of sides) out.push({ kind: 'sandbags', pos: at(add(c, scale(right(isl.bunker.facingYaw), s))), rotY: isl.bunker.facingYaw, tag: 'econ' });
  };
  post(near[0]);
  econ(isl.vault, [-1.05, 1.05]);
  if (near.length > 1) post(near[1]);
  econ(isl.generator, [0]);
  econ(isl.shop, [0]);
  if (t.range > 0.7 || t.builder > 0.8) {
    // Watchtower: ramp rising toward the nearest island, a scaffold deck straight off its top.
    const to = norm(sub(map[near[0]].center, isl.center));
    const base = add(add(isl.center, scale(to, 5)), scale(right(yawOf(to)), -6));
    const rotY = yawOf(to) + Math.PI; // a ramp rises along its local +Z (= -forward(rotY))
    out.push({ kind: 'ramp', pos: at(base), rotY, tag: 'tower' });
    const deck = add(base, scale(to, PIECES.ramp.d / 2 + PIECES.scaffold.d / 2 - 0.1));
    out.push({ kind: 'scaffold', pos: v3(deck.x, g + PIECES.ramp.h - 0.15, deck.z), rotY: yawOf(to), tag: 'tower', after: out.length - 1 });
  }
  return out;
}

/** Pieces of the plan this player will actually build: a share by skill and how much they like building. */
export function fortShare(plan: Slot[], t: Traits, difficulty: Difficulty): Slot[] {
  const k = Math.min(1, BUILD_SKILL[difficulty].fort * Math.min(1, 0.15 + t.builder));
  let n = Math.round(plan.length * k);
  // Don't stop halfway through a structure that only works whole (the tower deck needs its ramp).
  while (n < plan.length && plan[n].after !== undefined) n++;
  return plan.slice(0, n);
}

/** Is a slot standing (anyone's piece of that kind right there)? */
export const slotBuilt = (pieces: PieceState[], s: Slot) =>
  pieces.some((p) => p.kind === s.kind && dist2D(p.pos, s.pos) < 0.8 && Math.abs(p.pos.y - s.pos.y) < 0.6);

/** Count of each piece kind still missing from these slots. */
export function missing(pieces: PieceState[], slots: Slot[]): Partial<Record<PieceKind, number>> {
  const out: Partial<Record<PieceKind, number>> = {};
  for (const s of slots) if (!slotBuilt(pieces, s)) out[s.kind] = (out[s.kind] ?? 0) + 1;
  return out;
}

/** Easy players sometimes put a piece somewhere silly: up to a few metres off and skewed. */
export function fumble(pos: Vec3, rotY: number, rng: () => number): { pos: Vec3; rotY: number } {
  const a = rng() * 2 * Math.PI, r = 1 + rng() * 2;
  return { pos: v3(pos.x + dm.cos(a) * r, pos.y, pos.z + dm.sin(a) * r), rotY: rotY + (rng() - 0.5) * 1.6 };
}

/** Which side of a lane (+1 right, -1 left) faces the nearest other island: that's where flank fire comes from. */
export function flankSide(map: IslandLayout[], l: Lane): number {
  const mid = laneAt(l, l.length / 2);
  let best = Infinity, side = 1;
  for (const isl of map) {
    if (isl.index === l.from || isl.index === l.to) continue;
    const d = dist2D(isl.center, mid);
    if (d >= best) continue;
    best = d;
    const rel = sub(isl.center, mid);
    const r = right(yawOf(l.dir));
    side = rel.x * r.x + rel.z * r.z >= 0 ? 1 : -1;
  }
  return side;
}
