/**
 * Sim invariant checker: fed every authoritative snapshot of a run (self-play training match, or a
 * re-simulated human replay) to auto-detect sim bugs. Pure and DOM-free: no Physics/Rapier world is
 * needed (support is re-derived analytically from the static map geometry, see `floatingPieces`).
 *
 * Every check is deliberately conservative — a reported violation should be a genuine contradiction of
 * the sim's own rules, because each distinct signature may trigger an automated fix attempt. Conditions
 * that persist are reported once per player/piece (until they clear), and at most `maxPerKind` per kind.
 *
 * Expects full sim snapshots (Match.tick output). Network snapshots (they carry `hidden`, and may omit
 * pieces) are tolerated: hidden players and the piece-based checks are skipped for them.
 */
import { LIFECYCLE, PIECES } from './constants';
import { SETTING_RANGES } from './settings';
import { countOf, equippedFor, heldKinds, isHotbarItem, HOTBAR_SIZE, validSlot } from './hotbar';
import { buildMapDef, bunkerWallBoxes, type Box, type DockDef, type IslandLayout } from './map';
import { PROP_HALF } from './physics';
import { isSealed } from './seal';
import { sealBlocker, sidesLeft } from './teams';
import type { Inventory, PieceState, PlayerInput, PlayerState, Snapshot, Vec3 } from './types';
import { dist2D, rotateY, v3 } from './vec';

export type ViolationKind =
  | 'nonFinite' | 'stuck' | 'belowMap' | 'negativeCount' | 'floatingPiece' | 'sealContradiction' | 'hotbarDesync' | 'neverEnds';

export type Violation = {
  kind: ViolationKind;
  tick: number;
  time: number;
  playerId?: number;
  pieceId?: number;
  detail: string;
  /** Stable sub-category (a field path or rule name, no ids/numbers): see violationSignature. */
  sub?: string;
};

/** Stable grouping key for a violation (no tick/ids/numbers that vary run to run), e.g. "stuck" or "negativeCount:inv.grenades". */
export function violationSignature(v: Violation): string {
  return v.sub ? `${v.kind}:${v.sub}` : v.kind;
}

/**
 * Thresholds (all conservative; see the report in the PR/commit for the reasoning):
 * - STUCK_SEC 5 s / STUCK_DIST 0.15 m: holding a move input for 5 s moves ≥ 7.5 m even at the slowest
 *   legal speed (walk 5 m/s × slowest ADS 0.6); nothing in the sim (busy, healing, drinking, reload)
 *   blocks movement, so < 0.15 m of horizontal travel means the body is wedged.
 * - BODY_BLOCK_XZ 1.2 m / BODY_BLOCK_Y 2 m: players are solid capsules (r 0.35, h 1.8) to each other, so
 *   two bots pushing into each other is not a sim bug — skip anyone with another live player that close.
 * - BELOW_WATER_MARGIN 0.5 m: tickLifecycle kills every live player with y < waterY after all movement,
 *   before the snapshot, so a live player under water at all is impossible; the margin absorbs float noise.
 * - FLOAT_GRACE_TICKS 3: the collapse pass runs in the same tick as the destruction (or the next, for
 *   destructions outside tick() like debugDamagePiece); 3 ticks is ample.
 * - SEAL_GRACE_TICKS / WIN_GRACE_TICKS 2: seals and the win check are recomputed at the end of every tick;
 *   a 2-tick persistence filter only covers state mutated between ticks (debug helpers).
 * - DEFAULT_MAX_MATCH_SEC = suddenDeathAt (900 s) + 600 s: after sudden death nobody respawns and the tide
 *   rises 0.05 m/s, i.e. 30 m above sea level 600 s later — far above the island (2 m) and bunker roof
 *   (4.8 m) and any tower bots can afford, so every player should have drowned or been killed by then.
 */
