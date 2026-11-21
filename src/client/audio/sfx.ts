// Synthesized sound recipes. Every sound is built from noise buffers, oscillators, filters and
// envelopes at play time; nothing is loaded. Each recipe returns how long it rings (seconds).

import type { Cue } from './events';
import { jitter } from './voices';

export type Kit = { ctx: AudioContext; white: AudioBuffer; rnd: () => number };

const EPS = 0.0001;

type NoiseOpts = {
  dur: number; peak: number; attack?: number;
  type?: BiquadFilterType; freq?: number; freqEnd?: number; q?: number; rate?: number;
};

function noise(k: Kit, out: AudioNode, t: number, o: NoiseOpts): number {
  const { ctx, white } = k;
  const attack = o.attack ?? 0.002;
  const end = t + attack + o.dur;
  const s = ctx.createBufferSource();
  s.buffer = white;
  s.playbackRate.value = o.rate ?? 1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.peak, t + attack);
  g.gain.exponentialRampToValueAtTime(EPS, end);
  let head: AudioNode = g;
  if (o.type) {
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.frequency.setValueAtTime(o.freq ?? 1000, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, end);
    f.Q.value = o.q ?? 0.7;
    f.connect(g);
    head = f;
  }
  s.connect(head);
  g.connect(out);
  const span = attack + o.dur + 0.03;
  s.start(t, k.rnd() * Math.max(0, white.duration - span - 0.1));
  s.stop(end + 0.03);
  return end - t;
}

type ToneOpts = { type?: OscillatorType; f0: number; f1?: number; dur: number; peak: number; attack?: number; lp?: number };

function tone(k: Kit, out: AudioNode, t: number, o: ToneOpts): number {
  const { ctx } = k;
  const attack = o.attack ?? 0.003;
  const end = t + attack + o.dur;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, end);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.peak, t + attack);
  g.gain.exponentialRampToValueAtTime(EPS, end);
  if (o.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lp;
    osc.connect(f).connect(g);
  } else osc.connect(g);
  g.connect(out);
  osc.start(t);
  osc.stop(end + 0.03);
  return end - t;
}

/** Inharmonic struck-metal partials: [ratio, amp, decay s]. */
function partials(k: Kit, out: AudioNode, t: number, f: number, peak: number, ps: [number, number, number][]): number {
  let d = 0;
  for (const [ratio, amp, decay] of ps) d = Math.max(d, tone(k, out, t, { f0: f * ratio, dur: decay, peak: peak * amp, attack: 0.001 }));
  return d;
}

/** Sustained note with a soft attack and release (stingers, horn, alarm). */
function note(k: Kit, out: AudioNode, t: number, f: number, dur: number, peak: number, type: OscillatorType = 'triangle', lp = 4000): number {
  const { ctx } = k;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = f;
  const fl = ctx.createBiquadFilter();
  fl.type = 'lowpass';
  fl.frequency.value = lp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.02);
  g.gain.setValueAtTime(peak, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  osc.connect(fl).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.03);
  return dur;
}

// ---------------------------------------------------------------------------------------------

type GunSpec = {
  crack: [number, number, number]; // hp freq, dur, peak
  body: [number, number, number, number]; // bp freq, q, dur, peak
  thump: [number, number, number, number]; // f0, f1, dur, peak
  tail: [number, number, number]; // lp freq, dur, peak
};

const GUNS: Record<string, GunSpec> = {
  pistol: { crack: [2500, 0.05, 0.9], body: [1100, 1.2, 0.12, 0.7], thump: [170, 55, 0.12, 0.9], tail: [900, 0.4, 0.15] },
  smg: { crack: [3000, 0.035, 0.75], body: [1400, 1.4, 0.07, 0.55], thump: [200, 80, 0.06, 0.6], tail: [1100, 0.18, 0.08] },
  shotgun: { crack: [1800, 0.07, 1.0], body: [700, 0.8, 0.3, 0.9], thump: [110, 35, 0.35, 1.2], tail: [600, 0.9, 0.25] },
  rifle: { crack: [4000, 0.03, 1.1], body: [1800, 1.5, 0.1, 0.6], thump: [140, 45, 0.18, 0.9], tail: [800, 1.0, 0.2] },
};

/** Rocket launch: a hard pop, then the motor's rushing whoosh as it leaves. */
function rocketLaunch(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const p = jitter(k.rnd(), 0.05);
  noise(k, out, t, { type: 'highpass', freq: 1500, dur: 0.05, peak: 0.9 });
  tone(k, out, t, { f0: 120 * p, f1: 40, dur: 0.3, peak: cue.own ? 1.4 : 1.0, attack: 0.002 });
  noise(k, out, t, { type: 'lowpass', freq: 900, dur: 0.35, peak: 0.9 });
  return noise(k, out, t + 0.02, { type: 'bandpass', freq: 600 * p, freqEnd: 2600, q: 0.9, dur: 0.9, peak: 0.8, attack: 0.06 });
}

