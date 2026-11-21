import RAPIER from '@dimforge/rapier3d-compat';
import { CHARGE, GRENADE, PIECES, PLAYER } from '../../sim/constants';
import { bunkerWallBoxes, type MapDef } from '../../sim/map';
import { CENTER_PROP_HALF, centerPropYaw, PROP_HALF } from '../../sim/physics';
import type { PieceState, Vec3 } from '../../sim/types';
import { DEBRIS_SPEC, type DebrisSpawn, quayFrame, toWorld } from './debrisPlace';

/**
 * Client-only cosmetic physics for tier-B debris (bottles, cans, small boxes, cones, planks, buoys). A separate
 * Rapier world with gravity, colliding with the static map, built pieces and kinematic player capsules. It never
 * feeds back into the sim: no sim state, nothing blocks players or bullets, no seal/support effects, and online
 * clients may disagree harmlessly.
 *
 * Budget: every prop starts FROZEN (no body; its pose is just a matrix). A prop gets a rigid body only when something
 * disturbs it (a player walks into it, a shot or blast near it); at most `cap` bodies exist, nearest-to-camera first,
 * and a body that has slept for a moment is frozen again. Displaced props respawn at home once nobody is near.
 */
export type Pose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
type Prop = {
  spawn: DebrisSpawn;
  pose: Pose;
  body: RAPIER.RigidBody | null;
  /** seconds the body has been asleep (frozen once it reaches FREEZE_AFTER) */
  sleepT: number;
  /** pose changed since the renderer last read it */
  dirty: boolean;
  /** sank out of sight: hidden until respawn */
  sunk: boolean;
  moved: boolean;
};

export type DebrisOptions = { cap?: number; respawnDist?: number };

const STEP = 1 / 60;
const FREEZE_AFTER = 0.8;
const CELL = 4;
const CAPSULE_HALF = (PLAYER.height - 2 * PLAYER.radius) / 2;
const MAX_PLAYERS = 16;

const quatY = (r: number) => ({ x: 0, y: Math.sin(r / 2), z: 0, w: Math.cos(r / 2) });

let ready: Promise<void> | null = null;

export class DebrisSim {
  readonly props: Prop[];
  readonly cap: number;
  readonly respawnDist: number;
  private world: RAPIER.World;
  private acc = 0;
  private active = new Set<number>();
  private grid = new Map<number, number[]>();
  private cellOf: number[];
  private pieceCols = new Map<number, RAPIER.Collider>();
  private players: RAPIER.RigidBody[] = [];
  private respawnT = 0;
  /** CPU-side wave height hook (the waves agent supplies one); default flat water at `waterY`. */
  waveHeight: (x: number, z: number, t: number) => number = () => 0;
  private time = 0;
  /** stats (debug/tests) */
  readonly stats = { activations: 0, evictions: 0, respawns: 0, frozen: 0 };

  static async create(def: MapDef, spawns: DebrisSpawn[], o: DebrisOptions = {}) {
    await (ready ??= RAPIER.init());
    return new DebrisSim(def, spawns, o);
  }

  private constructor(def: MapDef, spawns: DebrisSpawn[], o: DebrisOptions) {
    this.cap = o.cap ?? 150;
    this.respawnDist = o.respawnDist ?? 30;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.buildStatics(def);
    this.props = spawns.map((s) => {
      const q = quatY(s.yaw);
      return { spawn: s, pose: { x: s.x, y: s.y, z: s.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w }, body: null, sleepT: 0, dirty: true, sunk: false, moved: false };
    });
    this.cellOf = this.props.map(() => NaN);
    this.props.forEach((_, i) => this.regrid(i));
  }

