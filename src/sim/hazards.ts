import { CHARGE, CRATE_LOOT, GRENADE, HAZARD, MAP, ROCKET, WEAPONS } from './constants';
import * as dm from './dmath';
import { applyPlayerDamage, friendlyFire, hitPiece, nearestOnBody, nearestOnPiece, type CombatCtx } from './combat';
import { emptyInventory } from './economy';
import { hash01 } from './gunplay';
import type { CenterIsland, HazardDef, HazardKind, MapDef, StaticBox } from './map';
import type { GunKind, HazardNet, Inventory, LootBag, MatchEvent, PlayerState, Vec3 } from './types';
import { dist, dist2D, norm, rotateY, sub, v3 } from './vec';

/**
 * Explosive barrels, propane tanks and lootable supply crates (MapDef.hazards). Sim-authoritative and
 * deterministic: no randomness except the crate loot roll, which hashes (match seed, crate id, times broken).
 *
 * - Bullets stop at them and hurt them (combat.ts asks `ray` / `damage`); fists only hurt crates.
 * - A barrel/tank shot to 0 hp fuses for HAZARD.fuseSec (leaks, hisses, flashes), then blows. A grenade,
 *   rocket or charge blast sets it off at once; a hazard blast sets off the next one HAZARD.chainSec later.
 * - The blast is grenade-like with a bigger radius: players (shield first; a quarter through a wall), pieces,
 *   crates and other hazards. Damage and kills are credited to whoever set the first one off (`by`), and
 *   carry `weapon: 'barrel' | 'propane'` so the feed says "X via barrel".
 * - A broken crate drops a small random loot bag (crateLoot).
 * - Gone ones come back after respawnSec once no live player is within HAZARD.respawnClearM.
 *
 * Physics props hook: the live position is `HazardState.pos` (seeded from the def); a mover may change it
 * with `moveTo`. Everything here reads only that, never the def position.
 */
export type HazardState = {
  def: HazardDef;
  pos: Vec3;
  hp: number;
  /** 0 intact/damaged, 1 fusing, 2 gone. */
  st: 0 | 1 | 2;
  /** Fusing: blows at this sim time. */
  blowAt: number;
  /** Who set it off / broke it (kill credit, loot roll). */
  by: number | null;
  goneAt: number;
  /** Times broken so far (loot roll salt). */
  gen: number;
};

export const hazardSpec = (k: HazardKind) => HAZARD[k];
export const isExplosive = (k: HazardKind) => k !== 'crate';

const ev = (t: number, type: MatchEvent['type'], data: Record<string, unknown>): MatchEvent => ({ t, type, data });
const r2 = (n: number) => Math.round(n * 100) / 100;

/** What a non-hazard blast does to hazards: radius and crate damage at the centre. */
const BLASTS: Record<string, { radius: number; dmg: number }> = {
  grenade: { radius: GRENADE.radius, dmg: GRENADE.dmg },
  rocket: { radius: ROCKET.radius, dmg: ROCKET.playerDmg },
  charge: { radius: CHARGE.radius + 1, dmg: 200 },
};

/** Distance along a unit ray to an upright cylinder (side or top), or null. */
export function rayCylinder(o: Vec3, d: Vec3, base: Vec3, r: number, h: number, maxDist: number): number | null {
  let best: number | null = null;
  const ox = o.x - base.x, oz = o.z - base.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        if (t < 0 || t > maxDist) continue;
        const y = o.y + d.y * t;
        if (y >= base.y && y <= base.y + h) { best = t; break; }
      }
      // Starting inside the cylinder's footprint and height: hit at once.
      if (best === null && c <= 0 && o.y >= base.y && o.y <= base.y + h) best = 0;
    }
  }
  if (Math.abs(d.y) > 1e-9) {
    for (const y of [base.y + h, base.y]) {
      const t = (y - o.y) / d.y;
      if (t < 0 || t > maxDist || (best !== null && t >= best)) continue;
      const x = ox + d.x * t, z = oz + d.z * t;
      if (x * x + z * z <= r * r) best = t;
    }
  }
  return best;
}

