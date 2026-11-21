import { CHARGE, GRENADE, WEAPONS } from './constants';
import { COSMETIC, type CosmeticDef } from './map';
import type { MatchEvent, Vec3, WeaponKind } from './types';

/**
 * Breakable decoration (barrels, crates, fences, palms, lamps, bollards). Sim-authoritative hit points so
 * every client agrees on what is broken, but no colliders at all: they never block players, bullets,
 * pieces, seals or support. A bullet passing through one damages it and carries on.
 */
export class Cosmetics {
  private hp = new Map<number, number>();
  /** Ids broken so far, in order (part of every snapshot). */
  readonly broken: number[] = [];

  constructor(private readonly defs: CosmeticDef[]) {
    for (const d of defs) this.hp.set(d.id, COSMETIC[d.kind].hp);
  }

  /** Apply this tick's shots and explosions; returns `cosmeticBroken` events. */
  onEvents(events: MatchEvent[], now: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    for (const e of events) {
      if (e.type === 'shot') {
        const w = WEAPONS[e.data.weapon as WeaponKind];
        if (!w || e.data.weapon === 'fists') continue;
        this.segment(e.data.from as Vec3, e.data.to as Vec3, w.dmg * w.pellets, now, out);
      } else if (e.type === 'explosion') {
        const k = e.data.kind;
        const r = k === 'grenade' ? GRENADE.radius : k === 'charge' ? CHARGE.radius + 1 : 3;
        this.blast(e.data.pos as Vec3, r, 200, now, out);
      }
    }
    return out;
  }

  /** Damage everything a bullet path from→to passes through. */
  segment(from: Vec3, to: Vec3, dmg: number, now: number, out: MatchEvent[]) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const l2 = dx * dx + dz * dz;
    for (const d of this.defs) {
      if (!this.hp.has(d.id)) continue;
      const c = COSMETIC[d.kind];
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((d.pos.x - from.x) * dx + (d.pos.z - from.z) * dz) / l2));
      const px = from.x + dx * t - d.pos.x, pz = from.z + dz * t - d.pos.z;
      if (px * px + pz * pz > c.r * c.r) continue;
      const y = from.y + dy * t;
      if (y < d.pos.y || y > d.pos.y + c.h) continue;
      this.damage(d, dmg, now, out);
    }
  }

  blast(pos: Vec3, radius: number, dmg: number, now: number, out: MatchEvent[]) {
    for (const d of this.defs) {
      if (!this.hp.has(d.id)) continue;
      const c = COSMETIC[d.kind];
      const y = Math.max(d.pos.y, Math.min(d.pos.y + c.h, pos.y));
      const dist = Math.max(0, Math.hypot(d.pos.x - pos.x, y - pos.y, d.pos.z - pos.z) - c.r);
      if (dist < radius) this.damage(d, dmg * (1 - dist / radius), now, out);
    }
  }

  /** Fire damage over time on one prop (sim/fire.ts). */
  burn(id: number, dmg: number, now: number, out: MatchEvent[]) {
    const d = this.defs.find((x) => x.id === id);
    if (d && this.hp.has(id)) this.damage(d, dmg, now, out);
  }

  private damage(d: CosmeticDef, dmg: number, now: number, out: MatchEvent[]) {
    const left = (this.hp.get(d.id) ?? 0) - dmg;
    if (left > 0) { this.hp.set(d.id, left); return; }
    this.hp.delete(d.id);
    this.broken.push(d.id);
    out.push({ t: now, type: 'cosmeticBroken', data: { id: d.id, kind: d.kind, pos: d.pos, rotY: d.rotY } });
  }

  hpOf(id: number): number | null {
    return this.hp.get(id) ?? null;
  }
}
