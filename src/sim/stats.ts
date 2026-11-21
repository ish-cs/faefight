import type { MatchEvent, PlayerState, PlayerStats } from './types';

type Counters = Omit<PlayerStats, 'id' | 'kills' | 'deaths'>;
const zero = (): Counters => ({ damage: 0, seals: 0, built: 0, cash: 0, longestLife: 0, headshots: 0 });

/**
 * Match totals for the end-screen summary. Fed from each tick's events (hits, seals, placements) plus the
 * players' alive flags (longest life); kills/deaths come straight from PlayerState. Pure bookkeeping:
 * nothing here changes the game.
 */
export class MatchStats {
  private rows = new Map<number, Counters>();
  /** Sim time each living player's current life started. */
  private lifeStart = new Map<number, number>();

  private row(id: number): Counters {
    let r = this.rows.get(id);
    if (!r) { r = zero(); this.rows.set(id, r); }
    return r;
  }

  /** Cash a player collected from a generator. */
  earned(id: number, amount: number) {
    if (amount > 0) this.row(id).cash += amount;
  }

  /** Call once per tick after the tick's events are final. */
  onTick(events: readonly MatchEvent[], players: Iterable<PlayerState>, now: number) {
    for (const e of events) {
      const d = e.data;
      if (e.type === 'hit') {
        const by = d.by, target = d.target;
        if (typeof by !== 'number' || by === target) continue;
        const r = this.row(by);
        r.damage += Number(d.amount) || 0;
        if (d.part === 'head') r.headshots++;
      } else if (e.type === 'sealed' && typeof d.by === 'number') {
        this.row(d.by).seals++;
      } else if (e.type === 'placed' && typeof d.by === 'number') {
        this.row(d.by).built++;
      }
    }
    for (const p of players) {
      const start = this.lifeStart.get(p.id);
      if (p.alive && start === undefined) this.lifeStart.set(p.id, now);
      else if (!p.alive && start !== undefined) {
        const r = this.row(p.id);
        r.longestLife = Math.max(r.longestLife, now - start);
        this.lifeStart.delete(p.id);
      }
    }
  }

  /** Totals as of `now` (a life still going counts up to now). */
  totals(players: Iterable<PlayerState>, now: number): PlayerStats[] {
    const out: PlayerStats[] = [];
    for (const p of players) {
      const r = this.rows.get(p.id) ?? zero();
      const start = this.lifeStart.get(p.id);
      const life = start === undefined ? 0 : now - start;
      out.push({
        id: p.id, kills: p.kills, deaths: p.deaths, damage: Math.round(r.damage), seals: r.seals, built: r.built,
        cash: Math.round(r.cash), longestLife: Math.round(Math.max(r.longestLife, life) * 10) / 10, headshots: r.headshots,
      });
    }
    return out;
  }
}