  private buildStatics(def: MapDef) {
    const w = this.world;
    const box = (c: Vec3, h: Vec3, rotY: number) =>
      w.createCollider(RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(c.x, c.y, c.z).setRotation(quatY(rotY)).setFriction(0.8));
    const disc = (c: Vec3, r: number, top: number) =>
      w.createCollider(RAPIER.ColliderDesc.cylinder(3, r).setTranslation(c.x, top - 3, c.z).setFriction(0.8));
    const n = def.islands.length;
    for (const isl of def.islands) {
      disc(isl.center, isl.radius, isl.groundY);
      for (const b of bunkerWallBoxes(isl.bunker)) box(b.center, b.half, b.rotY);
      for (const key of ['generator', 'vault', 'shop'] as const) {
        const p = isl[key], h = PROP_HALF[key];
        box({ x: p.x, y: p.y + h.y, z: p.z }, h, isl.bunker.facingYaw);
      }
      // backdrop quay deck (80 m deep behind the front edge), a solid slab down to the sea floor
      const f = quayFrame(isl, n);
      const c = toWorld(isl, 0, f.z0 + 40);
      box({ x: c.x, y: f.top - 4, z: c.z }, { x: f.hw, y: 4, z: 40 }, isl.bunker.facingYaw);
    }
    const c = def.center;
    disc(c.center, c.radius, c.groundY);
    for (const key of ['goldGen', 'supplyGen', 'potionShop'] as const) {
      const p = c[key], h = CENTER_PROP_HALF[key];
      box({ x: p.x, y: p.y + h.y, z: p.z }, h, centerPropYaw(p, c.center));
    }
    for (const s of def.statics) box(s.center, s.half, s.rotY);
  }

  // ------------------------------------------------------------------ spatial grid (frozen + active poses)

  private key(x: number, z: number) { return (Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096); }

  private regrid(i: number) {
    const p = this.props[i].pose, k = this.key(p.x, p.z), old = this.cellOf[i];
    if (old === k) return;
    if (!Number.isNaN(old)) { const a = this.grid.get(old)!; a.splice(a.indexOf(i), 1); }
    let a = this.grid.get(k);
    if (!a) { a = []; this.grid.set(k, a); }
    a.push(i);
    this.cellOf[i] = k;
  }

