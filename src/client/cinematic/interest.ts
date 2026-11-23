/**
 * Cinematic mode, part 1: what is worth watching right now. Pure (no DOM / three.js): reads snapshots
 * (players, events, projectiles, the host-side bot brains when present) and scores storylines per player.
 * The director (director.ts) picks shots from these with hysteresis.
 */

export type ShotKind = 'shoulder' | 'wide' | 'orbit' | 'drone';
export type ShotReason = 'duel' | 'clutch' | 'seal' | 'hunt' | 'rocket' | 'parkour' | 'leader' | 'elimination' | 'suddenDeath' | 'idle';

type V3 = { x: number; y: number; z: number };
/** The slice of a snapshot the scoring reads (structural, so tests can hand-build one). */
export type InterestPlayer = {
  id: number; name: string; alive: boolean; eliminated: boolean; island: number; team?: number;
  pos: V3; vel: V3; hp: number; shield: number; kills: number; hook?: { st: number };
};
export type InterestSnap = {
  time: number; tick: number; players: InterestPlayer[]; sealed: boolean[]; suddenDeath: boolean;
  storm?: { x: number; z: number } | null;
  projectiles?: { kind: string; pos: V3; vel: V3 }[];
  brains?: { id: number; goal: string | null; target: number | null }[];
  events: { t: number; type: string; data: Record<string, unknown> }[];
};

export interface Storyline {
  reason: ShotReason;
  playerId: number;
  otherId?: number;
  score: number;
  /** The shot this storyline wants. */
  kind: ShotKind;
  /** Where an orbit / drone shot is centred (else the featured player). */
  at?: V3;
}

/** How long each kind of moment stays interesting (s of sim time). */
export const RECENT = { hit: 3, multi: 4, kill: 3.5, elimination: 5, seal: 6 } as const;
/** Base scores: bigger moments interrupt smaller ones (see director.ts PREEMPT). */
export const SCORE = {
  elimination: 9, kill: 6.5, rocket: 7, sealDone: 7, sealing: 4.5, hunt: 4, hunter: 1.2,
  duel: 3, duelLowHp: 4, clutch: 3, outnumbered: 2.5, parkour: 2.5, leader: 1.5, suddenDeath: 5, lastFew: 2, idle: 0.5,
} as const;
const HP_MAX = 100;
const PARKOUR_SPEED = 9;
const ROCKET_RANGE = 45;

type Hit = { t: number; by: number; target: number };

/** Remembers recent notable events across snapshots (each snapshot carries only its own tick's events). */
export class InterestTracker {
  private hits: Hit[] = [];
  private kills: { t: number; killer: number | null; victim: number; at: V3 | null }[] = [];
  private elims: { t: number; player: number; at: V3 | null }[] = [];
  private seals: { t: number; by: number | null; owner: number | null; island: number }[] = [];
  private lastTick = -1;
  /** Last known position of every player (a killed player's spot for the orbit). */
  private lastPos = new Map<number, V3>();

  ingest(s: InterestSnap) {
    if (s.tick === this.lastTick) return;
    if (s.tick < this.lastTick) this.reset(); // a new match (rematch) restarts the tick count
    this.lastTick = s.tick;
    for (const e of s.events) {
      const d = e.data;
      if (e.type === 'hit' && typeof d.target === 'number' && typeof d.by === 'number' && d.by !== d.target) this.hits.push({ t: e.t, by: d.by, target: d.target });
      else if (e.type === 'kill' && typeof d.victim === 'number') this.kills.push({ t: e.t, killer: typeof d.killer === 'number' && d.killer !== d.victim ? d.killer : null, victim: d.victim, at: this.spot(d.victim) });
      else if (e.type === 'eliminated' && typeof d.player === 'number') this.elims.push({ t: e.t, player: d.player, at: this.spot(d.player) });
      else if (e.type === 'sealed' && typeof d.island === 'number') this.seals.push({ t: e.t, island: d.island, by: typeof d.by === 'number' ? d.by : null, owner: typeof d.owner === 'number' ? d.owner : null });
    }
    for (const p of s.players) if (p.alive) {
      const o = this.lastPos.get(p.id);
      if (o) { o.x = p.pos.x; o.y = p.pos.y; o.z = p.pos.z; } else this.lastPos.set(p.id, { x: p.pos.x, y: p.pos.y, z: p.pos.z });
    }
    const t = s.time;
    this.hits = this.hits.filter((h) => t - h.t <= RECENT.multi);
    this.kills = this.kills.filter((k) => t - k.t <= RECENT.kill);
    this.elims = this.elims.filter((k) => t - k.t <= RECENT.elimination);
    this.seals = this.seals.filter((k) => t - k.t <= RECENT.seal);
  }

