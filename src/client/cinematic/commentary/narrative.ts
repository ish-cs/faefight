/**
 * The match narrative behind the commentary: what happened before (rivalries, streaks, slumps, repeat seals,
 * escapes and clutches, early leaders who faded, the long-time richest), what players are likely to do
 * next (bot brain goals and targets, or plain state for humans), why a fight was won (height, a heal, a
 * third party), and the halftime / pre-storm / post-match recaps. Templates only; the Commentator
 * decides when to speak. Every prediction is checked against the current state first, so the colour
 * commentator never predicts a seal on an eliminated player or a heal for someone who has none.
 * Times here are sim seconds (snapshot.time).
 */
import { LIFECYCLE } from '../../../sim/constants';
import type { BotBrainInfo, PlayerState, Snapshot } from '../../../sim/types';
import type { LineKey, Vars } from './lines';
import type { Prio } from './commentator';

export interface NarrativeHost {
  say(key: LineKey, vars: Vars, prio: Prio, maxAge?: number): void;
  name(id: number): string;
  /** Rate limit by tag (true = go ahead, and starts the cooldown). */
  ready(tag: string, sec: number): boolean;
  rng(): number;
}

const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);
const minutes = (sec: number) => Math.max(1, Math.round(sec / 60));
const agoPhrase = (sec: number) => {
  const m = Math.round(sec / 60);
  return m <= 1 ? 'a minute ago' : `${['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][m] ?? m} minutes ago`;
};
const HALF = LIFECYCLE.suddenDeathAt / 2;
const PRE_STORM = LIFECYCLE.suddenDeathAt - 60;

const hasHeals = (p: PlayerState) => p.inv.medkits > 0 || Object.values(p.inv.potions ?? {}).some((n) => (n ?? 0) > 0);
const inPlay = (p: PlayerState | undefined): p is PlayerState => !!p && p.alive && !p.eliminated;

export class Narrative {
  /** Fights between two players (by pair) and who won them. */
  readonly pairs = new Map<string, { meetings: number; wins: Map<number, number> }>();
  readonly streak = new Map<number, number>();
  readonly bestStreak = new Map<number, number>();
  /** Deaths since the player's last kill. */
  readonly dry = new Map<number, number>();
  private lastKillT = new Map<number, number>();
  /** Seals by owner: who sealed it and when. */
  private seals = new Map<number, { by: number; t: number }[]>();
  private escaped = new Set<number>();
  private clutched = new Map<number, number>();
  private drankT = new Map<number, number>();
  /** Recent damage taken: victim → [{by, t}]. */
  private hurt = new Map<number, { by: number | null; t: number }[]>();
  private firstLeader: { id: number; t: number } | null = null;
  private richest: { id: number; since: number } | null = null;
  readonly brains = new Map<number, BotBrainInfo>();
  private halftimeSaid = false;
  private preStormSaid = false;
  private turn = 0;
  private snap: Snapshot | null = null;
  /** Who the director is showing (talk about them first). */
  featured: number | null = null;

  constructor(private host: NarrativeHost) {}

  reset() {
    for (const m of [this.pairs, this.streak, this.bestStreak, this.dry, this.lastKillT, this.seals, this.clutched, this.drankT, this.hurt, this.brains]) m.clear();
    this.escaped.clear();
    this.firstLeader = null; this.richest = null; this.halftimeSaid = false; this.preStormSaid = false; this.snap = null; this.featured = null;
  }

  private player(id: number) { return this.snap?.players.find((p) => p.id === id); }

  // ---- memory input ----

  onSnapshot(s: Snapshot) {
    this.snap = s;
    if (s.brains) for (const b of s.brains) this.brains.set(b.id, b);
    const live = s.players.filter((p) => !p.eliminated);
    const rich = [...live].sort((x, y) => y.inv.cash - x.inv.cash)[0];
    if (rich && rich.inv.cash > 0 && rich.id !== this.richest?.id) this.richest = { id: rich.id, since: s.time };
    const top = [...s.players].sort((x, y) => y.kills - x.kills);
    if (!this.firstLeader && top[0] && top[0].kills >= 2 && (!top[1] || top[1].kills < top[0].kills)) this.firstLeader = { id: top[0].id, t: s.time };
    if (s.winner === null && !s.suddenDeath) {
      if (!this.halftimeSaid && s.time >= HALF) { this.halftimeSaid = true; this.recap('halftime', s); }
      else if (!this.preStormSaid && s.time >= PRE_STORM) { this.preStormSaid = true; this.recap('preSuddenDeath', s); }
    }
  }

