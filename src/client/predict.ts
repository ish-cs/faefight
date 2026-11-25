import { speedMult } from '../sim/potions';
import { adsMoveCmd, adsSpeed } from '../sim/gunplay';
import { DT } from '../sim/constants';
import type { MapDef } from '../sim/map';
import { newMoveState, stepMove, type MoveCmd, type MoveState, type Mover } from '../sim/movement';
import { Physics } from '../sim/physics';
import { barrierBoxes } from '../sim/barriers';
import type { PieceState, PlayerState, Snapshot, Vec3 } from '../sim/types';

/** Prediction errors bigger than this (teleport, respawn, a wall that wasn't there) snap instead of blending. */
export const SNAP_DIST = 1.5;
/** Small corrections decay with this time constant (≈95% gone after ~100 ms). */
export const SMOOTH_TAU = 0.035;
/** Unacknowledged commands kept for replay (~2 s); older ones are dropped. */
const MAX_HISTORY = 60;

const cloneMover = (m: Mover): Mover => ({ pos: { ...m.pos }, vel: { ...m.vel }, mv: { ...m.mv } });

/**
 * Client-side prediction for the local player. Runs the sim's own movement code (movement.ts)
 * against a local copy of the collision world (static map + pieces + other players from snapshots),
 * applies the player's commands immediately, and reconciles with authoritative snapshots: rewind to
 * the server state for the last acknowledged command, replay the rest, and blend away small
 * differences (large ones snap).
 */
export class Predictor {
  private state: Mover | null = null;
  /** Speed-potion multiplier from the last snapshot, so prediction matches the sim while boosted. */
  private speedMult = 1;
  /** Sights state from the last snapshot (aiming slows you and stops sprinting, as in the sim). */
  private aim: Pick<PlayerState, 'ads' | 'equipped'> = { ads: false, equipped: 'fists' };
  private history: MoveCmd[] = [];
  private offset = { x: 0, y: 0, z: 0 };
  private pieceIds = new Set<number>();
  /** How many broken pier sections the local world has taken out (snapshot `docks` only grows). */
  private docksGone = 0;
  private others = new Set<number>();
  private alive = false;
  /** Stats for debugging/tests. */
  readonly stats = { reconciles: 0, snaps: 0, lastError: 0, maxReplay: 0 };

  private constructor(private physics: Physics, readonly humanId: number, private readonly map: MapDef) {}

  static async create(map: MapDef, humanId: number): Promise<Predictor> {
    return new Predictor(await Physics.create(map), humanId, map);
  }

  /** True when the local player is alive and has a predicted state to render. */
  get active() { return this.alive && this.state !== null; }

  /** Predicted (committed, latest-step) state. */
  get current(): Readonly<Mover> | null { return this.state; }

  get pending() { return this.history.length; }

  /** Predicted stamina (movement.ts), so the HUD bar reacts to sprint on the very next frame. */
  get stamina(): number | null { return this.state && this.alive ? this.state.mv.stamina : null; }

  /** The local collision world (map + snapshot pieces + players); build aiming validates against it. */
  get world(): Physics { return this.physics; }

  /** Feed every authoritative snapshot as soon as it arrives (not delayed by interpolation). */
  onSnapshot(snap: Snapshot) {
    this.syncWorld(snap);
    const me = snap.players.find((p) => p.id === this.humanId);
    if (me) { this.aim = { ads: me.ads, equipped: me.equipped }; this.speedMult = speedMult(me, snap.time) * adsSpeed(this.aim); }
    if (me) this.reconcile(me);
  }

  /** One fixed client step (1/30 s) with a new command; the same command must go to the sim. */
  step(cmd: MoveCmd) {
    this.history.push(cmd);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    if (this.state && this.alive) this.apply(this.state, cmd, DT);
  }

  /**
   * Render-time state: the committed state advanced by `frac` of a step with the live (not yet
   * committed) command, so input shows up on the very next frame, plus the decaying correction.
   */
  renderState(live: MoveCmd, frac: number, dt: number, out: { pos: Vec3; vel: Vec3 }): boolean {
    if (!this.state || !this.alive) return false;
    const k = Math.exp(-dt / SMOOTH_TAU);
    this.offset.x *= k; this.offset.y *= k; this.offset.z *= k;
    const m = cloneMover(this.state);
    const f = Math.min(1, Math.max(0, frac));
    if (f > 1e-4) stepMove(m, adsMoveCmd(this.aim, live), f * DT, { movePlayer: (d) => this.physics.peekMovePlayer(this.humanId, d) }, this.speedMult);
    out.pos.x = m.pos.x + this.offset.x;
    out.pos.y = m.pos.y + this.offset.y;
    out.pos.z = m.pos.z + this.offset.z;
    out.vel.x = m.vel.x; out.vel.y = m.vel.y; out.vel.z = m.vel.z;
    return true;
  }