  reset() {
    this.hits = []; this.kills = []; this.elims = []; this.seals = []; this.lastPos.clear(); this.lastTick = -1;
  }

  private spot(id: number): V3 | null {
    const p = this.lastPos.get(id);
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }

  /** Every live storyline, best first. */
  storylines(s: InterestSnap): Storyline[] {
    const t = s.time;
    const out: Storyline[] = [];
    const alive = s.players.filter((p) => p.alive);
    const byId = new Map(s.players.map((p) => [p.id, p]));
    const isAlive = (id: number | null | undefined) => id != null && !!byId.get(id)?.alive;

    // Eliminations and kills: orbit the spot where it happened, featuring the killer when they live.
    for (const e of this.elims) {
      const k = [...this.kills].reverse().find((x) => x.victim === e.player);
      const who = k?.killer != null && isAlive(k.killer) ? k.killer : e.player;
      out.push({ reason: 'elimination', playerId: who, otherId: e.player, score: SCORE.elimination - (t - e.t) * 0.3, kind: 'orbit', at: e.at ?? k?.at ?? undefined });
    }
    for (const k of this.kills) {
      if (this.elims.some((e) => e.player === k.victim)) continue;
      const who = k.killer !== null && isAlive(k.killer) ? k.killer : k.victim;
      out.push({ reason: 'elimination', playerId: who, otherId: k.victim, score: SCORE.kill - (t - k.t) * 0.4, kind: 'orbit', at: k.at ?? undefined });
    }
    // A bunker just sealed: orbit the sealer.
    for (const sl of this.seals) {
      const who = sl.by !== null && isAlive(sl.by) ? sl.by : sl.owner !== null && isAlive(sl.owner) ? sl.owner : null;
      if (who !== null) out.push({ reason: 'seal', playerId: who, otherId: sl.owner ?? undefined, score: SCORE.sealDone - (t - sl.t) * 0.3, kind: 'orbit' });
    }
    // A rocket in flight: the player it is heading for (closest to its path ahead).
    for (const pr of s.projectiles ?? []) {
      if (pr.kind !== 'rocket') continue;
      const sp = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z) || 1;
      let best: InterestPlayer | null = null, bestD = Infinity;
      for (const p of alive) {
        const dx = p.pos.x - pr.pos.x, dy = p.pos.y + 1 - pr.pos.y, dz = p.pos.z - pr.pos.z;
        const along = (dx * pr.vel.x + dy * pr.vel.y + dz * pr.vel.z) / sp;
        if (along < 1 || along > ROCKET_RANGE) continue;
        const off = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
        if (off < 6 && off < bestD) { bestD = off; best = p; }
      }
      if (best) out.push({ reason: 'rocket', playerId: best.id, score: SCORE.rocket, kind: 'wide', at: { x: pr.pos.x, y: pr.pos.y, z: pr.pos.z } });
    }

