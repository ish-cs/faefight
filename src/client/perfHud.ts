/**
 * Dev perf HUD (`?perf`): per-system main-thread ms of the frame loop, draw calls, triangles, JS heap and a GC
 * count, with a budget bar per system. Off by default and free when off: `lap()` is one branch.
 *
 * The frame loop calls `probe.begin()` at the top of a drawn frame, `probe.lap(S.x)` after each system and
 * `probe.end()` at the bottom; each lap charges the time since the previous lap to that system. The panel
 * refreshes at 4 Hz with an exponential average (and the worst frame of the last window), one text write.
 * `window.__faefight.perfProbe()` returns the same numbers for harnesses (tests/visual/batteryProxy.mjs).
 */
export const PERF_SYSTEMS = [
  'snapshots', // snapshot apply + interpolation buffer
  'input', // input sample, prediction step
  'camera', // killcam / spectator / own camera
  'build', // build + trap aim (raycasts against the predictor world)
  'net', // view/input send
  'hudFx', // compass, damage arcs, HUD DOM writes
  'chars', // character sync, loot labels
  'fx', // gun fx, ropes, footprints, day/night, storm, beacons, traps, barriers, critters
  'submit', // world.render: tide, grass, post chain, draw submission
  'viewmodel', // first-person viewmodel render
  'audio', // listener + loops
] as const;
export type PerfSystem = (typeof PERF_SYSTEMS)[number];
export const S = Object.fromEntries(PERF_SYSTEMS.map((n, i) => [n, i])) as { [K in PerfSystem]: number };

/** Budget per system (ms) for the bars: the main-thread budget (5.5 ms, docs/frame-budget.md) split roughly by cost. */
const BUDGET_MS = [0.3, 0.3, 0.3, 0.4, 0.1, 0.4, 0.8, 0.6, 2.0, 0.4, 0.2];
const N = PERF_SYSTEMS.length;
const TAU = 0.1; // EMA weight per frame

type Mem = { usedJSHeapSize: number };

export class PerfProbe {
  readonly on: boolean;
  private t = 0;
  private frameT0 = 0;
  /** this frame's ms per system */
  private cur = new Float64Array(N);
  /** smoothed ms per system */
  readonly avg = new Float64Array(N);
  /** worst ms per system since the last panel refresh */
  readonly peak = new Float64Array(N);
  totalAvg = 0;
  /** GCs seen (heap drops > 512 KB between samples) and the last heap size */
  gcs = 0;
  heapMB = 0;
  private lastHeap = 0;
  private el: HTMLPreElement | null = null;
  private nextPaint = 0;

  constructor(on: boolean) { this.on = on; }

  begin() {
    if (!this.on) return;
    this.t = this.frameT0 = performance.now();
    this.cur.fill(0);
  }

  lap(sys: number) {
    if (!this.on) return;
    const now = performance.now();
    this.cur[sys] += now - this.t;
    this.t = now;
  }

  /** Skip the time since the last lap (work that belongs to no system, e.g. the warm-up hook). */
  skip() { if (this.on) this.t = performance.now(); }

  end(info: { drawCalls: number; triangles: number }) {
    if (!this.on) return;
    const now = performance.now();
    for (let i = 0; i < N; i++) {
      this.avg[i] += (this.cur[i] - this.avg[i]) * TAU;
      if (this.cur[i] > this.peak[i]) this.peak[i] = this.cur[i];
    }
    this.totalAvg += (now - this.frameT0 - this.totalAvg) * TAU;
    const mem = (performance as unknown as { memory?: Mem }).memory;
    if (mem) {
      const h = mem.usedJSHeapSize;
      if (h < this.lastHeap - 512 * 1024) this.gcs++;
      this.lastHeap = h;
      this.heapMB = h / 1048576;
    }
    if (now >= this.nextPaint) { this.nextPaint = now + 250; this.paint(info); }
  }

  private paint(info: { drawCalls: number; triangles: number }) {
    if (!this.el) {
      this.el = document.createElement('pre');
      this.el.className = 'perf-hud';
      this.el.style.cssText = 'position:fixed;left:8px;top:64px;z-index:50;margin:0;padding:6px 8px;font:11px/1.25 ui-monospace,monospace;color:#e8f0e0;background:rgba(0,0,0,.62);pointer-events:none;contain:strict;width:310px;height:236px;white-space:pre';
      document.body.appendChild(this.el);
    }
    let s = `main ${this.totalAvg.toFixed(2)} ms  (budget 5.5)\n`;
    for (let i = 0; i < N; i++) {
      const ms = this.avg[i];
      const cells = Math.min(10, Math.round((ms / BUDGET_MS[i]) * 5));
      s += `${PERF_SYSTEMS[i].padEnd(9)} ${ms.toFixed(2).padStart(5)} ${this.peak[i].toFixed(1).padStart(5)} ${'█'.repeat(cells)}${'░'.repeat(10 - cells)}${ms > BUDGET_MS[i] ? ' !' : ''}\n`;
    }
    s += `draws ${info.drawCalls} · ${(info.triangles / 1e6).toFixed(2)}M tris\nheap ${this.heapMB.toFixed(0)} MB · GCs ${this.gcs}`;
    this.el.textContent = s;
    this.peak.fill(0);
  }

  stats() {
    const out: Record<string, number> = { total: +this.totalAvg.toFixed(3), heapMB: +this.heapMB.toFixed(1), gcs: this.gcs };
    for (let i = 0; i < N; i++) out[PERF_SYSTEMS[i]] = +this.avg[i].toFixed(3);
    return out;
  }
}

export const probe = new PerfProbe(typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf'));
