import * as dm from './dmath';
import { MAP, PLAYER, WEAPONS } from './constants';
import { eyePos } from './combat';
import { emptyInventory } from './economy';
import { addKind, emptyHotbar, isGunItem, isPieceItem, syncFromInventory } from './hotbar';
import type { MatchStateCore } from './lifecycle';
import { buildMapDef, type Bunker, type MapDef, type StaticBox } from './map';
import { newMoveState } from './movement';
import type { Physics } from './physics';
import { newPlayer } from './player';
import { isSealed } from './seal';
import type { GunKind, HotbarItem, Inventory, PieceKind, PieceState, PlayerInput, PlayerState, Vec3 } from './types';
import { NO_INPUT } from './types';
import { clone, dist, dist2D, norm, right, sub, v3, yawOf } from './vec';

/**
 * Practice range: an offline sandbox on the Harbor map that runs the real sim (movement, gunplay, building and
 * seals are untouched). Everything practice-only lives here; Match calls in at a few fixed points when
 * `MatchSetup.practice` is set, and normal matches never construct this.
 *
 * Layout (2-player Harbor, the player on island 0): the firing line faces -Z across the south half of the island;
 * four lanes put a static target and a target strafing on a short rail at 10 / 25 / 50 / 100 m (lanes past the
 * island edge stand on container barges). Three dummies stand behind the firing line: one still, one strafing,
 * one that shoots back weakly. The player's own bunker is the practice bunker for sealing.
 */

export type PracticeCmd =
  | { kind: 'reset' }
  | { kind: 'clearPieces' }
  | { kind: 'dummies'; on: boolean }
  | { kind: 'shooter'; on: boolean };

export const PRACTICE = {
  /** Cash is held at this every tick: every buy is free in effect (the HUD shows ∞). */
  cash: 1_000_000,
  /** Every piece kind held is topped back up to this: building never runs out. */
  pieces: 99,
  /** Guns are topped up to at least this many spare magazines. */
  spareMags: 3,
  /** A target that went down stands back up at its post after this long. */
  reviveSec: 0.6,
  /** Targets heal to full this long after their last hit (so each string of shots starts fresh). */
  healSec: 1.5,
  /** Shooter dummy: one pistol shot this often, aim off by up to this many degrees, only within this range. */
  shooterEverySec: 2,
  shooterJitterDeg: 3,
  shooterRange: 45,
  /** Firing line (z) and the lane distances. */
  lineZ: -8,
  lanes: [10, 25, 50, 100] as const,
  laneX: [-49, -43, -37, -31] as const,
  /** Half-length of a target's rail and of the strafing dummy's run (m). */
  railHalf: 1.2,
  strafeHalf: 2.5,
};

const G = MAP.groundY;
/** Where you start (and come back to): on the firing line, facing the lanes (yaw 0 = -Z). */
export const PRACTICE_START: Vec3 = v3(-40, G, PRACTICE.lineZ + 1);
const PARKED = v3(0, -1000, 0);

type DummyKind = 'static' | 'rail' | 'still' | 'strafe' | 'shooter';
type Dummy = {
  id: number;
  kind: DummyKind;
  post: Vec3;
  yaw: number;
  /** Rail/strafe direction along right(yaw). */
  dir: 1 | -1;
  /** Dead: stands back up at this time. */
  reviveAt: number | null;
  nextShotAt: number;
};

type DummySpec = { kind: DummyKind; name: string; post: Vec3; yaw: number };
/** The three dummies (the panel's toggle); lane targets are always up. */
const toggled = (d: Dummy) => d.kind === 'still' || d.kind === 'strafe' || d.kind === 'shooter';

function dummySpecs(): DummySpec[] {
  const out: DummySpec[] = [];
  PRACTICE.lanes.forEach((d, i) => {
    const x = PRACTICE.laneX[i], z = PRACTICE.lineZ - d;
    // Targets face the firing line (+Z: yaw π).
    out.push({ kind: 'static', name: `Target ${d}m`, post: v3(x - 1.5, G, z), yaw: Math.PI });
    out.push({ kind: 'rail', name: `Mover ${d}m`, post: v3(x + 1.5, G, z), yaw: Math.PI });
  });
  // Dummies behind the firing line, facing it (-Z: yaw 0).
  out.push({ kind: 'still', name: 'Still dummy', post: v3(-46, G, 12), yaw: 0 });
  out.push({ kind: 'strafe', name: 'Strafe dummy', post: v3(-40, G, 12), yaw: 0 });
  out.push({ kind: 'shooter', name: 'Shooter dummy', post: v3(-34, G, 12), yaw: 0 });
  return out;
}

