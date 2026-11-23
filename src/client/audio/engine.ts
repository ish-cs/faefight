// Web Audio graph, voice playback, listener, ambience and settings.
//
//   voice ─ air/occlusion LP ─ HRTF panner ─┬─ sfxBus ─┬──────────── world ─ muffle LP ─┐
//                                           └─ echoSend ─ echo (delay/LP/feedback) ─┘   ├─ compressor ─ master ─ out
//                                                       sfxBus ─ reverbSend ─ convolver ─┘                  │
//   ambience loops (waves, foam, wind, rain) ─ ambientLP ─┬─ ambBus ─ world                                 │
//   ambient one-shots (gulls, critters) ─ panner ─────────┘         uiBus (stingers, heartbeat) ─ comp      │
//   music (music.ts, persistent voices) ─ musicBus ──────────────────────────────────────────────────── master
//
// Mixer buses = Settings → Audio: Effects (sfxBus + echo), Interface (uiBus), Ambience (ambBus), Music
// (musicBus, also on/off), under Master. Music skips the compressor so gunfire doesn't pump it.

import type { DockDef, IslandLayout } from '../../sim/map';
import type { Snapshot, Vec3 } from '../../sim/types';
import { type Cue, type Env, occlusion, type SoundId, SoundDirector } from './events';
import { type Mood, MUSIC_TRIM, MusicDirector, MusicPlayer } from './music';
import { casingClink, clank, critterCall, fireLoop, gull, heartbeat, type Kit, playRecipe, rocketLoop } from './sfx';
import { registerAudio, type SfxOpts } from './api';
import {
  audibility, DEFAULT_LIMITS, dist, distanceCutoff, echoSend, heartbeatInterval, MAX_DISTANCE, muffleCutoff,
  REF_DISTANCE, ROLLOFF, VoiceLimiter, voicePriority, waveLevel, withinHearing,
} from './voices';
import { isAction } from '../keymap';
import { settings, type Settings } from '../settings/store';

/** 2D cues on the Interface bus: not muffled by low health or reverb. */
const UI_SOUNDS = new Set(['hitmarker', 'headshot', 'shieldCrack', 'kill', 'death', 'eliminated', 'elimination', 'win', 'lose', 'draw', 'alarm', 'tick', 'escaped', 'horn', 'coin', 'loot', 'purchase', 'vault', 'click', 'ping']);
/** Past this distance a shot or blast arrives late, at the speed of sound (343 m/s), like thunder. */
const SOUND_DELAY_FROM = 40;
/** Low-pass cutoff (Hz) and level for a sound behind one wall / two or more. */
const OCCLUDED = [{ hz: 1100, gain: 0.6 }, { hz: 600, gain: 0.4 }] as const;

type Bus = 'sfx' | 'amb';
type Chain = { input: GainNode; air: BiquadFilterNode; panner: PannerNode; echo: GainNode; bus: Bus };
type CameraLike = { matrixWorld: { elements: ArrayLike<number> } };


export type AudioStats = { state: string; played: number; dropped: number; active: number; bySound: Record<string, number>; music: Mood | 'none' };

export class AudioSystem {
  /** Master volume / mute / bus levels mirror Settings → Audio (the store persists them). */
  volume = 0.8;
  muted = false;
  effects = 1;
  uiVol = 0.8;
  ambience = 1;
  musicVol = 0.4;
  musicOn = true;
  private ctx: AudioContext | null = null;
  private kit: Kit | null = null;
  private master!: GainNode;
  private world!: GainNode;
  private muffle!: BiquadFilterNode;
  private sfxBus!: GainNode;
  private uiBus!: GainNode;
  private ambBus!: GainNode;
  private musicBus!: GainNode;
  private music: MusicPlayer | null = null;
  private musicDir = new MusicDirector();
  private mood: Mood = 'calm';
  private map: IslandLayout[] = [];
  /** 1 = full day, 0 = night (setDaylight; the day/night cycle drives it). */
  private daylight = 1;
  private reverbSend!: GainNode;
  private echoIn!: GainNode;
  private ambient: { bus: GainNode; lp: BiquadFilterNode; waves: GainNode; wind: GainNode; rain: GainNode } | null = null;
  private pools: Record<Bus, Chain[]> = { sfx: [], amb: [] };
  private voices = new Map<number, GainNode>();
  private limiter = new VoiceLimiter(DEFAULT_LIMITS);
  private director = new SoundDirector();
  private listener: Vec3 = { x: 0, y: 0, z: 0 };
  private started = false;
  private nextAmbientAt = 0;
  private nextBeatAt = 0;
  private stats_ = { played: 0, bySound: {} as Record<string, number> };
  private listeners = new Set<() => void>();
  /** Rocket motor loops, by projectile id, each on its own positional chain. */
  private flights = new Map<number, { ch: Chain; loop: { stop(): void } }>();
  private blazes = new Map<string, { ch: Chain; loop: { stop(): void } }>();

