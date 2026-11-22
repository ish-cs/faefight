import RAPIER from '@dimforge/rapier3d-compat';
import { CHARGE, GRENADE, PLAYER, ROCKET, WEAPONS } from './constants';
import type { CenterIsland, IslandLayout } from './map';
import type { Physics, PropPush } from './physics';
import { boxesOverlap, type NoBuildZone } from './propZones';
import { stepWorld } from './rapierStep';
import type { MatchEvent, PieceState, PlayerState, Vec3, WeaponKind } from './types';
import { add, dist2D, v3 } from './vec';
import { inBunkerArea, PROP_KINDS, PROPS, type PropKind, type PropPose, type PropSpawn, propZones, type Quat } from './propPlace';

export * from './propPlace';

/**
 * Tier A gameplay props: crates, oil drums, pallets, IBC tanks, cable reels and tyres as real rigid bodies, owned by
 * the authoritative sim. Players stand and jump on them (the character controller sees a fixed mirror collider in the
 * query world, see Physics.setPropPose), push them by walking into them (slower for heavy kinds), and shots and
 * explosions knock them around. They float or sink in the water and go back to their spawn after a while.
 *
 * Rules safety: props are never building pieces (seal.ts and support.ts only ever look at pieces), they are not
 * ground for building or support (Physics.probeDown skips them), and any prop that ends up in a bunker interior,
 * a doorway or a no-build zone is put back at its spawn (or pushed out while someone stands on its spawn).
 *
 * Determinism: a separate Rapier world with gravity, stepped once per sim tick at DT, seeded placement, no
 * Math.random; every operation happens in tick order, so replays reproduce the same poses.
 *
 * Hazards hook (not wired yet): a hazard (e.g. an explosive barrel) can become a pushable body by being added
 * as one more PropSpawn with its own kind entry in PROP_KINDS; PropSim only needs kind, rest pose and mass.
 */

export function propColliderDesc(kind: PropKind): RAPIER.ColliderDesc {
  const s = PROP_KINDS[kind].shape;
  return 'box' in s ? RAPIER.ColliderDesc.cuboid(s.box.x, s.box.y, s.box.z) : RAPIER.ColliderDesc.cylinder(s.cyl.h, s.cyl.r);
}


/** A placed piece's collider in the props world, as plain data (rebuilt identically on every canonical rebuild). */
export type PieceShape = { id: number; t: [number, number, number]; r: [number, number, number, number]; cuboid?: [number, number, number]; hull?: number[] };

/**
 * Everything one PropSim tick consumes, recorded since the last canonical rebuild (see `canonicalize`). Players are
 * [id, x, y, z] quads (float64: exactly the sim's numbers); `place` = a debugPlace between ticks.
 */
type Step =
  | { now: number; waterY: number; players: Float64Array; pushes: PropPush[]; blasts: [Vec3, number][]; shots: [Vec3, Vec3, WeaponKind][]; addPieces: PieceShape[]; delPieces: number[] }
  | { place: number; pos: Vec3 };

/**
 * The props world at a canonical rebuild, as plain data: per live prop 14 float32 (pos 3, rot 4, linvel 3, angvel 3,
 * asleep 1) and 2 float64 (lastActive, wetSince or NaN); pieces; kinematic player capsules [id, x, y, z].
 */
type Canon = { bodies: Float32Array; meta: Float64Array; pieces: PieceShape[]; players: Float64Array };

/**
 * PropSim.save(): compact and deterministic. The canonical state at the last rebuild plus the steps since; load
 * rebuilds the world from the map's static colliders + that state and re-runs the steps, so the restored sim is
 * bit-identical to the original (no Rapier snapshot: its contact graph was ~75 KB gzipped).
 */
export type PropSimSave = {
  islands: IslandLayout[]; zones: NoBuildZone[]; spawns: PropSpawn[]; rest: Float32Array; dt: number;
  canon: Canon; log: Step[];
};

/** Canonical rebuild cadence (sim ticks): bounds a checkpoint's step log. */
export const PROP_CANON_TICKS = 15;
/** Zero-gravity, held-still steps that let a rebuilt world find its contact pairs. */
const PRIME_STEPS = 12;