/** True when (x, z) stands on the given island disc with a margin. */
const onIsland = (def: MapDef, x: number, z: number) => def.islands.some((i) => Math.hypot(x - i.center.x, z - i.center.z) <= i.radius - 1.5);

/**
 * Harbor for two, plus container barges under the lanes that reach past the island, minus the decorative props
 * that stood in the lanes or the dummy area (they would soak up shots).
 */
export function practiceMapDef(seed = 1): MapDef {
  const def = buildMapDef(2, 'harbor', seed);
  const statics: StaticBox[] = [...def.statics];
  PRACTICE.lanes.forEach((d, i) => {
    const x = PRACTICE.laneX[i], z = PRACTICE.lineZ - d;
    if (onIsland(def, x - 3, z) && onIsland(def, x + 3, z)) return;
    // A container lying in the water, its top flush with the island ground.
    statics.push({ center: v3(x, G - 1, z), half: v3(3.4, 1, 1.8), rotY: 0, role: 'cover', island: 0, look: 'container' });
  });
  const lanes = (p: Vec3) => p.x > PRACTICE.laneX[0] - 5 && p.x < PRACTICE.laneX[3] + 5 && p.z < PRACTICE.lineZ + 2;
  const dummies = (p: Vec3) => p.x > -51 && p.x < -29 && p.z > 7 && p.z < 18;
  return { ...def, name: 'Practice Range', statics, cosmetics: def.cosmetics.filter((c) => !lanes(c.pos) && !dummies(c.pos)) };
}

/**
 * Which of a bunker's doorways (bunker.doorways order: front, left, right) a body can't get out through: each one
 * is checked with the other two plugged, using the real seal rule. All three blocked = sealed.
 */
export function doorwaysBlocked(bunker: Bunker, pieces: PieceState[]): boolean[] {
  return bunker.doorways.map((_, i) => {
    const plugs: PieceState[] = bunker.doorways
      .filter((_, j) => j !== i)
      .map((d, j) => ({ id: -1 - j, kind: 'metal', owner: 0, pos: v3(d.center.x, bunker.center.y, d.center.z), rotY: d.yaw, hp: 1 }));
    return isSealed(bunker, [...pieces, ...plugs]);
  });
}

