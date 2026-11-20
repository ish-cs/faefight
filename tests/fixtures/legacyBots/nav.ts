// Frozen copy of the pre-training bots (behavior baseline for series tests and training). Do not edit.
import { MAP } from '../../../src/sim/constants';
import type { Bunker, IslandLayout } from '../../../src/sim/map';
import type { Vec3 } from '../../../src/sim/types';
import { add, dist2D, forward, right, rotateY, scale, sub, v3, yawOf } from '../../../src/sim/vec';
import type { BotView } from '../../../src/sim/bots/view';

/** Bridges run parallel to the island-to-island line, offset to the builder's right, clear of vault/shop/generator. */
export const LANE_OFFSET = 3;
const SCAN_STEP = 0.25;
const CARROT = 2;
const LOOK = [0.4, 0.8];
const DETOURS = [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6];
/** Highest step the character controller climbs without jumping (autostep 0.3 m). */
const STEP_UP = 0.35;
const BUNKER_HALF = MAP.bunker.interior / 2 + MAP.bunker.wall;
/** Don't walk off anything higher than this when there's another way (falls over ~3.3 m hurt). */
const MAX_DROP = 3;

export type Lane = { from: number; to: number; origin: Vec3; dir: Vec3; length: number };
export type Frontier = { s: number; complete: boolean };

export function lane(map: IslandLayout[], from: number, to: number): Lane {
  if (from === to) throw new Error(`lane: from and to are both island ${from}`);
  const a = map[from].center, b = map[to].center;
  const length = dist2D(a, b);
  const dir = v3((b.x - a.x) / length, 0, (b.z - a.z) / length);
  return { from, to, origin: add(a, scale(right(yawOf(dir)), LANE_OFFSET)), dir, length };
}

export const laneAt = (l: Lane, s: number): Vec3 => add(l.origin, scale(l.dir, s));
export const laneS = (l: Lane, p: Vec3) => (p.x - l.origin.x) * l.dir.x + (p.z - l.origin.z) * l.dir.z;
const laneOff = (l: Lane, p: Vec3) => Math.abs((p.x - l.origin.x) * l.dir.z - (p.z - l.origin.z) * l.dir.x);
/** Distance along a lane from an island center to where its land ends. */
const landHalf = (isl: IslandLayout) => Math.sqrt(isl.radius ** 2 - LANE_OFFSET ** 2);

export function islandAt(map: IslandLayout[], p: Vec3): number {
  for (const isl of map) if (dist2D(p, isl.center) <= isl.radius - 0.1) return isl.index;
  return -1;
}

const toLocal = (b: Bunker, p: Vec3) => rotateY(sub(p, b.center), -b.facingYaw);
const toWorld = (b: Bunker, l: Vec3) => add(b.center, rotateY(l, b.facingYaw));

export function insideBunker(b: Bunker, p: Vec3): boolean {
  const l = toLocal(b, p);
  return Math.abs(l.x) < BUNKER_HALF - MAP.bunker.wall / 2 && Math.abs(l.z) < BUNKER_HALF - MAP.bunker.wall / 2;
}