type Live = {
  spawn: PropSpawn;
  body: RAPIER.RigidBody;
  rest: { pos: Vec3; rot: Quat };
  /** Sim time it was last awake (moving), and when it went into the water (null = dry). */
  lastActive: number;
  wetSince: number | null;
};

const BLAST_R: Record<string, number> = { grenade: GRENADE.radius, charge: CHARGE.radius + 1, rocket: ROCKET.radius };
const SETTLE_STEPS = 90;

/**
 * The props' dynamics world: the same static colliders as the query world (copied from Physics), placed pieces,
 * players as kinematic capsules (props bump into them, never into gameplay), and one dynamic body per prop.
 */
export class PropSim {
  private world: RAPIER.World;
  private live: Live[] = [];
  private byHandle = new Map<number, Live>();
  private pieceCols = new Map<number, RAPIER.Collider>();
  private playerBodies = new Map<number, RAPIER.RigidBody>();
  private zones: NoBuildZone[];
  private canon!: Canon;
  private log: Step[] = [];

  constructor(private readonly physics: Physics, private readonly islands: IslandLayout[], center: CenterIsland, spawns: PropSpawn[], dt: number) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = dt;
    this.zones = propZones({ islands, center });
    physics.forEachStaticCollider((shape, pos, rot) => {
      this.world.createCollider(new RAPIER.ColliderDesc(shape).setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    });
    for (const s of spawns) {
      const k = PROP_KINDS[s.kind];
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(s.pos.x, s.pos.y, s.pos.z)
        .setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] })
        .setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(true));
      const col = this.world.createCollider(propColliderDesc(s.kind).setMass(k.mass).setFriction(0.7).setRestitution(0.1), body);
      const l: Live = { spawn: s, body, rest: { pos: s.pos, rot: s.rot }, lastActive: 0, wetSince: null };
      this.live.push(l);
      this.byHandle.set(col.handle, l);
    }
    // Settle onto the ground once at match start: the rest pose is where each prop really lies.
    for (let i = 0; i < SETTLE_STEPS; i++) stepWorld(this.world);
    for (const l of this.live) {
      l.rest = this.poseOf(l.body);
      l.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      l.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      l.body.sleep();
      this.mirror(l);
    }
    physics.recordPushes = true;
    this.canonicalize();
  }

  get count() { return this.live.length; }

  /**
   * An independent copy (Match.fork: replay checkpoints) bound to `physics`, the forked query world: the dynamics
   * world is snapshotted and every body/collider handle re-resolved in the copy.
   */
  clone(physics: Physics): PropSim {
    const world = RAPIER.World.restoreSnapshot(this.world.takeSnapshot());
    if (!world) throw new Error('PropSim.clone: Rapier could not restore the prop world snapshot');
    const body = (b: RAPIER.RigidBody) => {
      const c = world.getRigidBody(b.handle);
      if (!c) throw new Error(`PropSim.clone: body ${b.handle} missing from the snapshot`);
      return c;
    };
    const col = (c: RAPIER.Collider) => {
      const x = world.getCollider(c.handle);
      if (!x) throw new Error(`PropSim.clone: collider ${c.handle} missing from the snapshot`);
      return x;
    };
    const p = Object.create(PropSim.prototype) as PropSim;
    const q = p as unknown as Record<string, unknown>, self = this as unknown as Record<string, unknown>;
    q.physics = physics;
    q.islands = this.islands;
    q.zones = this.zones;
    q.world = world;
    const remap = new Map<Live, Live>();
    q.live = this.live.map((l) => {
      const n: Live = { spawn: l.spawn, body: body(l.body), rest: { pos: { ...l.rest.pos }, rot: [...l.rest.rot] as Quat }, lastActive: l.lastActive, wetSince: l.wetSince };
      remap.set(l, n);
      return n;
    });
    q.byHandle = new Map([...this.byHandle].map(([h, l]) => [h, remap.get(l)!]));
    q.pieceCols = new Map([...this.pieceCols].map(([id, c]) => [id, col(c)]));
    q.playerBodies = new Map([...this.playerBodies].map(([id, b]) => [id, body(b)]));
    // any other (plain) fields added later: copied by value
    for (const k of Object.keys(self)) if (!(k in q)) q[k] = structuredClone(self[k]);
    return p;
  }

  /**
   * Rebuild the props world from plain state: the query world's static colliders, the pieces, the props (pose,
   * velocities, sleep), the player capsules, always in the same order. The original does this every
   * PROP_CANON_TICKS ticks and a checkpoint restore does it once, so both continue from an identical Rapier world
   * (fresh contact cache, same handles).
   */
  canonicalize() {
    const c = this.capture();
    this.rebuild(c);
    this.canon = c;
    this.log = [];
  }

  private capture(): Canon {
    const bodies = new Float32Array(this.live.length * 14), meta = new Float64Array(this.live.length * 2);
    this.live.forEach((l, i) => {
      const t = l.body.translation(), r = l.body.rotation(), v = l.body.linvel(), w = l.body.angvel();
      bodies.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z, l.body.isSleeping() ? 1 : 0], i * 14);
      meta[i * 2] = l.lastActive;
      meta[i * 2 + 1] = l.wetSince ?? NaN;
    });
    const pieces = [...this.pieceCols.keys()].sort((a, b) => a - b).map((id) => shapeOf(id, this.pieceCols.get(id)!));
    const ids = [...this.playerBodies.keys()].sort((a, b) => a - b);
    const players = new Float64Array(ids.length * 4);
    ids.forEach((id, i) => { const t = this.playerBodies.get(id)!.translation(); players.set([id, t.x, t.y, t.z], i * 4); });
    return { bodies, meta, pieces, players };
  }

  private rebuild(c: Canon) {
    const dt = this.world.timestep;
    this.world.free();
    const world = this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = dt;
    this.physics.forEachStaticCollider((shape, pos, rot) => {
      world.createCollider(new RAPIER.ColliderDesc(shape).setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    });
    this.pieceCols = new Map();
    for (const ps of c.pieces) this.pieceCols.set(ps.id, world.createCollider(pieceDesc(ps)));
    this.byHandle = new Map();
    this.live.forEach((l, i) => {
      const b = c.bodies.subarray(i * 14, i * 14 + 14);
      const k = PROP_KINDS[l.spawn.kind];
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b[0], b[1], b[2]).setRotation({ x: b[3], y: b[4], z: b[5], w: b[6] })
        .setLinvel(b[7], b[8], b[9]).setAngvel({ x: b[10], y: b[11], z: b[12] })
        .setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(true));
      const col = world.createCollider(propColliderDesc(l.spawn.kind).setMass(k.mass).setFriction(0.7).setRestitution(0.1), body);
      l.body = body;
      l.lastActive = c.meta[i * 2];
      l.wetSince = Number.isNaN(c.meta[i * 2 + 1]) ? null : c.meta[i * 2 + 1];
      this.byHandle.set(col.handle, l);
    });
    // Prime the fresh world's broad/narrow phase (a new world finds its contact pairs only during steps): step it with
    // no gravity and every body held still, then put velocities and sleep back. Same in the original and a restore.
    world.gravity = { x: 0, y: 0, z: 0 };
    for (const l of this.live) { l.body.wakeUp(); l.body.setLinvel({ x: 0, y: 0, z: 0 }, false); l.body.setAngvel({ x: 0, y: 0, z: 0 }, false); }
    for (let k = 0; k < PRIME_STEPS; k++) {
      stepWorld(world);
      for (const l of this.live) { l.body.setLinvel({ x: 0, y: 0, z: 0 }, false); l.body.setAngvel({ x: 0, y: 0, z: 0 }, false); }
    }
    world.gravity = { x: 0, y: -9.81, z: 0 };
    this.live.forEach((l, i) => {
      const b = c.bodies.subarray(i * 14, i * 14 + 14);
      l.body.setLinvel({ x: b[7], y: b[8], z: b[9] }, false);
      l.body.setAngvel({ x: b[10], y: b[11], z: b[12] }, false);
      if (b[13]) l.body.sleep(); else l.body.wakeUp();
    });
    // player capsules after priming: they must not shove props during the held-still steps
    this.playerBodies = new Map();
    for (let i = 0; i < c.players.length; i += 4) {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(c.players[i + 1], c.players[i + 2], c.players[i + 3]));
      world.createCollider(playerCapsule(), b);
      this.playerBodies.set(c.players[i], b);
    }
  }

  /** Host-migration checkpoint (net/matchCheckpoint.ts): see PropSimSave. `PropSim.load` is the inverse. */
  save(): PropSimSave {
    const rest = new Float32Array(this.live.length * 7);
    this.live.forEach((l, i) => rest.set([l.rest.pos.x, l.rest.pos.y, l.rest.pos.z, ...l.rest.rot], i * 7));
    return {
      islands: this.islands, zones: this.zones, spawns: this.live.map((l) => l.spawn), rest, dt: this.world.timestep,
      canon: this.canon, log: this.log,
    };
  }

  /** Inverse of save(), bound to the restored query world. RAPIER must be initialised (Physics.load does it). */
  static load(physics: Physics, s: PropSimSave): PropSim {
    const p = Object.create(PropSim.prototype) as PropSim;
    const q = p as unknown as Record<string, unknown>;
    q.physics = physics;
    q.islands = s.islands;
    q.zones = s.zones;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = s.dt;
    q.world = world;
    q.live = s.spawns.map((spawn, i) => {
      const r = s.rest.subarray(i * 7, i * 7 + 7);
      return { spawn, body: null, rest: { pos: v3(r[0], r[1], r[2]), rot: [r[3], r[4], r[5], r[6]] as Quat }, lastActive: 0, wetSince: null };
    });
    q.byHandle = new Map(); q.pieceCols = new Map(); q.playerBodies = new Map();
    p.rebuild(s.canon);
    q.canon = s.canon;
    // re-run the steps since the canonical rebuild; the query world's mirrors end where the original's are, and its
    // pending-sync flag is put back (the replayed intermediate poses would otherwise mark it dirty)
    const pending = physics.syncPending;
    const steps = s.log;
    q.log = [];
    for (const st of steps) p.run(st);
    physics.syncPending = pending;
    return p;
  }

  private poseOf(b: RAPIER.RigidBody): { pos: Vec3; rot: Quat } {
    const t = b.translation(), r = b.rotation();
    return { pos: v3(t.x, t.y, t.z), rot: [r.x, r.y, r.z, r.w] };
  }

  private mirror(l: Live) {
    const t = l.body.translation(), r = l.body.rotation();
    this.physics.setPropPose(l.spawn.id, v3(t.x, t.y, t.z), r);
  }

  /** One sim tick, after players moved and explosives went off. `events`: this tick's events (shots, explosions). */
  tick(now: number, players: Iterable<PlayerState>, pieces: Map<number, PieceState>, events: MatchEvent[], waterY: number) {
    const pl: number[] = [];
    for (const x of players) if (x.alive) pl.push(x.id, x.pos.x, x.pos.y, x.pos.z);
    const blasts: [Vec3, number][] = [], shots: [Vec3, Vec3, WeaponKind][] = [];
    for (const e of events) {
      if (e.type === 'explosion' && e.data.pos) blasts.push([{ ...(e.data.pos as Vec3) }, BLAST_R[e.data.kind as string] ?? 3]);
      else if (e.type === 'shot' && e.data.from && e.data.to && e.data.weapon !== 'fists' && WEAPONS[e.data.weapon as WeaponKind]) {
        shots.push([{ ...(e.data.from as Vec3) }, { ...(e.data.to as Vec3) }, e.data.weapon as WeaponKind]);
      }
    }
    const delPieces = [...this.pieceCols.keys()].filter((id) => !pieces.has(id));
    const addPieces: PieceShape[] = [];
    for (const id of pieces.keys()) {
      if (this.pieceCols.has(id)) continue;
      const src = this.physics.pieceCollider(id);
      if (src) addPieces.push(shapeOf(id, src));
    }
    this.run({ now, waterY, players: new Float64Array(pl), pushes: this.physics.takePushes(), blasts, shots, addPieces, delPieces });
    if (this.log.length >= PROP_CANON_TICKS) this.canonicalize();
  }

  /** Apply one recorded step (live ticks and checkpoint restores go through here alike). */
  private run(st: Step) {
    this.log.push(st);
    if ('place' in st) { this.placeNow(st.place, st.pos); return; }
    const { now, waterY } = st;
    for (const id of st.delPieces) { const c = this.pieceCols.get(id); if (c) { this.world.removeCollider(c, true); this.pieceCols.delete(id); } }
    for (const ps of st.addPieces) this.pieceCols.set(ps.id, this.world.createCollider(pieceDesc(ps)));
    this.syncPlayers(st.players);
    for (const push of st.pushes) this.push(push.prop, push.dir, push.speed, push.feetY);
    for (const [pos, r] of st.blasts) this.blast(pos, r);
    for (const [from, to, w] of st.shots) this.shot(from, to, w);
    this.water(now, waterY);
    stepWorld(this.world);
    const alive = [...this.playerBodies.values()].map((b) => b.translation());
    for (const l of this.live) {
      if (!l.body.isSleeping()) l.lastActive = now;
      const t = l.body.translation();
      const pos = v3(t.x, t.y, t.z);
      const nearSpawn = alive.some((p) => dist2D(p, l.rest.pos) < 1.3 && Math.abs(p.y - l.rest.pos.y) < 2);
      const misplaced = inBunkerArea(this.islands, pos) || this.inZone(l, pos);
      const lost = t.y < waterY - 4 || t.y < -30 || (l.wetSince !== null && now - l.wetSince > PROPS.wetRespawnSec);
      const idle = this.displaced(l) && now - l.lastActive > PROPS.idleRespawnSec
        && !alive.some((p) => dist2D(p, pos) < PROPS.idleClearM || dist2D(p, l.rest.pos) < PROPS.idleClearM);
      const spawnDry = l.rest.pos.y - PROP_KINDS[l.spawn.kind].ext.y > waterY + 0.1;
      if ((misplaced || lost || idle) && !nearSpawn && spawnDry) this.respawn(l);
      else if (misplaced) this.eject(l, pos);
      this.mirror(l);
    }
  }

  private inZone(l: Live, pos: Vec3) {
    const e = PROP_KINDS[l.spawn.kind].ext;
    const half = v3(e.x, e.y, e.z), r = Math.hypot(e.x, e.z);
    // Exact early-out (boxesOverlap is a full separating-axis test per zone, for every prop every tick): boxes whose
    // Y ranges or bounding circles don't touch can't overlap, so only the near zones get the real test.
    return this.zones.some((z) => Math.abs(pos.y - z.center.y) < half.y + z.half.y
      && Math.hypot(pos.x - z.center.x, pos.z - z.center.z) <= r + Math.hypot(z.half.x, z.half.z) + 1e-6
      && boxesOverlap(pos, half, 0, z));
  }

  private displaced(l: Live): boolean {
    const p = this.poseOf(l.body);
    const d = Math.hypot(p.pos.x - l.rest.pos.x, p.pos.y - l.rest.pos.y, p.pos.z - l.rest.pos.z);
    const dot = Math.abs(p.rot[0] * l.rest.rot[0] + p.rot[1] * l.rest.rot[1] + p.rot[2] * l.rest.rot[2] + p.rot[3] * l.rest.rot[3]);
    return d > PROPS.posEps || 1 - dot > PROPS.rotEps;
  }

  private respawn(l: Live) {
    const { pos, rot } = l.rest;
    l.body.setTranslation(pos, false);
    l.body.setRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] }, false);
    l.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    l.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    l.body.sleep();
    l.wetSince = null;
  }

  /** Out of a bunker area / zone while its spawn is occupied: slide it outward, away from the bunker or zone centre. */
  private eject(l: Live, pos: Vec3) {
    let from: Vec3 | null = null;
    for (const isl of this.islands) if (dist2D(isl.bunker.center, pos) < PROPS.bunkerHalf * 1.5) from = isl.bunker.center;
    for (const z of this.zones) if (!from && dist2D(z.center, pos) < 4) from = z.center;
    if (!from) return;
    let dx = pos.x - from.x, dz = pos.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
    const v = l.body.linvel();
    l.body.setLinvel({ x: dx * 2.5, y: Math.max(v.y, 0.5), z: dz * 2.5 }, true);
  }

  private syncPlayers(quads: Float64Array) {
    const seen = new Set<number>();
    for (let i = 0; i < quads.length; i += 4) {
      const id = quads[i];
      seen.add(id);
      const c = { x: quads[i + 1], y: quads[i + 2] + PLAYER.height / 2, z: quads[i + 3] };
      let b = this.playerBodies.get(id);
      if (!b) {
        b = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(c.x, c.y, c.z));
        this.world.createCollider(playerCapsule(), b);
        this.playerBodies.set(id, b);
        continue;
      }
      const t = b.translation();
      if (Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z) > 2) b.setTranslation(c, true); // teleport/respawn: no sweep
      else b.setNextKinematicTranslation(c);
    }
    for (const [id, b] of this.playerBodies) if (!seen.has(id)) { this.world.removeRigidBody(b); this.playerBodies.delete(id); }
  }

  /** A player walked into prop `id` along `dir` (unit, horizontal) at `speed` m/s: it slides at a fraction of that. */
  private push(id: number, dir: Vec3, speed: number, feetY: number) {
    const l = this.live[id - 1];
    if (!l) return;
    const k = PROP_KINDS[l.spawn.kind];
    const t = l.body.translation();
    if (t.y + k.ext.y * 0.6 < feetY + 0.3) return; // stepping onto / standing on it, not shoving it
    const v = l.body.linvel();
    const target = speed * k.push;
    const along = v.x * dir.x + v.z * dir.z;
    if (along >= target) return;
    const j = k.mass * (target - along);
    l.body.applyImpulse({ x: dir.x * j, y: 0, z: dir.z * j }, true);
  }

  private blast(pos: Vec3 | undefined, r: number) {
    if (!pos) return;
    for (const l of this.live) {
      const t = l.body.translation();
      const dx = t.x - pos.x, dy = t.y - pos.y, dz = t.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > r + 0.6) continue;
      const k = Math.max(0, 1 - Math.max(0, d - 0.3) / r);
      const m = PROP_KINDS[l.spawn.kind].mass;
      const dv = PROPS.blastDv * k * Math.min(1, Math.sqrt(PROPS.blastRefMass / m));
      let nx = dx, ny = dy + 0.8, nz = dz;
      const n = Math.hypot(nx, ny, nz) || 1;
      nx /= n; ny /= n; nz /= n;
      const j = m * dv;
      // slightly below the centre on the blast side: they tumble, not just slide
      l.body.applyImpulseAtPoint({ x: nx * j, y: ny * j, z: nz * j }, { x: t.x - nx * 0.15, y: t.y - 0.12, z: t.z - nz * 0.15 }, true);
    }
  }

  private shot(from: Vec3 | undefined, to: Vec3 | undefined, weapon: WeaponKind) {
    const w = WEAPONS[weapon];
    if (!from || !to || !w || weapon === 'fists') return;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.world.castRay(new RAPIER.Ray(from, dir), len + 0.3, true, undefined, undefined, undefined, undefined, (c) => this.byHandle.has(c.handle));
    if (!hit) return;
    const l = this.byHandle.get(hit.collider.handle)!;
    const p = { x: from.x + dir.x * hit.timeOfImpact, y: from.y + dir.y * hit.timeOfImpact, z: from.z + dir.z * hit.timeOfImpact };
    const j = w.dmg * w.pellets * PROPS.shotImpulse;
    l.body.applyImpulseAtPoint({ x: dir.x * j, y: dir.y * j, z: dir.z * j }, p, true);
  }

  /** Buoyancy + drag: floaters ride half submerged, the rest sink slowly. */
  private water(now: number, waterY: number) {
    for (const l of this.live) {
      const k = PROP_KINDS[l.spawn.kind];
      const t = l.body.translation();
      const hy = Math.max(k.ext.x, k.ext.y, k.ext.z) * 0.8;
      const frac = Math.min(1, Math.max(0, (waterY - (t.y - hy)) / (2 * hy)));
      if (frac <= 0) { l.wetSince = null; continue; }
      l.wetSince ??= now;
      const lift = (k.floats ? 1.9 : 0.4) * frac;
      const dt = this.world.timestep;
      l.body.applyImpulse({ x: 0, y: k.mass * 9.81 * lift * dt, z: 0 }, frac > 0.95 && k.floats);
      if (l.body.isSleeping()) continue;
      const v = l.body.linvel(), w = l.body.angvel();
      const drag = Math.max(0, 1 - 2.5 * frac * dt), spin = Math.max(0, 1 - 1.5 * frac * dt);
      l.body.setLinvel({ x: v.x * drag, y: v.y * drag, z: v.z * drag }, false);
      l.body.setAngvel({ x: w.x * spin, y: w.y * spin, z: w.z * spin }, false);
    }
  }

  /**
   * Every prop's footprint where it is now (bots' Nav walks round them): centre, horizontal radius, and the top's
   * height. Upright (as it was placed, up to yaw) the placement extents hold; tipped over, the largest ones.
   */
  footprints(): { pos: Vec3; r: number; top: number }[] {
    const up = (q: Quat) => v3(2 * (q[0] * q[1] - q[3] * q[2]), 1 - 2 * (q[0] * q[0] + q[2] * q[2]), 2 * (q[1] * q[2] + q[3] * q[0]));
    return this.live.map((l) => {
      const e = PROP_KINDS[l.spawn.kind].ext, p = this.poseOf(l.body);
      const a = up(p.rot), b = up(l.rest.rot);
      const upright = a.x * b.x + a.y * b.y + a.z * b.z > 0.9;
      const [s0, s1, s2] = [e.x, e.y, e.z].sort((m, n) => n - m);
      return upright ? { pos: p.pos, r: Math.hypot(e.x, e.z), top: p.pos.y + e.y } : { pos: p.pos, r: Math.hypot(s0, s1), top: p.pos.y + s2 };
    });
  }

  /** Poses of every prop away from its rest pose, ascending id (the snapshot's `props`). */
  poses(): PropPose[] {
    const out: PropPose[] = [];
    for (const l of this.live) {
      if (!this.displaced(l)) continue;
      const p = this.poseOf(l.body);
      out.push({ id: l.spawn.id, p: [p.pos.x, p.pos.y, p.pos.z], q: p.rot });
    }
    return out;
  }

  /** Current pose of prop `id` (tests/debug). */
  pose(id: number): { pos: Vec3; rot: Quat } | null {
    const l = this.live[id - 1];
    return l ? this.poseOf(l.body) : null;
  }

  /** Rest pose (settled spawn) of prop `id`. */
  restPose(id: number) { return this.live[id - 1]?.rest ?? null; }

  /** Debug/tests: put prop `id` at `pos` (awake, still). */
  debugPlace(id: number, pos: Vec3) {
    if (!this.live[id - 1]) throw new Error(`PropSim.debugPlace: no prop ${id}`);
    this.run({ place: id, pos: { ...pos } });
  }

  private placeNow(id: number, pos: Vec3) {
    const l = this.live[id - 1];
    l.body.setTranslation(pos, true);
    l.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    l.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    l.lastActive = -Infinity;
    this.mirror(l);
  }
}

