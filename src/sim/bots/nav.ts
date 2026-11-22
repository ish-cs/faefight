import * as dm from '../dmath';
import { MAP, PIECES, PLAYER } from '../constants';
import { MOVE } from '../movement';
import type { Box, Bunker, CenterIsland, Doorway, IslandLayout, StaticBox } from '../map';
import { doorBlocked } from './plans';
import type { Vec3 } from '../types';
import { add, dist2D, forward, right, rotateY, scale, sub, v3, yawOf } from '../vec';
import type { BotView } from './view';

/** Bridges run parallel to the node-to-node line, offset to the builder's right, clear of vault/shop/generator. */
export const LANE_OFFSET = 3;
const SCAN_STEP = 0.25;
const CARROT = 2;
const LOOK = [0.4, 0.8];
/** Side offset of the edge probes in safeDir (most of the body radius: the capsule hangs over a rim before it drops). */
const EDGE = 0.25;
/** How long safeDir keeps detouring to the same side. */
const DETOUR_KEEP_SEC = 1.5;
const DETOURS = [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6];
/** Highest step the character controller climbs without jumping (autostep 0.3 m). */
const STEP_UP = 0.35;
/** Don't walk off anything higher than this when there's another way (falls over ~3.3 m hurt). */
const MAX_DROP = 3;
/** Jump arc check: time step. */
const JUMP_STEP = 0.1;
const BUNKER_HALF = MAP.bunker.interior / 2 + MAP.bunker.wall;
/** Within this (m) of a bunker corner waypoint counts as having rounded it (withinIsland). */
const CORNER_REACHED = 0.6;
/** Walk grid: cell size, and how far to keep the body from cover (player radius + margin). */
const GRID_CELL = 0.5;
const COVER_CLEARANCE = PLAYER.radius + 0.3;
/** A prop whose top is at most this above the ground is stepped onto (the character controller's autostep), not walked round. */
const PROP_STEP = 0.35;
/** How long a planned path around cover is reused before re-planning. */
const PATH_TTL = 1.0;

/**
 * A place bots can stand on: a player island (index = island) or the neutral center island
 * (index = number of player islands). The center island has no bunker.
 */
export type NavNode = { index: number; center: Vec3; radius: number; groundY: number; bunker: Bunker | null };

export type Lane = { from: number; to: number; origin: Vec3; dir: Vec3; length: number };
export type Frontier = { s: number; complete: boolean };

/** Player islands plus, when the map has one, the center island as the last node. */
export function navNodes(map: IslandLayout[], center?: CenterIsland | null): NavNode[] {
  const nodes: NavNode[] = map.map((i) => ({ index: i.index, center: i.center, radius: i.radius, groundY: i.groundY, bunker: i.bunker }));
  if (center) nodes.push({ index: map.length, center: center.center, radius: center.radius, groundY: center.groundY, bunker: null });
  return nodes;
}

export function lane(map: { center: Vec3 }[], from: number, to: number): Lane {
  if (from === to) throw new Error(`lane: from and to are both node ${from}`);
  const a = map[from].center, b = map[to].center;
  const length = dist2D(a, b);
  const dir = v3((b.x - a.x) / length, 0, (b.z - a.z) / length);
  return { from, to, origin: add(a, scale(right(yawOf(dir)), LANE_OFFSET)), dir, length };
}

export const laneAt = (l: Lane, s: number): Vec3 => add(l.origin, scale(l.dir, s));
export const laneS = (l: Lane, p: Vec3) => (p.x - l.origin.x) * l.dir.x + (p.z - l.origin.z) * l.dir.z;
const laneOff = (l: Lane, p: Vec3) => Math.abs((p.x - l.origin.x) * l.dir.z - (p.z - l.origin.z) * l.dir.x);
/** Distance along a lane from a node center to where its land ends. */
export const landEdge = (n: { radius: number }) => Math.sqrt(n.radius * n.radius - LANE_OFFSET * LANE_OFFSET);

/** Player island under p (center island and water: -1). */
export function islandAt(map: IslandLayout[], p: Vec3): number {
  for (const isl of map) if (dist2D(p, isl.center) <= isl.radius - 0.1) return isl.index;
  return -1;
}

