import { PIECES, PLAYER } from '../sim/constants';
import { emptyInventory } from '../sim/economy';
import { bunkerWallBoxes, type Box, type IslandLayout } from '../sim/map';
import type { MatchEvent, PieceState, PlayerState, Snapshot, Vec3 } from '../sim/types';
import { add, rotateY, v3 } from '../sim/vec';
import type { NetPlayer, NetSnapshot } from './snapshotCodec';

/**
 * Per-client interest management (anti-ESP): the host only tells each remote client what that
 * client's player could plausibly perceive. See docs/superpowers/specs/2026-11-20-anti-cheat.md.
 *
 * - Enemies are revealed when within earshot, in line of sight (bunker walls + placed pieces occlude,
 *   tested generously: several eye/body sample points, 0.25 s of lookahead), or when they just hurt
 *   you. A reveal lasts `graceSec` past the last positive test so nothing pops at corners.
 * - Unrevealed enemies stay in the list (names, alive/eliminated for HUD + kill feed) with a frozen
 *   last-sent position, neutral aim/hp/timers, and their id in `hidden` (the renderer skips them).
 * - Enemy generator cash only near it; loot bag contents never; far shots from hidden shooters become
 *   a coarse sound position with no tracer; hits on unrevealed players are dropped.
 */
export const INTEREST = {
  nearRadius: 10,
  graceSec: 0.6,
  leadSec: 0.25,
  leanM: 0.6,
  bodySideM: 0.45,
  hearShotRadius: 120,
  /** A tracer passing this close to your eye is something you'd see: full shot + shooter revealed. */
  nearMissM: 4,
  coarseGrid: 4,
  generatorRevealM: 15,
  /** Occluder boxes are shrunk by this (under-occlude on grazing rays rather than over-occlude). */
  shrink: 0.05,
};

type Obb = {
  cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; cos: number; sin: number;
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
};

function obb(center: Vec3, half: Vec3, rotY: number): Obb {
  const s = INTEREST.shrink;
  const hx = Math.max(0.01, half.x - s), hy = Math.max(0.01, half.y - s), hz = Math.max(0.01, half.z - s);
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const ex = Math.abs(cos) * hx + Math.abs(sin) * hz, ez = Math.abs(sin) * hx + Math.abs(cos) * hz;
  return {
    cx: center.x, cy: center.y, cz: center.z, hx, hy, hz, cos, sin,
    minX: center.x - ex, maxX: center.x + ex, minY: center.y - hy, maxY: center.y + hy, minZ: center.z - ez, maxZ: center.z + ez,
  };
}

function pieceObb(p: PieceState): Obb {
  const s = PIECES[p.kind];
  // Ramps are wedges: only the box under the slope's midpoint is surely solid.
  if (p.kind === 'ramp') return obb(add(p.pos, rotateY(v3(0, s.h / 4, s.d / 4), p.rotY)), v3(s.w / 2, s.h / 4, s.d / 4), p.rotY);
  return obb(v3(p.pos.x, p.pos.y + s.h / 2, p.pos.z), v3(s.w / 2, s.h / 2, s.d / 2), p.rotY);
}

