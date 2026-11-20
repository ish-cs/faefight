// Web Audio graph, voice playback, listener, ambience and settings.
//
//   voice ─ air-absorption LP ─ HRTF panner ─┬─ sfxBus ─┬──────────── world ─ muffle LP ─┐
//                                            └─ echoSend ─ echo (delay/LP/feedback) ─┘   ├─ compressor ─ master ─ out
//                                                        sfxBus ─ reverbSend ─ convolver ─┘
//   ambience (waves, foam, wind) ─ ambientLP ─ world                 uiBus (stingers, heartbeat) ─┘

import type { IslandLayout } from '../../sim/map';
import type { Snapshot, Vec3 } from '../../sim/types';
import { type Cue, type Env, SoundDirector } from './events';
import { clank, gull, heartbeat, type Kit, playRecipe } from './sfx';
import {
  audibility, DEFAULT_LIMITS, dist, distanceCutoff, echoSend, heartbeatInterval, MAX_DISTANCE, muffleCutoff,
  REF_DISTANCE, ROLLOFF, VoiceLimiter, waveLevel,
} from './voices';

const VOL_KEY = 'faefight.volume';
const MUTE_KEY = 'faefight.muted';
/** 2D cues that should not be muffled by low health or reverb (UI-ish). */
const UI_SOUNDS = new Set(['hitmarker', 'kill', 'death', 'eliminated', 'win', 'lose', 'draw', 'alarm', 'tick', 'escaped', 'horn', 'coin', 'loot', 'purchase', 'vault']);

type Chain = { input: GainNode; air: BiquadFilterNode; panner: PannerNode; echo: GainNode };
type CameraLike = { matrixWorld: { elements: ArrayLike<number> } };

function readStore(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* private mode: settings just don't persist */ }
}

export type AudioStats = { state: string; played: number; dropped: number; active: number; bySound: Record<string, number> };

export class AudioSystem {
  volume: number;
  muted: boolean;
  private ctx: AudioContext | null = null;
  private kit: Kit | null = null;
  private master!: GainNode;
  private world!: GainNode;
  private muffle!: BiquadFilterNode;
  private sfxBus!: GainNode;
  private uiBus!: GainNode;
  private reverbSend!: GainNode;
  private echoIn!: GainNode;
  private ambient: { bus: GainNode; lp: BiquadFilterNode; waves: GainNode; wind: GainNode } | null = null;
  private pool: Chain[] = [];
  private voices = new Map<number, GainNode>();
  private limiter = new VoiceLimiter(DEFAULT_LIMITS);
  private director = new SoundDirector();
  private listener: Vec3 = { x: 0, y: 0, z: 0 };
  private started = false;
  private nextAmbientAt = 0;
  private nextBeatAt = 0;
  private stats_ = { played: 0, bySound: {} as Record<string, number> };
  private listeners = new Set<() => void>();