/** Reload / handling sounds: `kind` = "weapon:beat". Small, close, mechanical. */
function handling(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const [weapon, beat] = (cue.kind ?? 'pistol:magIn').split(':');
  const p = jitter(k.rnd(), 0.06);
  const heavy = weapon === 'rifle' ? 0.85 : weapon === 'smg' ? 1 : weapon === 'pistol' ? 1.25 : 1;
  switch (beat) {
    case 'release': // mag catch
      noise(k, out, t, { type: 'highpass', freq: 4200 * p, dur: 0.012, peak: 0.6 });
      return tone(k, out, t, { f0: 2400 * p * heavy, dur: 0.02, peak: 0.25, attack: 0.001 });
    case 'magOut': // mag slides out
      if (weapon === 'rocket') return noise(k, out, t, { type: 'bandpass', freq: 700, q: 1.2, dur: 0.18, peak: 0.35, attack: 0.03 });
      noise(k, out, t, { type: 'bandpass', freq: 1700 * p * heavy, q: 3, dur: 0.07, peak: 0.45, attack: 0.01 });
      return 0.05 + tone(k, out, t + 0.05, { f0: 520 * heavy, f1: 380, dur: 0.05, peak: 0.25, attack: 0.001 });
    case 'magIn': // scrape in, then the firm seat
      // (The animation's seat jolt lands with the click, ~40 ms after the beat.)
      noise(k, out, t, { type: 'bandpass', freq: 1500 * p * heavy, q: 2.5, dur: 0.03, peak: 0.3, attack: 0.005 });
      noise(k, out, t + 0.04, { type: 'bandpass', freq: 3200 * p, q: 1.5, dur: 0.025, peak: 0.85 });
      return 0.04 + tone(k, out, t + 0.04, { f0: 900 * heavy * p, f1: 520, dur: 0.045, peak: 0.6, attack: 0.001 });
    case 'rack': { // slide/bolt back, then slams forward
      noise(k, out, t, { type: 'bandpass', freq: 2600 * p, q: 2, dur: 0.05, peak: 0.55 });
      const at = t + (weapon === 'pistol' ? 0.07 : 0.11);
      noise(k, out, at, { type: 'highpass', freq: 3000, dur: 0.03, peak: 0.9 });
      return at - t + tone(k, out, at, { f0: 600 * heavy * p, f1: 300, dur: 0.06, peak: 0.6, attack: 0.001 });
    }
    case 'shell': // a shell thumbed into the tube
      noise(k, out, t, { type: 'bandpass', freq: 1300 * p, q: 2, dur: 0.05, peak: 0.45, attack: 0.008 });
      return tone(k, out, t + 0.01, { f0: 340 * p, f1: 260, dur: 0.05, peak: 0.45, attack: 0.001 });
    case 'pump': { // chk-chk
      noise(k, out, t, { type: 'bandpass', freq: 1100 * p, q: 1.5, dur: 0.06, peak: 0.8 });
      tone(k, out, t, { f0: 210 * p, f1: 150, dur: 0.07, peak: 0.6, attack: 0.001 });
      noise(k, out, t + 0.14, { type: 'bandpass', freq: 1500 * p, q: 1.5, dur: 0.05, peak: 0.9 });
      return 0.14 + tone(k, out, t + 0.14, { f0: 260 * p, f1: 170, dur: 0.07, peak: 0.7, attack: 0.001 });
    }
    case 'load': // a rocket shoved home: heavy clunk
      tone(k, out, t, { f0: 95 * p, f1: 48, dur: 0.22, peak: 1.0, attack: 0.002 });
      noise(k, out, t, { type: 'lowpass', freq: 700, dur: 0.14, peak: 0.7 });
      return partials(k, out, t, 310 * p, 0.35, [[1, 1, 0.3], [2.7, 0.5, 0.18], [5.1, 0.3, 0.1]]);
    default:
      return noise(k, out, t, { type: 'highpass', freq: 3000, dur: 0.02, peak: 0.4 });
  }
}

function gunshot(k: Kit, out: AudioNode, t: number, cue: Cue, d: number): number {
  const p = jitter(k.rnd(), 0.05);
  if (cue.kind === 'fists') {
    noise(k, out, t, { type: 'bandpass', freq: 500 * p, freqEnd: 1400 * p, q: 1.5, dur: 0.12, peak: 0.35, attack: 0.03 });
    const h = t + 0.09;
    tone(k, out, h, { f0: 120 * p, f1: 50, dur: 0.1, peak: 0.8 });
    return Math.max(0.25, noise(k, out, h, { type: 'lowpass', freq: 400, dur: 0.06, peak: 0.6 }) + 0.09);
  }
  if (cue.kind === 'rocket') return rocketLaunch(k, out, t, cue);
  const g = GUNS[cue.kind ?? 'pistol'] ?? GUNS.pistol;
  const own = !!cue.own;
  const far = !own && d > 30;
  const near = own || d < 12;
  let len = 0;
  // Close: bright supersonic crack. Far: the crack dulls to a thud with a long low tail.
  len = Math.max(len, noise(k, out, t, far
    ? { type: 'bandpass', freq: 900 * p, q: 0.8, dur: g.crack[1] * 2, peak: g.crack[2] * 0.6 }
    : { type: 'highpass', freq: g.crack[0] * p, dur: g.crack[1], peak: g.crack[2] * (near ? 1.15 : 1) }));
  len = Math.max(len, noise(k, out, t, { type: 'bandpass', freq: g.body[0] * p, q: g.body[1], dur: g.body[2], peak: g.body[3] * (far ? 0.6 : 1) }));
  len = Math.max(len, tone(k, out, t, { f0: g.thump[0] * p, f1: g.thump[1], dur: g.thump[2], peak: g.thump[3] * (own ? 1.35 : far ? 0.55 : 1), attack: 0.001 }));
  len = Math.max(len, noise(k, out, t + 0.01, { type: 'lowpass', freq: g.tail[0] * (far ? 0.6 : 1), dur: g.tail[1] * (far ? 1.6 : 1), peak: g.tail[2] * (far ? 1.6 : 1), attack: 0.02 }));
  if (own) noise(k, out, t, { type: 'highpass', freq: 5000, dur: 0.012, peak: 0.35 }); // action click
  return len + 0.02;
}

