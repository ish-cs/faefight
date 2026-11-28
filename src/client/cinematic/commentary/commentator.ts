/**
 * The sportscaster: turns match events, snapshot state and the cinematic director's shots into spoken
 * lines. Templates only (lines.ts), no LLM. Rules:
 * - One voice at a time, always: a line is never cut mid-sentence, except by a TOP call (an elimination, the
 *   final two, the win), which hands over naturally ("Hold on!"). Everything else waits its turn, and lines
 *   that waited too long are dropped (STALE_LOW / STALE_HIGH / STALE_TOP sec), never squeezed in.
 * - Turn-taking: a short breath after every line (GAP), longer when the other commentator takes over
 *   (SWITCH_GAP); colour chat only after COLOUR_IDLE sec of silence with no call waiting.
 * - Variety: a template isn't reused within REPEAT_SEC (the least recently used one wins if all are fresh).
 * - Two voices: play-by-play calls the events, the colour commentator fills quiet moments and reacts.
 * Client only: wall-clock time and Math.random are fine here (nothing feeds back into the sim).
 */
import type { MatchEvent, PlayerState, Snapshot } from '../../../sim/types';
import { fill, KEY_VARS, LINES, PERSONA, weaponPhrase, type LineKey, type Vars } from './lines';
import { Narrative, type NarrativeHost } from './narrative';
import type { Persona, Tts } from './tts';

export const REPEAT_SEC = 180;
export const STALE_LOW = 3;
export const STALE_HIGH = 6;
/** Silence before the colour commentator fills in. */
export const COLOUR_IDLE = 5;
/** Breath between two lines. */
export const GAP = 0.45;
/** Breath when the other commentator takes over. */
export const SWITCH_GAP = 0.9;
/** How long a top call (elimination, final two, win) may wait for its turn before it is dropped. */
export const STALE_TOP = 10;
/** Kills by one player within this window count as a multi-kill. */
export const MULTI_SEC = 10;

/** 0 colour, 1 minor, 2 major, 3 big, 4 top (eliminations, final two, win: the only calls that may cut in). */
export type Prio = 0 | 1 | 2 | 3 | 4;
export const TOP: Prio = 4;
/** What a top call says first when it has to cut a line short. */
export const HANDOFFS = ['Hold on!', 'Wait, wait!', 'Stop right there!', 'Oh, hang on!', 'Sorry to cut in!'];

/** What the director tells us (src/client/cinematic/director.ts, structural copy so this compiles alone). */
export type ShotReason = 'duel' | 'clutch' | 'seal' | 'hunt' | 'rocket' | 'parkour' | 'leader' | 'elimination' | 'suddenDeath' | 'idle';
export interface ShotEvent { playerId: number; reason: ShotReason; kind: string; otherId?: number; score: number; t: number }

export interface Caption { text: string; persona: Persona; key: LineKey; prio: Prio }
export interface LogLine extends Caption { at: number }

type Pending = { key: LineKey; vars: Vars; prio: Prio; at: number; maxAge: number };

export interface CommentatorOpts {
  tts: Tts;
  /** Seconds (wall clock). */
  now?: () => number;
  rng?: () => number;
  /** Commentary volume 0..1 (read at each line). */
  volume?: () => number;
  onCaption?: (c: Caption | null) => void;
  /** Duck the game mix while speaking. */
  duck?: (on: boolean) => void;
  /** How to say a player's name (default: their sim name). */
  displayName?: (p: PlayerState) => string;
}

/** Rough speaking time of a line (≈ 2.9 words/s at sportscaster pace), for captions and silent mode. */
export const estimateSec = (text: string) => 0.6 + text.split(/\s+/).length / 2.9;

const SHOT_KEY: Partial<Record<ShotReason, LineKey>> = {
  duel: 'shotDuel', hunt: 'shotHunt', parkour: 'shotParkour', clutch: 'shotClutch', leader: 'shotLeader',
};