const STUCK_SEC = 5;
const STUCK_DIST = 0.15;
const STUCK_MIN_MOVE = 0.5;
const BODY_BLOCK_XZ = 1.2;
const BODY_BLOCK_Y = 2;
const BELOW_WATER_MARGIN = 0.5;
const FLOAT_GRACE_TICKS = 3;
const SEAL_GRACE_TICKS = 2;
const WIN_GRACE_TICKS = 2;
const COUNT_EPS = 1e-6;
// The latest sudden death a host can set (settings.ts), plus 600 s.
export const DEFAULT_MAX_MATCH_SEC = SETTING_RANGES.suddenDeathSec.max + 600;
const DEFAULT_MAX_PER_KIND = 20;

type StuckWindow = { since: number; x: number; z: number };

export class InvariantChecker {
  readonly violations: Violation[] = [];
  private map: IslandLayout[] | null;
  /** Pier sections of the map (standing ones support pieces like the ground). */
  private docks: DockDef[];
  private readonly stuckSec: number;
  private readonly maxMatchSec: number;
  private readonly maxPerKind: number;
  private readonly perKind = new Map<ViolationKind, number>();
  /** Keys of conditions currently reported (cleared when the condition goes away). */
  private active = new Set<string>();
  /** Conditions seen but still inside their grace period: key → first tick seen. */
  private pending = new Map<string, number>();
  private stuck = new Map<number, StuckWindow>();
  /** Support check due at `due` for the pieces that survived the collapse pass after the last destruction. */
  private floatCheck: { due: number; ids: Set<number> } | null = null;
  private sealCache: { key: string; sealed: boolean[] } | null = null;
  /** Keys never cleared from `active` (floatingPiece: a one-shot check, not re-evaluated every tick). */
  private keepActive = new Set<string>();
  private winChecked = false;
  private found: Violation[] = [];

  constructor(opts: { map?: IslandLayout[]; docks?: DockDef[]; stuckSec?: number; maxMatchSec?: number; maxPerKind?: number } = {}) {
    this.map = opts.map ?? null;
    this.docks = opts.docks ?? [];
    this.stuckSec = opts.stuckSec ?? STUCK_SEC;
    this.maxMatchSec = opts.maxMatchSec ?? DEFAULT_MAX_MATCH_SEC;
    this.maxPerKind = opts.maxPerKind ?? DEFAULT_MAX_PER_KIND;
  }

  /** Feed every tick's snapshot (in order). Returns NEW violations found this tick. */
  observe(snap: Snapshot, inputs?: Map<number, PlayerInput>): Violation[] {
    this.found = [];
    const seen = new Set<string>();
    const hidden = new Set(snap.hidden ?? []);
    const visible = snap.players.filter((p) => !hidden.has(p.id));
    const fullSnapshot = snap.hidden === undefined;
    if (!this.map && snap.players.length >= 2 && snap.players.length <= 8) {
      const def = buildMapDef(snap.players.length);
      this.map = def.islands;
      this.docks = def.docks ?? [];
    }

    this.checkNonFinite(snap, visible, seen);
    this.checkNegative(snap, visible, seen);
    this.checkBelowMap(snap, visible, seen);
    this.checkStuck(snap, visible, inputs, seen);
    for (const p of visible) this.checkHotbar(snap, p, seen);
    this.checkLifecycle(snap, seen);
    if (fullSnapshot && this.map) {
      this.checkSeals(snap, this.map, seen);
      this.checkFloating(snap, this.map);
    }

    // Conditions not seen this tick have cleared: they may be reported again if they come back.
    for (const k of this.active) if (!seen.has(k) && !this.keepActive.has(k)) this.active.delete(k);
    for (const k of this.pending.keys()) if (!seen.has(k)) this.pending.delete(k);
    return this.found;
  }