/** Distance from a point to an upright cylinder's surface (0 inside). */
export function distToCylinder(p: Vec3, base: Vec3, r: number, h: number): number {
  const y = Math.max(base.y, Math.min(base.y + h, p.y));
  const radial = Math.max(0, Math.hypot(p.x - base.x, p.z - base.z) - r);
  return Math.hypot(radial, p.y - y);
}

const GUN_ORDER: GunKind[] = ['rifle', 'smg', 'shotgun', 'pistol', 'rocket'];

/** The gun a crate's ammo drop is for: the one in hand, else the first owned in GUN_ORDER; null if none. */
export function ammoGunFor(p: Pick<PlayerState, 'equipped' | 'inv'> | null): GunKind | null {
  if (!p) return null;
  if (p.equipped !== 'fists' && p.inv.weapons[p.equipped]) return p.equipped;
  return GUN_ORDER.find((g) => !!p.inv.weapons[g]) ?? null;
}

export type CrateDrop = { what: 'ammo' | 'medkit' | 'cash' | 'grenade' | 'sandbags'; inv: Inventory; ammoOnly: boolean };

/**
 * The loot a crate drops: weighted roll on CRATE_LOOT, from two uniform numbers (hashes of seed, crate id,
 * times broken). Ammo is a magazine (one rocket) for `gun`, else the roll becomes cash.
 */
export function crateLoot(u1: number, u2: number, gun: GunKind | null): CrateDrop {
  const w = CRATE_LOOT.weights;
  const total = w.ammo + w.medkit + w.cash + w.grenade + w.sandbags;
  let x = u1 * total;
  const order = ['ammo', 'medkit', 'cash', 'grenade', 'sandbags'] as const;
  let what: CrateDrop['what'] = 'sandbags';
  for (const k of order) { if (x < w[k]) { what = k; break; } x -= w[k]; }
  if (what === 'ammo' && !gun) what = 'cash';
  const inv = emptyInventory();
  if (what === 'ammo') {
    const n = gun === 'rocket' ? CRATE_LOOT.rockets : WEAPONS[gun!].mag;
    inv.weapons[gun!] = { mag: 0, spare: n };
  } else if (what === 'medkit') inv.medkits = 1;
  else if (what === 'grenade') inv.grenades = 1;
  else if (what === 'sandbags') inv.pieces.sandbags = CRATE_LOOT.sandbags;
  else {
    const { min, max, step } = CRATE_LOOT.cash;
    const steps = Math.floor((max - min) / step) + 1;
    inv.cash = min + Math.min(steps - 1, Math.floor(u2 * steps)) * step;
  }
  return { what, inv, ammoOnly: what === 'ammo' };
}

export type HazardHost = {
  ctx: CombatCtx;
  loot: Map<number, LootBag>;
  seed: number;
};

export class Hazards {
  readonly list: HazardState[];
  private byId = new Map<number, HazardState>();

  constructor(defs: HazardDef[]) {
    this.list = defs.map((def) => ({ def, pos: { ...def.pos }, hp: HAZARD[def.kind].hp, st: 0, blowAt: 0, by: null, goneAt: 0, gen: 0 }));
    for (const h of this.list) this.byId.set(h.def.id, h);
  }

  get(id: number): HazardState | undefined { return this.byId.get(id); }

  /** Physics-prop hook: a mover pushed this hazard (feet position). */
  moveTo(id: number, pos: Vec3): void {
    const h = this.byId.get(id);
    if (!h) throw new Error(`Hazards.moveTo: no hazard ${id}`);
    h.pos = { ...pos };
  }