function explosion(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const big = cue.kind === 'charge' || cue.kind === 'rocket' || cue.kind === 'barrel' || cue.kind === 'propane';
  const p = jitter(k.rnd(), 0.06);
  noise(k, out, t, { type: 'highpass', freq: 1200, dur: 0.08, peak: 1.0 });
  tone(k, out, t, { f0: (big ? 62 : 78) * p, f1: 22, dur: big ? 1.7 : 1.3, peak: 1.4, attack: 0.004 });
  let len = noise(k, out, t, { type: 'lowpass', freq: 1100 * p, freqEnd: 110, dur: big ? 2.2 : 1.7, peak: 1.0, attack: 0.006 });
  const bits = big ? 12 : 8;
  for (let i = 0; i < bits; i++) {
    const at = t + 0.2 + k.rnd() * (big ? 1.4 : 1.0);
    len = Math.max(len, at - t + noise(k, out, at, { type: 'bandpass', freq: 1500 + k.rnd() * 3500, q: 4, dur: 0.02 + k.rnd() * 0.04, peak: 0.12 + k.rnd() * 0.25 }));
  }
  return len;
}

/** Barrels, tanks and crates: gas hiss (the fuse), a drum clang, a crate knock, a crate splintering. */
function hazardSound(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const p = jitter(k.rnd(), 0.06);
  switch (cue.kind) {
    case 'hiss':
      // pressurised leak: a bright noise jet that rises in pitch for the whole ~1 s fuse, plus a little metal tick
      partials(k, out, t, 900 * p, 0.25, [[1, 1, 0.12], [2.7, 0.5, 0.08]]);
      noise(k, out, t, { type: 'bandpass', freq: 3500 * p, freqEnd: 7000, q: 1.2, dur: 1.0, peak: 0.55, attack: 0.04 });
      return noise(k, out, t, { type: 'highpass', freq: 5000, dur: 1.0, peak: 0.25, attack: 0.1 });
    case 'clang':
      noise(k, out, t, { type: 'highpass', freq: 3000, dur: 0.02, peak: 0.5 });
      return partials(k, out, t, 310 * p, 0.45, [[1, 1, 0.45], [2.4, 0.7, 0.3], [4.1, 0.4, 0.2], [6.3, 0.25, 0.12]]);
    case 'crateHit':
      return woodKnock(k, out, t, 0.8, p);
    default: {
      // crate breaking: a crack, then planks clattering down
      noise(k, out, t, { type: 'bandpass', freq: 1400 * p, q: 1.5, dur: 0.06, peak: 0.9 });
      let len = woodKnock(k, out, t, 1.0, p * 0.9);
      for (let i = 0; i < 6; i++) {
        const at = t + 0.08 + k.rnd() * 0.5;
        len = Math.max(len, at - t + woodKnock(k, out, at, 0.25 + k.rnd() * 0.35, p * (0.9 + k.rnd() * 0.4)));
      }
      return len;
    }
  }
}

function woodKnock(k: Kit, out: AudioNode, t: number, peak: number, p: number): number {
  noise(k, out, t, { type: 'bandpass', freq: 450 * p, q: 6, dur: 0.09, peak });
  return tone(k, out, t, { f0: 210 * p, f1: 170 * p, dur: 0.1, peak: peak * 0.6, attack: 0.001 });
}

function placed(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const p = jitter(k.rnd(), 0.05);
  switch (cue.kind) {
    case 'sandbags':
      noise(k, out, t, { type: 'bandpass', freq: 1200, dur: 0.1, peak: 0.2 });
      tone(k, out, t, { f0: 80 * p, f1: 45, dur: 0.15, peak: 0.8 });
      return noise(k, out, t, { type: 'lowpass', freq: 350 * p, dur: 0.18, peak: 0.9 });
    case 'wood': case 'ramp':
      woodKnock(k, out, t, 1.0, p);
      return 0.09 + woodKnock(k, out, t + 0.09, 0.55, p * 1.04);
    case 'metal':
      noise(k, out, t, { type: 'highpass', freq: 3000, dur: 0.02, peak: 0.6 });
      return partials(k, out, t, 420 * p, 0.5, [[1, 1, 0.5], [2.76, 0.6, 0.35], [5.4, 0.4, 0.25], [8.9, 0.25, 0.15]]);
    case 'steel':
      tone(k, out, t, { f0: 90 * p, f1: 45, dur: 0.2, peak: 0.9 });
      return partials(k, out, t, 180 * p, 0.45, [[1, 1, 1.2], [2.32, 0.7, 0.9], [4.25, 0.5, 0.6], [6.8, 0.3, 0.4]]);
    case 'scaffold':
      woodKnock(k, out, t, 0.5, p);
      return partials(k, out, t, 760 * p, 0.35, [[1, 0.8, 0.25], [2.9, 0.4, 0.15]]);
    case 'container':
      tone(k, out, t, { f0: 55 * p, f1: 30, dur: 0.6, peak: 1.2 });
      noise(k, out, t, { type: 'lowpass', freq: 500, dur: 0.4, peak: 0.8 });
      return partials(k, out, t, 62 * p, 0.55, [[1, 1, 2.2], [2.1, 0.8, 1.6], [3.7, 0.5, 1.0], [5.9, 0.3, 0.6]]);
    default:
      return woodKnock(k, out, t, 0.8, p);
  }
}