  onHit(target: number, by: number | null, t: number) {
    const h = (this.hurt.get(target) ?? []).filter((x) => t - x.t <= 8);
    h.push({ by, t });
    this.hurt.set(target, h);
  }

  onDrink(id: number, t: number) { this.drankT.set(id, t); }

  /** After the main kill call: rivalry callback, streaks, and sometimes the why. */
  onKill(killer: number, victim: number, t: number, opts: { clutchHp?: number } = {}) {
    const h = this.host;
    // Rivalry memory.
    const pk = pairKey(killer, victim);
    const pr = this.pairs.get(pk) ?? { meetings: 0, wins: new Map() };
    pr.meetings++;
    pr.wins.set(killer, (pr.wins.get(killer) ?? 0) + 1);
    this.pairs.set(pk, pr);
    // Streaks and slumps.
    const vs = this.streak.get(victim) ?? 0;
    this.streak.set(victim, 0);
    this.dry.set(victim, (this.dry.get(victim) ?? 0) + 1);
    const ks = (this.streak.get(killer) ?? 0) + 1;
    this.streak.set(killer, ks);
    this.bestStreak.set(killer, Math.max(this.bestStreak.get(killer) ?? 0, ks));
    this.dry.set(killer, 0);
    this.lastKillT.set(killer, t);
    if (opts.clutchHp !== undefined) this.clutched.set(killer, opts.clutchHp);

    const a = h.name(killer), b = h.name(victim);
    if (vs >= 3) h.say('streakEnd', { a, b, n: vs }, 2, 10);
    else if (ks === 3 || ks === 5 || ks === 8) h.say('streak', { a, n: ks }, 2, 8);
    else if (pr.meetings >= 3 && h.ready(`rivalry:${pk}`, 90)) h.say('callbackRivalry', { a, b, n: pr.meetings, g: pr.wins.get(killer) ?? 0 }, 1, 12);
    else this.why(killer, victim, t);
  }

  /** Analysis: why that fight was won (only when there's a clear reason, and not every time). */
  private why(killer: number, victim: number, t: number) {
    const h = this.host;
    if (!h.ready('why', 20) || h.rng() > 0.6) return;
    const k = this.player(killer), v = this.player(victim);
    const a = h.name(killer), b = h.name(victim);
    const third = (this.hurt.get(victim) ?? []).some((x) => x.by !== null && x.by !== killer && t - x.t <= 8);
    const drank = this.drankT.get(killer);
    if (third) h.say('whyThirdParty', { a, b }, 1, 10);
    else if (drank !== undefined && t - drank <= 10) h.say('whyHeal', { a }, 1, 10);
    else if (k && v && k.pos.y - v.pos.y >= 2.5) h.say('whyHighGround', { a, b }, 1, 10);
  }

  onSealed(by: number, owner: number, t: number) {
    const prev = (this.seals.get(owner) ?? []).filter((x) => x.by === by).at(-1);
    this.seals.set(owner, [...(this.seals.get(owner) ?? []), { by, t }]);
    if (prev && t - prev.t >= 30) this.host.say('callbackSeal', { a: this.host.name(by), b: this.host.name(owner), w: agoPhrase(t - prev.t) }, 1, 12);
  }

  onEscaped(id: number) { this.escaped.add(id); }

  /** A player is out for good: remember what they survived before. */
  onEliminated(id: number) {
    const a = this.host.name(id);
    if (this.escaped.has(id)) this.host.say('callbackNearElim', { a }, 1, 12);
    else if (this.clutched.has(id)) this.host.say('callbackClutch', { a, n: this.clutched.get(id)! }, 1, 12);
  }