  /** Call once when the run ends (winner or not); reports neverEnds if no winner and time exceeded maxMatchSec. */
  finish(last: Snapshot): Violation[] {
    this.found = [];
    if (last.winner === null && last.time > this.maxMatchSec) {
      const left = last.players.filter((p) => !p.eliminated).length;
      this.record(last, `neverEnds`, {
        kind: 'neverEnds',
        detail: `no winner after ${last.time.toFixed(1)} s (limit ${this.maxMatchSec} s), ${left} players not eliminated, waterY ${last.waterY.toFixed(2)}`,
      }, new Set());
    }
    return this.found;
  }

  // ---- reporting ----

  /** Reports `v` once while the condition (identified by `key`) persists. `grace`: ticks it must persist first. */
  private record(snap: Snapshot, key: string, v: Omit<Violation, 'tick' | 'time'>, seen: Set<string>, grace = 0): void {
    seen.add(key);
    if (this.active.has(key)) return;
    if (grace > 0) {
      const first = this.pending.get(key);
      if (first === undefined) { this.pending.set(key, snap.tick); return; }
      if (snap.tick - first < grace) return;
    }
    this.active.add(key);
    const n = this.perKind.get(v.kind) ?? 0;
    if (n >= this.maxPerKind) return;
    this.perKind.set(v.kind, n + 1);
    const full: Violation = { ...v, tick: snap.tick, time: snap.time };
    this.violations.push(full);
    this.found.push(full);
  }

  // ---- checks ----

  private checkNonFinite(snap: Snapshot, players: PlayerState[], seen: Set<string>) {
    const bad = (sub: string, where: string, value: unknown, ids: { playerId?: number; pieceId?: number }) =>
      this.record(snap, `nonFinite:${sub}:${ids.playerId ?? ''}:${ids.pieceId ?? ''}:${where}`,
        { kind: 'nonFinite', sub, ...ids, detail: `${where} = ${String(value)}` }, seen);
    const vec = (v: Vec3 | undefined) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    const fmt = (v: Vec3 | undefined) => (v ? `(${v.x}, ${v.y}, ${v.z})` : String(v));

    for (const p of players) {
      const id = { playerId: p.id };
      if (!p.alive) continue; // dead players are parked at y = -1000 with zeroed state
      if (!vec(p.pos)) bad('player.pos', `player ${p.id} pos`, fmt(p.pos), id);
      if (!vec(p.vel)) bad('player.vel', `player ${p.id} vel`, fmt(p.vel), id);
      for (const f of ['yaw', 'pitch', 'hp', 'shield'] as const)
        if (!Number.isFinite(p[f])) bad(`player.${f}`, `player ${p.id} ${f}`, p[f], id);
    }
    for (const p of players)
      for (const [which, inv] of [['inv', p.inv], ['vault', p.vault]] as const)
        for (const [path, n] of inventoryCounts(inv))
          if (!Number.isFinite(n)) bad(`${which}.${path}`, `player ${p.id} ${which}.${path}`, n, { playerId: p.id });
    for (const pc of snap.pieces) {
      if (!vec(pc.pos)) bad('piece.pos', `piece ${pc.id} (${pc.kind}) pos`, fmt(pc.pos), { pieceId: pc.id });
      if (!Number.isFinite(pc.hp)) bad('piece.hp', `piece ${pc.id} (${pc.kind}) hp`, pc.hp, { pieceId: pc.id });
      if (!Number.isFinite(pc.rotY)) bad('piece.rotY', `piece ${pc.id} (${pc.kind}) rotY`, pc.rotY, { pieceId: pc.id });
    }
    for (const pr of snap.projectiles ?? []) {
      if (!vec(pr.pos)) bad('projectile.pos', `${pr.kind} ${pr.id} pos`, fmt(pr.pos), {});
      if (!vec(pr.vel)) bad('projectile.vel', `${pr.kind} ${pr.id} vel`, fmt(pr.vel), {});
    }
    for (const b of snap.loot) if (!vec(b.pos)) bad('loot.pos', `loot ${b.id} pos`, fmt(b.pos), {});
    for (const g of snap.generators)
      if (!Number.isFinite(g.stored)) bad('generator.stored', `generator ${g.island} stored`, g.stored, {});
    if (!Number.isFinite(snap.waterY)) bad('waterY', 'waterY', snap.waterY, {});
  }