function destroyed(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const metal = cue.kind === 'metal' || cue.kind === 'steel' || cue.kind === 'container';
  let len = noise(k, out, t, { type: 'lowpass', freq: 1800, freqEnd: 200, dur: 0.7, peak: 0.8, attack: 0.005 });
  if (cue.kind === 'sandbags') len = Math.max(len, noise(k, out, t + 0.05, { type: 'bandpass', freq: 800, dur: 0.6, peak: 0.35, attack: 0.08 }));
  for (let i = 0; i < 7; i++) {
    const at = t + k.rnd() * 0.6;
    const l = metal
      ? partials(k, out, at, 600 + k.rnd() * 1400, 0.18, [[1, 1, 0.18], [2.7, 0.5, 0.1]])
      : noise(k, out, at, { type: 'bandpass', freq: 500 + k.rnd() * 400, q: 5, dur: 0.04 + k.rnd() * 0.04, peak: 0.3 + k.rnd() * 0.3 });
    len = Math.max(len, at - t + l);
  }
  return len;
}

function coin(k: Kit, out: AudioNode, t: number): number {
  const notes = [2093, 2349, 2637, 3136];
  let len = 0;
  const n = 3 + Math.floor(k.rnd() * 2);
  for (let i = 0; i < n; i++) {
    const at = t + i * (0.05 + k.rnd() * 0.025);
    const f = notes[Math.floor(k.rnd() * notes.length)] * jitter(k.rnd(), 0.015);
    len = Math.max(len, at - t + partials(k, out, at, f, 0.25, [[1, 1, 0.12 + k.rnd() * 0.12], [2.76, 0.3, 0.06]]));
  }
  return len;
}

function footstep(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const p = jitter(k.rnd(), 0.12);
  const v = jitter(k.rnd(), 0.2);
  switch (cue.kind) {
    case 'grass':
      noise(k, out, t, { type: 'highpass', freq: 3000 * p, dur: 0.03, peak: 0.12 * v });
      return noise(k, out, t, { type: 'lowpass', freq: 900 * p, dur: 0.07, peak: 0.5 * v, attack: 0.006 });
    case 'sand':
      noise(k, out, t, { type: 'lowpass', freq: 300 * p, dur: 0.05, peak: 0.4 * v });
      return noise(k, out, t, { type: 'bandpass', freq: 1800 * p, q: 0.7, dur: 0.09, peak: 0.4 * v, attack: 0.01 });
    case 'concrete':
      noise(k, out, t, { type: 'bandpass', freq: 2500 * p, q: 1, dur: 0.025, peak: 0.4 * v });
      return noise(k, out, t, { type: 'lowpass', freq: 500 * p, dur: 0.04, peak: 0.5 * v });
    case 'wood':
      noise(k, out, t, { type: 'bandpass', freq: 1200 * p, dur: 0.02, peak: 0.2 * v });
      return noise(k, out, t, { type: 'bandpass', freq: 380 * p, q: 4, dur: 0.08, peak: 0.7 * v });
    case 'hollow':
      noise(k, out, t, { type: 'bandpass', freq: 380 * p, q: 4, dur: 0.08, peak: 0.6 * v });
      return tone(k, out, t, { f0: 180 * p, f1: 150 * p, dur: 0.15, peak: 0.35 * v, attack: 0.002 });
    case 'metal':
      noise(k, out, t, { type: 'lowpass', freq: 400, dur: 0.04, peak: 0.4 * v });
      noise(k, out, t, { type: 'highpass', freq: 4000, dur: 0.02, peak: 0.3 * v });
      return partials(k, out, t, 900 * p, 0.25 * v, [[1, 0.4, 0.12], [2.7, 0.25, 0.08]]);
    default:
      return noise(k, out, t, { type: 'lowpass', freq: 900 * p, dur: 0.07, peak: 0.5 * v });
  }
}

/** Touching down after a fall: a low body thud plus the surface's own character. */
function land(k: Kit, out: AudioNode, t: number, cue: Cue): number {
  const p = jitter(k.rnd(), 0.08);
  noise(k, out, t, { type: 'lowpass', freq: 260 * p, dur: 0.12, peak: 0.9 });
  tone(k, out, t, { f0: 95 * p, f1: 48, dur: 0.14, peak: 0.6, attack: 0.002 });
  switch (cue.kind) {
    case 'metal': return Math.max(0.16, partials(k, out, t, 620 * p, 0.3, [[1, 0.6, 0.25], [2.7, 0.35, 0.15], [4.1, 0.2, 0.1]]));
    case 'wood': case 'hollow': return Math.max(0.16, noise(k, out, t, { type: 'bandpass', freq: 340 * p, q: 4, dur: 0.14, peak: 0.8 }));
    case 'concrete': return Math.max(0.16, noise(k, out, t, { type: 'bandpass', freq: 2200 * p, q: 1, dur: 0.04, peak: 0.5 }));
    case 'sand': return Math.max(0.16, noise(k, out, t, { type: 'bandpass', freq: 1600 * p, q: 0.7, dur: 0.16, peak: 0.45, attack: 0.01 }));
    default: return Math.max(0.16, noise(k, out, t, { type: 'lowpass', freq: 1100 * p, dur: 0.1, peak: 0.45, attack: 0.004 }));
  }
}