  constructor() {
    registerAudio(this);
    this.applySettings(settings.get().audio);
    // Interface clicks: any button in the menus, shop, vault or settings.
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('button, .btn, [role="button"]')) this.play({ sound: 'click', pos: null, gain: 0.5 });
    }, { capture: true });
    settings.subscribe((s) => this.applySettings(s.audio));
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', (e) => {
      unlock();
      if (!isAction('mute', e.code) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      this.setMuted(!this.muted);
    }, { capture: true });
  }

  /** Subscribe to volume/mute changes (UI controls). */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  setVolume(v: number) {
    settings.update((s) => { s.audio.master = Math.min(1, Math.max(0, v)); });
  }

  setMuted(m: boolean) {
    settings.update((s) => { s.audio.muted = m; });
  }

  private applySettings(a: Settings['audio']) {
    this.volume = a.master;
    this.muted = a.muted;
    this.effects = a.effects;
    this.uiVol = a.ui;
    this.ambience = a.ambience;
    this.musicVol = a.music;
    this.musicOn = a.musicOn;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.02);
      this.sfxBus.gain.setTargetAtTime(this.effects, t, 0.02);
      this.echoIn.gain.setTargetAtTime(this.effects, t, 0.02);
      this.uiBus.gain.setTargetAtTime(this.uiVol, t, 0.02);
      this.ambBus.gain.setTargetAtTime(this.ambience, t, 0.05);
      this.musicBus.gain.setTargetAtTime(this.musicLevel(), t, 0.05);
      if (!this.musicWanted() && this.music) { this.music.dispose(); this.music = null; }
    }
    this.listeners.forEach((fn) => fn());
  }

  private musicLevel() { return this.musicOn ? this.musicVol * MUSIC_TRIM : 0; }
  private musicWanted() { return this.musicOn && this.musicVol > 0; }

  private critterVoices = 0;
  /**
   * Wildlife call at `s` (world/critters.ts): quiet, positional, scaled by the Ambience volume, only within 20 m,
   * at most 4 at once so a scattering flock doesn't swamp the mix.
   */
  critter(s: { kind: string; x: number; y: number; z: number }) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.kit || this.muted || this.ambience <= 0) return;
    if (dist(s, this.listener) > 20 || this.critterVoices >= 4) return;
    this.critterVoices++;
    this.spatial(s, 0.6, `critter_${s.kind}`, (out, t) => {
      const len = critterCall(this.kit!, out, t, s.kind);
      setTimeout(() => { this.critterVoices--; }, (len + 0.1) * 1000);
      return len;
    });
  }

  private casingVoices = 0;
  private casingAt: Vec3 = { x: 0, y: 0, z: 0 };
  /**
   * A shell casing bouncing (world/casings.ts): positional, on the effects bus, only within 14 m and at most
   * 6 at once (a long spray doesn't turn into a wall of clinks). `speed` = impact speed (m/s).
   */
  casing(x: number, y: number, z: number, speed: number, hull: boolean) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.kit || this.muted || this.effects <= 0) return;
    const at = this.casingAt;
    at.x = x; at.y = y; at.z = z;
    if (dist(at, this.listener) > 14 || this.casingVoices >= 6) return;
    this.casingVoices++;
    const v = Math.min(1, speed / 6);
    this.spatial(at, 0.7, hull ? 'casing_hull' : 'casing', (out, t) => {
      const len = casingClink(this.kit!, out, t, hull, v);
      setTimeout(() => { this.casingVoices--; }, (len + 0.05) * 1000);
      return len;
    });
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
    this.uiBus.gain.value = this.uiVol;
    this.uiBus.connect(comp);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = this.ambience;
    this.ambBus.connect(this.world);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicLevel();
    this.musicBus.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.effects;
    this.sfxBus.connect(this.world);

    // Short synthetic room: enclosed bunker reverb (send level follows the listener's location).
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, 0.9, 3.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.06;
    this.sfxBus.connect(this.reverbSend).connect(conv).connect(this.world);

    // Distant slap-back echo for far shots and explosions.
    this.echoIn = ctx.createGain();
    this.echoIn.gain.value = this.effects;
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
    bus.gain.setTargetAtTime(1, ctx.currentTime, 1.5); // fade in (the Ambience level is ambBus)
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 20000;
    bus.connect(lp).connect(this.ambBus);

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

    // Rain (sudden-death storm): a hiss of drops plus a low wash; silent until the storm starts.
    const rain = ctx.createGain();
    rain.gain.value = 0;
    const rhp = ctx.createBiquadFilter();
    rhp.type = 'bandpass'; rhp.frequency.value = 4200; rhp.Q.value = 0.3;
    const drops = loop(5, false);
    drops.connect(rhp).connect(rain);
    const wash = ctx.createGain();
    wash.gain.value = 0.5;
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass'; rlp.frequency.value = 900;
    const brown2 = loop(8, true);
    brown2.connect(rlp).connect(wash).connect(rain);
    lfo(0.07, 0.15, wash.gain);
    rain.connect(bus);
    drops.start(); brown2.start();

    this.ambient = { bus, lp, waves, wind, rain };
    this.nextAmbientAt = ctx.currentTime + 6 + Math.random() * 8;
  }

  /** Whose ears: the followed player while spectating, else the local player (viewed.ts). */
  setViewed(id: number) { this.director.setViewed(id); this.musicDir.setViewed(id); }

  setMap(map: IslandLayout[], humanId: number, docks: readonly DockDef[] = []) {
    this.director.setMap(map, humanId, docks);
    this.map = map;
    this.musicDir.reset();
    this.musicDir.setViewed(humanId);
  }

  /** Day/night (0 = night, 1 = day): gulls and clanks by day, crickets and owls at night. */
  setDaylight(k: number) { this.daylight = Math.min(1, Math.max(0, k)); }

  /**
   * Play a named sound effect (names: SoundId in events.ts, documented in api.ts). `pos` = world position
   * for a 3D sound with distance falloff, air absorption and occlusion; null = 2D (your own body / the UI).
   */
  playSfx(sound: SoundId, pos: Vec3 | null = null, opts: SfxOpts = {}) {
    this.play({ sound, pos, gain: opts.gain ?? 0.8, kind: opts.kind, own: opts.own });
  }

  /** Debug (?debug=1): play any cue directly, bypassing the event mapping. */
  debugPlay(cue: Cue) {
    this.play(cue);
  }

  /** HUD alerts (bunker threat alarm, generator ping): 2D, through the usual effects bus and volume settings. */
  alert(cue: Cue) {
    this.play(cue);
  }

  /** UI-originated sounds (e.g. opening the vault). */
  ui(sound: 'vault' | 'tick', gain = 0.8) {
    this.play({ sound, pos: null, gain });
  }

  /** Predicted shot / hitmarker (shotPredict.ts): the host's echo of it plays nothing. */
  predicted(sound: 'shot' | 'hitmarker' | 'headshot', kind?: string) {
    this.play(sound === 'shot' ? { sound, kind, pos: null, gain: 1, own: true } : { sound, pos: null, gain: sound === 'headshot' ? 0.7 : 0.6 });
  }

  /** Your own handling sounds that the sim doesn't report (raising the sights). */
  local(sound: 'ads') {
    this.play({ sound, pos: null, gain: 0.7, own: true });
  }

  /** Per frame: a motor loop follows every rocket in the air; it stops when the rocket is gone. */
  rockets(list: { id: number; pos: Vec3 }[]) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.kit) return;
    const seen = new Set<number>();
    for (const r of list) {
      seen.add(r.id);
      let f = this.flights.get(r.id);
      const d = dist(r.pos, this.listener);
      if (!f) {
        const ch = this.chain(r.pos, d);
        ch.input.gain.value = 0.9;
        f = { ch, loop: rocketLoop(this.kit, ch.input) };
        this.flights.set(r.id, f);
        this.count('rocketLoop');
      }
      const p = f.ch.panner;
      p.positionX.value = r.pos.x; p.positionY.value = r.pos.y; p.positionZ.value = r.pos.z;
      f.ch.air.frequency.value = distanceCutoff(d);
    }
    for (const [id, f] of this.flights) {
      if (seen.has(id)) continue;
      f.loop.stop();
      setTimeout(() => this.releaseChain(f.ch), 400);
      this.flights.delete(id);
    }
  }

  /** Per frame: crackle loops on the (up to) three burning things nearest the listener, within earshot. */
  fires(list: { id: string; pos: Vec3 }[]) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.kit) return;
    const near = list.map((f) => ({ f, d: dist(f.pos, this.listener) })).filter((x) => x.d < 45).sort((a, b) => a.d - b.d).slice(0, 3);
    const seen = new Set<string>();
    for (const { f, d } of near) {
      seen.add(f.id);
      let b = this.blazes.get(f.id);
      if (!b) {
        const ch = this.chain(f.pos, d);
        ch.input.gain.value = 0.8;
        b = { ch, loop: fireLoop(this.kit, ch.input) };
        this.blazes.set(f.id, b);
        this.count('fireLoop');
      }
      const p = b.ch.panner;
      p.positionX.value = f.pos.x; p.positionY.value = f.pos.y; p.positionZ.value = f.pos.z;
      b.ch.air.frequency.value = distanceCutoff(d);
    }
    for (const [id, b] of this.blazes) {
      if (seen.has(id)) continue;
      b.loop.stop();
      setTimeout(() => this.releaseChain(b.ch), 1600);
      this.blazes.delete(id);
    }
  }

  /** Feed every snapshot in order (events are per snapshot). */
  snapshot(s: Snapshot) {
    const cues = this.director.update(s);
    this.mood = this.musicDir.update(s);
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.started) { this.started = true; this.startAmbient(this.ctx); }
    if (!this.music && this.musicWanted() && this.kit) this.music = new MusicPlayer(this.ctx, this.musicBus, this.kit.white);
    this.music?.setMood(this.mood);
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
    this.music?.tick();
  }

  private environment(ctx: AudioContext, env: Env) {
    const now = ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(muffleCutoff(env.hp, env.alive), now, 0.25);
    this.reverbSend.gain.setTargetAtTime(env.inBunker ? 0.5 : 0.06, now, 0.15);
    const a = this.ambient!;
    a.waves.gain.setTargetAtTime(0.5 * waveLevel(env.shoreDist) * (env.inBunker ? 0.35 : 1), now, 0.5);
    a.wind.gain.setTargetAtTime((env.storm ? 0.11 : 0.035) * (env.inBunker ? 0.35 : 1), now, env.storm ? 2 : 0.5);
    a.rain.gain.setTargetAtTime(env.storm ? (env.inBunker ? 0.03 : 0.12) : 0, now, env.storm ? 2.5 : 0.5);
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
        const night = this.daylight < 0.3;
        this.spatial(pos, night ? 0.35 : 0.5, 'ambient', (out, t) => night
          ? critterCall(this.kit!, out, t, Math.random() < 0.7 ? 'cricket' : 'owl')
          : (Math.random() < 0.65 ? gull : clank)(this.kit!, out, t));
      }
    }
  }

  private play(cue: Cue) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.kit) return;
    let delay = 0;
    if (cue.sound === 'thunder' && cue.pos) {
      // Thunder fills the sky (2D), arrives d/343 s after the flash, a sharp crack when close, a rumble far off.
      const td = dist(cue.pos, this.listener);
      delay = Math.min(4, td / 343);
      cue = { ...cue, pos: null, gain: cue.gain * Math.max(0.25, Math.min(1, 40 / (td + 10))), kind: td < 45 ? 'near' : 'far' };
    }
    const d = cue.pos ? dist(cue.pos, this.listener) : 0;
    if (cue.pos && !withinHearing(cue.sound, d, cue.own)) return; // past its hearing cap: not a voice at all
    if (cue.pos && !cue.own && d > SOUND_DELAY_FROM && (cue.sound === 'shot' || cue.sound === 'explosion')) delay = d / 343;
    // Walls between you and the source: duller and quieter (one-shot cues only, tested once at start).
    const occ = cue.pos && !cue.own ? Math.min(2, occlusion(this.listener, cue.pos, this.director.pieces, this.map)) : 0;
    const key = cue.sound === 'shot' ? `shot_${cue.kind}` : cue.sound;
    const level = audibility(cue.gain, cue.pos, this.listener) * voicePriority(cue.sound, !!cue.pos, cue.own) * (occ ? OCCLUDED[occ - 1].gain : 1);
    // Generous expiry backstop; the voice is released by timer when its recipe actually ends.
    const adm = this.limiter.admit(key, level, ctx.currentTime, 10);
    if (!adm.ok) return;
    if (adm.evict !== null) this.stopVoice(adm.evict);
    if (cue.sound === 'explosion' && (!cue.pos || d < 25)) this.music?.duck(0.6, 2.5);
    else if (cue.sound === 'death') this.music?.duck(0.7, 4);
    // Tiny start offset on repeated world sounds so simultaneous shots don't phase-lock.
    const t = ctx.currentTime + delay + (cue.own || !cue.pos ? 0.005 : 0.005 + Math.random() * 0.012);
    let len: number;
    let input: GainNode;
    if (cue.pos) {
      const ch = this.chain(cue.pos, d);
      input = ch.input;
      input.gain.value = cue.gain * (occ ? OCCLUDED[occ - 1].gain : 1);
      if (occ) ch.air.frequency.value = Math.min(ch.air.frequency.value, OCCLUDED[occ - 1].hz);
      len = playRecipe(this.kit, input, t, cue, d) + 0.1 + delay;
      setTimeout(() => this.releaseChain(ch), (len + 0.3) * 1000);
    } else {
      input = ctx.createGain();
      input.gain.value = cue.gain;
      input.connect(UI_SOUNDS.has(cue.sound) ? this.uiBus : this.sfxBus);
      len = playRecipe(this.kit, input, t, cue, d) + 0.1 + delay;
      setTimeout(() => input.disconnect(), (len + 0.3) * 1000);
    }
    this.voices.set(adm.id, input);
    setTimeout(() => { this.limiter.release(adm.id); this.voices.delete(adm.id); }, len * 1000);
    this.count(key);
  }

  /** Ambient one-shots: positional, bypass the limiter's frame caps but still count. */
  private spatial(pos: Vec3, gain: number, key: string, recipe: (out: AudioNode, t: number) => number) {
    const ch = this.chain(pos, dist(pos, this.listener), 'amb');
    ch.input.gain.value = gain;
    const len = recipe(ch.input, this.ctx!.currentTime + 0.01);
    setTimeout(() => this.releaseChain(ch), (len + 0.4) * 1000);
    this.count(key);
  }

  private chain(pos: Vec3, d: number, bus: Bus = 'sfx'): Chain {
    const ctx = this.ctx!;
    let ch = this.pools[bus].pop();
    if (!ch) {
      const input = ctx.createGain();
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      const panner = new PannerNode(ctx, {
        panningModel: 'HRTF', distanceModel: 'inverse', refDistance: REF_DISTANCE, maxDistance: MAX_DISTANCE, rolloffFactor: ROLLOFF,
      });
      const echo = ctx.createGain();
      input.connect(air).connect(panner).connect(bus === 'amb' ? this.ambBus : this.sfxBus);
      panner.connect(echo).connect(this.echoIn);
      ch = { input, air, panner, echo, bus };
    }
    ch.air.frequency.value = distanceCutoff(d);
    ch.echo.gain.value = echoSend(d);
    ch.panner.positionX.value = pos.x; ch.panner.positionY.value = pos.y; ch.panner.positionZ.value = pos.z;
    return ch;
  }

  private releaseChain(ch: Chain) {
    const pool = this.pools[ch.bus];
    if (pool.length < 32) { ch.input.gain.cancelScheduledValues(0); ch.input.gain.value = 1; pool.push(ch); }
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
    return { state: this.ctx?.state ?? 'none', played: this.stats_.played, dropped: this.limiter.dropped, active: this.limiter.count, bySound: { ...this.stats_.bySound }, music: this.music ? this.mood : 'none' };
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