export function nodeAt(nodes: NavNode[], p: Vec3): number {
  for (const n of nodes) if (dist2D(p, n.center) <= n.radius - 0.1) return n.index;
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
  return segHitsRect(a, b, h, h);
}
function segHitsRect(a: Vec3, b: Vec3, hx: number, hz: number): boolean {
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[a.x, b.x - a.x, hx], [a.z, b.z - a.z, hz]]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(p) > h) return false; continue; }
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Bunker-local: the first corner on the shortest walk a → c round the bunker square (Dijkstra over a, the four
 * corners and c; a leg counts when it clears the wall), c itself when it's in sight, or null when c can't be reached
 * that way (it hugs the wall).
 * `at`: the corner I'm standing on; I count as being there, so the next waypoint is the one after it.
 */
function route(a: Vec3, c: Vec3, corners: Vec3[], at: Vec3 | undefined): Vec3 | null {
  const H = BUNKER_HALF + 0.05;
  const pts = [at ?? a, ...corners, c], n = pts.length, goal = n - 1;
  const d = new Array<number>(n).fill(Infinity), first = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  d[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0 || u === goal) break;
    done[u] = true;
    for (let v = 1; v < n; v++) {
      if (done[v] || pts[v] === pts[u] || segHitsSquare(pts[u], pts[v], H)) continue;
      const w = d[u] + dist2D(pts[u], pts[v]);
      if (w < d[v]) { d[v] = w; first[v] = u === 0 ? v : first[u]; }
    }
  }
  return first[goal] > 0 ? pts[first[goal]] : null;
}

/** Next waypoint toward dest on one island: through doorways when entering/leaving the bunker, around it otherwise. */
/** `open`: doorways a player can still walk through (a plugged one is skipped unless all are). */
export function withinIsland(isl: { bunker: Bunker }, me: Vec3, dest: Vec3, open: (d: Doorway) => boolean = () => true): Vec3 {
  const b = isl.bunker;
  const inMe = insideBunker(b, me), inDest = insideBunker(b, dest);
  if (inMe === inDest) {
    if (inMe) return dest;
    const a = toLocal(b, me), c = toLocal(b, dest);
    const nearWall = Math.abs(a.x) < BUNKER_HALF + 0.4 && Math.abs(a.z) < BUNKER_HALF + 0.4;
    if (!segHitsSquare(a, c, nearWall ? BUNKER_HALF + 0.05 : BUNKER_HALF + 0.4)) return dest;
    const k = BUNKER_HALF + 1.3;
    // Standing in a doorway (inside the wall square, not the room): no corner is reachable from here and a
    // straight line cuts back through the room, so step straight out first (else bots dither on the threshold).
    if (Math.abs(a.x) < BUNKER_HALF + 0.05 && Math.abs(a.z) < BUNKER_HALF + 0.05) {
      const out = Math.abs(a.x) > Math.abs(a.z) ? v3(Math.sign(a.x) * k, 0, a.z) : v3(a.x, 0, Math.sign(a.z) * k);
      return toWorld(b, out);
    }
    const corners = [v3(k, 0, k), v3(-k, 0, k), v3(k, 0, -k), v3(-k, 0, -k)];
    // Already round a corner: the corner was only a waypoint, so go on as soon as the wall itself is out of the way
    // (a destination close to the wall always clips the wider margin, and re-picking the corner I stand on makes
    // bots dither on it, their view flipping with each step).
    const at = corners.find((q) => dist2D(a, q) < CORNER_REACHED);
    if (at && !segHitsSquare(a, c, BUNKER_HALF + 0.05)) return dest;
    // Shortest walk round the square: me → corners (along the sides) → dest, every leg clear of the wall. Pricing a
    // corner as me→corner→dest without checking the corner→dest leg made a corner whose way on cuts back through
    // the bunker look cheapest; standing on the corner it was skipped for the next one, a step later it was
    // cheapest again: bots paced between two corners, their view flipping each step (botAim seed 1, seal walk).
    const next = route(a, c, corners, at);
    if (next === c) return dest;
    if (next) return toWorld(b, next);
    let best: Vec3 | null = null, bestCost = Infinity;
    for (const corner of corners) {
      if (corner === at || segHitsSquare(a, corner, BUNKER_HALF + 0.05)) continue;
      const cost = dist2D(a, corner) + dist2D(corner, c);
      if (cost < bestCost) { bestCost = cost; best = corner; }
    }
    return best ? toWorld(b, best) : dest;
  }
  const usable = b.doorways.filter(open);
  const doors = usable.length ? usable : b.doorways;
  const door = doors.reduce((p, d) => (dist2D(d.center, inMe ? dest : me) < dist2D(p.center, inMe ? dest : me) ? d : p));
  const out = forward(door.yaw);
  const rel = sub(me, door.center);
  const lateral = Math.abs(rel.x * right(door.yaw).x + rel.z * right(door.yaw).z);
  const depth = rel.x * out.x + rel.z * out.z;
  if (inMe) return lateral > 0.4 ? add(door.center, scale(out, -0.8)) : add(door.center, scale(out, 1.5));
  return lateral > 0.4 || depth > 2 ? add(door.center, scale(out, 1.2)) : dest;
}