const playerCapsule = () => RAPIER.ColliderDesc.capsule((PLAYER.height - 2 * PLAYER.radius) / 2, PLAYER.radius - 0.03);

/** A piece collider as plain data (cuboid or convex hull, as Physics builds them). */
function shapeOf(id: number, c: RAPIER.Collider): PieceShape {
  const t = c.translation(), r = c.rotation(), sh = c.shape;
  const out: PieceShape = { id, t: [t.x, t.y, t.z], r: [r.x, r.y, r.z, r.w] };
  if (sh instanceof RAPIER.Cuboid) out.cuboid = [sh.halfExtents.x, sh.halfExtents.y, sh.halfExtents.z];
  else if (sh instanceof RAPIER.ConvexPolyhedron) out.hull = [...sh.vertices];
  else throw new Error(`PropSim: piece ${id} has an unsupported collider shape (${sh.type})`);
  return out;
}

function pieceDesc(ps: PieceShape): RAPIER.ColliderDesc {
  const d = ps.cuboid ? RAPIER.ColliderDesc.cuboid(ps.cuboid[0], ps.cuboid[1], ps.cuboid[2]) : RAPIER.ColliderDesc.convexHull(new Float32Array(ps.hull!));
  if (!d) throw new Error(`PropSim: piece ${ps.id} hull could not be rebuilt`);
  return d.setTranslation(ps.t[0], ps.t[1], ps.t[2]).setRotation({ x: ps.r[0], y: ps.r[1], z: ps.r[2], w: ps.r[3] });
}