/** Does segment a→b pass through the box? (Slab test in the box's local frame; vec.ts rotateY convention.) */
function segmentHits(ax: number, ay: number, az: number, bx: number, by: number, bz: number, o: Obb): boolean {
  if (Math.max(ax, bx) < o.minX || Math.min(ax, bx) > o.maxX || Math.max(ay, by) < o.minY || Math.min(ay, by) > o.maxY
    || Math.max(az, bz) < o.minZ || Math.min(az, bz) > o.maxZ) return false;
  // world → local = rotateY(·, -rotY): x' = x cos - z sin, z' = x sin + z cos
  const px = ax - o.cx, pz = az - o.cz, dx = bx - ax, dz = bz - az;
  const ox = px * o.cos - pz * o.sin, oz = px * o.sin + pz * o.cos;
  const vx = dx * o.cos - dz * o.sin, vz = dx * o.sin + dz * o.cos;
  let t0 = 0, t1 = 1;
  const slab = (origin: number, dir: number, h: number): boolean => {
    if (Math.abs(dir) < 1e-9) return Math.abs(origin) <= h;
    let n = (-h - origin) / dir, f = (h - origin) / dir;
    if (n > f) { const t = n; n = f; f = t; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    return t0 <= t1;
  };
  return slab(ox, vx, o.hx) && slab(ay - o.cy, by - ay, o.hy) && slab(oz, vz, o.hz);
}

const r = (n: number, g: number) => Math.round(n / g) * g;

export class InterestManager {
  private statics: Obb[];
  private pieceBoxes: Obb[] = [];
  private occluders: Obb[] = [];
  private piecesKey = '';
  private latest: Snapshot | null = null;
  /** viewer → target → sim time of the last positive reveal test. */
  private seenAt = new Map<number, Map<number, number>>();
  /** viewer → target → position last sent to that viewer. */
  private lastSent = new Map<number, Map<number, Vec3>>();
  /** Total time spent in apply(), for perf logging. */
  costMs = 0;

  /** `cover`: the map's built-in indestructible cover boxes (they hide players too). */
  constructor(private readonly map: IslandLayout[], cover: Box[] = []) {
    this.statics = [
      ...map.flatMap((isl) => bunkerWallBoxes(isl.bunker).map((b) => obb(b.center, b.half, b.rotY))),
      ...cover.map((b) => obb(b.center, b.half, b.rotY)),
    ];
    this.occluders = this.statics;
  }

  /** The full-resolution snapshot that the next apply() calls describe. */
  update(snap: Snapshot): void {
    this.latest = snap;
    const key = snap.pieces.map((p) => p.id).join(',');
    if (key !== this.piecesKey) {
      this.piecesKey = key;
      this.pieceBoxes = snap.pieces.map(pieceObb);
      this.occluders = [...this.statics, ...this.pieceBoxes];
    }
  }

  /** Redact `net` (from SnapshotEncoder.take(viewerId)) to what viewerId's player could perceive. */
  apply(viewerId: number, net: NetSnapshot): NetSnapshot {
    const t0 = performance.now();
    const s = this.latest;
    if (!s) throw new Error('InterestManager.apply: update() was never called');
    const me = s.players.find((p) => p.id === viewerId);
    if (!me) throw new Error(`InterestManager.apply: no player ${viewerId} in snapshot`);
    const seen = this.mapFor(this.seenAt, viewerId);
    const sent = this.mapFor(this.lastSent, viewerId);
    const omniscient = me.eliminated || s.winner !== null;
    const eye = v3(me.pos.x, me.pos.y + PLAYER.eyeHeight, me.pos.z);

    for (const p of s.players) if (p.id !== viewerId && (omniscient || this.perceives(me, eye, p))) seen.set(p.id, s.time);

    // You know who just shot at / hurt you.
    for (const e of net.events) {
      const d = e.data;
      if (e.type === 'hit' && d.target === viewerId && typeof d.by === 'number') seen.set(d.by, s.time);
      if (e.type === 'shot' && typeof d.by === 'number' && d.by !== viewerId && this.nearMiss(d.from, d.to, eye)) seen.set(d.by, s.time);
    }

    const revealed = (id: unknown) => id === viewerId || (typeof id === 'number' && s.time - (seen.get(id) ?? -Infinity) <= INTEREST.graceSec);
    const hidden: number[] = [];
    const players = net.players.map((p): NetPlayer => {
      if (revealed(p.id)) { sent.set(p.id, p.pos); return p; }
      hidden.push(p.id);
      return this.redact(p, sent);
    });

    const out: NetSnapshot = {
      ...net,
      players,
      events: this.filterEvents(net.events, viewerId, eye, revealed),
      generators: net.generators.map((g) => (g.island === me.island || Math.hypot(this.map[g.island].generator.x - me.pos.x, this.map[g.island].generator.z - me.pos.z) <= INTEREST.generatorRevealM
        ? g : { island: g.island, stored: 0 })),
      loot: net.loot.map((b) => ({ ...b, inv: emptyInventory() })),
    };
    if (hidden.length) out.hidden = hidden;
    else delete out.hidden;
    this.costMs += performance.now() - t0;
    return out;
  }

  /** Viewer left: forget its state. */
  forget(viewerId: number): void {
    this.seenAt.delete(viewerId);
    this.lastSent.delete(viewerId);
  }

  private mapFor<T>(m: Map<number, Map<number, T>>, id: number): Map<number, T> {
    let x = m.get(id);
    if (!x) { x = new Map(); m.set(id, x); }
    return x;
  }

  private perceives(me: PlayerState, eye: Vec3, t: PlayerState): boolean {
    const dx = t.pos.x - me.pos.x, dz = t.pos.z - me.pos.z;
    if (Math.hypot(dx, t.pos.y - me.pos.y, dz) <= INTEREST.nearRadius) return true;
    const len = Math.hypot(dx, dz) || 1;
    // Unit vector across the line of sight (horizontal), for lean / body-width samples.
    const sx = -dz / len, sz = dx / len;
    const L = INTEREST.leadSec;
    const eyes: Vec3[] = [
      eye,
      v3(eye.x + me.vel.x * L, eye.y, eye.z + me.vel.z * L),
      v3(eye.x + sx * INTEREST.leanM, eye.y, eye.z + sz * INTEREST.leanM),
      v3(eye.x - sx * INTEREST.leanM, eye.y, eye.z - sz * INTEREST.leanM),
    ];
    const at = (x: number, y: number, z: number) => v3(t.pos.x + x, t.pos.y + y, t.pos.z + z);
    const w = INTEREST.bodySideM;
    const body: Vec3[] = [
      at(0, 1.2, 0), at(0, 1.7, 0), at(0, 0.4, 0), at(sx * w, 1.2, sz * w), at(-sx * w, 1.2, -sz * w),
      at(t.vel.x * L, 1.2, t.vel.z * L),
    ];
    // Broad phase: only boxes overlapping the bounds of every sample ray matter for this pair.
    const pts = [...eyes, ...body];
    const lo = (k: 'x' | 'y' | 'z') => Math.min(...pts.map((p) => p[k])), hi = (k: 'x' | 'y' | 'z') => Math.max(...pts.map((p) => p[k]));
    const [x0, y0, z0, x1, y1, z1] = [lo('x'), lo('y'), lo('z'), hi('x'), hi('y'), hi('z')];
    const near = this.occluders.filter((o) => o.maxX >= x0 && o.minX <= x1 && o.maxY >= y0 && o.minY <= y1 && o.maxZ >= z0 && o.minZ <= z1);
    if (near.length === 0) return true;
    for (const b of body) for (const e of eyes) if (clear(e, b, near)) return true;
    return false;
  }

  /** Does the tracer from→to pass within nearMissM of the eye? */
  private nearMiss(from: unknown, to: unknown, eye: Vec3): boolean {
    if (!isVec(from) || !isVec(to)) return false;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const l2 = dx * dx + dy * dy + dz * dz;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((eye.x - from.x) * dx + (eye.y - from.y) * dy + (eye.z - from.z) * dz) / l2)) : 0;
    return Math.hypot(from.x + dx * k - eye.x, from.y + dy * k - eye.y, from.z + dz * k - eye.z) <= INTEREST.nearMissM;
  }

  private filterEvents(events: MatchEvent[], viewerId: number, eye: Vec3, revealed: (id: unknown) => boolean): MatchEvent[] {
    const out: MatchEvent[] = [];
    for (const e of events) {
      const d = e.data;
      if (e.type === 'shot') {
        if (revealed(d.by)) { out.push(e); continue; }
        if (!isVec(d.from) || Math.hypot(d.from.x - eye.x, d.from.y - eye.y, d.from.z - eye.z) > INTEREST.hearShotRadius) continue;
        const g = INTEREST.coarseGrid;
        out.push({ t: e.t, type: 'shot', data: { by: null, weapon: d.weapon, from: v3(r(d.from.x, g), r(d.from.y, g), r(d.from.z, g)) } });
      } else if (e.type === 'hit') {
        if (d.target === viewerId || d.by === viewerId || revealed(d.target)) out.push(e);
      } else if (e.type === 'dry') {
        if (revealed(d.by)) out.push(e);
      } else if (e.type === 'pieceHit' && !revealed(d.by)) {
        out.push({ ...e, data: { ...d, by: null } });
      } else {
        out.push(e);
      }
    }
    return out;
  }

  private redact(p: NetPlayer, sent: Map<number, Vec3>): NetPlayer {
    let pos = sent.get(p.id);
    if (!pos) {
      const b = this.map[p.island]?.bunker.center;
      pos = b ? v3(b.x, this.map[p.island].groundY, b.z) : v3(0, -50, 0);
      sent.set(p.id, pos);
    }
    return {
      ...p, pos, vel: v3(), yaw: 0, pitch: 0, hp: PLAYER.hp, equipped: 'fists', selected: 0, healAt: null,
      reloadUntil: 0, nextFireAt: 0, busyUntil: 0, invulnUntil: 0, lastDamagedAt: 0, breakoutUntil: null,
      shield: 0, drinking: null, healLeft: 0, speedUntil: 0, reloadSec: 0, reloadMag: 0, ads: false,
    };
  }
}

const isVec = (x: unknown): x is Vec3 =>
  typeof x === 'object' && x !== null && typeof (x as Vec3).x === 'number' && typeof (x as Vec3).y === 'number' && typeof (x as Vec3).z === 'number';

function clear(a: Vec3, b: Vec3, occluders: Obb[]): boolean {
  for (const o of occluders) if (segmentHits(a.x, a.y, a.z, b.x, b.y, b.z, o)) return false;
  return true;
}