/** Does the 2D segment a→b cross the centered square of half-size h? (slab test) */
function segHitsSquare(a: Vec3, b: Vec3, h: number): boolean {
  let t0 = 0, t1 = 1;
  for (const [p, d] of [[a.x, b.x - a.x], [a.z, b.z - a.z]]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(p) > h) return false; continue; }
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** Next waypoint toward dest on one island: through doorways when entering/leaving the bunker, around it otherwise. */
export function withinIsland(isl: IslandLayout, me: Vec3, dest: Vec3): Vec3 {
  const b = isl.bunker;
  const inMe = insideBunker(b, me), inDest = insideBunker(b, dest);
  if (inMe === inDest) {
    if (inMe) return dest;
    const a = toLocal(b, me), c = toLocal(b, dest);
    const nearWall = Math.abs(a.x) < BUNKER_HALF + 0.4 && Math.abs(a.z) < BUNKER_HALF + 0.4;
    if (!segHitsSquare(a, c, nearWall ? BUNKER_HALF + 0.05 : BUNKER_HALF + 0.4)) return dest;
    const k = BUNKER_HALF + 1.3;
    let best: Vec3 | null = null, bestCost = Infinity;
    for (const corner of [v3(k, 0, k), v3(-k, 0, k), v3(k, 0, -k), v3(-k, 0, -k)]) {
      if (segHitsSquare(a, corner, BUNKER_HALF + 0.05)) continue;
      const cost = dist2D(a, corner) + dist2D(corner, c);
      if (cost < bestCost) { bestCost = cost; best = corner; }
    }
    return best ? toWorld(b, best) : dest;
  }
  const door = b.doorways.reduce((p, d) => (dist2D(d.center, inMe ? dest : me) < dist2D(p.center, inMe ? dest : me) ? d : p));
  const out = forward(door.yaw);
  const rel = sub(me, door.center);
  const lateral = Math.abs(rel.x * right(door.yaw).x + rel.z * right(door.yaw).z);
  const depth = rel.x * out.x + rel.z * out.z;
  if (inMe) return lateral > 0.4 ? add(door.center, scale(out, -0.8)) : add(door.center, scale(out, 1.5));
  return lateral > 0.4 || depth > 2 ? add(door.center, scale(out, 1.2)) : dest;
}

/** Pathing facts derived from a view; bridge scans are cached for `ttl` seconds. */
export class Nav {
  private cache = new Map<string, { at: number; f: Frontier }>();
  private view!: BotView;

  constructor(private readonly ttl = 0.5) {}

  /** Finished bridges between island pairs, memoised for the current tick. */
  private bridges = new Map<number, Lane | null>();

  begin(view: BotView) { this.view = view; this.bridges.clear(); }
  invalidate() { this.cache.clear(); }

  /** Scans a lane outward from its home island: last solid s, and whether it reaches the far island. */
  frontier(l: Lane): Frontier {
    const key = `${l.from}>${l.to}`;
    const hit = this.cache.get(key);
    if (hit && this.view.now - hit.at < this.ttl) return hit.f;
    const map = this.view.map;
    let f: Frontier | null = null;
    for (let s = landHalf(map[l.from]) - 2; s <= l.length; s += SCAN_STEP) {
      const p = laneAt(l, s);
      if (this.view.groundAt(p.x, p.z) === null) { f = { s: s - SCAN_STEP, complete: false }; break; }
      if (islandAt(map, p) === l.to) { f = { s, complete: true }; break; }
    }
    if (!f) throw new Error(`Nav.frontier: lane ${key} never reached island ${l.to}; map geometry is inconsistent`);
    this.cache.set(key, { at: this.view.now, f });
    return f;
  }

  /**
   * A finished bridge walkable from island a to b, or null. Decks chain level, but a bridge can still end high
   * (e.g. built off a stack), so check the end on island a is enterable.
   */
  bridge(a: number, b: number): Lane | null {
    const key = a * 64 + b;
    const hit = this.bridges.get(key);
    if (hit !== undefined) return hit;
    let out: Lane | null = null;
    for (const l of [lane(this.view.map, a, b), lane(this.view.map, b, a)])
      if (this.frontier(l).complete && this.enterable(l, a)) { out = l; break; }
    this.bridges.set(key, out);
    return out;
  }

  /**
   * Island to head for next from a toward b over finished bridges (anyone's), or null.
   * Breadth-first, so a route of several hops across other players' islands is found too.
   */
  hop(a: number, b: number): number | null {
    if (a === b) return b;
    const n = this.view.map.length;
    const first = new Array<number>(n).fill(-1);
    first[a] = a;
    const queue = [a];
    while (queue.length) {
      const x = queue.shift()!;
      for (let y = 0; y < n; y++) {
        if (first[y] >= 0 || !this.bridge(x, y)) continue;
        first[y] = x === a ? y : first[x];
        if (y === b) return first[y];
        queue.push(y);
      }
    }
    return null;
  }