/** Play `cue` into `out` at time `t`. `d` = distance to the listener (0 for 2D cues). Returns ring time. */
export function playRecipe(k: Kit, out: AudioNode, t: number, cue: Cue, d: number): number {
  const p = jitter(k.rnd(), 0.04);
  switch (cue.sound) {
    case 'shot': return gunshot(k, out, t, cue, d);
    case 'reload': return handling(k, out, t, cue);
    case 'dry': // hammer on an empty chamber
      noise(k, out, t, { type: 'highpass', freq: 5200 * p, dur: 0.01, peak: 0.6 });
      return tone(k, out, t, { f0: 1700 * p, f1: 1300, dur: 0.018, peak: 0.35, attack: 0.001 });
    case 'ads': // cloth + a soft grip shift as the sights come up
      noise(k, out, t, { type: 'bandpass', freq: 900 * p, q: 0.8, dur: 0.1, peak: 0.22, attack: 0.03 });
      return 0.06 + noise(k, out, t + 0.06, { type: 'bandpass', freq: 2600 * p, q: 3, dur: 0.012, peak: 0.12 });
    case 'impact':
      noise(k, out, t, { type: 'bandpass', freq: 2500 * p, q: 2, dur: 0.04, peak: 0.8 });
      noise(k, out, t, { type: 'lowpass', freq: 800 * p, dur: 0.08, peak: 0.6 });
      return tone(k, out, t, { f0: 260 * p, f1: 110, dur: 0.06, peak: 0.6, attack: 0.001 });
    case 'hurt':
      noise(k, out, t, { type: 'bandpass', freq: 3000 * p, q: 1, dur: 0.08, peak: 0.15 });
      noise(k, out, t, { type: 'lowpass', freq: 250, dur: 0.2, peak: 0.6 });
      return tone(k, out, t, { f0: 90 * p, f1: 38, dur: 0.3, peak: 1.0, attack: 0.002 });
    case 'hitmarker': // crisp tick: a tiny bright click + two short high tones
      noise(k, out, t, { type: 'highpass', freq: 6500, dur: 0.008, peak: 0.35, attack: 0.0005 });
      tone(k, out, t, { type: 'triangle', f0: 2600 * p, dur: 0.035, peak: 0.5, attack: 0.001 });
      return 0.005 + tone(k, out, t + 0.005, { f0: 3900 * p, dur: 0.025, peak: 0.25, attack: 0.001 });
    case 'headshot': // a clear metallic ding over the tick
      return 0.01 + partials(k, out, t + 0.01, 1975 * p, 0.32, [[1, 1, 0.45], [2.76, 0.45, 0.25], [5.4, 0.2, 0.12]]);
    case 'shieldCrack': { // you broke their shield: a dry crack + a quick falling glassy zap
      noise(k, out, t, { type: 'highpass', freq: 3500, dur: 0.035, peak: 0.8, attack: 0.0005 });
      noise(k, out, t + 0.012, { type: 'bandpass', freq: 5200, q: 2, dur: 0.05, peak: 0.4 });
      tone(k, out, t, { type: 'square', f0: 2400, f1: 600, dur: 0.14, peak: 0.12, lp: 5000, attack: 0.001 });
      return partials(k, out, t + 0.02, 3100 * p, 0.18, [[1, 1, 0.12], [1.83, 0.6, 0.08]]) + 0.02;
    }
    case 'land': return land(k, out, t, cue);
    case 'splash':
      noise(k, out, t, { type: 'bandpass', freq: 3000, dur: 0.25, peak: 0.3, attack: 0.01 });
      return noise(k, out, t, { type: 'lowpass', freq: 1500 * p, freqEnd: 400, dur: 0.5, peak: 0.8, attack: 0.01 });
    case 'explosion': return explosion(k, out, t, cue);
    case 'hazard': return hazardSound(k, out, t, cue);
    case 'placed': return placed(k, out, t, cue);
    case 'destroyed': return destroyed(k, out, t, cue);
    case 'coin': return coin(k, out, t);
    case 'loot':
      noise(k, out, t, { type: 'bandpass', freq: 1800, q: 1, dur: 0.25, peak: 0.4, attack: 0.05 });
      return 0.1 + coin(k, out, t + 0.1);
    case 'purchase':
      noise(k, out, t, { type: 'highpass', freq: 2000, dur: 0.03, peak: 0.6 });
      noise(k, out, t + 0.05, { type: 'lowpass', freq: 400, dur: 0.05, peak: 0.5 });
      return 0.12 + partials(k, out, t + 0.12, 1760 * p, 0.35, [[1, 1, 0.9], [2, 0.3, 0.6], [3, 0.15, 0.4]]);
    case 'vault':
      noise(k, out, t, { type: 'lowpass', freq: 300, dur: 0.12, peak: 1.0 });
      partials(k, out, t, 140 * p, 0.5, [[1, 1, 0.6], [2.6, 0.5, 0.4], [4.1, 0.3, 0.25]]);
      noise(k, out, t + 0.22, { type: 'highpass', freq: 2500, dur: 0.02, peak: 0.5 });
      partials(k, out, t + 0.22, 230 * p, 0.4, [[1, 1, 0.35], [2.4, 0.5, 0.2]]);
      return 0.35 + noise(k, out, t + 0.35, { type: 'bandpass', freq: 600, freqEnd: 900, q: 8, dur: 0.5, peak: 0.12, attack: 0.1 });
    case 'kill':
      tone(k, out, t, { type: 'triangle', f0: 1046, dur: 0.12, peak: 0.45 });
      tone(k, out, t, { f0: 2600, dur: 0.04, peak: 0.4, attack: 0.001 });
      return 0.08 + tone(k, out, t + 0.08, { type: 'triangle', f0: 1568, dur: 0.3, peak: 0.45 });
    case 'death':
      noise(k, out, t, { type: 'lowpass', freq: 300, dur: 0.5, peak: 0.6 });
      tone(k, out, t, { f0: 70, f1: 35, dur: 0.4, peak: 0.9 });
      return tone(k, out, t, { type: 'sawtooth', f0: 220, f1: 55, dur: 1.1, peak: 0.25, lp: 700, attack: 0.02 });
    case 'win':
      [523, 659, 784].forEach((f, i) => note(k, out, t + i * 0.12, f, 0.5, 0.25));
      note(k, out, t + 0.36, 2094, 1.4, 0.06, 'sine');
      return 0.36 + note(k, out, t + 0.36, 1047, 1.4, 0.28);
    case 'lose':
      [440, 349].forEach((f, i) => note(k, out, t + i * 0.25, f, 0.6, 0.25));
      return 0.5 + note(k, out, t + 0.5, 294, 1.4, 0.28);
    case 'eliminated':
      tone(k, out, t, { f0: 60, f1: 35, dur: 0.5, peak: 0.8 });
      note(k, out, t, 147, 1.6, 0.2, 'sawtooth', 600);
      return note(k, out, t + 0.05, 220, 1.6, 0.15, 'sawtooth', 600);
    case 'draw':
      note(k, out, t, 392, 0.5, 0.25);
      note(k, out, t + 0.45, 392, 1.0, 0.2);
      return 0.45 + note(k, out, t + 0.45, 587, 1.0, 0.2);
    case 'alarm': {
      // Bunker threat escalates: kind '1' = one whoop, '2' = two, higher; no kind (sealed) = the full three.
      const n = cue.kind === '1' ? 1 : cue.kind === '2' ? 2 : 3;
      const f0 = cue.kind === '1' ? 420 : 470;
      let len = 0;
      for (let i = 0; i < n; i++) {
        const at = t + i * 0.6;
        for (const det of [1, 1.007]) {
          const o = k.ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f0 * det, at);
          o.frequency.linearRampToValueAtTime((f0 - 70) * det, at + 0.45);
          const f = k.ctx.createBiquadFilter();
          f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 1;
          const g = k.ctx.createGain();
          g.gain.setValueAtTime(0, at);
          g.gain.linearRampToValueAtTime(0.35, at + 0.03);
          g.gain.setValueAtTime(0.35, at + 0.4);
          g.gain.linearRampToValueAtTime(0, at + 0.45);
          o.connect(f).connect(g).connect(out);
          o.start(at); o.stop(at + 0.5);
        }
        len = at - t + 0.5;
      }
      return len;
    }
    case 'ping': // soft two-note chime (generator ready)
      partials(k, out, t, 880, 0.35, [[1, 1, 0.18], [2, 0.25, 0.12]]);
      return 0.12 + partials(k, out, t + 0.12, 1320, 0.5, [[1, 1, 0.16], [2, 0.2, 0.1]]);
    case 'tick':
      if (cue.kind === 'urgent') {
        tone(k, out, t, { f0: 1500, dur: 0.06, peak: 0.45, attack: 0.002 });
        return 0.1 + tone(k, out, t + 0.1, { f0: 1500, dur: 0.06, peak: 0.45, attack: 0.002 });
      }
      return tone(k, out, t, { f0: 1000, dur: 0.07, peak: 0.4, attack: 0.002 });
    case 'escaped': {
      let len = 0;
      [784, 988, 1175, 1568].forEach((f, i) => { len = i * 0.09 + partials(k, out, t + i * 0.09, f, 0.22, [[1, 1, 0.6], [2, 0.2, 0.3]]); });
      return len;
    }
    case 'thunder':
      if (cue.kind === 'near') {
        // Close strike: a ripping crack, then the boom.
        noise(k, out, t, { type: 'highpass', freq: 1800, dur: 0.12, peak: 1.0, attack: 0.001 });
        noise(k, out, t + 0.02, { type: 'bandpass', freq: 700 * p, q: 0.6, dur: 0.5, peak: 0.9 });
      }
      noise(k, out, t, { type: 'lowpass', freq: 380 * p, freqEnd: 60, dur: 2.8 + k.rnd() * 1.5, peak: 1.2, attack: cue.kind === 'near' ? 0.01 : 0.25, rate: 0.5 });
      return 0.3 + noise(k, out, t + 0.3 + k.rnd() * 0.4, { type: 'lowpass', freq: 160, freqEnd: 45, dur: 3, peak: 0.8, attack: 0.3, rate: 0.4 });
    case 'horn':
      note(k, out, t, 233, 2.2, 0.22, 'sawtooth', 1400);
      note(k, out, t, 235.5, 2.2, 0.22, 'sawtooth', 1400);
      return note(k, out, t, 466, 2.2, 0.12, 'sawtooth', 1400);
    case 'footstep': return footstep(k, out, t, cue);
    case 'shieldHit':
      // Glassy energy ping: bright inharmonic ring + a short zap, no low thud (that's flesh).
      noise(k, out, t, { type: 'highpass', freq: 5000 * p, dur: 0.03, peak: 0.45 });
      tone(k, out, t, { type: 'triangle', f0: 1900 * p, f1: 1300 * p, dur: 0.09, peak: 0.35, attack: 0.001 });
      return partials(k, out, t, 1250 * p, 0.25, [[1, 1, 0.22], [2.31, 0.6, 0.15], [3.73, 0.35, 0.1]]);
    case 'shieldBreak': {
      // Shatter: a crack, then a spray of glass shards and a falling zap.
      noise(k, out, t, { type: 'highpass', freq: 2500, dur: 0.06, peak: 0.9 });
      tone(k, out, t, { type: 'sawtooth', f0: 1600, f1: 180, dur: 0.35, peak: 0.25, lp: 3000, attack: 0.002 });
      let len = 0.4;
      for (let i = 0; i < 9; i++) {
        const at = t + 0.02 + k.rnd() * 0.35;
        len = Math.max(len, at - t + partials(k, out, at, 2400 + k.rnd() * 3200, 0.12 + k.rnd() * 0.1, [[1, 1, 0.08 + k.rnd() * 0.1], [2.7, 0.4, 0.05]]));
      }
      return len;
    }
    case 'drink': {
      // Three gulps: low bandpassed bloops with a little rising pitch.
      let len = 0;
      for (let i = 0; i < 3; i++) {
        const at = t + i * 0.22;
        noise(k, out, at, { type: 'bandpass', freq: 450 * p, q: 3, dur: 0.07, peak: 0.35, attack: 0.01 });
        len = at - t + tone(k, out, at, { f0: 170 * p, f1: 330 * p, dur: 0.1, peak: 0.45, attack: 0.008 });
      }
      return len;
    }
    case 'potionDone': {
      // Rising sparkle; shields shimmer higher.
      const base = cue.kind === 'shieldSmall' || cue.kind === 'shieldBig' ? 1047 : cue.kind === 'speedPotion' ? 880 : 784;
      let len = 0;
      [1, 1.25, 1.5, 2].forEach((r, i) => { len = i * 0.06 + partials(k, out, t + i * 0.06, base * r * p, 0.18, [[1, 1, 0.4], [2, 0.25, 0.2]]); });
      return len;
    }
    default: return 0;
  }
}