  /** Middle of a hazard's body (explosion origin, aim point). */
  center(h: HazardState): Vec3 {
    return v3(h.pos.x, h.pos.y + HAZARD[h.def.kind].h / 2, h.pos.z);
  }

  /** First standing (not gone) hazard along a unit ray within maxDist. */
  ray(o: Vec3, d: Vec3, maxDist: number): { id: number; dist: number } | null {
    let best: { id: number; dist: number } | null = null;
    for (const h of this.list) {
      if (h.st === 2) continue;
      const s = HAZARD[h.def.kind];
      // Cheap reject: the ray's closest approach to the hazard's middle.
      const cx = h.pos.x - o.x, cy = h.pos.y + s.h / 2 - o.y, cz = h.pos.z - o.z;
      const along = cx * d.x + cy * d.y + cz * d.z;
      if (along < -s.h || along > maxDist + s.h) continue;
      const t = rayCylinder(o, d, h.pos, s.r, s.h, best ? best.dist : maxDist);
      if (t !== null && (!best || t < best.dist)) best = { id: h.def.id, dist: t };
    }
    return best;
  }

  /**
   * Damage one hazard. Bullets: a barrel/tank at 0 hp starts its fuse; fists don't hurt those. Explosive:
   * sets a barrel/tank off after `delay` (0 = this tick). A crate at 0 hp breaks and drops loot.
   */
  damage(host: HazardHost, id: number, amount: number, source: 'bullet' | 'fist' | 'explosive', by: number | null, now: number, at?: Vec3, delay = 0): MatchEvent[] {
    const h = this.byId.get(id);
    if (!h || h.st === 2) return [];
    const kind = h.def.kind;
    const out: MatchEvent[] = [];
    if (isExplosive(kind)) {
      if (source === 'fist') return [];
      if (source === 'explosive') {
        if (h.st === 1 && h.blowAt <= now + delay) return [];
        if (h.st === 0) { h.by = by; out.push(ev(now, 'hazard', { what: 'fuse', id, kind, pos: h.pos, by, sec: delay })); }
        h.st = 1;
        h.hp = 0;
        h.blowAt = now + delay;
        return out;
      }
      if (h.st === 1) return [];
      h.hp -= amount;
      if (at) out.push(ev(now, 'hazard', { what: 'hit', id, kind, pos: { x: r2(at.x), y: r2(at.y), z: r2(at.z) }, by }));
      if (h.hp <= 0) {
        h.hp = 0;
        h.st = 1;
        h.by = by;
        h.blowAt = now + HAZARD.fuseSec;
        out.push(ev(now, 'hazard', { what: 'fuse', id, kind, pos: h.pos, by, sec: HAZARD.fuseSec }));
      }
      return out;
    }
    h.hp -= amount;
    if (at) out.push(ev(now, 'hazard', { what: 'hit', id, kind, pos: { x: r2(at.x), y: r2(at.y), z: r2(at.z) }, by }));
    if (h.hp > 0) return out;
    out.push(...this.breakCrate(host, h, by, now));
    return out;
  }

  private breakCrate(host: HazardHost, h: HazardState, by: number | null, now: number): MatchEvent[] {
    h.st = 2;
    h.hp = 0;
    h.by = by;
    h.goneAt = now;
    const breaker = by !== null ? host.ctx.players.get(by) ?? null : null;
    const salt = h.def.id * 4096 + h.gen;
    const drop = crateLoot(hash01(host.seed, salt, 71), hash01(host.seed, salt, 72), ammoGunFor(breaker));
    h.gen++;
    const id = host.ctx.nextId();
    const bag: LootBag = { id, pos: { ...h.pos }, inv: drop.inv };
    if (drop.ammoOnly) bag.ammoOnly = true;
    host.loot.set(id, bag);
    return [ev(now, 'hazard', { what: 'break', id: h.def.id, kind: h.def.kind, pos: h.pos, rotY: h.def.rotY, by, loot: drop.what })];
  }

