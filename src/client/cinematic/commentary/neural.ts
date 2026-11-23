/**
 * Free neural commentary voice (e.g. Kokoro-82M, Apache-2.0 weights) synthesized in a worker (neuralEngine),
 * played through a small AudioContext of its own. Lazy: nothing loads until commentary is actually on;
 * until the model is ready (or if it can't load) the browser voice speaks instead (HybridTts).
 * Latency: each line is synthesized when it's said (a short sentence takes well under a second on a
 * recent Mac); fixed lines are pre-synthesized in idle time and audio is cached per exact text + voice.
 */
import { BrowserTts, speakable, type Persona, type SpeakOpts, type Tts } from './tts';

/** Kokoro English voices worth offering (VOICES.md grades), best first. */
export const NEURAL_VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'am_puck', label: 'Puck (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
  { id: 'bm_fable', label: 'Fable (UK, male)' },
] as const;
export const NEURAL_DEFAULT: Record<Persona, string> = { pbp: 'am_michael', colour: 'af_heart' };
/** Pace per commentator (Kokoro's natural prosody does the rest; no pitch tricks). */
const SPEED: Record<Persona, number> = { pbp: 1.1, colour: 1.0 };
/** Give up on a line whose audio takes longer than this to arrive (the commentator moves on). */
const SYNTH_TIMEOUT_MS = 5000;
const CACHE_MAX = 80;

export type NeuralState = 'off' | 'loading' | 'ready' | 'failed';

type Clip = { data: Float32Array; rate: number };
type Out =
  | { type: 'progress'; pct: number } | { type: 'ready'; ms: number } | { type: 'error'; message: string }
  | { type: 'audio'; id: number; data: Float32Array; rate: number; ms: number } | { type: 'failed'; id: number; message: string };

/** Settings → Test voice hook: the live Commentary installs it (returns false when the neural voice isn't ready). */
export const voiceTester: { neural: ((persona: Persona, voice: string) => boolean) | null } = { neural: null };

/**
 * The neural voice's synthesis worker, registered by the build that ships one (none by default: the Kokoro
 * worker's phonemizer embeds eSpeak NG, GPL-3.0, so it stays off main until that's decided). Without it the
 * commentary uses the browser voice and Settings hides the engine choice.
 */
export const neuralEngine: { makeWorker: (() => Worker) | null } = { makeWorker: null };

export const neuralSupported = () => !!neuralEngine.makeWorker && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof AudioContext !== 'undefined';

export class NeuralTts implements Tts {
  state: NeuralState = 'off';
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private cache = new Map<string, Clip>();
  private pending = new Map<number, { key: string; resolve: (c: Clip | null) => void }>();
  private nextId = 1;
  private playing: { src: AudioBufferSourceNode | null; end: () => void; token: number } | null = null;
  private token = 0;
  voices: Record<Persona, string> = { ...NEURAL_DEFAULT };
  /** Synthesis times (ms), for the latency log. */
  readonly synthMs: number[] = [];

  constructor(private onState: (s: NeuralState, detail: string) => void = () => {},
    private makeWorker: () => Worker = () => {
      if (!neuralEngine.makeWorker) throw new Error('no neural voice engine in this build');
      return neuralEngine.makeWorker();
    }) {}

  get available() { return this.state === 'ready'; }
  get speaking() { return this.playing !== null; }

