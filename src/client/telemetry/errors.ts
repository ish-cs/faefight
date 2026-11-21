/**
 * Client error capture → /api/errors. Uncaught errors, unhandled rejections, worker crashes, WebGPU
 * device loss and (sampled) long frames are deduped per page session and sent in small batches, so a
 * crash loop costs one upload, not thousands. Feeds docs/auto-health.md via scripts/auto-improve.ts.
 */
import { defaultDeps, postWithRetry, type UploadDeps } from './upload';

export type ErrorKind = 'error' | 'rejection' | 'worker' | 'gpu' | 'longframe' | 'fatal';
export type Report = { build: string; kind: ErrorKind; message: string; stack?: string; replayId?: string; tick?: number; count: number; ua?: string; at: string };

export const LONG_FRAME_MS = 100;
/** Unique signatures sent per page session (repeats only bump the count). */
const MAX_UNIQUE = 15;
const FLUSH_DELAY_MS = 5000;

export class ErrorReporter {
  private pending = new Map<string, Report>();
  private seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private longFrames = 0;
  private worstFrame = 0;
  /** Current match context, attached to every report. */
  context: { replayId?: string; tick?: number } = {};

  constructor(private build: string, private url = '/api/errors', private deps: UploadDeps = defaultDeps(), private now = () => new Date()) {}

  report(kind: ErrorKind, message: string, stack?: string): void {
    const msg = String(message || 'unknown').slice(0, 1000);
    const key = `${kind}|${msg}|${(stack ?? '').split('\n')[1]?.trim() ?? ''}`;
    const p = this.pending.get(key);
    if (p) { p.count++; return; }
    if (this.seen.has(key)) return; // already sent this session
    if (this.seen.size >= MAX_UNIQUE) return;
    this.seen.add(key);
    this.pending.set(key, {
      build: this.build, kind, message: msg, stack: stack?.slice(0, 4000), replayId: this.context.replayId, tick: this.context.tick, count: 1,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : undefined, at: this.now().toISOString(),
    });
    if (!this.timer) this.timer = setTimeout(() => { void this.flush(); }, FLUSH_DELAY_MS);
  }

  /** Called every rendered frame with its duration; long frames are reported once per session as a count. */
  frame(ms: number): void {
    if (ms < LONG_FRAME_MS || (typeof document !== 'undefined' && document.hidden)) return;
    this.longFrames++;
    this.worstFrame = Math.max(this.worstFrame, ms);
  }

  async flush(keepalive = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.longFrames >= 5) { // a few hitches (loading, tab switch) are normal; sustained ones are not
      const key = 'longframe';
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.pending.set(key, { build: this.build, kind: 'longframe', message: `frames over ${LONG_FRAME_MS} ms (worst ${Math.round(this.worstFrame)} ms)`, count: this.longFrames, at: this.now().toISOString(), ...this.context });
      }
    }
    if (this.pending.size === 0) return;
    const reports = [...this.pending.values()];
    this.pending.clear();
    await postWithRetry(this.url, JSON.stringify({ reports }), 'application/json', this.deps, { attempts: keepalive ? 1 : 3, keepalive });
  }

  /** Hook window-level errors and flush on page hide. */
  install(win: Window): void {
    win.addEventListener('error', (e) => this.report('error', e.message, (e.error as Error | undefined)?.stack ?? `at ${e.filename}:${e.lineno}:${e.colno}`));
    win.addEventListener('unhandledrejection', (e) => {
      const r = e.reason as Error | undefined;
      this.report('rejection', r?.message ?? String(e.reason), r?.stack);
    });
    win.addEventListener('pagehide', () => { void this.flush(true); });
  }
}

declare const __BUILD_ID__: string;
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** The page-wide reporter (null in tests / when not installed). */
export let errors: ErrorReporter | null = null;

export function installErrorReporting(win: Window = window): ErrorReporter {
  errors = new ErrorReporter(BUILD_ID);
  errors.install(win);
  return errors;
}
