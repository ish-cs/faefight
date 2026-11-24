/**
 * Registers the free neural commentary voice (Kokoro-82M in kokoro.worker.ts; our own G2P, nothing GPL).
 * The worker chunk (transformers.js + ONNX runtime) only downloads when the neural voice is first used.
 */
import { neuralEngine } from './neural';

neuralEngine.makeWorker = () => new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });
