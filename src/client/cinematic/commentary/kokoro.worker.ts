/**
 * Neural commentary voice (Kokoro-82M v1.0, Apache-2.0 weights) in its own worker, so synthesis never touches the
 * game's main thread. No eSpeak / nothing GPL: our own G2P (g2p.ts: CMUdict-derived lexicon + NRL rules) makes the
 * phonemes; transformers.js (Apache-2.0) runs the ONNX model. Weights and voices come from Hugging Face once and
 * stay in Cache Storage. Messages:
 *   in:  { type: 'load', device?, dtype? } | { type: 'say', id, text, voice, speed }
 *   out: { type: 'progress', pct } | { type: 'ready', ms } | { type: 'error', message }
 *        | { type: 'audio', id, data: Float32Array, rate, ms } | { type: 'failed', id, message }
 */
import { AutoTokenizer, env, StyleTextToSpeech2Model, Tensor, type PreTrainedTokenizer } from '@huggingface/transformers';
import { G2P, type Lexicon } from './g2p';
import { NRL_RULES } from './nrlRules';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE_URL = (id: string) => `https://huggingface.co/${KOKORO_MODEL}/resolve/main/voices/${id}.bin`;
const SAMPLE_RATE = 24000;

export type KokoroDevice = 'wasm' | 'webgpu';
export type KokoroDtype = 'q8' | 'fp16' | 'fp32';
type In = { type: 'load'; device?: KokoroDevice; dtype?: KokoroDtype } | { type: 'say'; id: number; text: string; voice: string; speed: number };
type Engine = { model: StyleTextToSpeech2Model; tokenizer: PreTrainedTokenizer; g2p: G2P };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

// ONNX Runtime logs a benign "some nodes not assigned to the preferred execution provider" at error level on WebGPU.
if (env.backends.onnx) (env.backends.onnx as { logLevel?: string }).logLevel = 'fatal';

let engine: Promise<Engine> | null = null;
let chain: Promise<void> = Promise.resolve();
const voices = new Map<string, Promise<Float32Array>>();

/** A voice's style table (510 × 256 floats), from Cache Storage or Hugging Face. */
function voice(id: string): Promise<Float32Array> {
  let v = voices.get(id);
  if (!v) {
    v = (async () => {
      const url = VOICE_URL(id);
      let cache: Cache | null = null;
      try { cache = await caches.open('kokoro-voices'); } catch { /* no Cache Storage: plain fetch */ }
      const hit = await cache?.match(url);
      const res = hit ?? await fetch(url);
      if (!res.ok) throw new Error(`voice ${id}: HTTP ${res.status}`);
      if (!hit && cache) await cache.put(url, res.clone());
      return new Float32Array(await res.arrayBuffer());
    })();
    v.catch(() => voices.delete(id));
    voices.set(id, v);
  }
  return v;
}

function load(device: KokoroDevice = 'wasm', dtype: KokoroDtype = 'q8'): Promise<Engine> {
  if (engine) return engine;
  const t0 = performance.now();
  const files = new Map<string, number>();
  let lastPct = -1;
  console.info(`[kokoro] loading ${KOKORO_MODEL} (${dtype}, ${device})`);
  engine = (async () => {
    if (device === 'webgpu' && !(navigator as Navigator & { gpu?: unknown }).gpu) throw new Error('WebGPU unavailable in this browser');
    const [model, tokenizer, lexicon] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, {
        dtype, device,
        progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
          if (p.status !== 'progress' || !p.file || typeof p.progress !== 'number') return;
          files.set(p.file, p.progress);
          const pct = Math.floor(Math.min(...files.values()));
          if (pct !== lastPct) { lastPct = pct; post({ type: 'progress', pct }); }
        },
      }),
      AutoTokenizer.from_pretrained(KOKORO_MODEL),
      fetch(new URL('/commentary/lexicon-en.json', self.location.origin)).then(async (r) => {
        if (!r.ok) throw new Error(`lexicon: HTTP ${r.status}`);
        return ((await r.json()) as { words: Lexicon }).words;
      }),
    ]);
    return { model, tokenizer, g2p: new G2P(lexicon, NRL_RULES) };
  })();
  engine.then(
    () => post({ type: 'ready', ms: Math.round(performance.now() - t0) }),
    (e: unknown) => { engine = null; post({ type: 'error', message: String(e) }); },
  );
  return engine;
}

/** One line → 24 kHz mono samples. */
async function synth(e: Engine, text: string, voiceId: string, speed: number): Promise<Float32Array> {
  const phonemes = e.g2p.phonemize(text);
  const { input_ids } = e.tokenizer(phonemes, { truncation: true }) as { input_ids: Tensor };
  const n = input_ids.dims.at(-1) ?? 0;
  const at = 256 * Math.min(Math.max(n - 2, 0), 509);
  const style = (await voice(voiceId)).slice(at, at + 256);
  const out = await e.model({
    input_ids,
    style: new Tensor('float32', style, [1, 256]),
    speed: new Tensor('float32', [speed], [1]),
  }) as { waveform: Tensor };
  return out.waveform.data as Float32Array;
}

self.onmessage = (ev: MessageEvent<In>) => {
  const m = ev.data;
  if (m.type === 'load') { void load(m.device, m.dtype); return; }
  if (m.type === 'say') {
    chain = chain.then(async () => {
      const t0 = performance.now();
      try {
        const data = await synth(await load(), m.text, m.voice, m.speed);
        const ms = Math.round(performance.now() - t0);
        console.info(`[kokoro] ${m.text.length} chars → ${(data.length / SAMPLE_RATE).toFixed(1)} s of audio in ${ms} ms`);
        post({ type: 'audio', id: m.id, data, rate: SAMPLE_RATE, ms }, [data.buffer]);
      } catch (err) {
        post({ type: 'failed', id: m.id, message: String(err) });
      }
    });
  }
};