/**
 * Per-node walk grid around built-in cover (0.5 m cells over the disc). Straight lines are used whenever
 * they clear every obstacle; otherwise A* over the grid, string-pulled to a few corner waypoints.
 */
type Circle = { pos: Vec3; r: number };

const norm2D = (p: Vec3): Vec3 => { const l = Math.hypot(p.x, p.z); return l > 1e-6 ? v3(p.x / l, 0, p.z / l) : v3(1, 0, 0); };

/** Distance from p to the segment a→b (2D). */
function segPointDist(a: Vec3, b: Vec3, p: Vec3): number {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
  const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

export class WalkGrid {
  private readonly n: number;
  private readonly x0: number;
  private readonly z0: number;
  private blocked: Uint8Array;
  private readonly boxes: Box[];

  constructor(readonly node: NavNode, statics: Box[]) {
    this.boxes = statics.filter((s) => dist2D(s.center, node.center) < node.radius + 4);
    this.n = Math.ceil((2 * node.radius) / GRID_CELL);
    this.x0 = node.center.x - node.radius;
    this.z0 = node.center.z - node.radius;
    this.blocked = new Uint8Array(this.n * this.n);
    for (let i = 0; i < this.n; i++) for (let j = 0; j < this.n; j++) {
      const p = this.cellPos(i, j);
      if (dist2D(p, node.center) > node.radius - 0.5 || this.boxes.some((b) => this.inBox(b, p, COVER_CLEARANCE))) this.blocked[i * this.n + j] = 1;
    }
  }

  get hasObstacles() { return this.boxes.length > 0; }

  /** Props on this node too tall to step over (footprint circles), for this view; set by Nav.within. */
  props: readonly Circle[] = [];

  private cellPos(i: number, j: number): Vec3 {
    return v3(this.x0 + (i + 0.5) * GRID_CELL, this.node.groundY, this.z0 + (j + 0.5) * GRID_CELL);
  }

  private inBox(b: Box, p: Vec3, pad: number) {
    const l = rotateY(sub(p, b.center), -b.rotY);
    return Math.abs(l.x) <= b.half.x + pad && Math.abs(l.z) <= b.half.z + pad;
  }

  /** True when a straight walk a→b touches no cover (with a slightly thinner margin than the grid). */
  clear(a: Vec3, b: Vec3): boolean {
    for (const box of this.boxes) {
      const la = rotateY(sub(a, box.center), -box.rotY), lb = rotateY(sub(b, box.center), -box.rotY);
      if (segHitsRect(la, lb, box.half.x + COVER_CLEARANCE - 0.1, box.half.z + COVER_CLEARANCE - 0.1)) return false;
    }
    for (const c of this.props) if (segPointDist(a, b, c.pos) < c.r + COVER_CLEARANCE - 0.1) return false;
    return true;
  }

  isBlocked(p: Vec3): boolean {
    const k = this.cellOf(p);
    return k < 0 || this.blocked[k] === 1;
  }

  private cellOf(p: Vec3): number {
    const i = Math.floor((p.x - this.x0) / GRID_CELL), j = Math.floor((p.z - this.z0) / GRID_CELL);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return i * this.n + j;
  }

  /** Nearest free cell to p (p itself when free), or -1. */
  private freeNear(p: Vec3): number {
    const k = this.cellOf(p);
    if (k >= 0 && !this.blocked[k]) return k;
    let best = -1, bestD = Infinity;
    const i0 = Math.floor((p.x - this.x0) / GRID_CELL), j0 = Math.floor((p.z - this.z0) / GRID_CELL);
    for (let r = 1; r <= 10 && best < 0; r++)
      for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
        if (i < 0 || j < 0 || i >= this.n || j >= this.n || this.blocked[i * this.n + j]) continue;
        const d = dist2D(this.cellPos(i, j), p);
        if (d < bestD) { bestD = d; best = i * this.n + j; }
      }
    return best;
  }

  /** Waypoints from a to b around cover (excluding a, ending at b), or null when b can't be reached. */
  path(a: Vec3, b: Vec3): Vec3[] | null {
    if (this.clear(a, b)) return [b];
    const n = this.n;
    const base = this.blocked;
    if (this.props.length) {
      // Props move: rasterize the ones here into a copy of the cover grid for this search only.
      const blocked = base.slice();
      for (const c of this.props) {
        const R = c.r + COVER_CLEARANCE;
        const i0 = Math.max(0, Math.floor((c.pos.x - R - this.x0) / GRID_CELL)), i1 = Math.min(n - 1, Math.floor((c.pos.x + R - this.x0) / GRID_CELL));
        const j0 = Math.max(0, Math.floor((c.pos.z - R - this.z0) / GRID_CELL)), j1 = Math.min(n - 1, Math.floor((c.pos.z + R - this.z0) / GRID_CELL));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (dist2D(this.cellPos(i, j), c.pos) <= R) blocked[i * n + j] = 1;
      }
      this.blocked = blocked;
    }
    try { return this.search(a, b); } finally { this.blocked = base; }
  }

  private search(a: Vec3, b: Vec3): Vec3[] | null {
    const s = this.freeNear(a), g = this.freeNear(b);
    if (s < 0 || g < 0) return null;
    const n = this.n;
    const cost = new Float32Array(n * n).fill(Infinity);
    const prev = new Int32Array(n * n).fill(-1);
    const gi = Math.floor(g / n), gj = g % n;
    const h = (k: number) => Math.hypot(Math.floor(k / n) - gi, (k % n) - gj);
    // Binary heap of [f, k].
    const heap: number[][] = [];
    const push = (f: number, k: number) => {
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    cost[s] = 0;
    push(h(s), s);
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let found = false;
    while (heap.length) {
      const [f, k] = pop();
      if (k === g) { found = true; break; }
      if (f - h(k) > cost[k] + 1e-6) continue;
      const i = Math.floor(k / n), j = k % n;
      for (const [di, dj, c] of DIRS) {
        const a2 = i + di, b2 = j + dj;
        if (a2 < 0 || b2 < 0 || a2 >= n || b2 >= n) continue;
        const kk = a2 * n + b2;
        if (this.blocked[kk]) continue;
        if (di && dj && (this.blocked[a2 * n + j] || this.blocked[i * n + b2])) continue; // no corner cutting
        const nc = cost[k] + c;
        if (nc < cost[kk]) { cost[kk] = nc; prev[kk] = k; push(nc + h(kk), kk); }
      }
    }
    if (!found) return null;
    const cells: Vec3[] = [];
    for (let k = g; k !== -1 && k !== s; k = prev[k]) cells.push(this.cellPos(Math.floor(k / n), k % n));
    cells.reverse();
    cells.push(b);
    // String-pull: from each anchor, skip ahead to the farthest point still in straight sight.
    const out: Vec3[] = [];
    let from = a;
    let i = 0;
    while (i < cells.length) {
      let j = cells.length - 1;
      while (j > i && !this.clear(from, cells[j])) j--;
      out.push(cells[j]);
      from = cells[j];
      i = j + 1;
    }
    return out;
  }
}

/** Pathing facts derived from a view; bridge scans are cached for `ttl` seconds. */
export class Nav {
  private cache = new Map<string, { at: number; f: Frontier }>();
  private view!: BotView;
  private nodeList: NavNode[] = [];
  private nodesFor: IslandLayout[] | null = null;
  private grids = new Map<number, WalkGrid>();
  private planned: { node: number; goal: Vec3; at: number; pts: Vec3[] } | null = null;
  /** Finished bridges between node pairs, memoised for the current tick. */
  private bridges = new Map<number, Lane | null>();

  constructor(private readonly ttl = 0.5) {}

  begin(view: BotView) {
    this.view = view;
    this.bridges.clear();
    if (this.nodesFor !== view.map) {
      this.nodesFor = view.map;
      this.nodeList = navNodes(view.map, view.center?.island);
      this.grids.clear();
      for (const n of this.nodeList) {
        const own = (view.statics ?? []).filter((s: StaticBox) => (s.island < 0 ? view.map.length : s.island) === n.index);
        this.grids.set(n.index, new WalkGrid(n, own));
      }
    }
  }
  invalidate() { this.cache.clear(); }

  /** Player islands, then the center island (if any). */
  get nodes(): NavNode[] { return this.nodeList; }
  /** Node index of the center island, or -1. */
  get centerNode(): number { return this.view.center ? this.view.map.length : -1; }
  nodeAt(p: Vec3): number { return nodeAt(this.nodeList, p); }
  grid(node: number): WalkGrid | undefined { return this.grids.get(node); }

  /** Scans a lane outward from its home node: last solid s, and whether it reaches the far node. */
  frontier(l: Lane): Frontier {
    const key = `${l.from}>${l.to}`;
    const hit = this.cache.get(key);
    if (hit && this.view.now - hit.at < this.ttl) return hit.f;
    const nodes = this.nodeList;
    let f: Frontier | null = null;
    for (let s = landEdge(nodes[l.from]) - 2; s <= l.length; s += SCAN_STEP) {
      const p = laneAt(l, s);
      // A sliver between two decks (a few cm) is walkable: only a real gap ends the bridge.
      if (this.view.groundAt(p.x, p.z) === null && !this.solidAhead(l, s)) { f = { s: s - SCAN_STEP, complete: false }; break; }
      if (nodeAt(nodes, p) === l.to) { f = { s, complete: true }; break; }
    }
    if (!f) throw new Error(`Nav.frontier: lane ${key} never reached node ${l.to}; map geometry is inconsistent`);
    this.cache.set(key, { at: this.view.now, f });
    return f;
  }

  private solidAhead(l: Lane, s: number): boolean {
    // Decks laid end to end can leave a few-cm seam; anything wider is a real gap.
    const p = laneAt(l, s + 0.06);
    return this.view.groundAt(p.x, p.z) !== null;
  }

  lane(from: number, to: number): Lane { return lane(this.nodeList, from, to); }

  /** Scaffolds still needed to finish the bridge from node `from` to node `to` (at least 1). */
  scaffoldsTo(from: number, to: number, step: number): number {
    const l = this.lane(from, to);
    const left = l.length - landEdge(this.nodeList[to]) - this.frontier(l).s;
    return Math.max(1, Math.ceil(left / step));
  }

  /**
   * A finished bridge walkable from node a to b, or null. Decks chain level, but a bridge can still end high
   * (e.g. built off a stack), so check the end on node a is enterable.
   */
  bridge(a: number, b: number): Lane | null {
    const key = a * 64 + b;
    const hit = this.bridges.get(key);
    if (hit !== undefined) return hit;
    let out: Lane | null = null;
    for (const l of [this.lane(a, b), this.lane(b, a)])
      if (this.frontier(l).complete && this.enterable(l, a)) { out = l; break; }
    this.bridges.set(key, out);
    return out;
  }

  /** Shortest walk over finished bridges from node a to b (node list incl. both ends), or null. */
  route(a: number, b: number): number[] | null {
    if (a === b) return [a];
    const n = this.nodeList.length;
    const d = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
    d[a] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
      if (u < 0 || u === b) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v] || v === u) continue;
        const w = d[u] + dist2D(this.nodeList[u].center, this.nodeList[v].center);
        if (w >= d[v] || !this.bridge(u, v)) continue;
        d[v] = w; prev[v] = u;
      }
    }
    if (d[b] === Infinity) return null;
    const path = [b];
    while (path[0] !== a) path.unshift(prev[path[0]]);
    return path;
  }

  /** Node to head for next from a toward b over finished bridges (b itself, or the next stop on the way), or null. */
  hop(a: number, b: number): number | null {
    const r = this.route(a, b);
    return r ? r[Math.min(1, r.length - 1)] : null;
  }

  private enterable(l: Lane, i: number): boolean {
    const nodes = this.nodeList;
    const p = laneAt(l, i === l.from ? landEdge(nodes[i]) + 0.5 : l.length - landEdge(nodes[i]) - 0.5);
    const y = this.view.groundAt(p.x, p.z);
    return y !== null && y - nodes[i].groundY <= STEP_UP;
  }

  private nearestLane(p: Vec3): Lane | null {
    const nodes = this.nodeList;
    let best: Lane | null = null, bestOff = 2.5;
    for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const l = this.lane(i, j);
      const s = laneS(l, p);
      if (s < 0 || s > l.length) continue;
      const off = laneOff(l, p);
      if (off < bestOff) { bestOff = off; best = l; }
    }
    return best;
  }

  /** s on lane l where node i's solid land starts, a little inland. */
  private landS(l: Lane, i: number): number {
    const nodes = this.nodeList;
    if (i === l.from) return landEdge(nodes[l.from]) - 1.5;
    if (i === l.to) return l.length - landEdge(nodes[l.to]) + 1.5;
    const nearTo = dist2D(nodes[i].center, nodes[l.to].center) < dist2D(nodes[i].center, nodes[l.from].center);
    return this.landS(l, nearTo ? l.to : l.from);
  }

  /** Next waypoint toward dest on node i: bunker doorways, then around built-in cover. */
  within(i: number, me: Vec3, dest: Vec3): Vec3 {
    const node = this.nodeList[i];
    const pieces = this.view.pieces;
    let wp = node.bunker ? withinIsland({ bunker: node.bunker }, me, dest, (d) => !doorBlocked(pieces, d)) : dest;
    const g = this.grids.get(i);
    if (g) g.props = (this.view.props ?? []).filter((p) => p.top - node.groundY > PROP_STEP && dist2D(p.pos, node.center) < node.radius + 1);
    // A waypoint on a prop (a lane carrot, a spot by the rim) moves to just beside it: round it, not shoving it ahead.
    if (g) for (const c of g.props) {
      const d = dist2D(wp, c.pos), R = c.r + COVER_CLEARANCE;
      if (d >= R) continue;
      const away = d > 1e-3 ? v3((wp.x - c.pos.x) / d, 0, (wp.z - c.pos.z) / d) : norm2D(sub(me, c.pos));
      wp = v3(c.pos.x + away.x * R, wp.y, c.pos.z + away.z * R);
    }
    if (!g || (!g.hasObstacles && !g.props.length) || g.clear(me, wp)) return wp;
    const now = this.view.now;
    const plan = this.planned;
    if (!plan || plan.node !== i || dist2D(plan.goal, wp) > 0.75 || now - plan.at > PATH_TTL) {
      this.planned = { node: i, goal: wp, at: now, pts: g.path(me, wp) ?? [wp] };
    }
    const pts = this.planned!.pts;
    while (pts.length > 1 && (dist2D(pts[0], me) < 0.6 || g.clear(me, pts[1]))) pts.shift();
    return pts[0];
  }

  /** Next waypoint toward dest, or null when no walkable route exists (no bridge yet). */
  routeTo(dest: Vec3): Vec3 | null {
    const me = this.view.self.pos;
    const a = this.nodeAt(me), b = this.nodeAt(dest);
    if (a >= 0 && a === b) return this.within(a, me, dest);
    let l: Lane | null;
    let sTarget: number;
    if (a >= 0 && b >= 0) {
      const h = this.hop(a, b);
      l = h === null ? null : this.bridge(a, h);
      if (!l || h === null) return null;
      sTarget = this.landS(l, h);
      // Get onto the bridge's start first, around any cover on this island (the lane may cross a container).
      const exitS = l.from === a ? landEdge(this.nodeList[a]) - 1.2 : l.length - landEdge(this.nodeList[a]) + 1.2;
      const s = laneS(l, me);
      const before = l.from === a ? s < exitS - 0.5 : s > exitS + 0.5;
      if (before || laneOff(l, me) > 1.0) {
        const entry = laneAt(l, exitS);
        if (dist2D(me, entry) > 0.6) return this.within(a, me, v3(entry.x, this.nodeList[a].groundY, entry.z));
      }
    } else if (a < 0) {
      l = this.nearestLane(me);
      if (!l) return null;
      sTarget = b >= 0 ? this.landS(l, b) : laneS(l, dest);
      // Out on one bridge, heading for a spot on another (e.g. the tip of a pier on a new lane): back to the island
      // both lanes hang off first, not straight at it across the water (that flip-flops on the deck forever).
      // (Not in the storm: heading home first there is walking out into it.)
      if (b < 0 && !this.view.storm) {
        const ld = this.nearestLane(dest);
        if (ld && !(ld.from === l.from && ld.to === l.to) && !(ld.from === l.to && ld.to === l.from)) {
          const shared = [l.from, l.to].find((n) => n === ld.from || n === ld.to);
          if (shared !== undefined) sTarget = this.landS(l, shared);
        }
      }
    } else {
      l = this.nearestLane(dest);
      if (!l || (l.from !== a && l.to !== a)) return null;
      sTarget = laneS(l, dest);
    }
    const sMe = laneS(l, me);
    const gap = sTarget - sMe;
    if (Math.abs(gap) < 0.5) return b >= 0 && a !== b ? laneAt(l, sTarget) : dest;
    const carrot = laneAt(l, sMe + Math.sign(gap) * Math.min(CARROT, Math.abs(gap)));
    return a >= 0 ? this.within(a, me, carrot) : this.alongDeck(me, carrot);
  }

  /**
   * Out on a bridge: walk the centreline of the deck I'm standing on toward the carrot (the lane math can pick a
   * neighbouring lane a few metres to the side, and steering at it walks off the edge).
   */
  private alongDeck(me: Vec3, carrot: Vec3): Vec3 {
    let deck: { pos: Vec3; rotY: number } | null = null, bestD = Infinity;
    for (const p of this.view.pieces) {
      if (p.kind !== 'scaffold' || Math.abs(p.pos.y - me.y) > 1) continue;
      const d = dist2D(p.pos, me);
      if (d < bestD && d < 2.4) { bestD = d; deck = p; }
    }
    if (!deck) return carrot;
    const u = v3(dm.sin(deck.rotY), 0, dm.cos(deck.rotY));
    const along = (me.x - deck.pos.x) * u.x + (me.z - deck.pos.z) * u.z;
    const side = Math.abs((me.x - deck.pos.x) * u.z - (me.z - deck.pos.z) * u.x);
    // Off this deck's footprint (between two decks, or stepping onto land): the lane carrot is fine.
    if (Math.abs(along) > 2.2 || side > 1.2) return carrot;
    const k = (carrot.x - me.x) * u.x + (carrot.z - me.z) * u.z;
    const sign = k >= 0 ? 1 : -1;
    return v3(deck.pos.x + u.x * (along + sign * CARROT), me.y, deck.pos.z + u.z * (along + sign * CARROT));
  }

  /**
   * Would a jump now (steering toward `dir`, null = no input) come down on solid ground? Flies the arc the way
   * movement.ts does (jump velocity, gravity, slow air steering) from the current velocity and checks the ground
   * under every point of it: anyone looking at a deck edge knows not to hop sideways off it.
   */
  safeJump(dir: Vec3 | null, sprint: boolean): boolean {
    // Strict: solid ground under the whole arc (a hop is never worth crossing open water), and never off a deck
    // (they're 2 m wide: one bad hop and I'm swimming).
    const me = this.view.self.pos;
    const onDeck = this.view.pieces.some((p) => p.kind === 'scaffold' && Math.abs(p.pos.y + PIECES.scaffold.h - me.y) < 0.5 &&
      Math.abs((me.x - p.pos.x) * dm.cos(p.rotY) - (me.z - p.pos.z) * dm.sin(p.rotY)) < PIECES.scaffold.w / 2 + 0.4 &&
      Math.abs((me.x - p.pos.x) * dm.sin(p.rotY) + (me.z - p.pos.z) * dm.cos(p.rotY)) < PIECES.scaffold.d / 2 + 0.4);
    return !onDeck && this.landsOnGround(dir, sprint, PLAYER.jumpVelocity, true);
  }

  /**
   * Airborne (or about to jump with vertical speed vy0): does steering toward `dir` bring me down on something
   * solid rather than in the water?
   */
  landsOnGround(dir: Vec3 | null, sprint: boolean, vy0 = this.view.self.vel.y, strict = false): boolean {
    const me = this.view.self;
    let x = me.pos.x, z = me.pos.z, y = me.pos.y, vx = me.vel.x, vz = me.vel.z, vy = vy0;
    const speed = sprint ? PLAYER.sprint : PLAYER.walk;
    const wx = dir ? dir.x * speed : vx, wz = dir ? dir.z * speed : vz;
    for (let t = 0; t < 2; t += JUMP_STEP) {
      const dx = wx - vx, dz = wz - vz, d = Math.hypot(dx, dz), step = MOVE.airAccel * JUMP_STEP;
      if (d <= step) { vx = wx; vz = wz; } else { vx += dx / d * step; vz += dz / d * step; }
      vy -= PLAYER.gravity * JUMP_STEP;
      x += vx * JUMP_STEP; z += vz * JUMP_STEP; y += vy * JUMP_STEP;
      const g = this.view.groundAt(x, z);
      if (strict && (g === null || me.pos.y - g > MAX_DROP)) return false;
      if (vy > 0) continue;
      if (g !== null && y <= g + 0.05) {
        // Landed: with the body's edge on it too (the capsule slides off a corner it only grazes).
        return me.pos.y - g <= MAX_DROP && [[PLAYER.radius, 0], [-PLAYER.radius, 0], [0, PLAYER.radius], [0, -PLAYER.radius]]
          .filter(([ox, oz]) => this.view.groundAt(x + ox, z + oz) !== null).length >= 3;
      }
      if (y < this.view.waterY + 0.2) return false;
    }
    return false;
  }

  /**
   * Hanging over an edge (nothing under my centre, held up by the rim) or falling: the way back onto something
   * solid, or null when I'm fine.
   */
  rescue(sprint: boolean): Vec3 | null {
    const me = this.view.self;
    const under = this.view.groundAt(me.pos.x, me.pos.z);
    const airborne = Math.abs(me.vel.y) > 0.05;
    if (under !== null && !airborne) return null;
    let best: Vec3 | null = null, bestD = Infinity;
    for (let a = 0; a < 16; a++) {
      const d = v3(dm.sin(a * Math.PI / 8), 0, dm.cos(a * Math.PI / 8));
      if (airborne) {
        if (this.landsOnGround(d, sprint)) {
          const k = -(d.x * me.vel.x + d.z * me.vel.z);
          if (k < bestD) { bestD = k; best = d; }
        }
        continue;
      }
      for (const r of [0.3, 0.6, 0.9, 1.2]) {
        if (this.view.groundAt(me.pos.x + d.x * r, me.pos.z + d.z * r) === null) continue;
        if (r < bestD) { bestD = r; best = d; }
        break;
      }
    }
    return best;
  }

  /**
   * dir, or the nearest rotation of it whose path stays on solid (and, in sudden death, dry) ground without a
   * drop that would hurt; null if none.
   * A surface well above our feet is a roof, wall or overhanging deck: over a node the land is still under it,
   * over water what is under it is unknown, so it is avoided.
   */
  safeDir(dir: Vec3): Vec3 | null {
    const me = this.view.self.pos, vel = this.view.self.vel;
    // Look as far as it takes to stop (fast sprints and sharp turns carry momentum), and at the body's edges.
    const stop = (vel.x * vel.x + vel.z * vel.z) / (2 * MOVE.groundDecel) + 0.4;
    const looks = stop > LOOK[LOOK.length - 1] ? [...LOOK, stop] : LOOK;
    const ok = (d: Vec3, maxDrop: number) => looks.every((k) => [0, EDGE, -EDGE].every((o) => {
      const p = v3(me.x + d.x * k - d.z * o, me.y, me.z + d.z * k + d.x * o);
      let floor = this.view.groundAt(p.x, p.z);
      if (floor !== null && floor - me.y > STEP_UP + 0.25) {
        const i = this.nodeAt(p);
        floor = i >= 0 ? this.nodeList[i].groundY : null;
      }
      return floor !== null && me.y - floor <= maxDrop && !(this.view.suddenDeath && floor <= this.view.waterY + 0.05);
    }));
    // Rather a hurtful drop than being stuck up there forever.
    // Going round something: keep going round the same side for a bit (flip-flopping at a hole goes nowhere).
    const now = this.view.now;
    const side = now - this.detour.at < DETOUR_KEEP_SEC ? this.detour.sign : 0;
    const order = side ? [...DETOURS.filter((a) => Math.sign(a) === side), ...DETOURS.filter((a) => Math.sign(a) !== side)] : DETOURS;
    for (const maxDrop of [MAX_DROP, Infinity]) {
      if (ok(dir, maxDrop)) return dir;
      for (const a of order) {
        const d = rotateY(dir, a);
        if (ok(d, maxDrop)) { this.detour = { sign: Math.sign(a), at: now }; return d; }
      }
    }
    return null;
  }
  private detour = { sign: 0, at: -Infinity };
}