/** Ambient one-shots (always positional, far away). */
export function gull(k: Kit, out: AudioNode, t: number): number {
  const calls = 2 + Math.floor(k.rnd() * 3);
  let len = 0;
  for (let i = 0; i < calls; i++) {
    const at = t + i * (0.35 + k.rnd() * 0.25);
    const p = jitter(k.rnd(), 0.1);
    const o = k.ctx.createOscillator();
    o.frequency.setValueAtTime(1300 * p, at);
    o.frequency.linearRampToValueAtTime(2100 * p, at + 0.07);
    o.frequency.exponentialRampToValueAtTime(1400 * p, at + 0.32);
    const g = k.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.25, at + 0.04);
    g.gain.exponentialRampToValueAtTime(EPS, at + 0.34);
    o.connect(g).connect(out);
    o.start(at); o.stop(at + 0.36);
    len = at - t + 0.36;
  }
  return len;
}

export function clank(k: Kit, out: AudioNode, t: number): number {
  const p = jitter(k.rnd(), 0.15);
  partials(k, out, t, 180 * p, 0.35, [[1, 1, 0.9], [2.4, 0.6, 0.6], [3.9, 0.3, 0.4]]);
  return 0.45 + partials(k, out, t + 0.45, 210 * p, 0.25, [[1, 1, 0.7], [2.7, 0.4, 0.4]]);
}