  private checkNegative(snap: Snapshot, players: PlayerState[], seen: Set<string>) {
    const neg = (sub: string, where: string, value: number, playerId?: number) =>
      this.record(snap, `negativeCount:${sub}:${playerId ?? ''}:${where}`,
        { kind: 'negativeCount', sub, playerId, detail: `${where} = ${value}` }, seen);
    for (const p of players) {
      for (const [which, inv] of [['inv', p.inv], ['vault', p.vault]] as const)
        for (const [path, n] of inventoryCounts(inv))
          if (n < -COUNT_EPS) neg(`${which}.${path}`, `player ${p.id} ${which}.${path}`, n, p.id);
      if (p.alive && p.hp < -COUNT_EPS) neg('player.hp', `player ${p.id} hp (alive)`, p.hp, p.id);
      if (p.shield < -COUNT_EPS) neg('player.shield', `player ${p.id} shield`, p.shield, p.id);
    }
    for (const g of snap.generators)
      if (g.stored < -COUNT_EPS) neg('generator.stored', `generator ${g.island} stored`, g.stored);
    for (const b of snap.loot)
      for (const [path, n] of inventoryCounts(b.inv))
        if (n < -COUNT_EPS) neg(`loot.${path}`, `loot ${b.id} ${path}`, n);
  }

  private checkBelowMap(snap: Snapshot, players: PlayerState[], seen: Set<string>) {
    for (const p of players) {
      if (!p.alive || !Number.isFinite(p.pos.y)) continue;
      if (p.pos.y < snap.waterY - BELOW_WATER_MARGIN)
        this.record(snap, `belowMap:${p.id}`, {
          kind: 'belowMap', playerId: p.id,
          detail: `player ${p.id} alive at y=${p.pos.y.toFixed(2)} below waterY ${snap.waterY.toFixed(2)} (the water check kills anyone under it)`,
        }, seen);
    }
  }