  /** Indices of props whose pose lies within `r` (XZ) of (x, z). */
  near(x: number, z: number, r: number, out: number[] = []): number[] {
    out.length = 0;
    const c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL), d0 = Math.floor((z - r) / CELL), d1 = Math.floor((z + r) / CELL);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
      const a = this.grid.get((cx + 4096) * 8192 + (cz + 4096));
      if (!a) continue;
      for (const i of a) { const p = this.props[i].pose; if ((p.x - x) ** 2 + (p.z - z) ** 2 <= r * r) out.push(i); }
    }
    return out;
  }

  // ------------------------------------------------------------------ activation budget

  get activeCount() { return this.active.size; }
  get awakeCount() { let n = 0; for (const i of this.active) if (!this.props[i].body!.isSleeping()) n++; return n; }

  /** Give prop `i` a rigid body (evicting the least important body when at the cap). Returns success. */
  activate(i: number, focus: Vec3): boolean {
    const p = this.props[i];
    if (p.body) { p.body.wakeUp(); p.sleepT = 0; return true; }
    if (p.sunk) return false;
    if (this.active.size >= this.cap) {
      const dMe = this.dist2(p.pose, focus);
      let worst = -1, worstScore = -Infinity;
      for (const j of this.active) {
        const q = this.props[j];
        // sleeping bodies go first, then the farthest from the camera
        const score = this.dist2(q.pose, focus) + (q.body!.isSleeping() ? 1e9 : 0);
        if (score > worstScore) { worstScore = score; worst = j; }
      }
      if (worst < 0 || (worstScore < 1e9 && worstScore <= dMe)) return false;
      this.freeze(worst);
      this.stats.evictions++;
    }
    const s = DEBRIS_SPEC[p.spawn.kind], o = p.pose;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(o.x, o.y, o.z).setRotation({ x: o.qx, y: o.qy, z: o.qz, w: o.qw })
      .setLinearDamping(0.05).setAngularDamping(s.shape === 'box' ? 0.3 : 1.2).setCcdEnabled(s.half[1] < 0.05 || s.half[0] < 0.05));
    const [hx, hy, hz] = s.half;
    const desc = s.shape === 'box' ? RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      : s.shape === 'cyl' ? RAPIER.ColliderDesc.cylinder(hy, hx)
        : s.shape === 'cone' ? RAPIER.ColliderDesc.cone(hy, hx)
          : RAPIER.ColliderDesc.ball(hx);
    const vol = s.shape === 'box' ? 8 * hx * hy * hz : s.shape === 'ball' ? (4 / 3) * Math.PI * hx ** 3 : Math.PI * hx * hx * 2 * hy * (s.shape === 'cone' ? 1 / 3 : 1);
    desc.setDensity(s.mass / vol).setFriction(0.7).setRestitution(s.shape === 'ball' ? 0.45 : 0.2);
    this.world.createCollider(desc, body);
    p.body = body;
    p.sleepT = 0;
    this.active.add(i);
    this.stats.activations++;
    return true;
  }

  /** Drop prop `i`'s body, keeping its pose as a plain matrix. */
  freeze(i: number) {
    const p = this.props[i];
    if (!p.body) return;
    this.readPose(p);
    this.world.removeRigidBody(p.body);
    p.body = null;
    this.active.delete(i);
    this.regrid(i);
    this.stats.frozen++;
  }

  private dist2(a: { x: number; z: number }, b: { x: number; z: number }) { return (a.x - b.x) ** 2 + (a.z - b.z) ** 2; }

  private readPose(p: Prop) {
    const t = p.body!.translation(), r = p.body!.rotation(), o = p.pose;
    if (o.x !== t.x || o.y !== t.y || o.z !== t.z || o.qx !== r.x || o.qy !== r.y || o.qz !== r.z || o.qw !== r.w) {
      o.x = t.x; o.y = t.y; o.z = t.z; o.qx = r.x; o.qy = r.y; o.qz = r.z; o.qw = r.w;
      p.dirty = true;
      if (!p.moved && (Math.abs(t.x - p.spawn.x) + Math.abs(t.z - p.spawn.z) + Math.abs(t.y - p.spawn.y) > 0.05)) p.moved = true;
    }
  }

  // ------------------------------------------------------------------ world inputs

  /** Built pieces as static colliders (same shapes as the sim's). */
  setPieces(pieces: PieceState[]) {
    const seen = new Set<number>();
    for (const pc of pieces) {
      seen.add(pc.id);
      if (this.pieceCols.has(pc.id)) continue;
      const s = PIECES[pc.kind];
      let desc: RAPIER.ColliderDesc | null;
      if (pc.kind === 'ramp') {
        const w = s.w / 2, d = s.d / 2;
        desc = RAPIER.ColliderDesc.convexHull(new Float32Array([-w, 0, -d, w, 0, -d, -w, 0, d, w, 0, d, -w, s.h, d, w, s.h, d]));
        if (!desc) { console.warn('[debris] ramp hull failed'); continue; }
        desc.setTranslation(pc.pos.x, pc.pos.y, pc.pos.z);
      } else desc = RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(pc.pos.x, pc.pos.y + s.h / 2, pc.pos.z);
      desc.setRotation(quatY(pc.rotY));
      this.pieceCols.set(pc.id, this.world.createCollider(desc));
    }
    for (const [id, c] of this.pieceCols) {
      if (seen.has(id)) continue;
      const t = { ...c.translation() };
      this.world.removeCollider(c, true);
      this.pieceCols.delete(id);
      // whatever rested on the piece must fall now
      for (const i of this.near(t.x, t.z, 3)) this.activate(i, t);
    }
  }

  private tmp: number[] = [];

  /** Radial blast: wakes and flings everything within ~1.6 × the gameplay radius. */
  explosion(pos: Vec3, kind: string, focus: Vec3 = pos) {
    const r = (kind === 'grenade' ? GRENADE.radius : kind === 'charge' ? CHARGE.radius + 1 : 3) * 1.6;
    for (const i of this.near(pos.x, pos.z, r, this.tmp).slice()) {
      const p = this.props[i];
      const dx = p.pose.x - pos.x, dy = p.pose.y - pos.y, dz = p.pose.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > r || !this.activate(i, focus)) continue;
      const k = (1 - d / r) * 7 + 1.5; // m/s of kick
      const m = p.body!.mass(), inv = 1 / Math.max(d, 0.2);
      p.body!.applyImpulse({ x: dx * inv * k * m, y: (Math.max(dy * inv, 0) * 0.5 + 0.7) * k * m, z: dz * inv * k * m }, true);
      p.body!.applyTorqueImpulse({ x: (dz * inv) * m * 0.3, y: 0.1 * m, z: (-dx * inv) * m * 0.3 }, true);
    }
  }

  /** A bullet path: knocks props within 0.3 m of it along the shot direction. */
  shot(from: Vec3, to: Vec3, focus: Vec3 = to) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    // walk the path in grid-sized steps (rays can be 100+ m)
    const seen = new Set<number>();
    for (let s = 0; s <= L; s += CELL * 0.75) {
      for (const i of this.near(from.x + ux * s, from.z + uz * s, CELL * 0.75, this.tmp)) seen.add(i);
    }
    for (const i of this.near(to.x, to.z, 0.6, this.tmp)) seen.add(i);
    for (const i of seen) {
      const p = this.props[i].pose;
      const t = Math.max(0, Math.min(L, (p.x - from.x) * ux + (p.y - from.y) * uy + (p.z - from.z) * uz));
      const ex = from.x + ux * t - p.x, ey = from.y + uy * t - p.y, ez = from.z + uz * t - p.z;
      if (ex * ex + ey * ey + ez * ez > 0.09 || !this.activate(i, focus)) continue;
      const b = this.props[i].body!, m = b.mass();
      const k = Math.min(4, 1.2 / Math.max(m, 0.05)) * m + 0.4 * m;
      b.applyImpulseAtPoint({ x: ux * k, y: Math.abs(uy) * k + 0.3 * m, z: uz * k }, { x: p.x - ex * 0.5, y: p.y - ey * 0.5 + 0.02, z: p.z - ez * 0.5 }, true);
    }
  }

  // ------------------------------------------------------------------ frame

  /**
   * Advance by `dt` seconds. `players`: live feet positions (kinematic capsules that shove props); `focus`: the
   * camera (activation priority, respawn visibility); `waterY`: current sea level.
   */
  step(dt: number, focus: Vec3, players: Vec3[], waterY: number) {
    this.time += dt;
    // players: kinematic capsules; anything frozen in reach wakes up so it can be shoved
    for (let k = 0; k < Math.min(players.length, MAX_PLAYERS); k++) {
      let b = this.players[k];
      const f = players[k];
      if (!b) {
        b = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(f.x, f.y + PLAYER.height / 2, f.z));
        this.world.createCollider(RAPIER.ColliderDesc.capsule(CAPSULE_HALF, PLAYER.radius), b);
        this.players[k] = b;
      }
      b.setNextKinematicTranslation({ x: f.x, y: f.y + PLAYER.height / 2, z: f.z });
      for (const i of this.near(f.x, f.z, PLAYER.radius + 0.9, this.tmp)) {
        const p = this.props[i];
        if (!p.body && Math.abs(p.pose.y - f.y - 0.5) < 1.4) this.activate(i, focus);
      }
    }
    for (let k = players.length; k < this.players.length; k++) this.players[k].setNextKinematicTranslation({ x: 0, y: -500 - k * 5, z: 0 });

    this.acc = Math.min(this.acc + dt, STEP * 3);
    while (this.acc >= STEP) {
      this.buoyancy(waterY);
      this.world.step();
      this.acc -= STEP;
    }
    for (const i of [...this.active]) {
      const p = this.props[i], b = p.body!;
      this.readPose(p);
      this.regrid(i);
      this.rollingResistance(b);
      const surface = waterY + this.waveHeight(p.pose.x, p.pose.z, this.time);
      if (p.pose.y < surface - 2.5) { // gone under for good
        this.freeze(i);
        p.sunk = true; p.dirty = true;
        continue;
      }
      // Rapier sleep, or nearly still (round shapes on their side can rock/roll for ages: no rolling friction)
      const v = b.linvel(), w = b.angvel();
      const still = b.isSleeping() || (v.x * v.x + v.y * v.y + v.z * v.z < 0.05 && w.x * w.x + w.y * w.y + w.z * w.z < 1.5);
      const dry = p.pose.y - DEBRIS_SPEC[p.spawn.kind].half[1] > surface + 0.02;
      // slow-but-rocking bodies (a cone on its side) also count down, 4× slower, so nothing jitters forever
      const slow = v.x * v.x + v.y * v.y + v.z * v.z < 0.3;
      if (dry && (still || slow)) {
        p.sleepT += still ? dt : dt * 0.25;
        if (p.sleepT >= FREEZE_AFTER) this.freeze(i);
      } else p.sleepT = 0;
    }
    this.respawnT += dt;
    if (this.respawnT >= 1) { this.respawnT = 0; this.respawnFar(focus, players); }
  }

  /** Rapier has no rolling friction: slow tumbling/rolling bodies are bled down so they come to rest. */
  private rollingResistance(b: RAPIER.RigidBody) {
    const v = b.linvel(), w = b.angvel();
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z, w2 = w.x * w.x + w.y * w.y + w.z * w.z;
    if (v2 > 0.5 || w2 > 400 || Math.abs(v.y) > 0.3) return;
    b.setLinvel({ x: v.x * 0.9, y: v.y, z: v.z * 0.9 }, false);
    b.setAngvel({ x: w.x * 0.9, y: w.y * 0.9, z: w.z * 0.9 }, false);
  }

  /** Floating kinds bob at the surface; sinkers drift down slowly. */
  private buoyancy(waterY: number) {
    for (const i of this.active) {
      const p = this.props[i], b = p.body!, s = DEBRIS_SPEC[p.spawn.kind];
      const t = b.translation();
      const surface = waterY + this.waveHeight(t.x, t.z, this.time);
      const depth = surface - (t.y - s.half[1]);
      if (depth <= 0) continue;
      const sub = Math.min(1, depth / (2 * s.half[1]));
      const m = b.mass();
      b.applyImpulse({ x: 0, y: 9.81 * m * s.float * sub * STEP, z: 0 }, true);
      const v = b.linvel(), w = b.angvel();
      // water drag
      b.setLinvel({ x: v.x * (1 - 1.5 * STEP), y: v.y * (1 - 3 * STEP * sub), z: v.z * (1 - 1.5 * STEP) }, true);
      b.setAngvel({ x: w.x * (1 - 2 * STEP), y: w.y * (1 - 2 * STEP), z: w.z * (1 - 2 * STEP) }, true);
    }
  }

  /** Displaced or sunk props snap home once no player or camera is within `respawnDist` of either spot. */
  private respawnFar(focus: Vec3, players: Vec3[]) {
    const r2 = this.respawnDist * this.respawnDist;
    const clear = (x: number, z: number) => this.dist2({ x, z }, focus) > r2 && players.every((f) => this.dist2({ x, z }, f) > r2);
    this.props.forEach((p, i) => {
      if (!p.moved && !p.sunk) return;
      if (p.body && !p.body.isSleeping() && !p.sunk) return;
      if (!clear(p.pose.x, p.pose.z) || !clear(p.spawn.x, p.spawn.z)) return;
      if (p.body) this.freeze(i);
      const q = quatY(p.spawn.yaw);
      Object.assign(p.pose, { x: p.spawn.x, y: p.spawn.y, z: p.spawn.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
      p.sunk = false; p.moved = false; p.dirty = true;
      this.regrid(i);
      this.stats.respawns++;
    });
  }

  /** Nearest prop to a point (debug / screenshot harness). */
  nearest(x: number, z: number): Prop | null {
    let best: Prop | null = null, bd = Infinity;
    for (const r of [4, 12, 40]) {
      for (const i of this.near(x, z, r, this.tmp)) { const p = this.props[i]; const d = this.dist2(p.pose, { x, z }); if (d < bd && !p.sunk) { bd = d; best = p; } }
      if (best) return best;
    }
    return best;
  }

  dispose() { this.world.free(); }
}