  /** This tick's grenade / rocket / charge blasts (combat events): set hazards off, smash crates. */
  onExplosions(host: HazardHost, events: MatchEvent[], now: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    for (const e of events) {
      if (e.type !== 'explosion' || e.data.hazard !== undefined) continue;
      const b = BLASTS[e.data.kind as string];
      const pos = e.data.pos as Vec3 | undefined;
      if (!b || !pos) continue;
      out.push(...this.blastHazards(host, pos, b.radius, b.dmg, (e.data.by as number | null) ?? null, now, 0));
    }
    return out;
  }

  private blastHazards(host: HazardHost, pos: Vec3, radius: number, dmg: number, by: number | null, now: number, delay: number, skip?: HazardState): MatchEvent[] {
    const out: MatchEvent[] = [];
    for (const h of this.list) {
      if (h === skip || h.st === 2) continue;
      const s = HAZARD[h.def.kind];
      const d = distToCylinder(pos, h.pos, s.r, s.h);
      if (d >= radius) continue;
      out.push(...this.damage(host, h.def.id, dmg * (1 - d / radius), 'explosive', by, now, undefined, delay));
    }
    return out;
  }

  /** Blow everything whose fuse is up (chains follow later ticks), then bring back what may respawn. */
  tick(host: HazardHost, now: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    // Due ones in id order (deterministic); a blast this tick only queues its neighbours (chainSec later),
    // except a zero-delay chain, which the loop picks up because it rescans until nothing is due.
    for (let guard = 0; guard < this.list.length + 1; guard++) {
      const due = this.list.filter((h) => h.st === 1 && h.blowAt <= now + 1e-9);
      if (!due.length) break;
      for (const h of due) if (h.st === 1) out.push(...this.blow(host, h, now));
    }
    for (const h of this.list) {
      if (h.st !== 2 || now < h.goneAt + HAZARD[h.def.kind].respawnSec) continue;
      let clear = true;
      for (const p of host.ctx.players.values()) if (p.alive && dist(p.pos, h.pos) < HAZARD.respawnClearM) { clear = false; break; }
      if (!clear) continue;
      h.st = 0;
      h.hp = HAZARD[h.def.kind].hp;
      h.by = null;
      out.push(ev(now, 'hazard', { what: 'respawn', id: h.def.id, kind: h.def.kind, pos: h.pos }));
    }
    return out;
  }

  private blow(host: HazardHost, h: HazardState, now: number): MatchEvent[] {
    const { ctx } = host;
    const kind = h.def.kind;
    const s = HAZARD[kind];
    const c = this.center(h);
    const by = h.by;
    h.st = 2;
    h.hp = 0;
    h.goneAt = now;
    h.gen++;
    const out: MatchEvent[] = [ev(now, 'explosion', { kind, pos: { x: r2(c.x), y: r2(c.y), z: r2(c.z) }, by, hazard: h.def.id, radius: s.radius })];
    const R = s.radius;
    for (const pl of ctx.players.values()) {
      if (!pl.alive) continue;
      const { point, d } = nearestOnBody(pl, c);
      if (d >= R) continue;
      // A wall between the blast and the body takes most of it (a quarter gets through), as for rockets.
      let shield = 1;
      if (d > 0.3) {
        const block = ctx.physics.raycast(c, norm(sub(point, c)), d - 0.05);
        if (block && !(block.hit.type === 'player' && block.hit.id === pl.id)) shield = 0.25;
      }
      const f = (1 - d / R) * shield;
      out.push(...applyPlayerDamage(ctx, pl, s.dmg * f, by, now, { pos: { x: r2(point.x), y: r2(point.y), z: r2(point.z) }, weapon: kind }));
      if (pl.alive && ctx.onKnockback && !friendlyFire(ctx, by, pl)) {
        const away = norm(sub(v3(pl.pos.x, pl.pos.y + 0.9, pl.pos.z), c));
        ctx.onKnockback(pl.id, v3(away.x * HAZARD.knock * f, HAZARD.knockUp * f, away.z * HAZARD.knock * f));
      }
    }
    for (const pc of [...ctx.pieces.values()]) {
      const { point, d } = nearestOnPiece(pc, c);
      if (d < R) out.push(...hitPiece(ctx, pc.id, s.pieceDmg * (1 - d / R), 'explosive', now, by, point));
    }
    out.push(...this.blastHazards(host, c, R, s.dmg, by, now, HAZARD.chainSec, h));
    return out;
  }