  private checkStuck(snap: Snapshot, players: PlayerState[], inputs: Map<number, PlayerInput> | undefined, seen: Set<string>) {
    const live = players.filter((p) => p.alive && !p.eliminated);
    for (const p of snap.players) {
      const input = inputs?.get(p.id);
      const eligible = !!input && p.alive && !p.eliminated && live.includes(p) &&
        Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z) &&
        Math.hypot(input.moveX, input.moveZ) > STUCK_MIN_MOVE &&
        !live.some((o) => o.id !== p.id && dist2D(o.pos, p.pos) < BODY_BLOCK_XZ && Math.abs(o.pos.y - p.pos.y) < BODY_BLOCK_Y);
      if (!eligible) { this.stuck.delete(p.id); continue; }
      const w = this.stuck.get(p.id);
      if (!w || Math.hypot(p.pos.x - w.x, p.pos.z - w.z) >= STUCK_DIST) {
        this.stuck.set(p.id, { since: snap.time, x: p.pos.x, z: p.pos.z });
        continue;
      }
      if (snap.time - w.since > this.stuckSec)
        this.record(snap, `stuck:${p.id}`, {
          kind: 'stuck', playerId: p.id,
          detail: `player ${p.id} held move input for ${(snap.time - w.since).toFixed(1)} s but stayed within ${STUCK_DIST} m of (${w.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${w.z.toFixed(2)})`,
        }, seen);
    }
  }

  private checkHotbar(snap: Snapshot, p: PlayerState, seen: Set<string>) {
    const desync = (sub: string, detail: string) =>
      this.record(snap, `hotbarDesync:${sub}:${p.id}:${detail}`, { kind: 'hotbarDesync', sub, playerId: p.id, detail: `player ${p.id}: ${detail}` }, seen);
    const bar = p.hotbar;
    if (!Array.isArray(bar) || bar.length !== HOTBAR_SIZE) { desync('badLength', `hotbar has ${bar?.length} slots`); return; }
    if (!validSlot(p.selected)) desync('badSelected', `selected slot ${p.selected}`);
    const slotted = new Set<string>();
    bar.forEach((k, i) => {
      if (k === null) return;
      if (!isHotbarItem(k)) { desync('unknownItem', `slot ${i} holds unknown item ${String(k)}`); return; }
      if (slotted.has(k)) desync('duplicate', `${k} occupies two slots`);
      slotted.add(k);
      if (countOf(p.inv, k) <= 0) desync('emptySlot', `slot ${i} holds ${k} but inv has none`);
    });
    // Unslotted items are legal only when the hotbar is full (syncFromInventory overflow).
    if (bar.includes(null))
      for (const k of heldKinds(p.inv))
        if (!slotted.has(k)) desync('unslotted', `${k} held (${countOf(p.inv, k)}) but on no slot while a slot is free`);
    if (validSlot(p.selected)) {
      const want = equippedFor(bar, p.selected);
      if (p.equipped !== want) desync('equippedMismatch', `equipped ${p.equipped} but selected slot ${p.selected} gives ${want}`);
    }
  }

  private checkLifecycle(snap: Snapshot, seen: Set<string>) {
    for (const p of snap.players)
      if (p.eliminated && p.alive)
        this.record(snap, `sealContradiction:eliminatedAlive:${p.id}`, {
          kind: 'sealContradiction', sub: 'eliminatedAlive', playerId: p.id, detail: `player ${p.id} is eliminated but alive`,
        }, seen);

    if (snap.players.length < 2) return;
    const left = snap.players.filter((p) => !p.eliminated);
    const sides = sidesLeft(left);
    if (snap.winner === null) {
      if (sides <= 1)
        this.record(snap, 'sealContradiction:noWinner', {
          kind: 'sealContradiction', sub: 'noWinner',
          detail: `${left.length} player(s) (${sides} side(s)) not eliminated but no winner declared`,
        }, seen, WIN_GRACE_TICKS);
      return;
    }
    // The win is decided once; after that the run may keep ticking (later deaths don't undo it).
    if (this.winChecked) return;
    this.winChecked = true;
    if (sides >= 2)
      this.record(snap, 'sealContradiction:winnerWithRivals', {
        kind: 'sealContradiction', sub: 'winnerWithRivals',
        detail: `winner ${snap.winner} declared while ${left.length} players are not eliminated (${left.map((p) => p.id).join(', ')})`,
      }, seen);
    else if (snap.winner === -1 ? left.length !== 0 : left[0]?.id !== snap.winner && !left.some((p) => p.id === snap.winner))
      this.record(snap, 'sealContradiction:wrongWinner', {
        kind: 'sealContradiction', sub: 'wrongWinner',
        detail: `winner ${snap.winner} but the non-eliminated players are [${left.map((p) => p.id).join(', ')}]`,
      }, seen);
  }

  private checkSeals(snap: Snapshot, map: IslandLayout[], seen: Set<string>) {
    if (snap.sealed.length !== map.length) {
      this.record(snap, 'sealContradiction:sealedLength', {
        kind: 'sealContradiction', sub: 'sealedLength', detail: `sealed has ${snap.sealed.length} entries for ${map.length} islands`,
      }, seen);
      return;
    }
    // Sudden death force-seals every bunker; otherwise each flag is the flood fill over the current pieces.
    let expected: boolean[];
    if (snap.suddenDeath) expected = map.map(() => true);
    else {
      const key = snap.pieces.map((p) => p.id).join(',');
      if (this.sealCache?.key !== key) this.sealCache = { key, sealed: map.map((isl, i) => {
        const owner = snap.players.find((p) => p.island === i);
        return isSealed(isl.bunker, snap.pieces.filter((pc) => sealBlocker(owner, snap.players.find((p) => p.id === pc.owner))));
      }) };
      expected = this.sealCache.sealed;
    }
    expected.forEach((want, i) => {
      if (snap.sealed[i] !== want)
        this.record(snap, `sealContradiction:sealedMismatch:${i}`, {
          kind: 'sealContradiction', sub: 'sealedMismatch',
          detail: `island ${i} sealed=${snap.sealed[i]} but the seal rule says ${want}${snap.suddenDeath ? ' (sudden death)' : ''}`,
        }, seen, SEAL_GRACE_TICKS);
    });
  }

  private checkFloating(snap: Snapshot, map: IslandLayout[]) {
    if (snap.events.some((e) => e.type === 'destroyed'))
      this.floatCheck = { due: snap.tick + FLOAT_GRACE_TICKS, ids: new Set(snap.pieces.map((p) => p.id)) };
    if (!this.floatCheck || snap.tick < this.floatCheck.due) return;
    const { ids } = this.floatCheck;
    this.floatCheck = null;
    const seen = new Set<string>();
    const broken = new Set(snap.docks ?? []);
    for (const id of floatingPieces(map, snap.pieces, this.docks.filter((d) => !broken.has(d.id)))) {
      if (!ids.has(id)) continue; // placed after the collapse pass ran: validated by placement, not support
      const pc = snap.pieces.find((p) => p.id === id)!;
      this.record(snap, `floatingPiece:${id}`, {
        kind: 'floatingPiece', sub: pc.kind, pieceId: id,
        detail: `${pc.kind} ${id} at (${pc.pos.x.toFixed(2)}, ${pc.pos.y.toFixed(2)}, ${pc.pos.z.toFixed(2)}) has no support chain to the ground but survived the collapse pass`,
      }, seen);
    }
    // Keep floating keys active for the rest of the run so a piece isn't re-reported on the next destruction.
    for (const k of seen) this.keepActive.add(k);
  }

}

