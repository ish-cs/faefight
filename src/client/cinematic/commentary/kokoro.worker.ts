/**
 * Neural commentary voice (Kokoro-82M, Apache-2.0) in its own worker, so synthesis never touches the game's
 * main thread or the GPU: WASM backend, q8 weights (~92 MB, fetched once from Hugging Face and kept in Cache
 * Storage by transformers.js / kokoro-js). Messages:
 *   in:  { type: 'load' } | { type: 'say', id, text, voice, speed }
 *   out: { type: 'progress', pct } | { type: 'ready', ms } | { type: 'error', message }
 *        | { type: 'audio', id, data: Float32Array, rate, ms } | { type: 'failed', id, message }
 */
import { KokoroTTS } from 'kokoro-js';

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export type KokoroDevice = 'wasm' | 'webgpu';
export type KokoroDtype = 'q8' | 'fp16' | 'fp32';
type In = { type: 'load'; device?: KokoroDevice; dtype?: KokoroDtype } | { type: 'say'; id: number; text: string; voice: string; speed: number };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let tts: Promise<KokoroTTS> | null = null;
/** One synthesis at a time, in order. */
let chain: Promise<void> = Promise.resolve();

function load(device: KokoroDevice = 'wasm', dtype: KokoroDtype = 'q8'): Promise<KokoroTTS> {
  if (tts) return tts;
  const t0 = performance.now();
  const files = new Map<string, number>();
  let lastPct = -1;
  console.info(`[kokoro] loading ${KOKORO_MODEL} (${dtype}, ${device})`);
  tts = KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype,
    device,
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status !== 'progress' || !p.file || typeof p.progress !== 'number') return;
      files.set(p.file, p.progress);
      // The model file dominates the download; report the slowest file.
      const pct = Math.floor(Math.min(...files.values()));
      if (pct !== lastPct) { lastPct = pct; post({ type: 'progress', pct }); }
    },
  });
  tts.then(
    () => post({ type: 'ready', ms: Math.round(performance.now() - t0) }),
    (e: unknown) => { tts = null; post({ type: 'error', message: String(e) }); },
  );
  return tts;
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === 'load') { void load(m.device, m.dtype); return; }
  if (m.type === 'say') {
    chain = chain.then(async () => {
      const t0 = performance.now();
      try {
        const model = await load();
        const out = await model.generate(m.text, { voice: m.voice as never, speed: m.speed });
        const data = out.audio as Float32Array;
        console.info(`[kokoro] ${m.text.length} chars → ${(data.length / out.sampling_rate).toFixed(1)} s of audio in ${Math.round(performance.now() - t0)} ms`);
        post({ type: 'audio', id: m.id, data, rate: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [data.buffer]);
      } catch (err) {
        post({ type: 'failed', id: m.id, message: String(err) });
      }
    });
  }
};