export class Commentator {
  active = false;
  /** While true (a killcam is playing), no new line starts; one already playing finishes. */
  hold = false;
  readonly log: LogLine[] = [];
  private queue: Pending[] = [];
  private speaking: { item: Pending; caption: Caption; until: number; hardUntil: number } | null = null;
  private lastPersona: Persona | null = null;
  private lastEnd = 0;
  private captionOff = 0;
  /** Template id ("key#i") → last time said. */
  private used = new Map<string, number>();
  /** Rate limits per tag. */
  private cooldown = new Map<string, number>();
  // Match memory.
  private started = false;
  private anyKill = false;
  private startTime = 0;
  private firstTime: number | null = null;
  private names = new Map<number, string>();
  private players = new Map<number, PlayerState>();
  private lastHit = new Map<number, { by: number | null; weapon?: string; part?: string; pos?: { x: number; y: number; z: number } }>();
  private hurtAt = new Map<number, number>();
  private killTimes = new Map<number, number[]>();
  private killedBy = new Map<number, number>();
  private escapedAt = new Map<number, number>();
  private drinking = new Set<number>();
  private leader: number | null = null;
  private allSealedSaid = false;
  private colourTopic = 0;
  /** Quiet moments rotate: narrative (strategy, memory) twice, then stats colour. */
  private narrativeTurn = 0;
  private readonly now: () => number;
  private readonly rng: () => number;
  /** Storylines, predictions and analysis (narrative.ts). */
  readonly narrative: Narrative;