/** Every count in an inventory as [path, value] (gun mag/spare included). */
function inventoryCounts(inv: Inventory): [string, number][] {
  const out: [string, number][] = [
    ['cash', inv.cash], ['grenades', inv.grenades], ['charges', inv.charges], ['medkits', inv.medkits], ['traps', inv.traps],
  ];
  for (const [k, n] of Object.entries(inv.pieces ?? {})) if (n !== undefined) out.push([`pieces.${k}`, n]);
  for (const [k, n] of Object.entries(inv.potions ?? {})) if (n !== undefined) out.push([`potions.${k}`, n]);
  for (const [k, a] of Object.entries(inv.weapons ?? {}))
    if (a) out.push([`weapons.${k}.mag`, a.mag], [`weapons.${k}.spare`, a.spare]);
  return out;
}

// ---- support (mirror of support.ts without a physics world) ----

/** support.ts constants, plus slack so this check is strictly MORE permissive than the sim's. */
const GROUND_EPS = 0.12;
const TOUCH_EPS = 0.06;
const SLACK = 0.03;
const ISLAND_DEPTH = 12;

type Obb = { cx: number; cz: number; hx: number; hz: number; rotY: number; y0: number; y1: number };

function worldBoxes(map: IslandLayout[], docks: readonly Box[]): Obb[] {
  const out: Obb[] = [];
  const push = (b: Box) => out.push({ cx: b.center.x, cz: b.center.z, hx: b.half.x, hz: b.half.z, rotY: b.rotY, y0: b.center.y - b.half.y, y1: b.center.y + b.half.y });
  for (const d of docks) push(d); // standing pier sections
  for (const isl of map) {
    for (const b of bunkerWallBoxes(isl.bunker)) push(b);
    for (const key of ['generator', 'vault', 'shop'] as const) {
      const p = isl[key], h = PROP_HALF[key];
      push({ center: v3(p.x, p.y + h.y, p.z), half: h, rotY: isl.bunker.facingYaw });
    }
  }
  return out;
}