/** What Match lends the range: its state, physics and a way to remove pieces with the usual bookkeeping. */
export type PracticeHost = {
  s: MatchStateCore;
  physics: Physics;
  removePiece(id: number): void;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The starting loadout: three guns and three building pieces, three slots free for the shop. */
function startKit(): { inv: Inventory; hotbar: (HotbarItem | null)[] } {
  const inv = emptyInventory();
  inv.cash = PRACTICE.cash;
  const hotbar = emptyHotbar();
  for (const g of ['rifle', 'smg', 'shotgun'] as GunKind[]) {
    inv.weapons[g] = { mag: WEAPONS[g].mag, spare: WEAPONS[g].mag * PRACTICE.spareMags };
    addKind(hotbar, g);
  }
  for (const k of ['wood', 'metal', 'ramp'] as PieceKind[]) {
    inv.pieces[k] = PRACTICE.pieces;
    addKind(hotbar, k);
  }
  return { inv, hotbar };
}

export class PracticeRange {
  private dummies = new Map<number, Dummy>();
  private dummiesOn = true;
  private shooterOn = true;
  private rng = mulberry32(0x5eed);
  /** The player's loadout as of the start of the tick: given back when they die (no loss in practice). */
  private saved: { inv: Inventory; hotbar: (HotbarItem | null)[]; selected: number } | null = null;
  /** First entity id of this tick: loot bags from deaths this tick are at or above it. */
  private idAtTick = 0;

  constructor(private host: PracticeHost, readonly humanId: number) {
    const { s, physics } = host;
    const me = this.human();
    const kit = startKit();
    me.inv = kit.inv;
    me.hotbar = kit.hotbar;
    me.selected = 0;
    this.place(me, PRACTICE_START, 0);
    // Dummies belong to the other island (unused): their bunker is never near them.
    for (const spec of dummySpecs()) {
      const id = Math.max(...s.players.keys()) + 1; // player ids (not entity ids): 2, 3, …
      const p = newPlayer(id, spec.name, true, 1, spec.post);
      p.inv = emptyInventory();
      p.yaw = spec.yaw;
      s.players.set(id, p);
      physics.addPlayer(id, p.pos);
      this.dummies.set(id, { id, kind: spec.kind, post: spec.post, yaw: spec.yaw, dir: 1, reviveAt: null, nextShotAt: 0 });
      if (spec.kind === 'shooter') this.armShooter(p);
    }
  }

  isDummy(id: number): boolean {
    return this.dummies.has(id);
  }

  /** Start of a tick: hold cash, top up pieces and ammo, remember the loadout. */
  before(): void {
    this.idAtTick = this.host.s.nextId;
    const me = this.human();
    if (me.alive) {
      topUp(me.inv);
      this.saved = { inv: structuredClone(me.inv), hotbar: [...me.hotbar], selected: me.selected };
    }
    for (const d of this.dummies.values()) {
      const p = this.player(d.id);
      if (d.kind === 'shooter' && p.alive) { const a = p.inv.weapons.pistol; if (a) a.spare = WEAPONS.pistol.mag * 4; }
    }
  }

  /** A dummy's input this tick (they never go through the bot brains). */
  inputFor(p: PlayerState, now: number): PlayerInput {
    const d = this.dummies.get(p.id);
    if (!d) throw new Error(`PracticeRange.inputFor: ${p.id} is not a dummy`);
    const input: PlayerInput = { ...NO_INPUT, yaw: d.yaw, pitch: 0 };
    if (d.kind === 'rail' || d.kind === 'strafe') {
      const half = d.kind === 'rail' ? PRACTICE.railHalf : PRACTICE.strafeHalf;
      const r = right(d.yaw);
      const off = (p.pos.x - d.post.x) * r.x + (p.pos.z - d.post.z) * r.z;
      if (off > half) d.dir = -1;
      else if (off < -half) d.dir = 1;
      input.moveX = d.dir;
    } else if (d.kind === 'shooter') {
      this.aimShooter(p, d, now, input);
    }
    return input;
  }

  /** After the lifecycle step: nobody stays dead, targets heal, death drops vanish. */
  after(now: number): void {
    const { s } = this.host;
    let died = false;
    const me = this.human();
    if (!me.alive) { died = true; this.reviveHuman(me); }
    for (const d of this.dummies.values()) {
      const p = this.player(d.id);
      if (toggled(d) && !this.dummiesOn) continue;
      if (!p.alive) {
        died = true;
        if (d.reviveAt === null) { d.reviveAt = now + PRACTICE.reviveSec; p.respawnAt = null; } // the range brings it back, not the lifecycle
        else if (now >= d.reviveAt) this.reviveDummy(p, d);
        continue;
      }
      if (p.hp < PLAYER.hp && now - p.lastDamagedAt >= PRACTICE.healSec) p.hp = PLAYER.hp;
    }
    // Loot bags from this tick's deaths (dropped items carry noPickup and stay).
    if (died) for (const [id, bag] of s.loot) if (id >= this.idAtTick && !bag.noPickup) s.loot.delete(id);
  }

  command(cmd: PracticeCmd): void {
    switch (cmd.kind) {
      case 'reset': {
        const me = this.human();
        if (me.alive) { me.hp = PLAYER.hp; me.shield = 0; this.place(me, PRACTICE_START, 0); }
        else this.reviveHuman(me);
        for (const d of this.dummies.values()) if (!toggled(d) || this.dummiesOn) this.reviveDummy(this.player(d.id), d);
        break;
      }
      case 'clearPieces':
        for (const id of [...this.host.s.pieces.keys()]) this.host.removePiece(id);
        break;
      case 'dummies':
        this.dummiesOn = cmd.on;
        for (const d of this.dummies.values()) {
          if (!toggled(d)) continue;
          const p = this.player(d.id);
          if (cmd.on) this.reviveDummy(p, d);
          else this.park(p, d);
        }
        break;
      case 'shooter':
        this.shooterOn = cmd.on;
        break;
      default:
        throw new Error(`PracticeRange.command: unknown ${JSON.stringify(cmd)}`);
    }
    console.info(`[practice] ${JSON.stringify(cmd)}`);
  }

  private aimShooter(p: PlayerState, d: Dummy, now: number, input: PlayerInput) {
    input.slot = 'pistol';
    const me = this.human();
    if (!this.shooterOn || !me.alive) return;
    const eye = eyePos(p);
    const chest = v3(me.pos.x, me.pos.y + 1.2, me.pos.z);
    const range = dist(eye, chest);
    if (range > PRACTICE.shooterRange) return;
    const hit = this.host.physics.raycast(eye, norm(sub(chest, eye)), range + 0.5, p.id, true);
    if (hit?.hit.type !== 'player' || hit.hit.id !== me.id) return;
    const jitter = () => ((this.rng() * 2 - 1) * PRACTICE.shooterJitterDeg * Math.PI) / 180;
    input.yaw = yawOf(sub(chest, eye)) + jitter();
    input.pitch = dm.atan2(chest.y - eye.y, dist2D(chest, eye)) + jitter();
    if (now >= d.nextShotAt) { input.fire = true; d.nextShotAt = now + PRACTICE.shooterEverySec; }
  }

  private armShooter(p: PlayerState) {
    p.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: WEAPONS.pistol.mag * 4 };
    syncFromInventory(p.hotbar, p.inv);
    p.selected = p.hotbar.indexOf('pistol');
  }

  private reviveHuman(me: PlayerState) {
    const kit = this.saved ?? startKit();
    me.inv = structuredClone(kit.inv);
    me.hotbar = [...kit.hotbar];
    me.selected = this.saved?.selected ?? 0;
    me.alive = true;
    me.hp = PLAYER.hp;
    me.shield = 0;
    me.respawnAt = null;
    me.breakoutUntil = null;
    me.healAt = null;
    me.drinking = null;
    this.place(me, PRACTICE_START, 0);
    console.info('[practice] you went down: back at the range start');
  }

  private reviveDummy(p: PlayerState, d: Dummy) {
    d.reviveAt = null;
    d.dir = 1;
    p.alive = true;
    p.hp = PLAYER.hp;
    p.shield = 0;
    p.respawnAt = null;
    p.breakoutUntil = null;
    p.mv = newMoveState();
    if (d.kind === 'shooter') this.armShooter(p);
    this.place(p, d.post, d.yaw);
  }

  private park(p: PlayerState, d: Dummy) {
    d.reviveAt = null;
    p.alive = false;
    p.respawnAt = null;
    p.pos = clone(PARKED);
    p.vel = v3();
    this.host.physics.setPlayerPos(p.id, PARKED);
  }

  private place(p: PlayerState, pos: Vec3, yaw: number) {
    p.pos = clone(pos);
    p.vel = v3();
    p.yaw = yaw;
    p.pitch = 0;
    this.host.physics.setPlayerPos(p.id, pos);
  }

  private human(): PlayerState {
    return this.player(this.humanId);
  }

  private player(id: number): PlayerState {
    const p = this.host.s.players.get(id);
    if (!p) throw new Error(`PracticeRange: no player ${id}`);
    return p;
  }
}

/** Cash held, every piece kind held back to a full stack, every gun with spare magazines. */
function topUp(inv: Inventory) {
  inv.cash = PRACTICE.cash;
  for (const k of Object.keys(inv.pieces)) if (isPieceItem(k) && (inv.pieces[k] ?? 0) > 0) inv.pieces[k] = PRACTICE.pieces;
  for (const [g, a] of Object.entries(inv.weapons)) {
    if (!a || !isGunItem(g)) continue;
    a.spare = Math.max(a.spare, WEAPONS[g].mag * PRACTICE.spareMags);
  }
}