  postMatch(winner: number) {
    let rival: number | null = null, most = 0;
    for (const [k, p] of this.pairs) {
      const [x, y] = k.split(':').map(Number);
      if ((x === winner || y === winner) && p.meetings > most) { most = p.meetings; rival = x === winner ? y : x; }
    }
    const best = this.bestStreak.get(winner) ?? 0;
    if (rival !== null && best >= 2) this.host.say('postMatch', { a: this.host.name(winner), b: this.host.name(rival), n: best }, 2, 25);
  }

  private recap(key: 'halftime' | 'preSuddenDeath', s: Snapshot) {
    const top = [...s.players].filter((p) => !p.eliminated).sort((x, y) => y.kills - x.kills);
    if (!top[0]) return;
    const a = this.host.name(top[0].id);
    if (key === 'halftime') {
      // The one to watch: the best streak among the rest, else the runner-up.
      const watch = top.slice(1).sort((x, y) => (this.streak.get(y.id) ?? 0) - (this.streak.get(x.id) ?? 0) || y.kills - x.kills)[0];
      if (!watch) return;
      this.host.say('halftime', { a, n: top[0].kills, b: this.host.name(watch.id) }, 2, 20);
    } else this.host.say('preSuddenDeath', { a, n: top[0].kills }, 2, 20);
    const r = this.topRivalry();
    if (r) this.host.say('recapRivalry', { a: this.host.name(r.x), b: this.host.name(r.y), n: r.meetings }, 1, 25);
  }

  private topRivalry(): { x: number; y: number; meetings: number } | null {
    let best: { x: number; y: number; meetings: number } | null = null;
    for (const [k, p] of this.pairs) {
      if (p.meetings < 3 || (best && p.meetings <= best.meetings)) continue;
      const [x, y] = k.split(':').map(Number);
      const wx = p.wins.get(x) ?? 0, wy = p.wins.get(y) ?? 0;
      best = wx >= wy ? { x, y, meetings: p.meetings } : { x: y, y: x, meetings: p.meetings };
    }
    return best;
  }

  // ---- quiet moments: strategy, prediction, memory ----

  /** Say one strategy / memory line if there's something worth saying. Returns whether it did. */
  quiet(): boolean {
    const s = this.snap;
    if (!s || s.winner !== null) return false;
    const topics = [() => this.predict(s), () => this.situation(s), () => this.memory(s)];
    for (let i = 0; i < topics.length; i++) {
      const k = (this.turn + i) % topics.length;
      if (topics[k]()) { this.turn = k + 1; return true; }
    }
    return false;
  }

  /** Players to talk about, the featured one first. */
  private subjects(s: Snapshot): PlayerState[] {
    const live = s.players.filter(inPlay);
    const f = live.find((p) => p.id === this.featured);
    const rest = live.filter((p) => p !== f).sort(() => this.host.rng() - 0.5);
    return f ? [f, ...rest] : rest;
  }

  /** What a bot is about to do (from its brain), checked against the state. */
  predict(s: Snapshot): boolean {
    const h = this.host;
    for (const p of this.subjects(s)) {
      const b = this.brains.get(p.id);
      if (!b || !h.ready(`predict:${p.id}`, 45)) continue;
      const line = this.prediction(p, b, s);
      if (line) { h.say(line.key, line.vars, 0); return true; }
      this.unready(`predict:${p.id}`);
    }
    return false;
  }

  /** Read one player's intent right now (the director just cut to them). */
  predictFor(id: number): boolean {
    const s = this.snap, p = this.player(id), b = this.brains.get(id);
    if (!s || !p || !b || !this.host.ready(`predict:${id}`, 45)) return false;
    const line = this.prediction(p, b, s);
    if (!line) { this.unready(`predict:${id}`); return false; }
    this.host.say(line.key, line.vars, 1, 6);
    return true;
  }