const insideXZ = (b: Obb, x: number, z: number, pad: number) => {
  const l = rotateY(v3(x - b.cx, 0, z - b.cz), -b.rotY);
  return Math.abs(l.x) <= b.hx + pad && Math.abs(l.z) <= b.hz + pad;
};

/** 2D separating-axis overlap of two Y-rotated rectangles. */
function overlapXZ(a: Obb, b: Obb): boolean {
  const axes = [a.rotY, b.rotY].flatMap((r) => [rotateY(v3(1, 0, 0), r), rotateY(v3(0, 0, 1), r)]);
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  const radius = (o: Obb, ax: Vec3) => {
    const ux = rotateY(v3(1, 0, 0), o.rotY), uz = rotateY(v3(0, 0, 1), o.rotY);
    return o.hx * Math.abs(ux.x * ax.x + ux.z * ax.z) + o.hz * Math.abs(uz.x * ax.x + uz.z * ax.z);
  };
  return axes.every((ax) => Math.abs(dx * ax.x + dz * ax.z) <= radius(a, ax) + radius(b, ax));
}

const pieceBox = (p: PieceState, pad: number): Obb => {
  const s = PIECES[p.kind];
  return { cx: p.pos.x, cz: p.pos.z, hx: s.w / 2 + pad, hz: s.d / 2 + pad, rotY: p.rotY, y0: p.pos.y - pad, y1: p.pos.y + s.h + pad };
};

/**
 * Ids of pieces with no chain of touching pieces down to solid ground — the rule of support.ts
 * `unsupportedPieces`, evaluated analytically. Every approximation errs toward "supported" (so a piece
 * flagged here is one the sim's own rule would certainly collapse):
 * - grounded: any of the same 5 footprint samples is over the island disc or a static box (bunker walls/roof,
 *   generator/vault/shop props) whose vertical extent meets [y − 0.12, y + 0.12] (the sim's probe band); the
 *   sim additionally requires that no piece is hit first.
 * - touching: boxes overlap after growing the query piece by TOUCH_EPS (+ slack); ramps use their full box,
 *   a superset of their wedge collider.
 */
export function floatingPieces(map: IslandLayout[], pieces: PieceState[], docks: readonly Box[] = []): number[] {
  const boxes = worldBoxes(map, docks);
  const band = GROUND_EPS + SLACK;
  const grounded = (p: PieceState) => {
    const s = PIECES[p.kind];
    const hx = s.w / 2 - 0.05, hz = s.d / 2 - 0.05;
    for (const local of [v3(0, 0, 0), v3(-hx, 0, -hz), v3(hx, 0, -hz), v3(-hx, 0, hz), v3(hx, 0, hz)]) {
      const w = rotateY(local, p.rotY);
      const x = p.pos.x + w.x, z = p.pos.z + w.z;
      for (const isl of map)
        if (dist2D({ x, z }, isl.center) <= isl.radius + SLACK && p.pos.y <= isl.groundY + band && p.pos.y >= isl.groundY - ISLAND_DEPTH - band)
          return true;
      for (const b of boxes)
        if (insideXZ(b, x, z, SLACK) && b.y1 >= p.pos.y - band && b.y0 <= p.pos.y + band) return true;
    }
    return false;
  };
  const reached = new Set<number>();
  const queue: PieceState[] = [];
  for (const p of pieces) if (grounded(p)) { reached.add(p.id); queue.push(p); }
  const plain = pieces.map((p) => ({ p, box: pieceBox(p, 0) }));
  while (queue.length) {
    const q = pieceBox(queue.pop()!, TOUCH_EPS + SLACK);
    for (const { p, box } of plain) {
      if (reached.has(p.id)) continue;
      if (box.y1 < q.y0 || box.y0 > q.y1 || !overlapXZ(q, box)) continue;
      reached.add(p.id);
      queue.push(p);
    }
  }
  return pieces.filter((p) => !reached.has(p.id)).map((p) => p.id);
}