export function heartbeat(k: Kit, out: AudioNode, t: number): number {
  tone(k, out, t, { f0: 62, f1: 40, dur: 0.12, peak: 0.9 });
  noise(k, out, t, { type: 'lowpass', freq: 120, dur: 0.08, peak: 0.5 });
  return 0.18 + tone(k, out, t + 0.18, { f0: 55, f1: 38, dur: 0.1, peak: 0.65 });
}

/**
 * Rocket motor: a looping band-passed roar. Returns a stop function (fades out) and a rate setter.
 * Played through a positional chain that the engine moves with the rocket.
 */
export function rocketLoop(k: Kit, out: AudioNode): { stop(): void } {
  const { ctx, white } = k;
  const s = ctx.createBufferSource();
  s.buffer = white;
  s.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.6;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 400;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.55, t + 0.08);
  s.connect(bp).connect(g);
  s.connect(lp).connect(g);
  g.connect(out);
  s.start(t, k.rnd() * 2);
  return {
    stop() {
      const now = ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0, now, 0.04);
      s.stop(now + 0.3);
    },
  };
}

/** One pitched chirp: oscillator sweep f0 → f1 over `dur`, peak gain `g`. */
function chirp(k: Kit, out: AudioNode, at: number, type: OscillatorType, f0: number, f1: number, dur: number, g: number) {
  const o = k.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
  const e = k.ctx.createGain();
  e.gain.setValueAtTime(0, at);
  e.gain.linearRampToValueAtTime(g, at + Math.min(0.02, dur * 0.3));
  e.gain.exponentialRampToValueAtTime(EPS, at + dur);
  o.connect(e).connect(out);
  o.start(at); o.stop(at + dur + 0.02);
}