  /** The line for one bot's goal, or null when it doesn't apply right now (never contradicts the state). */
  prediction(p: PlayerState, b: BotBrainInfo, s: Snapshot): { key: LineKey; vars: Vars } | null {
    if (!inPlay(p)) return null;
    const a = this.host.name(p.id);
    const tgt = b.target !== null ? s.players.find((x) => x.id === b.target) : undefined;
    const tgtOk = tgt && !tgt.eliminated && tgt.id !== p.id;
    // The full debug goal when the bot exposes it, else its current action (which is the goal's name).
    switch (b.goal ?? b.action) {
      case 'seal': case 'raid':
        if (tgtOk && !s.sealed[tgt.island]) return { key: 'predictSeal', vars: { a, b: this.host.name(tgt.id) } };
        return null;
      case 'attack': case 'fight': case 'cut':
        return tgtOk && tgt.alive ? { key: 'predictAttack', vars: { a, b: this.host.name(tgt.id) } } : null;
      case 'shop':
        return p.inv.cash >= 200 ? { key: 'predictShop', vars: { a, n: p.inv.cash } } : null;
      case 'bank':
        return p.inv.cash >= 100 ? { key: 'predictBank', vars: { a, n: p.inv.cash } } : null;
      case 'bridge':
        return { key: 'predictBridge', vars: { a } };
      case 'defend': case 'guard': case 'fortify':
        return s.sealed[p.island] ? null : { key: 'predictDefend', vars: { a } };
      case 'contest':
        return { key: 'predictContest', vars: { a } };
      case 'disengage': case 'heal':
        return p.hp < 60 ? { key: 'predictDisengage', vars: { a, n: Math.max(1, Math.round(p.hp)) } } : null;
      default:
        return null;
    }
  }

  /** Reads from plain state (works for humans too): last life, low with no heals, the storm. */
  situation(s: Snapshot): boolean {
    const h = this.host;
    if (s.suddenDeath && h.ready('stormStrategy', 60)) {
      h.say('stormStrategy', { n: s.players.filter(inPlay).length }, 0);
      return true;
    }
    for (const p of this.subjects(s)) {
      if (p.hp <= 35 && !hasHeals(p) && h.ready(`lowNoHeal:${p.id}`, 60)) {
        h.say('adviceLowNoHeal', { a: h.name(p.id), n: Math.max(1, Math.round(p.hp)) }, 0);
        return true;
      }
      if (s.sealed[p.island] && p.breakoutUntil === null && h.ready(`oneLife:${p.id}`, 120)) {
        h.say('oneLifeLeft', { a: h.name(p.id) }, 0);
        return true;
      }
    }
    return false;
  }

  /** Memory: slumps, the early leader who faded, the long-time richest, the big rivalry. */
  memory(s: Snapshot): boolean {
    const h = this.host;
    for (const p of this.subjects(s)) {
      const d = this.dry.get(p.id) ?? 0;
      if (d >= 4 && h.ready(`slump:${p.id}`, 180)) { h.say('slump', { a: h.name(p.id), n: d }, 0); return true; }
    }
    const fl = this.firstLeader;
    if (fl && inPlay(this.player(fl.id))) {
      const since = s.time - (this.lastKillT.get(fl.id) ?? fl.t);
      const leader = [...s.players].sort((x, y) => y.kills - x.kills)[0];
      if (leader.id !== fl.id && since >= 180 && h.ready('fellOff', 240)) { h.say('fellOff', { a: h.name(fl.id), n: minutes(since) }, 0); return true; }
    }
    const r = this.richest;
    if (r && s.time - r.since >= 180 && inPlay(this.player(r.id)) && h.ready('richRun', 180)) {
      h.say('richRun', { a: h.name(r.id), n: minutes(s.time - r.since) }, 0);
      return true;
    }
    const top = this.topRivalry();
    if (top && h.ready('recapRivalry', 150)) { h.say('recapRivalry', { a: h.name(top.x), b: h.name(top.y), n: top.meetings }, 0); return true; }
    return false;
  }

  /** Undo a cooldown we only tested (nothing was said). */
  private unready(tag: string) { (this.host as { unready?: (t: string) => void }).unready?.(tag); }
}
