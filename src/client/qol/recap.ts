import type { Snapshot, Vec3 } from '../../sim/types';

/**
 * Death recap (pure): remembers the hits you took over the last 10 s and, when a kill event names you as
 * the victim, sums them up: who killed you, with what, from how far, headshot or not, damage by source and
 * what the killer had left.
 */

export const RECAP_WINDOW_SEC = 10;
export type DamageSource = 'bullets' | 'melee' | 'explosion' | 'fall' | 'water' | 'other';
export const SOURCE_LABEL: Record<DamageSource, string> = {
  bullets: 'Bullets', melee: 'Melee', explosion: 'Explosions', fall: 'Fall', water: 'Water', other: 'Other',
};

export type Recap = {
  killer: { id: number; name: string; island: number } | null;
  /** Weapon / cause key for the icon (pistol, rocket, grenade, fall, water…), null if unknown. */
  weapon: string | null;
  distance: number | null;
  headshot: boolean;
  /** Damage taken in the last 10 s, by source (only sources that did something). */
  bySource: { source: DamageSource; amount: number }[];
  killerHp: number | null;
  killerShield: number | null;
  /** One line: "Killed by Rex", "You drowned", "You fell", "You blew yourself up"… */
  title: string;
};

type Hit = { t: number; by: number | null; amount: number; source: DamageSource; weapon: string | null; part: unknown };

const GUNS = new Set(['pistol', 'smg', 'shotgun', 'rifle']);
const BLASTS = new Set(['rocket', 'grenade', 'charge']);

export function sourceOf(weapon: unknown, by: unknown): DamageSource {
  if (weapon === 'fists') return 'melee';
  if (typeof weapon === 'string' && GUNS.has(weapon)) return 'bullets';
  if (typeof weapon === 'string' && BLASTS.has(weapon)) return 'explosion';
  if (weapon === 'fall') return 'fall';
  return typeof by === 'number' ? 'explosion' : 'other';
}

export class RecapTracker {
  private hits: Hit[] = [];
  private lastPos: Vec3 | null = null;
  /** HP + shield while last alive (what the water took when you drown). */
  private lastHealth = 0;

  /** Feed every applied snapshot. Returns a recap on the snapshot where you died, else null. */
  onSnapshot(s: Snapshot, humanId: number): Recap | null {
    let recap: Recap | null = null;
    for (const e of s.events) {
      const d = e.data;
      if (e.type === 'hit' && d.target === humanId) {
        const amount = Number(d.amount) || 0;
        if (amount > 0) this.hits.push({ t: e.t, by: typeof d.by === 'number' ? d.by : null, amount, source: sourceOf(d.weapon, d.by), weapon: typeof d.weapon === 'string' ? d.weapon : null, part: d.part });
      } else if (e.type === 'kill' && d.victim === humanId) {
        recap = this.build(s, humanId, typeof d.killer === 'number' ? d.killer : null, d.inWater === true, e.t);
      }
    }
    const me = s.players.find((p) => p.id === humanId);
    if (me?.alive) { this.lastPos = { ...me.pos }; this.lastHealth = me.hp + (me.shield ?? 0); }
    const cut = s.time - RECAP_WINDOW_SEC;
    if (this.hits.length && this.hits[0].t < cut) this.hits = this.hits.filter((h) => h.t >= cut);
    return recap;
  }

  private build(s: Snapshot, humanId: number, killerId: number | null, inWater: boolean, t: number): Recap {
    const recent = this.hits.filter((h) => h.t >= t - RECAP_WINDOW_SEC);
    const sums = new Map<DamageSource, number>();
    for (const h of recent) sums.set(h.source, (sums.get(h.source) ?? 0) + h.amount);
    if (inWater) sums.set('water', (sums.get('water') ?? 0) + Math.max(1, Math.round(this.lastHealth)));
    const bySource = [...sums].map(([source, amount]) => ({ source, amount: Math.round(amount) })).filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const lastHit = recent[recent.length - 1];
    const self = killerId === humanId;
    const k = killerId !== null && !self ? s.players.find((p) => p.id === killerId) : undefined;
    const kHits = k ? recent.filter((h) => h.by === k.id) : [];
    const kLast = kHits[kHits.length - 1];
    const hidden = k ? !!s.hidden?.includes(k.id) : true;
    let weapon: string | null = inWater ? 'water' : kLast?.weapon ?? (k && !hidden && k.equipped !== 'fists' ? k.equipped : null) ?? lastHit?.weapon ?? null;
    if (!k && !inWater && lastHit?.source === 'fall') weapon = 'fall';
    const distance = k && !hidden && k.alive && this.lastPos ? Math.round(Math.hypot(k.pos.x - this.lastPos.x, k.pos.y - this.lastPos.y, k.pos.z - this.lastPos.z)) : null;
    const title = k ? `Killed by ${k.name}`
      : inWater ? 'You drowned'
      : self ? 'You blew yourself up'
      : weapon === 'fall' ? 'You fell to your death'
      : 'You died';
    this.hits = [];
    return {
      killer: k ? { id: k.id, name: k.name, island: k.island } : null,
      weapon, distance, headshot: !!kLast && kLast.part === 'head', bySource,
      killerHp: k && !hidden ? Math.max(0, Math.ceil(k.hp)) : null,
      killerShield: k && !hidden ? Math.max(0, Math.ceil(k.shield ?? 0)) : null,
      title,
    };
  }
}