/** Wildlife calls (world/critters.ts): quiet, short, positional. Returns the length (s); 0 = unknown kind. */
export function critterCall(k: Kit, out: AudioNode, t: number, kind: string): number {
  const p = jitter(k.rnd(), 0.12);
  switch (kind) {
    case 'squeak': {
      const n = 1 + Math.floor(k.rnd() * 3);
      for (let i = 0; i < n; i++) chirp(k, out, t + i * 0.09, 'sine', 3800 * p, 5200 * p, 0.06, 0.12);
      return n * 0.09 + 0.06;
    }
    case 'bark':
      chirp(k, out, t, 'sawtooth', 420 * p, 260 * p, 0.14, 0.18);
      noise(k, out, t, { dur: 0.12, peak: 0.12, type: 'bandpass', freq: 900 * p, q: 2 });
      return 0.2;
    case 'coo':
      chirp(k, out, t, 'sine', 420 * p, 360 * p, 0.25, 0.08);
      chirp(k, out, t + 0.3, 'sine', 460 * p, 330 * p, 0.35, 0.07);
      return 0.7;
    case 'caw':
      for (let i = 0; i < 2; i++) {
        chirp(k, out, t + i * 0.32, 'sawtooth', 900 * p, 620 * p, 0.22, 0.09);
        noise(k, out, t + i * 0.32, { dur: 0.2, peak: 0.05, type: 'bandpass', freq: 1400, q: 1.5 });
      }
      return 0.6;
    case 'squawk':
      chirp(k, out, t, 'square', 1800 * p, 2600 * p, 0.12, 0.06);
      chirp(k, out, t + 0.13, 'square', 2600 * p, 1500 * p, 0.18, 0.06);
      return 0.35;
    case 'croak':
      chirp(k, out, t, 'sawtooth', 160 * p, 120 * p, 0.35, 0.1);
      return 0.4;
    case 'flap':
      for (let i = 0; i < 4; i++) noise(k, out, t + i * 0.11, { dur: 0.07, peak: 0.1, type: 'bandpass', freq: 700 * p, q: 0.8 });
      return 0.5;
    case 'gull':
      return gull(k, out, t);
    case 'splash':
      noise(k, out, t, { dur: 0.25, peak: 0.12, type: 'highpass', freq: 1500 });
      return 0.3;
    case 'buzz': {
      // fly / bee: a buzzing saw with a wobbling pitch, swelling past the ear
      const o = k.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(190 * p, t);
      o.frequency.linearRampToValueAtTime(240 * p, t + 0.4);
      o.frequency.linearRampToValueAtTime(175 * p, t + 0.9);
      const f = k.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 600; f.Q.value = 1.2;
      const e = k.ctx.createGain();
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(0.05, t + 0.3);
      e.gain.linearRampToValueAtTime(EPS, t + 1.0);
      o.connect(f).connect(e).connect(out);
      o.start(t); o.stop(t + 1.05);
      return 1.05;
    }
    default:
      return 0;
  }
}

/** Crackle buffer (2 s, looped): sparse pops and snaps over a low roar, generated once per context. */
const crackles = new WeakMap<AudioContext, AudioBuffer>();
function crackleBuffer(k: Kit): AudioBuffer {
  let b = crackles.get(k.ctx);
  if (b) return b;
  const sr = k.ctx.sampleRate, n = Math.floor(sr * 2);
  b = k.ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  let roar = 0;
  for (let i = 0; i < n; i++) { roar = roar * 0.985 + (k.rnd() * 2 - 1) * 0.015; d[i] = roar * 2.2; }
  for (let i = 0; i < n; i++) {
    if (k.rnd() > 0.0009) continue;
    const len = Math.floor(sr * (0.002 + k.rnd() * 0.012)), amp = 0.25 + k.rnd() * 0.75;
    for (let j = 0; j < len && i + j < n; j++) d[i + j] += (k.rnd() * 2 - 1) * amp * Math.exp((-6 * j) / len);
  }
  crackles.set(k.ctx, b);
  return b;
}

/** Fire crackle loop (positional via `out`); stop() fades it out. */
export function fireLoop(k: Kit, out: AudioNode): { stop(): void } {
  const { ctx } = k;
  const s = ctx.createBufferSource();
  s.buffer = crackleBuffer(k);
  s.loop = true;
  s.playbackRate.value = 0.85 + k.rnd() * 0.3;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 120;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.6);
  s.connect(hp).connect(g).connect(out);
  s.start(t, k.rnd() * 2);
  return {
    stop() {
      const now = ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0, now, 0.3);
      s.stop(now + 1.5);
    },
  };
}