    // Per player: fights, clutches, seals in progress, hunted sealed players, movement, the leader.
    const maxKills = Math.max(0, ...alive.map((p) => p.kills));
    const hunters = new Map<number, number>();
    for (const b of s.brains ?? []) if (b.target !== null && isAlive(b.id)) hunters.set(b.target, (hunters.get(b.target) ?? 0) + 1);
    for (const p of alive) {
      const life = p.hp + p.shield;
      const recentIn = this.hits.filter((h) => h.target === p.id && t - h.t <= RECENT.hit);
      const recentOut = this.hits.filter((h) => h.by === p.id && t - h.t <= RECENT.hit);
      const attackers = new Set(this.hits.filter((h) => h.target === p.id).map((h) => h.by));
      // Duel: both trading hits. Feature the side in more danger; low HP makes it a fight about to end.
      const foe = recentIn.find((h) => recentOut.some((o) => o.target === h.by))?.by ?? null;
      if (foe !== null && isAlive(foe)) {
        const f = byId.get(foe)!;
        const low = Math.min(life, f.hp + f.shield);
        if (life <= f.hp + f.shield) out.push({ reason: 'duel', playerId: p.id, otherId: foe, score: SCORE.duel + SCORE.duelLowHp * (1 - Math.min(1, low / HP_MAX)), kind: 'shoulder' });
      }
      // Clutch: nearly dead and still being shot, or several attackers at once.
      if (recentIn.length && life <= 30) out.push({ reason: 'clutch', playerId: p.id, otherId: recentIn[recentIn.length - 1].by, score: SCORE.clutch + (attackers.size >= 2 ? SCORE.outnumbered : 0) + (1 - life / 30), kind: 'shoulder' });
      else if (attackers.size >= 2) out.push({ reason: 'clutch', playerId: p.id, score: SCORE.outnumbered + attackers.size * 0.3, kind: 'shoulder' });
      // Sealed in and alive: being hunted.
      if (s.sealed[p.island]) out.push({ reason: 'hunt', playerId: p.id, score: SCORE.hunt + SCORE.hunter * (hunters.get(p.id) ?? 0), kind: 'shoulder' });
      const brain = s.brains?.find((b) => b.id === p.id);
      if (brain?.goal === 'seal') out.push({ reason: 'seal', playerId: p.id, otherId: brain.target ?? undefined, score: SCORE.sealing, kind: 'shoulder' });
      const hs = Math.hypot(p.vel.x, p.vel.z);
      if ((p.hook && p.hook.st === 1) || hs > PARKOUR_SPEED || p.vel.y > 6) out.push({ reason: 'parkour', playerId: p.id, score: SCORE.parkour, kind: 'shoulder' });
      if (maxKills > 0 && p.kills === maxKills) out.push({ reason: 'leader', playerId: p.id, score: SCORE.leader + Math.min(1.5, p.kills * 0.2), kind: 'shoulder' });
      out.push({ reason: 'idle', playerId: p.id, score: SCORE.idle + (hunters.get(p.id) ?? 0) * 0.2 + (brain?.goal === 'fight' || brain?.goal === 'attack' ? 0.6 : 0), kind: 'shoulder' });
    }
    // Sudden death: the high drone view over the storm, on the leader among the last players.
    if (s.suddenDeath && alive.length) {
      const lead = alive.reduce((a, b) => (b.kills > a.kills ? b : a));
      const at = s.storm ? { x: s.storm.x, y: lead.pos.y, z: s.storm.z } : undefined;
      out.push({ reason: 'suddenDeath', playerId: lead.id, score: SCORE.suddenDeath + (alive.length <= 3 ? SCORE.lastFew : 0), kind: 'drone', at });
    }
    return out.filter((x) => isAlive(x.playerId) || x.kind === 'orbit').sort((a, b) => b.score - a.score || a.playerId - b.playerId);
  }
}

/** Best score per player (for the "current interest" of a featured player). */
export function scoreOf(lines: Storyline[], playerId: number): number {
  let s = 0;
  for (const l of lines) if (l.playerId === playerId && l.score > s) s = l.score;
  return s;
}