  /** Start the download / load (once). */
  load() {
    if (this.state !== 'off') return;
    this.state = 'loading';
    this.onState('loading', '0');
    try {
      this.worker = this.makeWorker();
    } catch (e) {
      this.fail(`worker: ${String(e)}`);
      return;
    }
    this.worker.onmessage = (e: MessageEvent<Out>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(`worker error: ${e.message}`);
    // Dev/e2e override for measuring: ?ttsDevice=webgpu&ttsDtype=fp16.
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const device = q?.get('ttsDevice') === 'webgpu' ? 'webgpu' : 'wasm';
    const dtype = (['q8', 'fp16', 'fp32'] as const).find((d) => d === q?.get('ttsDtype')) ?? 'q8';
    this.worker.postMessage({ type: 'load', device, dtype });
    console.info(`[commentary] loading the neural voice (Kokoro-82M ${dtype} on ${device}; downloaded once, then cached)`);
  }

  private fail(why: string) {
    console.warn(`[commentary] neural voice unavailable, using the browser voice: ${why}`);
    this.state = 'failed';
    this.onState('failed', why);
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }

  private onMessage(m: Out) {
    if (m.type === 'progress') this.onState('loading', String(m.pct));
    else if (m.type === 'ready') { this.state = 'ready'; console.info(`[commentary] neural voice ready in ${m.ms} ms`); this.onState('ready', ''); }
    else if (m.type === 'error') this.fail(m.message);
    else if (m.type === 'audio' || m.type === 'failed') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'failed') { console.warn(`[commentary] neural line failed: ${m.message}`); p.resolve(null); return; }
      this.synthMs.push(m.ms);
      if (this.synthMs.length > 50) this.synthMs.shift();
      const clip = { data: m.data, rate: m.rate };
      this.cache.set(p.key, clip);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      p.resolve(clip);
    }
  }

  private synth(text: string, voice: string, speed: number): Promise<Clip | null> {
    const key = `${voice}|${speed}|${text}`;
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return Promise.resolve(hit); }
    if (!this.worker || this.state === 'failed') return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { key, resolve });
      this.worker!.postMessage({ type: 'say', id, text, voice, speed });
    });
  }

  /** Pre-synthesize a line nobody is waiting for (only while the worker is otherwise idle). */
  prefetch(text: string, persona: Persona): boolean {
    if (this.state !== 'ready' || this.pending.size > 0) return false;
    void this.synth(speakable(text), this.voices[persona], SPEED[persona]);
    return true;
  }

  speak(text: string, opts: SpeakOpts) {
    const token = ++this.token;
    let done = false;
    const end = () => { if (done) return; done = true; if (this.playing?.token === token) this.playing = null; opts.onEnd?.(); };
    this.playing = { src: null, end, token };
    const t0 = performance.now();
    const timer = setTimeout(() => { if (this.playing?.token === token && !this.playing.src) { console.warn('[commentary] neural line too slow; skipped'); end(); } }, SYNTH_TIMEOUT_MS);
    void this.synth(speakable(text), this.voices[opts.persona], SPEED[opts.persona]).then((clip) => {
      clearTimeout(timer);
      if (this.playing?.token !== token) return; // cancelled or timed out meanwhile
      if (!clip) { end(); return; }
      try {
        this.ctx ??= new AudioContext({ latencyHint: 'playback' });
        if (this.ctx.state === 'suspended') void this.ctx.resume();
        const buf = this.ctx.createBuffer(1, clip.data.length, clip.rate);
        buf.copyToChannel(clip.data as Float32Array<ArrayBuffer>, 0);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = Math.min(1, Math.max(0, opts.volume));
        src.connect(g).connect(this.ctx.destination);
        src.onended = end;
        this.playing.src = src;
        src.start();
        const wait = performance.now() - t0;
        if (wait > 1200) console.info(`[commentary] neural line started after ${Math.round(wait)} ms`);
      } catch (e) {
        console.warn(`[commentary] neural playback failed: ${String(e)}`);
        end();
      }
    });
  }

  cancel() {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    try { p.src?.stop(); } catch { /* already stopped */ }
    p.end();
  }
}

/**
 * The commentary voice: the neural voice once it's loaded, the browser voice before that, if it fails,
 * or if the user picked "Browser" in Settings.
 */
export class HybridTts implements Tts {
  readonly browser: BrowserTts;
  neural: NeuralTts | null = null;
  useNeural = true;
  private current: Tts | null = null;

  constructor(browser = new BrowserTts(), private onState: (s: NeuralState, detail: string) => void = () => {}) {
    this.browser = browser;
  }

  /** Neural voice active right now? */
  get neuralActive() { return this.useNeural && !!this.neural?.available; }
  get available() { return this.neuralActive || this.browser.available; }
  get speaking() { return this.current?.speaking ?? false; }

  /** Load the neural voice (lazy; call when commentary turns on). */
  ensureNeural() {
    if (!this.useNeural || this.neural || !neuralSupported()) return;
    this.neural = new NeuralTts(this.onState);
    this.neural.load();
  }

  speak(text: string, opts: SpeakOpts) {
    const engine: Tts = this.neuralActive ? this.neural! : this.browser;
    this.current = engine;
    engine.speak(text, { ...opts, onEnd: () => { if (this.current === engine) this.current = null; opts.onEnd?.(); } });
  }

  cancel() { this.current?.cancel(); }
}
