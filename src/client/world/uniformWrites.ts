import type * as THREE from 'three/webgpu';

type Binding = { buffer: ArrayBufferView & { length: number; BYTES_PER_ELEMENT: number }; updateRanges: { start: number; count: number }[] };
type Queue = { writeBuffer(buf: unknown, offset: number, data: ArrayBufferView, dataOffset: number, size: number): void };
type BindingUtils = { backend: { device: { queue: Queue }; get(b: unknown): { buffer: unknown } }; updateBinding(b: Binding): void };

/** writeBuffer calls saved by coalescing (debug / census) */
export const uniformWriteStats = { calls: 0, saved: 0 };

/**
 * One queue.writeBuffer per uniform buffer update instead of one per changed range (perf stage B).
 * three writes every non-contiguous changed range of a uniform group separately: ~5 calls per object group and ~10
 * per render group, ~1600 calls a frame. Each call crosses into Dawn's wire serializer, so for these small (< 1 KB)
 * buffers writing the span from the first to the last changed range in one call is cheaper; the bytes in the gaps
 * are the CPU copy's current values, so the GPU copy only ever receives what it would have anyway.
 */
export function installCoalescedUniformWrites(gpu: THREE.WebGPURenderer) {
  const utils = (gpu.backend as unknown as { bindingUtils?: BindingUtils }).bindingUtils;
  if (!utils || typeof utils.updateBinding !== 'function') return; // WebGL2 fallback: nothing to patch
  const orig = utils.updateBinding.bind(utils);
  utils.updateBinding = (binding: Binding) => {
    const r = binding.updateRanges, a = binding.buffer;
    if (r.length < 2 || !ArrayBuffer.isView(a)) { orig(binding); return; }
    const start = r[0].start, last = r[r.length - 1], end = last.start + last.count;
    const device = utils.backend.device, buffer = utils.backend.get(binding).buffer;
    device.queue.writeBuffer(buffer, start * a.BYTES_PER_ELEMENT, a, start, end - start);
    uniformWriteStats.calls++; uniformWriteStats.saved += r.length - 1;
  };
}