  /** Snapshot state: only hazards that aren't intact at full health. */
  net(): HazardNet[] | undefined {
    let out: HazardNet[] | undefined;
    for (const h of this.list) {
      const max = HAZARD[h.def.kind].hp;
      if (h.st === 0 && h.hp >= max) continue;
      (out ??= []).push({ id: h.def.id, st: h.st, hp: Math.max(0, Math.ceil(h.hp)) });
    }
    return out;
  }
}

/** Why a hazard can't stand here (null = fine): bunker, doorway, no-build zone, station, cover, off the island. */
export function hazardSpotProblem(def: Pick<MapDef, 'islands' | 'center' | 'statics'>, pos: Vec3, kind: HazardKind): string | null {
  const r = HAZARD[kind].r;
  const isl = def.islands.find((i) => dist2D(i.center, pos) < i.radius + 1);
  const c: CenterIsland = def.center;
  if (isl) {
    if (dist2D(isl.center, pos) > isl.radius - 1.5 - r) return 'too close to the island edge';
    const b = isl.bunker;
    const local = rotateY(sub(pos, b.center), -b.facingYaw);
    const outer = MAP.bunker.interior / 2 + MAP.bunker.wall;
    if (Math.abs(local.x) < outer + 2 && Math.abs(local.z) < outer + 2) return 'in or against a bunker';
    for (const d of b.doorways) if (dist2D(d.center, pos) < 3.5) return 'in a bunker doorway';
    for (const z of noBuildZones(isl)) {
      const l = rotateY(sub(pos, z.center), -z.rotY);
      if (Math.abs(l.x) < z.half.x + 1 && Math.abs(l.z) < z.half.z + 1) return 'in a no-build zone';
    }
    for (const st of [isl.generator, isl.vault, isl.shop]) if (dist2D(st, pos) < 3) return 'blocks a station';
  } else {
    if (dist2D(c.center, pos) > c.radius - 1.2 - r) return 'off the center island';
    for (const st of [c.goldGen, c.supplyGen, c.potionShop]) if (dist2D(st, pos) < 3) return 'blocks a station';
    if (dist2D(c.shieldWell, pos) < 3.5) return 'in the shield well';
  }
  for (const s of def.statics) if (distToBox2D(pos, s) < r + 1) return 'inside cover';
  return null;
}

/**
 * Painted no-build zones (the hatched pad in front of each bunker door, see client textures): oriented boxes.
 * The pad is 2.2 m wide and 2 m deep, 3.7 m out from the bunker centre toward the island centre.
 */
export function noBuildZones(isl: MapDef['islands'][number]): { center: Vec3; half: Vec3; rotY: number }[] {
  const b = isl.bunker;
  const fwd = v3(-dm.sin(b.facingYaw), 0, -dm.cos(b.facingYaw));
  return [{ center: v3(b.center.x + fwd.x * 3.7, b.center.y, b.center.z + fwd.z * 3.7), half: v3(1.1, 0.5, 1), rotY: b.facingYaw }];
}

function distToBox2D(p: Vec3, s: StaticBox): number {
  const l = rotateY(sub(p, s.center), -s.rotY);
  const dx = Math.max(0, Math.abs(l.x) - s.half.x), dz = Math.max(0, Math.abs(l.z) - s.half.z);
  return Math.hypot(dx, dz);
}
