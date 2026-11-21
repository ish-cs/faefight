import type { FromViewer, ToViewer } from './viewerWorker';

export type ReplayInfo = Extract<FromViewer, { type: 'info' }>;
export type ReplayState = Extract<FromViewer, { type: 'state' }>;

/**
 * Page side of a replay: the worker that re-simulates it, plus the playback clock the renderer
 * interpolates against (it runs at the replay speed and stops while paused, so 8× and pause look smooth).
 */
export class ReplayLink {
  private worker = new Worker(new URL('./viewerWorker.ts', import.meta.url), { type: 'module' });
  private vt = 0;
  private wall = performance.now();
  private speed = 1;
  private playing = false;
  readonly info: Promise<ReplayInfo>;
  onSnapshot: (m: Extract<FromViewer, { type: 'snapshot' }>) => void = () => {};
  onState: (s: ReplayState) => void = () => {};
  onError: (message: string) => void = (m) => console.error(`[replay] ${m}`);
  last: ReplayState | null = null;

  constructor(bytes: Uint8Array) {
    let gotInfo: (i: ReplayInfo) => void, failed: (e: Error) => void;
    this.info = new Promise((res, rej) => { gotInfo = res; failed = rej; });
    this.worker.onerror = (e) => { const msg = `replay worker crashed: ${e.message}`; failed(new Error(msg)); this.onError(msg); };
    this.worker.onmessage = (e: MessageEvent<FromViewer>) => {
      const m = e.data;
      if (m.type === 'info') gotInfo(m);
      else if (m.type === 'snapshot') this.onSnapshot(m);
      else if (m.type === 'state') {
        this.clock();
        this.playing = m.playing;
        this.speed = m.speed;
        this.last = m;
        this.onState(m);
      } else if (m.type === 'error') {
        failed(new Error(m.message));
        this.onError(m.message);
      }
    };
    this.send({ type: 'load', bytes });
  }

  private send(m: ToViewer) { this.worker.postMessage(m); }

  /** Playback clock (s) for the renderer's interpolation. */
  clock = (): number => {
    const now = performance.now();
    if (this.playing) this.vt += ((now - this.wall) / 1000) * this.speed;
    this.wall = now;
    return this.vt;
  };

  play() { this.send({ type: 'play' }); }
  pause() { this.send({ type: 'pause' }); }
  setSpeed(x: number) { this.send({ type: 'speed', speed: x }); }
  seek(tick: number) { this.send({ type: 'seek', tick }); }

  close() {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }
}