  constructor() {
    const v = Number(readStore(VOL_KEY));
    this.volume = readStore(VOL_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
    this.muted = readStore(MUTE_KEY) === '1';
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', (e) => {
      unlock();
      if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      this.setMuted(!this.muted);
    }, { capture: true });
  }

  /** Subscribe to volume/mute changes (UI controls). */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    writeStore(VOL_KEY, String(this.volume));
    this.applyMaster();
  }

  setMuted(m: boolean) {
    this.muted = m;
    writeStore(MUTE_KEY, m ? '1' : '0');
    this.applyMaster();
  }

  private applyMaster() {
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    this.listeners.forEach((fn) => fn());
  }

  /** Create/resume the AudioContext. Must run inside a user gesture (browser autoplay policy). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch((e) => console.warn('[audio] resume failed', e));
      return;
    }
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('[audio] Web Audio unavailable; running silent', e);
      return;
    }
    this.build(this.ctx);
    this.ctx.resume().catch((e) => console.warn('[audio] resume failed', e));
    console.info(`[audio] context ${this.ctx.state} @ ${this.ctx.sampleRate} Hz`);
  }

  private build(ctx: AudioContext) {
    const white = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const w = white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
    this.kit = { ctx, white, rnd: Math.random };

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    comp.connect(this.master).connect(ctx.destination);

    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.muffle.Q.value = 0.5;
    this.world = ctx.createGain();
    this.world.connect(this.muffle).connect(comp);
    this.uiBus = ctx.createGain();
    this.uiBus.gain.value = 0.8;
    this.uiBus.connect(comp);

    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.world);

    // Short synthetic room: enclosed bunker reverb (send level follows the listener's location).
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, 0.9, 3.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.06;
    this.sfxBus.connect(this.reverbSend).connect(conv).connect(this.world);

    // Distant slap-back echo for far shots and explosions.
    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.22;
    const elp = ctx.createBiquadFilter();
    elp.type = 'lowpass'; elp.frequency.value = 1200;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    this.echoIn.connect(delay).connect(elp).connect(this.world);
    elp.connect(fb).connect(delay);
  }

  private startAmbient(ctx: AudioContext) {
    const loop = (seconds: number, brown: boolean) => {
      const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      const d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const r = Math.random() * 2 - 1;
        if (brown) { last = (last + 0.02 * r) / 1.02; d[i] = last * 3.5; } else d[i] = r;
      }
      const s = ctx.createBufferSource();
      s.buffer = b; s.loop = true;
      return s;
    };
    const lfo = (hz: number, depth: number, target: AudioParam) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g).connect(target);
      o.start();
    };
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.gain.setTargetAtTime(1, ctx.currentTime, 1.5); // fade in
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 20000;
    bus.connect(lp).connect(this.world);

    // Waves: brown-noise swell + a hissy foam layer on a different period.
    const waves = ctx.createGain();
    waves.gain.value = 0.5;
    waves.connect(bus);
    const swell = ctx.createGain();
    swell.gain.value = 0.35;
    lfo(0.085, 0.3, swell.gain);
    const wlp = ctx.createBiquadFilter();
    wlp.type = 'lowpass'; wlp.frequency.value = 520;
    lfo(0.085, 180, wlp.frequency);
    const brown = loop(9, true);
    brown.connect(wlp).connect(swell).connect(waves);
    brown.start();
    const foam = ctx.createGain();
    foam.gain.value = 0.025;
    lfo(0.13, 0.02, foam.gain);
    const fhp = ctx.createBiquadFilter();
    fhp.type = 'bandpass'; fhp.frequency.value = 2500; fhp.Q.value = 0.4;
    const hiss = loop(7, false);
    hiss.connect(fhp).connect(foam).connect(waves);
    hiss.start();

    // Wind: band-passed noise with a slowly wandering centre.
    const wind = ctx.createGain();
    wind.gain.value = 0.035;
    lfo(0.05, 0.015, wind.gain);
    const wbp = ctx.createBiquadFilter();
    wbp.type = 'bandpass'; wbp.frequency.value = 520; wbp.Q.value = 0.8;
    lfo(0.037, 220, wbp.frequency);
    const air = loop(6, false);
    air.connect(wbp).connect(wind).connect(bus);
    air.start();

    this.ambient = { bus, lp, waves, wind };
    this.nextAmbientAt = ctx.currentTime + 6 + Math.random() * 8;
  }

  setMap(map: IslandLayout[], humanId: number) {
    this.director.setMap(map, humanId);
  }

  /** Debug (?debug=1): play any cue directly, bypassing the event mapping. */
  debugPlay(cue: Cue) {
    this.play(cue);
  }

  /** UI-originated sounds (e.g. opening the vault). */
  ui(sound: 'vault') {
    this.play({ sound, pos: null, gain: 0.8 });
  }

  /** Feed every snapshot in order (events are per snapshot). */
  snapshot(s: Snapshot) {
    const cues = this.director.update(s);
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.started) { this.started = true; this.startAmbient(this.ctx); }
    for (const c of cues) this.play(c);
  }

  /** Per render frame: listener follows the camera; ambience/muffle follow the player. */
  frame(camera: CameraLike) {
    this.limiter.beginFrame();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const e = camera.matrixWorld.elements;
    this.listener.x = e[12]; this.listener.y = e[13]; this.listener.z = e[14];
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = e[12]; l.positionY.value = e[13]; l.positionZ.value = e[14];
      l.forwardX.value = -e[8]; l.forwardY.value = -e[9]; l.forwardZ.value = -e[10];
      l.upX.value = e[4]; l.upY.value = e[5]; l.upZ.value = e[6];
    } else {
      l.setPosition(e[12], e[13], e[14]);
      l.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
    if (this.started) this.environment(ctx, this.director.env);
  }

  private environment(ctx: AudioContext, env: Env) {
    const now = ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(muffleCutoff(env.hp, env.alive), now, 0.25);
    this.reverbSend.gain.setTargetAtTime(env.inBunker ? 0.5 : 0.06, now, 0.15);
    const a = this.ambient!;
    a.waves.gain.setTargetAtTime(0.5 * waveLevel(env.shoreDist) * (env.inBunker ? 0.35 : 1), now, 0.5);
    a.wind.gain.setTargetAtTime(env.inBunker ? 0.012 : 0.035, now, 0.5);
    a.lp.frequency.setTargetAtTime(env.inBunker ? 500 : 20000, now, 0.15);

    if (env.alive && env.hp < 30 && env.hp > 0) {
      if (now >= this.nextBeatAt) {
        heartbeat(this.kit!, this.uiBus, now + 0.02);
        this.nextBeatAt = now + heartbeatInterval(env.hp);
      }
    } else this.nextBeatAt = 0;

    if (now >= this.nextAmbientAt) {
      this.nextAmbientAt = now + 9 + Math.random() * 14;
      if (!env.inBunker) {
        const ang = Math.random() * Math.PI * 2, r = 30 + Math.random() * 35;
        const pos = { x: this.listener.x + Math.cos(ang) * r, y: this.listener.y + 4 + Math.random() * 10, z: this.listener.z + Math.sin(ang) * r };
        this.spatial(pos, 0.5, 'ambient', (out, t) => (Math.random() < 0.65 ? gull : clank)(this.kit!, out, t));
      }
    }
  }

  private play(cue: Cue) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.kit) return;
    const d = cue.pos ? dist(cue.pos, this.listener) : 0;
    const key = cue.sound === 'shot' ? `shot_${cue.kind}` : cue.sound;
    const level = audibility(cue.gain, cue.pos, this.listener);
    // Generous expiry backstop; the voice is released by timer when its recipe actually ends.
    const adm = this.limiter.admit(key, level, ctx.currentTime, 10);
    if (!adm.ok) return;
    if (adm.evict !== null) this.stopVoice(adm.evict);
    // Tiny start offset on repeated world sounds so simultaneous shots don't phase-lock.
    const t = ctx.currentTime + (cue.own || !cue.pos ? 0.005 : 0.005 + Math.random() * 0.012);
    let len: number;
    let input: GainNode;
    if (cue.pos) {
      const ch = this.chain(cue.pos, d);
      input = ch.input;
      input.gain.value = cue.gain;
      len = playRecipe(this.kit, input, t, cue, d) + 0.1;
      setTimeout(() => this.releaseChain(ch), (len + 0.3) * 1000);
    } else {
      input = ctx.createGain();
      input.gain.value = cue.gain;
      input.connect(UI_SOUNDS.has(cue.sound) ? this.uiBus : this.sfxBus);
      len = playRecipe(this.kit, input, t, cue, d) + 0.1;
      setTimeout(() => input.disconnect(), (len + 0.3) * 1000);
    }
    this.voices.set(adm.id, input);
    setTimeout(() => { this.limiter.release(adm.id); this.voices.delete(adm.id); }, len * 1000);
    this.count(key);
  }

  /** Ambient one-shots: positional, bypass the limiter's frame caps but still count. */
  private spatial(pos: Vec3, gain: number, key: string, recipe: (out: AudioNode, t: number) => number) {
    const ch = this.chain(pos, dist(pos, this.listener));
    ch.input.gain.value = gain;
    const len = recipe(ch.input, this.ctx!.currentTime + 0.01);
    setTimeout(() => this.releaseChain(ch), (len + 0.4) * 1000);
    this.count(key);
  }

  private chain(pos: Vec3, d: number): Chain {
    const ctx = this.ctx!;
    let ch = this.pool.pop();
    if (!ch) {
      const input = ctx.createGain();
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      const panner = new PannerNode(ctx, {
        panningModel: 'HRTF', distanceModel: 'inverse', refDistance: REF_DISTANCE, maxDistance: MAX_DISTANCE, rolloffFactor: ROLLOFF,
      });
      const echo = ctx.createGain();
      input.connect(air).connect(panner).connect(this.sfxBus);
      panner.connect(echo).connect(this.echoIn);
      ch = { input, air, panner, echo };
    }
    ch.air.frequency.value = distanceCutoff(d);
    ch.echo.gain.value = echoSend(d);
    ch.panner.positionX.value = pos.x; ch.panner.positionY.value = pos.y; ch.panner.positionZ.value = pos.z;
    return ch;
  }

  private releaseChain(ch: Chain) {
    if (this.pool.length < 32) { ch.input.gain.cancelScheduledValues(0); ch.input.gain.value = 1; this.pool.push(ch); }
    else { ch.input.disconnect(); ch.panner.disconnect(); }
  }

  private stopVoice(id: number) {
    const g = this.voices.get(id);
    if (!g || !this.ctx) return;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    this.voices.delete(id);
  }

  private count(key: string) {
    this.stats_.played++;
    this.stats_.bySound[key] = (this.stats_.bySound[key] ?? 0) + 1;
  }

  stats(): AudioStats {
    return { state: this.ctx?.state ?? 'none', played: this.stats_.played, dropped: this.limiter.dropped, active: this.limiter.count, bySound: { ...this.stats_.bySound } };
  }
}

/** Stereo exponentially-decaying noise: a small concrete room. */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}