  private enterable(l: Lane, i: number): boolean {
    const map = this.view.map;
    const p = laneAt(l, i === l.from ? landHalf(map[i]) + 0.5 : l.length - landHalf(map[i]) - 0.5);
    const y = this.view.groundAt(p.x, p.z);
    return y !== null && y - map[i].groundY <= STEP_UP;
  }

  private nearestLane(p: Vec3): Lane | null {
    const map = this.view.map;
    let best: Lane | null = null, bestOff = 2.5;
    for (let i = 0; i < map.length; i++) for (let j = 0; j < map.length; j++) {
      if (i === j) continue;
      const l = lane(map, i, j);
      const s = laneS(l, p);
      if (s < 0 || s > l.length) continue;
      const off = laneOff(l, p);
      if (off < bestOff) { bestOff = off; best = l; }
    }
    return best;
  }

  /** s on lane l where island i's solid land starts, a little inland. */
  private landS(l: Lane, i: number): number {
    const map = this.view.map;
    if (i === l.from) return landHalf(map[l.from]) - 1.5;
    if (i === l.to) return l.length - landHalf(map[l.to]) + 1.5;
    const nearTo = dist2D(map[i].center, map[l.to].center) < dist2D(map[i].center, map[l.from].center);
    return this.landS(l, nearTo ? l.to : l.from);
  }

  /** Next waypoint toward dest, or null when no walkable route exists (no bridge yet). */
  routeTo(dest: Vec3): Vec3 | null {
    const map = this.view.map;
    const me = this.view.self.pos;
    const a = islandAt(map, me), b = islandAt(map, dest);
    if (a >= 0 && a === b) return withinIsland(map[a], me, dest);
    let l: Lane | null;
    let sTarget: number;
    if (a >= 0 && b >= 0) {
      const h = this.hop(a, b);
      l = h === null ? null : this.bridge(a, h);
      if (!l || h === null) return null;
      sTarget = this.landS(l, h);
    } else if (a < 0) {
      l = this.nearestLane(me);
      if (!l) return null;
      sTarget = b >= 0 ? this.landS(l, b) : laneS(l, dest);
    } else {
      l = this.nearestLane(dest);
      if (!l || (l.from !== a && l.to !== a)) return null;
      sTarget = laneS(l, dest);
    }
    const sMe = laneS(l, me);
    const gap = sTarget - sMe;
    if (Math.abs(gap) < 0.5) return b >= 0 && a !== b ? laneAt(l, sTarget) : dest;
    const carrot = laneAt(l, sMe + Math.sign(gap) * Math.min(CARROT, Math.abs(gap)));
    return a >= 0 ? withinIsland(map[a], me, carrot) : carrot;
  }

  /**
   * dir, or the nearest rotation of it whose path stays on solid (and, in sudden death, dry) ground without a
   * drop that would hurt; null if none.
   * A surface well above our feet is a roof, wall or overhanging deck: over an island the land is still under it,
   * over water what is under it is unknown, so it is avoided.
   */
  safeDir(dir: Vec3): Vec3 | null {
    const me = this.view.self.pos;
    const ok = (d: Vec3, maxDrop: number) => LOOK.every((k) => {
      const p = v3(me.x + d.x * k, me.y, me.z + d.z * k);
      let floor = this.view.groundAt(p.x, p.z);
      if (floor !== null && floor - me.y > STEP_UP + 0.25) {
        const i = islandAt(this.view.map, p);
        floor = i >= 0 ? this.view.map[i].groundY : null;
      }
      return floor !== null && me.y - floor <= maxDrop && !(this.view.suddenDeath && floor <= this.view.waterY + 0.05);
    });
    // Rather a hurtful drop than being stuck up there forever.
    for (const maxDrop of [MAX_DROP, Infinity]) {
      if (ok(dir, maxDrop)) return dir;
      for (const a of DETOURS) {
        const d = rotateY(dir, a);
        if (ok(d, maxDrop)) return d;
      }
    }
    return null;
  }
}
