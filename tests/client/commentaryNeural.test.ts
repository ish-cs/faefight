import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedLines } from '../../src/client/cinematic/commentary';
import { HybridTts, NEURAL_DEFAULT, NEURAL_VOICES, NeuralTts } from '../../src/client/cinematic/commentary/neural';
import type { BrowserTts, SpeakOpts } from '../../src/client/cinematic/commentary/tts';

/** A fake Kokoro worker: answers 'load' with ready and each 'say' with 1 s of silence (asynchronously). */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  said: { text: string; voice: string; speed: number }[] = [];
  fail = false;
  postMessage(m: { type: string; id?: number; text?: string; voice?: string; speed?: number }) {
    const reply = (d: unknown) => queueMicrotask(() => this.onmessage?.({ data: d } as MessageEvent));
    if (m.type === 'load') reply(this.fail ? { type: 'error', message: 'no wasm' } : { type: 'ready', ms: 5 });
    else { this.said.push({ text: m.text!, voice: m.voice!, speed: m.speed! }); reply({ type: 'audio', id: m.id, data: new Float32Array(24000), rate: 24000, ms: 300 }); }
  }
}

/** Minimal Web Audio stand-in: buffer sources end when told to. */
class FakeCtx {
  state = 'running';
  sources: { onended: (() => void) | null; started: boolean; stop(): void }[] = [];
  destination = {};
  resume() { return Promise.resolve(); }
  createBuffer() { return { copyToChannel() {} }; }
  createGain() { return { gain: { value: 1 }, connect: (d: unknown) => d }; }
  createBufferSource() {
    const s = { buffer: null, onended: null as (() => void) | null, started: false, connect: (g: unknown) => g, start() { s.started = true; }, stop() { s.onended?.(); } };
    this.sources.push(s);
    return s;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

function neural() {
  const w = new FakeWorker();
  const states: string[] = [];
  const n = new NeuralTts((s) => states.push(s), () => w as unknown as Worker);
  const ctx = new FakeCtx();
  vi.stubGlobal('AudioContext', vi.fn(function () { return ctx; }));
  return { n, w, ctx, states };
}

describe('NeuralTts (Kokoro in a worker)', () => {
  it('loads lazily, speaks with the persona voice, ends when the clip ends, and caches by text', async () => {
    const { n, w, ctx, states } = neural();
    expect(n.available).toBe(false);
    n.load();
    await flush();
    expect(states).toEqual(['loading', 'ready']);
    expect(n.available).toBe(true);
    const onEnd = vi.fn();
    const opts: SpeakOpts = { persona: 'pbp', intensity: 1, volume: 0.7, onEnd };
    n.speak('HUGE seal by Mighty.Ana!', opts);
    expect(n.speaking).toBe(true);
    await flush();
    expect(w.said[0]).toEqual({ text: 'Huge seal by Mighty Ana!', voice: NEURAL_DEFAULT.pbp, speed: 1.1 });
    expect(ctx.sources[0].started).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    ctx.sources[0].onended!();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(n.speaking).toBe(false);
    // Same text + voice again: no new synthesis.
    n.speak('HUGE seal by Mighty.Ana!', opts);
    await flush();
    expect(w.said).toHaveLength(1);
    expect(ctx.sources).toHaveLength(2);
    // Colour uses its own voice.
    n.speak('Smart play.', { ...opts, persona: 'colour' });
    await flush();
    expect(w.said[1].voice).toBe(NEURAL_DEFAULT.colour);
  });

  it('cancel stops the clip and releases the caller once', async () => {
    const { n, ctx } = neural();
    n.load(); await flush();
    const onEnd = vi.fn();
    n.speak('Hold on!', { persona: 'pbp', intensity: 1, volume: 1, onEnd });
    await flush();
    n.cancel();
    expect(onEnd).toHaveBeenCalledTimes(1);
    ctx.sources[0].onended?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('prefetch only when the worker is idle', async () => {
    const { n, w } = neural();
    n.load(); await flush();
    expect(n.prefetch('What a play!', 'colour')).toBe(true);
    expect(n.prefetch('Wow. Just wow.', 'colour')).toBe(false); // one in flight
    await flush();
    expect(n.prefetch('Wow. Just wow.', 'colour')).toBe(true);
    expect(w.said.map((s) => s.text)).toEqual(['What a play!', 'Wow. Just wow.']);
  });

  it('a failed load reports failed (the browser voice takes over)', async () => {
    const w = new FakeWorker(); w.fail = true;
    const states: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = new NeuralTts((s) => states.push(s), () => w as unknown as Worker);
    n.load(); await flush();
    warn.mockRestore();
    expect(states).toEqual(['loading', 'failed']);
    expect(n.available).toBe(false);
  });
});

describe('HybridTts', () => {
  const fakeBrowser = () => {
    const said: string[] = [];
    return { said, b: { available: true, speaking: false, speak: (t: string, o: SpeakOpts) => { said.push(t); o.onEnd?.(); }, cancel() {}, setVoices() {} } as unknown as BrowserTts };
  };

  it('uses the browser voice until the neural one is ready, then switches; Browser engine stays on the browser', async () => {
    const { said, b } = fakeBrowser();
    const h = new HybridTts(b);
    h.speak('one', { persona: 'pbp', intensity: 0, volume: 1 });
    expect(said).toEqual(['one']);
    const { n } = neural();
    h.neural = n;
    n.load(); await flush();
    h.speak('two', { persona: 'pbp', intensity: 0, volume: 1 });
    expect(said).toEqual(['one']);
    expect(h.speaking).toBe(true);
    h.cancel();
    expect(h.speaking).toBe(false);
    h.useNeural = false;
    h.speak('three', { persona: 'pbp', intensity: 0, volume: 1 });
    expect(said).toEqual(['one', 'three']);
  });
});

describe('neural voice setup', () => {
  it('offers a distinct default pair and only real Kokoro ids', () => {
    expect(NEURAL_DEFAULT.pbp).not.toBe(NEURAL_DEFAULT.colour);
    const ids = NEURAL_VOICES.map((v) => v.id);
    expect(ids).toContain(NEURAL_DEFAULT.pbp);
    expect(ids).toContain(NEURAL_DEFAULT.colour);
    for (const id of ids) expect(id).toMatch(/^[ab][fm]_[a-z]+$/);
  });

  it('pre-synthesizes only placeholder-free lines', () => {
    const f = fixedLines();
    expect(f.length).toBeGreaterThan(20);
    expect(f.every((l) => !/[{}]/.test(l.text))).toBe(true);
  });
});
