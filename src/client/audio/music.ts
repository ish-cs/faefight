// Adaptive soundtrack, synthesized live (no files, so nothing to download or decode).
//
//   MusicDirector (pure, unit-tested): snapshots → mood: calm while building, tense while a fight is near
//   you, intense once the storm is closing in, off when the match has a result.
//   MusicPlayer (Web Audio): a small band of PERSISTENT voices (string pad, pluck, bass, kick, snare, hat)
//   whose pitch/envelopes are automated a few hundred ms ahead from the render loop. No nodes are created
//   per note, so playing music costs no garbage and no graph churn; changing mood only moves gains.

import type { Snapshot, Vec3 } from '../../sim/types';
import { isAlly } from '../../sim/teams';

export type Mood = 'off' | 'calm' | 'tense' | 'intense';

/** Seconds a fight keeps the music tense after its last shot/hit near you. */
export const COMBAT_HOLD = 14;
/** Someone shooting within this many metres of you (or landing bullets near you) is a fight near you. */
export const COMBAT_RADIUS = 45;
const NEAR_IMPACT = 8;
const EXPLOSION_RADIUS = 55;

const d2 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

export class MusicDirector {
  private viewed = -1;
  private lastCombat = -Infinity;

  /** Whose fight it is: the local player, or the followed player while spectating. */
  setViewed(id: number) { this.viewed = id; }

  /** A new match (sim time restarts). */
  reset() { this.lastCombat = -Infinity; }

  update(s: Snapshot): Mood {
    if (s.winner !== null && s.winner !== undefined) return 'off';
    if (s.time < this.lastCombat - 1) this.lastCombat = -Infinity; // time went backwards: replay seek / new match
    const me = s.players.find((p) => p.id === this.viewed);
    if (me) {
      for (const e of s.events) {
        const d = e.data;
        let fight = false;
        if (e.type === 'shot' && d.weapon !== 'fists') {
          fight = d.by === me.id
            || (!!d.from && d2(d.from as Vec3, me.pos) < COMBAT_RADIUS)
            || (!!d.to && d2(d.to as Vec3, me.pos) < NEAR_IMPACT);
        } else if (e.type === 'hit') {
          fight = d.target === me.id || d.by === me.id;
          // Teams: damage between teammates isn't a fight (none happens with friendly fire off; defence in depth).
          const by = s.players.find((p) => p.id === d.by), target = s.players.find((p) => p.id === d.target);
          if (fight && by && target && by.id !== target.id && isAlly(by, target)) fight = false;
        } else if (e.type === 'explosion') {
          fight = !!d.pos && d2(d.pos as Vec3, me.pos) < EXPLOSION_RADIUS;
        }
        if (fight) this.lastCombat = s.time;
      }
    }
    if (s.suddenDeath) return 'intense';
    return s.time - this.lastCombat < COMBAT_HOLD ? 'tense' : 'calm';
  }
}

// ---- harmony ------------------------------------------------------------------------------------

/** Four pad voices (MIDI) plus the bass root. Two bars per chord. */
export type Chord = { notes: [number, number, number, number]; bass: number };

export const PROGRESSIONS: Record<'calm' | 'tense', Chord[]> = {
  // D dorian, open voicings: Dm9 – Bbmaj7 – Fmaj9 – C6/9.
  calm: [
    { notes: [50, 57, 60, 64], bass: 38 },
    { notes: [50, 53, 57, 62], bass: 34 },
    { notes: [48, 53, 57, 64], bass: 41 },
    { notes: [48, 55, 57, 64], bass: 36 },
  ],
  // D minor with a dominant pull: Dm – Bb – Gm – A.
  tense: [
    { notes: [50, 53, 57, 62], bass: 38 },
    { notes: [50, 53, 58, 62], bass: 34 },
    { notes: [50, 55, 58, 62], bass: 43 },
    { notes: [49, 52, 57, 61], bass: 33 },
  ],
};