  private apply(m: Mover, cmd: MoveCmd, dt: number) {
    stepMove(m, adsMoveCmd(this.aim, cmd), dt, { movePlayer: (d) => this.physics.movePlayer(this.humanId, d) }, this.speedMult);
  }

  private reconcile(me: PlayerState) {
    const mv: MoveState = me.mv ? { ...me.mv } : newMoveState();
    const ack = mv.ack;
    let drop = 0;
    while (drop < this.history.length && this.history[drop].seq <= ack) drop++;
    if (drop) this.history.splice(0, drop);

    const wasAlive = this.alive;
    this.alive = me.alive;
    if (!me.alive) { this.state = null; this.offset = { x: 0, y: 0, z: 0 }; return; }

    const before = this.state ? { ...this.state.pos } : null;
    if (!this.physics.hasPlayer(this.humanId)) this.physics.addPlayer(this.humanId, me.pos);
    else this.physics.setPlayerPos(this.humanId, me.pos);
    const m: Mover = { pos: { ...me.pos }, vel: { ...me.vel }, mv };
    for (const c of this.history) this.apply(m, c, DT);
    this.state = m;
    this.stats.reconciles++;
    this.stats.maxReplay = Math.max(this.stats.maxReplay, this.history.length);

    if (!before || !wasAlive) { this.offset = { x: 0, y: 0, z: 0 }; return; }
    const ex = before.x - m.pos.x + this.offset.x, ey = before.y - m.pos.y + this.offset.y, ez = before.z - m.pos.z + this.offset.z;
    const err = Math.hypot(before.x - m.pos.x, before.y - m.pos.y, before.z - m.pos.z);
    this.stats.lastError = err;
    if (err > SNAP_DIST || Math.hypot(ex, ey, ez) > SNAP_DIST) { this.offset = { x: 0, y: 0, z: 0 }; this.stats.snaps++; return; }
    // Keep showing where we were drawing; the offset then decays to the corrected path.
    this.offset = { x: ex, y: ey, z: ez };
  }

  /**
   * A predicted piece (buildPredict.ts, negative id) joins the local world at once, so the next ghost and the
   * local move already see it. Snapshot syncs leave it alone; removeLocalPiece takes it out again.
   */
  addLocalPiece(p: PieceState) {
    if (p.id >= 0) throw new Error(`Predictor.addLocalPiece: predicted ids are negative, got ${p.id}`);
    this.physics.addPiece(p);
  }

  removeLocalPiece(id: number) { this.physics.removePiece(id); }

  /** Pieces and other players' capsules from the snapshot (they're what the local move collides with). */
  private syncWorld(snap: Snapshot) {
    const seen = new Set<number>();
    for (const p of snap.pieces) {
      seen.add(p.id);
      if (!this.pieceIds.has(p.id)) { this.physics.addPiece(p); this.pieceIds.add(p.id); }
    }
    for (const id of this.pieceIds) if (!seen.has(id)) { this.physics.removePiece(id); this.pieceIds.delete(id); }
    // Gameplay props are obstacles at their last known pose (no prediction of the prop itself).
    this.physics.setPropPoses(snap.props);
    // Broken pier sections: open water (removeDock ignores ones already gone).
    if (snap.docks && snap.docks.length !== this.docksGone) { for (const id of snap.docks) this.physics.removeDock(id); this.docksGone = snap.docks.length; }
    // Sudden-death doorway barriers: walls from then on (addBarriers is a no-op once they're in).
    if (snap.barrierAt != null && !this.physics.barrierCount) this.physics.addBarriers(barrierBoxes(this.map.islands));

    const live = new Set<number>();
    for (const p of snap.players) {
      if (p.id === this.humanId || !p.alive) continue;
      live.add(p.id);
      if (this.others.has(p.id)) this.physics.setPlayerPos(p.id, p.pos);
      else { this.physics.addPlayer(p.id, p.pos); this.others.add(p.id); }
    }
    for (const id of this.others) if (!live.has(id)) { this.physics.removePlayer(id); this.others.delete(id); }
  }
}
