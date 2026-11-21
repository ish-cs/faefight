import { DOCK } from './constants';
import type { DockDef } from './map';
import type { MatchEvent, Vec3 } from './types';
import { rotateY, sub } from './vec';

/** Distance from p to the nearest point of a dock section's box (0 inside). */
export function dockDist(d: DockDef, p: Vec3): number {
  const l = rotateY(sub(p, d.center), -d.rotY);
  const ex = Math.max(0, Math.abs(l.x) - d.half.x), ey = Math.max(0, Math.abs(l.y) - d.half.y), ez = Math.max(0, Math.abs(l.z) - d.half.z);
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/** Is (x, z) over this section's deck (grown by `pad`)? */
export function overDock(d: DockDef, p: { x: number; z: number }, pad = 0): boolean {
  const l = rotateY({ x: p.x - d.center.x, y: 0, z: p.z - d.center.z }, -d.rotY);
  return Math.abs(l.x) <= d.half.x + pad && Math.abs(l.z) <= d.half.z + pad;
}

/**
 * Wooden pier sections (MapDef.docks): sim-authoritative hit points, broken only by explosions (rockets, grenades,
 * charges, barrels, propane), damage per kind from DOCK.blast measured to the section's box. A broken section's
 * collider goes (the caller removes it), so players and pieces on it fall into the water. Deterministic: no
 * randomness, events in dock-id order.
 */
export class Docks {
  private hp = new Map<number, number>();
  /** Ids broken so far, in order (snapshot `docks`). */
  readonly broken: number[] = [];
  /** Ids damaged but still standing, in the order first hit (snapshot `dockHurt`: scorched decks). */
  readonly hurt: number[] = [];

  constructor(readonly defs: DockDef[]) {
    for (const d of defs) this.hp.set(d.id, DOCK.hp);
  }

  /** Standing sections (bots, tests). The same array until one breaks: callers must not change it. */
  standing(): readonly DockDef[] {
    if (this.up?.n !== this.broken.length) this.up = { n: this.broken.length, list: this.defs.filter((d) => this.hp.has(d.id)) };
    return this.up.list;
  }
  private up: { n: number; list: DockDef[] } | null = null;

  hpOf(id: number): number | null {
    return this.hp.get(id) ?? null;
  }

  /** Apply this tick's explosions; returns `dockBroken` events (data: id, island, row, pos, rotY, by, kind). */
  onEvents(events: readonly MatchEvent[], now: number): MatchEvent[] {
    const out: MatchEvent[] = [];
    if (!this.hp.size) return out;
    for (const e of events) {
      if (e.type !== 'explosion') continue;
      const blast = DOCK.blast[e.data.kind as string];
      if (!blast) continue;
      const [dmg, reach] = blast;
      const pos = e.data.pos as Vec3;
      for (const d of this.defs) {
        const left = this.hp.get(d.id);
        if (left === undefined) continue;
        const dist = dockDist(d, pos);
        if (dist >= reach) continue;
        const hp = left - dmg * (1 - dist / reach);
        if (hp > 0) {
          if (left === DOCK.hp) this.hurt.push(d.id);
          this.hp.set(d.id, hp);
          continue;
        }
        this.hp.delete(d.id);
        this.broken.push(d.id);
        const i = this.hurt.indexOf(d.id);
        if (i >= 0) this.hurt.splice(i, 1);
        out.push({ t: now, type: 'dockBroken', data: { id: d.id, island: d.island, row: d.row, pos: d.center, rotY: d.rotY, by: (e.data.by as number | null) ?? null, kind: e.data.kind } });
      }
    }
    return out;
  }
}