export function chordAt(p: Chord[], bar: number): Chord {
  return p[Math.floor(bar / 2) % p.length];
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

// ---- player -------------------------------------------------------------------------------------

const BPM = 84;
const STEP = 60 / BPM / 4; // a 16th note
const LOOKAHEAD = 0.35; // seconds scheduled ahead of the audio clock
/** Layer mix per mood: [pad, pluck, bass, percussion]. */
const LAYERS: Record<Mood, [number, number, number, number]> = {
  off: [0, 0, 0, 0],
  calm: [1, 1, 0.35, 0],
  tense: [0.75, 0.8, 1, 0.7],
  intense: [0.85, 0.9, 1.15, 1],
};
/** Overall trim so 100% on the Music slider sits under the effects. */
export const MUSIC_TRIM = 0.55;

type Env = GainNode;

export class MusicPlayer {
  private nodes: AudioNode[] = [];
  private sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
  private out: GainNode;
  private duckG: GainNode;
  private pad!: { oscs: OscillatorNode[]; lp: BiquadFilterNode; layer: GainNode };
  private pluck!: { a: OscillatorNode; b: OscillatorNode; env: Env; layer: GainNode };
  private bass!: { saw: OscillatorNode; sub: OscillatorNode; lp: BiquadFilterNode; env: Env; layer: GainNode };
  private kick!: { osc: OscillatorNode; env: Env };
  private snare!: Env;
  private hat!: Env;
  private perc!: GainNode;
  private step = 0;
  private nextAt = 0;
  private mood: Mood = 'calm';
  private playing: Mood = 'calm';
  private arp = 0;

  constructor(private ctx: AudioContext, dest: AudioNode, noise: AudioBuffer, private rnd: () => number = Math.random) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.duckG = ctx.createGain();
    this.out.connect(this.duckG).connect(dest);
    this.nodes.push(this.out, this.duckG);
    this.build(noise);
    this.nextAt = ctx.currentTime + 0.15;
    this.out.gain.setTargetAtTime(1, ctx.currentTime, 2); // fade in
  }

  private gain(v = 0): GainNode { const g = this.ctx.createGain(); g.gain.value = v; this.nodes.push(g); return g; }
  private osc(type: OscillatorType, f: number): OscillatorNode {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f; this.sources.push(o); return o;
  }
  private filter(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; this.nodes.push(b); return b;
  }

  private build(noise: AudioBuffer) {
    const ctx = this.ctx;
    const mix = this.gain(1);
    mix.connect(this.out);
    // Dotted-8th echo for the pluck and a little pad: space without a convolver.
    const echo = ctx.createDelay(1);
    echo.delayTime.value = STEP * 3;
    const fb = this.gain(0.32);
    const elp = this.filter('lowpass', 2400);
    const send = this.gain(0.35);
    send.connect(echo).connect(elp).connect(mix);
    elp.connect(fb).connect(echo);
    this.nodes.push(echo);

    // String pad: 4 notes × 2 detuned saws through a slowly breathing low-pass.
    const padLayer = this.gain(0);
    const padLp = this.filter('lowpass', 850, 0.6);
    const padSum = this.gain(0.028);
    padSum.connect(padLp).connect(padLayer).connect(mix);
    padLayer.connect(send);
    const lfo = this.osc('sine', 0.06);
    const lfoAmt = this.gain(260);
    lfo.connect(lfoAmt).connect(padLp.frequency);
    const oscs: OscillatorNode[] = [];
    for (let i = 0; i < 8; i++) {
      const o = this.osc('sawtooth', 110);
      o.detune.value = i % 2 ? 7 : -7;
      o.connect(padSum);
      oscs.push(o);
    }
    this.pad = { oscs, lp: padLp, layer: padLayer };

    // Pluck: triangle + a quiet 3rd harmonic, struck by an envelope.
    const pluckLayer = this.gain(0);
    const pluckEnv = this.gain(0);
    const pluckLp = this.filter('lowpass', 3200);
    const a = this.osc('triangle', 440), b = this.osc('sine', 1320);
    const bq = this.gain(0.18);
    a.connect(pluckEnv); b.connect(bq).connect(pluckEnv);
    pluckEnv.connect(pluckLp).connect(pluckLayer).connect(mix);
    pluckLayer.connect(send);
    this.pluck = { a, b, env: pluckEnv, layer: pluckLayer };

    // Bass: saw + sub sine through a low-pass that opens on each note.
    const bassLayer = this.gain(0);
    const bassEnv = this.gain(0);
    const bassLp = this.filter('lowpass', 220, 2);
    const saw = this.osc('sawtooth', 55), sub = this.osc('sine', 27.5);
    const sawG = this.gain(0.5);
    saw.connect(sawG).connect(bassLp);
    sub.connect(bassLp);
    bassLp.connect(bassEnv).connect(bassLayer).connect(mix);
    this.bass = { saw, sub, lp: bassLp, env: bassEnv, layer: bassLayer };

    // Percussion: one sine kick, and snare/hat filtered from one looping noise source.
    this.perc = this.gain(0);
    this.perc.connect(mix);
    const kickEnv = this.gain(0);
    const kosc = this.osc('sine', 50);
    kosc.connect(kickEnv).connect(this.perc);
    this.kick = { osc: kosc, env: kickEnv };
    const n = ctx.createBufferSource();
    n.buffer = noise; n.loop = true;
    this.sources.push(n);
    const sbp = this.filter('bandpass', 1900, 0.9);
    this.snare = this.gain(0);
    n.connect(sbp).connect(this.snare).connect(this.perc);
    const hhp = this.filter('highpass', 7500);
    this.hat = this.gain(0);
    n.connect(hhp).connect(this.hat).connect(this.perc);

    const t = ctx.currentTime;
    for (const s of this.sources) s.start(t);
  }

  setMood(m: Mood) { this.mood = m; }

  /** Dip under a big moment (a near explosion, your death), recovering over ~`sec`. */
  duck(depth: number, sec: number) {
    const now = this.ctx.currentTime, g = this.duckG.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(1 - depth, now, 0.03);
    g.setTargetAtTime(1, now + 0.15, sec / 3);
  }

  /** Per render frame: schedule every 16th that falls inside the lookahead window. */
  tick() {
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    // A long stall (hidden tab): skip ahead rather than burst-schedule the backlog.
    if (this.nextAt < this.ctx.currentTime - 0.5) this.nextAt = this.ctx.currentTime + 0.05;
    while (this.nextAt < horizon) {
      this.schedule(this.step, this.nextAt);
      this.step++;
      this.nextAt += STEP;
    }
  }

  private schedule(i: number, t: number) {
    const pos = i % 16, bar = Math.floor(i / 16);
    // Mood changes land on the bar line, so layers enter musically.
    if (pos === 0 && this.playing !== this.mood) {
      this.playing = this.mood;
      const [p, pl, b, pc] = LAYERS[this.playing];
      const tau = this.playing === 'off' ? 1.5 : 0.9;
      this.pad.layer.gain.setTargetAtTime(p, t, tau);
      this.pluck.layer.gain.setTargetAtTime(pl, t, tau);
      this.bass.layer.gain.setTargetAtTime(b, t, tau);
      this.perc.gain.setTargetAtTime(pc, t, 0.3);
      this.pad.lp.frequency.setTargetAtTime(this.playing === 'intense' ? 1500 : this.playing === 'tense' ? 1100 : 850, t, 1.5);
    }
    const m = this.playing;
    if (m === 'off') return;
    const prog = PROGRESSIONS[m === 'calm' ? 'calm' : 'tense'];
    const chord = chordAt(prog, bar);
    if (pos === 0 && bar % 2 === 0) {
      chord.notes.forEach((n, k) => {
        const f = hz(n);
        this.pad.oscs[k * 2].frequency.setTargetAtTime(f, t, 0.12);
        this.pad.oscs[k * 2 + 1].frequency.setTargetAtTime(f, t, 0.12);
      });
    }
    // Pluck: sparse and free when calm; a steady 8th-note arpeggio when tense.
    if (m === 'calm') {
      if ((pos === 0 || pos === 6 || pos === 10 || pos === 14) && this.rnd() < 0.5) {
        const n = chord.notes[1 + Math.floor(this.rnd() * 3)] + (this.rnd() < 0.5 ? 12 : 24);
        this.strike(n, t, 0.16, 0.5);
      }
    } else if (pos % 2 === 0) {
      const n = chord.notes[[0, 1, 2, 3, 2, 1][this.arp++ % 6]] + 12;
      this.strike(n, t, m === 'intense' ? 0.12 : 0.1, 0.18);
    }
    // Bass: a long root per bar when calm; a driving 8th-note figure otherwise.
    if (m === 'calm') {
      if (pos === 0) this.bassNote(chord.bass, t, 0.35, 2.2);
    } else if (pos % 2 === 0) {
      const off = [0, 0, 12, 0, 0, 0, 12, 7][(pos / 2) | 0];
      this.bassNote(chord.bass + off, t, pos % 8 === 0 ? 0.5 : 0.38, 0.22);
    }
    // Percussion (its bus is silent when calm).
    if (m === 'tense') {
      if (pos === 0 || pos === 10) this.kickHit(t, 0.55);
      if (pos % 4 === 2) this.hatHit(t, 0.045, 0.03);
    } else if (m === 'intense') {
      if (pos === 0 || pos === 7 || pos === 8 || (bar % 2 === 1 && pos === 10)) this.kickHit(t, 0.85);
      if (pos === 4 || pos === 12) this.snareHit(t, 0.32);
      if (bar % 4 === 3 && pos >= 13) this.snareHit(t, 0.12 + (pos - 13) * 0.06);
      this.hatHit(t, pos % 4 === 2 ? 0.06 : 0.028, 0.025);
    }
  }

  private strike(midi: number, t: number, peak: number, decay: number) {
    const f = hz(midi);
    this.pluck.a.frequency.setValueAtTime(f, t);
    this.pluck.b.frequency.setValueAtTime(f * 3, t);
    const g = this.pluck.env.gain;
    g.setTargetAtTime(peak, t, 0.003);
    g.setTargetAtTime(0, t + 0.012, decay / 3);
  }

  private bassNote(midi: number, t: number, peak: number, len: number) {
    const f = hz(midi);
    this.bass.saw.frequency.setValueAtTime(f, t);
    this.bass.sub.frequency.setValueAtTime(f / 2, t);
    this.bass.lp.frequency.setTargetAtTime(700, t, 0.004);
    this.bass.lp.frequency.setTargetAtTime(200, t + 0.02, 0.08);
    const g = this.bass.env.gain;
    g.setTargetAtTime(peak, t, 0.006);
    g.setTargetAtTime(0, t + len * 0.6, len / 4);
  }

  private kickHit(t: number, peak: number) {
    const f = this.kick.osc.frequency;
    f.setValueAtTime(140, t);
    f.exponentialRampToValueAtTime(44, t + 0.11);
    const g = this.kick.env.gain;
    g.setTargetAtTime(peak, t, 0.002);
    g.setTargetAtTime(0, t + 0.02, 0.09);
  }

  private snareHit(t: number, peak: number) {
    const g = this.snare.gain;
    g.setTargetAtTime(peak, t, 0.001);
    g.setTargetAtTime(0, t + 0.01, 0.05);
  }

  private hatHit(t: number, peak: number, decay: number) {
    const g = this.hat.gain;
    g.setTargetAtTime(peak, t, 0.001);
    g.setTargetAtTime(0, t + 0.004, decay / 3);
  }

  /** Fade out and release every node (Music turned off). */
  dispose() {
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.15);
    setTimeout(() => {
      for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } s.disconnect(); }
      for (const n of this.nodes) n.disconnect();
    }, 900);
  }
}
