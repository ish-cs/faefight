/**
 * Display refresh estimate (pure). Browsers don't expose the refresh rate, so it is read off the rAF interval:
 * the median of a window of light frames (menu, loading), snapped to a common rate. The estimate only ever rises
 * (a GPU-bound stretch at 70 fps on a 120 Hz panel must not read as a 60 Hz display), so feeding every frame of the
 * match is safe. The frame governor budgets for this rate when no frame cap is set: on a 120 Hz ProMotion Mac it
 * holds 120 fps instead of settling at 60.
 */
const RATES = [60, 75, 90, 100, 120, 144, 165, 240];
const WINDOW = 30;

export function snapHz(hz: number): number {
  let best = RATES[0];
  for (const r of RATES) if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
  return best;
}

/** Target frame time: the frame cap when one is set (never faster than the display), else the display refresh. */
export function frameBudgetMs(cap: number, displayHz: number): number {
  return 1000 / (cap ? Math.min(cap, displayHz) : displayHz);
}

export class RefreshProbe {
  hz = 60;
  private win: number[] = [];

  frame(ms: number) {
    if (!(ms > 2) || ms > 100) return;
    this.win.push(ms);
    if (this.win.length < WINDOW) return;
    const s = [...this.win].sort((a, b) => a - b);
    this.win.length = 0;
    const hz = snapHz(1000 / s[s.length >> 1]);
    if (hz > this.hz) {
      this.hz = hz;
      console.info(`[refresh] display ≈ ${hz} Hz`);
    }
  }
}

/**
 * Frames-in-flight limit. With vsync off, or when GPU-bound, the browser lets WebGPU work pile up: measured 0.5 s
 * from mouse-look to GPU done on ultra at 2× DPR. The frame loop asks `busy()` before starting a frame and skips the
 * rAF while `max` frames are still on the GPU, so input latency stays at ≤ max + 1 frames however heavy the GPU
 * load. A frame whose completion never arrives (device lost) is forgotten after 250 ms, so the loop can't stall.
 */
export class FrameQueue {
  private times: number[] = [];
  private gen = 0;
  constructor(private max = 2) {}
  get inFlight() { return this.times.length; }
  busy(now: number): boolean {
    if (this.times.length && now - this.times[0] > 250) { this.times.length = 0; this.gen++; }
    return this.times.length >= this.max;
  }
  /** Call after submitting a frame; call the returned function when the GPU has finished it. */
  submitted(now: number): () => void {
    this.times.push(now);
    const g = this.gen;
    return () => { if (g === this.gen && this.times.length) this.times.shift(); };
  }
}

/** The page's display estimate: probed from page load (menu frames are light), then fed by the game loop. */
export const displayRefresh = new RefreshProbe();
if (typeof requestAnimationFrame !== 'undefined') {
  let prev = 0, n = 0;
  const tick = (t: number) => {
    if (prev) displayRefresh.frame(t - prev);
    prev = t;
    if (++n < 120) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