  constructor(private opts: CommentatorOpts) {
    this.now = opts.now ?? (() => performance.now() / 1000);
    this.rng = opts.rng ?? Math.random;
    this.narrative = new Narrative({
      say: (k, v, p, age) => this.say(k, v, p, age),
      name: (id) => this.name(id),
      ready: (tag, sec) => this.ready(tag, sec),
      rng: () => this.rng(),
      unready: (tag: string) => this.cooldown.delete(tag),
    } as NarrativeHost);
  }

  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    console.info(`[commentary] ${on ? 'on' : 'off'}`);
    if (!on) {
      this.queue.length = 0;
      if (this.speaking) { this.speaking = null; this.opts.tts.cancel(); this.opts.duck?.(false); }
      this.opts.onCaption?.(null);
    } else this.lastEnd = this.now() - GAP; // free to speak at once; colour waits COLOUR_IDLE
  }

  /** New match: forget everything about the last one. */
  reset() {
    this.queue.length = 0;
    this.started = false; this.anyKill = false; this.firstTime = null; this.leader = null; this.allSealedSaid = false;
    for (const m of [this.lastHit, this.hurtAt, this.killTimes, this.killedBy, this.escapedAt, this.cooldown]) m.clear();
    this.drinking.clear();
    this.narrative.reset();
  }

  // ---- input ----

  onSnapshot(s: Snapshot) {
    for (const p of s.players) { this.names.set(p.id, this.opts.displayName?.(p) ?? p.name); this.players.set(p.id, p); }
    this.noteState(s);
    this.firstTime ??= s.time;
    const now = this.now();
    // Opening line once we're on air (joining mid-match still gets the welcome).
    if (this.active && !this.started && s.players.length >= 2 && s.winner === null) {
      this.started = true; this.startTime = this.firstTime ?? s.time;
      this.say('start', { n: s.players.length }, 2);
    }
    const elimInBatch = new Set<number>();
    for (const e of s.events) if (e.type === 'eliminated') elimInBatch.add(e.data.player as number);
    const killedInBatch = new Set<number>();
    this.narrative.onSnapshot(s);
    for (const e of s.events) this.onEvent(e, s, now, elimInBatch, killedInBatch);
    this.watchHeals(s, now);
    this.watchLeader(s);
    this.watchSeals(s);
    this.update();
  }

  /** The cinematic director cut to a new shot: low-priority scene-setting line (events speak louder). */
  onShot(e: ShotEvent) {
    this.narrative.featured = e.playerId;
    // The camera picked someone: sometimes the colour commentator reads what they're up to.
    if (this.ready('shotPredict', 20) && this.rng() < 0.5 && this.narrative.predictFor(e.playerId)) return;
    const key = SHOT_KEY[e.reason];
    if (!key || !this.ready(`shot:${e.reason}`, 15)) return;
    const a = this.name(e.playerId);
    const b = e.otherId !== undefined ? this.name(e.otherId) : undefined;
    if (KEY_VARS[key].includes('b' as never) && b === undefined) return;
    this.say(key, { a, b, n: this.players.get(e.playerId)?.kills ?? 0 }, 1);
  }

  private onEvent(e: MatchEvent, s: Snapshot, now: number, elimInBatch: Set<number>, killedInBatch: Set<number>) {
    const d = e.data;
    switch (e.type) {
      case 'hit': {
        const target = d.target as number;
        this.lastHit.set(target, { by: d.by as number | null, weapon: d.weapon as string | undefined, part: d.part as string | undefined, pos: d.pos as never });
        this.hurtAt.set(target, now);
        this.narrative.onHit(target, d.by as number | null, s.time);
        const victim = this.players.get(target);
        if (d.weapon === 'rocket' && typeof d.by === 'number' && d.by !== target && (d.amount as number) >= 35 && victim && victim.hp > 0 && this.ready('rocketHit', 10))
          this.say('rocketHit', { a: this.name(d.by), b: this.name(target) }, 1);
        break;
      }
      case 'kill': this.onKill(d, s, now, elimInBatch, killedInBatch); break;
      case 'eliminated': {
        const id = d.player as number;
        if (killedInBatch.has(id)) break; // already called as a kill + elimination
        const left = s.players.filter((p) => !p.eliminated);
        if (left.length === 2) this.say('finalTwo', { a: this.name(left[0].id), b: this.name(left[1].id) }, TOP);
        else if (left.length > 2) this.say('eliminated', { a: this.name(id), n: left.length }, TOP);
        this.narrative.onEliminated(id);
        break;
      }
      case 'sealed': {
        const owner = d.owner as number | null, by = d.by as number | null;
        if (owner === null || by === null || by === owner) break; // sudden-death closure / own pieces: not a play
        this.say('sealed', { a: this.name(by), b: this.name(owner) }, 2);
        this.narrative.onSealed(by, owner, s.time);
        break;
      }
      case 'unsealed': {
        const owner = d.owner as number | null;
        if (owner !== null && this.ready(`unsealed:${owner}`, 20)) this.say('unsealed', { a: this.name(owner) }, 1);
        break;
      }
      case 'trapped': {
        const id = d.player as number;
        if (this.ready(`trapped:${id}`, 45)) this.say('trapped', { a: this.name(id) }, 2);
        break;
      }
      case 'escaped': {
        const id = d.player as number;
        this.escapedAt.set(id, now);
        this.narrative.onEscaped(id);
        // The sim can re-trap and free the same player in quick succession: call it once.
        if (this.ready(`escaped:${id}`, 45)) {
          const a = this.name(id);
          this.queue = this.queue.filter((p) => !(p.key === 'trapped' && p.vars.a === a)); // out already: skip "trapped"
          this.say('escaped', { a }, 3);
        }
        break;
      }
      case 'flash': {
        // a flashbang that properly blinds two or more (the sim's hit list: [player id, strength])
        const n = Array.isArray(d.hit) ? (d.hit as [number, number][]).filter(([, k]) => k >= 0.5).length : 0;
        if (n >= 2 && typeof d.by === 'number' && this.ready('flash', 20)) this.say('flashBlind', { a: this.name(d.by), n }, 1);
        break;
      }
      case 'suddenDeath': this.say('suddenDeath', {}, 3); break;
      case 'lightning':
        if (this.ready('storm', 30)) this.say('storm', { n: s.players.filter((p) => p.alive).length }, 0);
        break;
      case 'centerCollect':
        if (d.station === 'gold' && (d.cash as number) >= 50 && this.ready('gold', 25)) this.say('gold', { a: this.name(d.by as number), n: d.cash as number }, 0);
        break;
      case 'win': {
        const w = d.winner as number;
        if (w < 0 || !this.names.has(w)) break;
        this.say('win', { a: this.name(w) }, TOP);
        const others = s.players.filter((p) => p.id !== w).sort((x, y) => y.kills - x.kills);
        const mins = Math.max(1, Math.round((s.time - this.startTime) / 60));
        this.say('recap', { a: this.name(w), b: others[0] ? this.name(others[0].id) : 'the field', n: this.players.get(w)?.kills ?? 0, g: mins }, 2, 20);
        this.narrative.postMatch(w);
        break;
      }
      default: break;
    }
  }

  private onKill(d: Record<string, unknown>, s: Snapshot, now: number, elimInBatch: Set<number>, killedInBatch: Set<number>) {
    const victim = d.victim as number, killer = d.killer as number | null;
    const b = this.name(victim);
    const hit = this.lastHit.get(victim);
    this.lastHit.delete(victim);
    if (killer === null || killer === victim) {
      const cause = (d.cause as string | undefined) ?? (d.inWater ? undefined : hit?.weapon);
      if (cause === 'storm' || cause === 'lightning') this.say('killEnv', { b, w: weaponPhrase(cause) }, 1);
      return;
    }
    const a = this.name(killer);
    const k = this.players.get(killer);
    const times = (this.killTimes.get(killer) ?? []).filter((t) => now - t <= MULTI_SEC);
    times.push(now);
    this.killTimes.set(killer, times);
    const revenge = this.killedBy.get(killer) === victim;
    this.killedBy.set(victim, killer);
    const first = !this.anyKill;
    this.anyKill = true;
    const weapon = hit && hit.by === killer ? hit.weapon : undefined;
    const w = weaponPhrase(weapon);
    const hp = k ? Math.round(k.hp + k.shield) : 100;
    let dist = -1;
    const kp = k?.pos, vp = hit?.pos ?? this.players.get(victim)?.pos;
    if (kp && vp) dist = Math.round(Math.hypot(kp.x - vp.x, kp.y - vp.y, kp.z - vp.z));
    const esc = this.escapedAt.get(killer);

    if (elimInBatch.has(victim)) {
      killedInBatch.add(victim);
      const left = s.players.filter((p) => !p.eliminated);
      if (left.length === 2) this.say('finalTwo', { a: this.name(left[0].id), b: this.name(left[1].id) }, TOP);
      else this.say('killElim', { a, b, n: left.length }, TOP);
      this.narrative.onKill(killer, victim, s.time);
      this.narrative.onEliminated(victim);
      return;
    }
    let key: LineKey = 'kill', prio: Prio = 2;
    const vars: Vars = { a, b, w };
    if (d.via && d.via !== 'water') { key = 'killVia'; vars.w = weaponPhrase(d.via); }
    else if (d.inWater) key = 'killWater';
    else if (times.length >= 3) { key = 'killMulti3'; vars.n = times.length; prio = 3; }
    else if (times.length === 2) { key = 'killMulti2'; prio = 3; }
    else if (first) { key = 'firstBlood'; prio = 3; }
    else if (hp > 0 && hp <= 25) { key = 'killClutch'; vars.n = hp; prio = 3; }
    else if (revenge && this.ready(`revenge:${Math.min(killer, victim)}:${Math.max(killer, victim)}`, 120)) { key = 'killRevenge'; prio = 2; }
    else if (esc !== undefined && now - esc <= 60 && this.ready(`comeback:${killer}`, 120)) { key = 'killComeback'; prio = 3; }
    else if (hit?.part === 'head') key = 'killHead';
    else if (weapon === 'rocket') key = 'killRocket';
    else if (weapon === 'grenade' || weapon === 'charge') key = 'killExplosive';
    else if (weapon === 'fists') key = 'killFists';
    else if (dist >= 40) { key = 'killLong'; vars.d = dist; }
    else if (weapon === 'shotgun' || (dist >= 0 && dist <= 4)) key = 'killClose';
    this.say(key, vars, prio);
    // Then the story: streaks, rivalries, or why it happened; else a quick reaction to a big one.
    const before = this.queue.length;
    this.narrative.onKill(killer, victim, s.time, key === 'killClutch' ? { clutchHp: hp } : {});
    if (this.queue.length === before && prio >= 3 && this.rng() < 0.4) this.say('react', {}, 1, 12);
  }

  private watchHeals(s: Snapshot, now: number) {
    for (const p of s.players) {
      const was = this.drinking.has(p.id);
      if (p.drinking && !was) {
        this.drinking.add(p.id);
        this.narrative.onDrink(p.id, s.time);
        const hurt = this.hurtAt.get(p.id);
        if (p.alive && p.hp <= 40 && hurt !== undefined && now - hurt <= 4 && this.ready(`heal:${p.id}`, 20))
          this.say('heal', { a: this.name(p.id), n: Math.max(1, Math.round(p.hp)) }, 2);
      } else if (!p.drinking && was) this.drinking.delete(p.id);
    }
  }

  private watchLeader(s: Snapshot) {
    const top = [...s.players].sort((x, y) => y.kills - x.kills);
    const l = top[0];
    if (!l || l.kills < 3 || (top[1] && top[1].kills === l.kills)) return;
    if (l.id !== this.leader) {
      this.leader = l.id;
      this.say('leader', { a: this.name(l.id), n: l.kills }, 1);
    }
  }

  private watchSeals(s: Snapshot) {
    if (this.allSealedSaid || !s.sealed.length) return;
    const islands = new Set(s.players.filter((p) => !p.eliminated).map((p) => p.island));
    if (islands.size < 2) return;
    if ([...islands].every((i) => s.sealed[i])) {
      this.allSealedSaid = true;
      this.say('allSealed', { n: s.players.filter((p) => !p.eliminated).length }, 2);
    }
  }

  // ---- queue ----

  /** Queue a line. maxAge: drop it if it can't start within this many seconds. */
  say(key: LineKey, vars: Vars, prio: Prio, maxAge = prio >= TOP ? STALE_TOP : prio >= 2 ? STALE_HIGH : STALE_LOW) {
    if (!this.active) return;
    this.queue.push({ key, vars, prio, at: this.now(), maxAge });
    if (this.queue.length > 8) {
      // Keep the most important, newest first.
      this.queue.sort((x, y) => y.prio - x.prio || y.at - x.at);
      this.queue.length = 8;
    }
  }

  /** Drive the queue: call often (every snapshot or frame). */
  update() {
    if (!this.active) return;
    const now = this.now();
    // Safety cap: an engine that never reports the end frees the floor (without cutting anything off).
    if (this.speaking && now >= this.speaking.until && !(this.opts.tts.available && this.opts.tts.speaking && now < this.speaking.hardUntil)) this.finish(now);
    this.queue = this.queue.filter((p) => now - p.at <= p.maxAge);
    if (this.captionOff && now >= this.captionOff && !this.speaking) { this.captionOff = 0; this.opts.onCaption?.(null); }
    if (this.speaking) {
      // Only a top call cuts in, and only on a lesser line; it opens with a hand-off. Never during a hold.
      const top = this.hold ? null : this.best(TOP);
      if (top && this.speaking.item.prio < TOP) {
        console.info(`[commentary] top call cuts in on "${this.speaking.caption.text}"`);
        this.opts.tts.cancel();
        this.finish(now);
        this.start(top, now, HANDOFFS[Math.floor(this.rng() * HANDOFFS.length)]);
      }
      return;
    }
    if (this.opts.tts.available && this.opts.tts.speaking) return; // the engine is still finishing a line
    if (this.hold) { this.lastEnd = Math.max(this.lastEnd, now - COLOUR_IDLE + 2); return; } // e.g. a killcam: no new lines; colour waits a beat after
    const next = this.best(0);
    const gap = next && this.lastPersona && PERSONA[next.key] !== this.lastPersona ? SWITCH_GAP : GAP;
    if (now - this.lastEnd < gap) return;
    if (next) { this.start(next, now); return; }
    if (now - this.lastEnd >= COLOUR_IDLE) this.colour(now);
  }

  private best(minPrio: Prio): Pending | null {
    let b: Pending | null = null;
    for (const p of this.queue) if (p.prio >= minPrio && (!b || p.prio > b.prio || (p.prio === b.prio && p.at < b.at))) b = p;
    return b;
  }

  private start(item: Pending, now: number, lead = '') {
    this.queue = this.queue.filter((p) => p !== item);
    const line = this.pick(item.key, item.vars, now);
    if (!line) return;
    const said = line.charAt(0).toUpperCase() + line.slice(1); // a name like "our player" can open the line
    const text = lead ? `${lead} ${said}` : said;
    const caption: Caption = { text, persona: PERSONA[item.key], key: item.key, prio: item.prio };
    const est = estimateSec(text);
    // A real voice releases the floor on its end event (capped in case it never comes); silent mode holds it for the estimate.
    const speaking = { item, caption, until: now + (this.opts.tts.available ? est * 2 + 2 : est), hardUntil: now + est * 4 + 6 };
    this.lastPersona = caption.persona;
    this.speaking = speaking;
    this.log.push({ ...caption, at: now });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.opts.onCaption?.(caption);
    this.opts.duck?.(true);
    this.opts.tts.speak(text, {
      persona: caption.persona, intensity: item.prio / TOP, volume: this.opts.volume?.() ?? 1,
      onEnd: () => { if (this.opts.tts.available && this.speaking === speaking) this.finish(this.now()); },
    });
  }

  private finish(now: number) {
    this.speaking = null;
    this.lastEnd = now;
    this.captionOff = now + 1.2;
    this.opts.duck?.(false);
  }

  /** A fresh template for `key` (not used within REPEAT_SEC; else the least recently used), filled in. */
  private pick(key: LineKey, vars: Vars, now: number): string | null {
    const lines = LINES[key];
    const fresh: number[] = [];
    let lru = 0, lruAt = Infinity;
    lines.forEach((_, i) => {
      const at = this.used.get(`${key}#${i}`);
      if (at === undefined || now - at >= REPEAT_SEC) fresh.push(i);
      else if (at < lruAt) { lru = i; lruAt = at; }
    });
    const i = fresh.length ? fresh[Math.floor(this.rng() * fresh.length)] : lru;
    this.used.set(`${key}#${i}`, now);
    try {
      return fill(lines[i], vars);
    } catch (e) {
      console.error(String(e));
      return null;
    }
  }

  /** Quiet moment: the colour commentator picks a topic from the live state. */
  private colour(now: number) {
    const ps = [...this.players.values()];
    const alive = ps.filter((p) => !p.eliminated);
    if (!alive.length) { this.lastEnd = now; return; }
    // Two quiet moments in three are strategy / memory, when there's a story to tell; the third is stats.
    this.narrativeTurn = (this.narrativeTurn + 1) % 3;
    if (this.narrativeTurn !== 2 && this.narrative.quiet()) { this.update(); return; }
    const topics: (() => boolean)[] = [
      () => {
        const r = [...alive].sort((x, y) => y.inv.cash - x.inv.cash)[0];
        return r.inv.cash >= 100 && this.sayNow('colourEconomy', { a: this.name(r.id), n: r.inv.cash });
      },
      () => {
        const l = [...alive].sort((x, y) => y.kills - x.kills)[0];
        return l.kills >= 2 && this.sayNow('colourStandings', { a: this.name(l.id), n: l.kills });
      },
      () => this.builderLine(),
      () => alive.length < ps.length && this.sayNow('colourAlive', { n: alive.length }),
      () => this.genLine(),
      () => this.sayNow('colourIdle', {}),
    ];
    for (let k = 0; k < topics.length; k++) {
      const t = topics[(this.colourTopic + k) % topics.length];
      if (t()) { this.colourTopic = (this.colourTopic + k + 1) % topics.length; break; }
    }
    this.update();
  }

  private pieceCount = new Map<number, number>();
  private genLevels: number[] = [];
  /** Snapshot-derived counters the colour topics need. */
  private noteState(s: Snapshot) {
    this.pieceCount.clear();
    for (const pc of s.pieces) this.pieceCount.set(pc.owner, (this.pieceCount.get(pc.owner) ?? 0) + 1);
    this.genLevels = s.genLevels;
  }

  private builderLine(): boolean {
    let best = -1, n = 0;
    for (const [id, c] of this.pieceCount) if (c > n && this.players.get(id) && !this.players.get(id)!.eliminated) { best = id; n = c; }
    return n >= 10 && this.sayNow('colourBuilder', { a: this.name(best), n });
  }

  private genLine(): boolean {
    const top = [...this.players.values()].filter((p) => !p.eliminated).sort((x, y) => (this.genLevels[y.island] ?? 1) - (this.genLevels[x.island] ?? 1))[0];
    const lvl = top ? this.genLevels[top.island] ?? 1 : 1;
    return lvl >= 2 && this.sayNow('colourGenerator', { a: this.name(top!.id), n: lvl });
  }

  private sayNow(key: LineKey, vars: Vars): boolean { this.say(key, vars, 0); return true; }

  private ready(tag: string, sec: number): boolean {
    const now = this.now(), t = this.cooldown.get(tag);
    if (t !== undefined && now - t < sec) return false;
    this.cooldown.set(tag, now);
    return true;
  }

  private name(id: number): string { return this.names.get(id) ?? `Player ${id}`; }
}
