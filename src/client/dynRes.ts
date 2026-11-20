/**
 * Dynamic resolution: trades render resolution for frame rate. Pure (no three.js / DOM); the frame loop feeds
 * it every frame interval and applies `scale` as a multiplier on the renderer's pixel ratio.
 *
 * - A smoothed frame time (EMA, ~250 ms time constant) above budget × `overFrac` for `overSec` drops the scale
 *   one step; one hitch (shader compile, GC) never does.
 * - Back under budget × `underFrac` for `raiseAfterSec` raises it one small step.
 * - Every change waits out `cooldownSec` (each change reallocates render targets, a cost of its own).
 * - Hysteresis: a raise that overloads again within `failWindowSec` is undone (back to the level that held) and
 *   the next raise waits twice as long (up to `maxBackoff`×), so a GPU sitting right at the edge settles instead
 *   of flipping between two scales forever. A raise that holds halves the wait again.
 */
export const DYNRES = {
  minScale: 0.6,
  maxScale: 1,
  downStep: 0.1,
  upStep: 0.05,
  overFrac: 1.2,
  underFrac: 1.08,
  overSec: 0.6,
  raiseAfterSec: 3,
  cooldownSec: 1,
  failWindowSec: 4,
  maxBackoff: 16,
  /** Frame intervals above this are not frames (tab hidden, debugger): ignored. */
  ignoreMs: 250,
  /** Frames are clamped to this before smoothing/timing, so one hitch can't trip a drop. */
  sampleCapMs: 50,
  tauMs: 250,
};

export class DynamicResolution {
  enabled = true;
  private s = 1;
  private ema = 0;
  private overT = 0;
  private underT = 0;
  private sinceChange = Infinity;
  private backoff = 1;
  /** Seconds since the last raise, and the scale it raised from (for undoing a failed raise). */
  private sinceRaise = Infinity;
  private beforeRaise = 1;

  /** Current render-scale multiplier (1 when disabled). */
  get scale(): number { return this.enabled ? this.s : 1; }
  /** Smoothed frame time (ms), for debugging. */
  get smoothedMs(): number { return this.ema; }

  /** One frame took `ms` (interval since the previous frame); `budgetMs` = target frame time. */
  frame(ms: number, budgetMs: number): void {
    if (!this.enabled || !(ms > 0) || ms > DYNRES.ignoreMs) return;
    const x = Math.min(ms, DYNRES.sampleCapMs);
    const k = 1 - Math.exp(-x / DYNRES.tauMs);
    this.ema = this.ema === 0 ? x : this.ema + (x - this.ema) * k;
    const dt = x / 1000;
    this.sinceChange += dt;
    this.sinceRaise += dt;
    if (this.sinceRaise > DYNRES.failWindowSec && this.sinceRaise - dt <= DYNRES.failWindowSec) this.backoff = Math.max(1, this.backoff / 2);

    if (this.ema > budgetMs * DYNRES.overFrac) { this.overT += dt; this.underT = 0; }
    else if (this.ema <= budgetMs * DYNRES.underFrac) { this.underT += dt; this.overT = 0; }
    else { this.overT = 0; this.underT = 0; }

    if (this.sinceChange < DYNRES.cooldownSec) return;
    if (this.overT >= DYNRES.overSec && this.s > DYNRES.minScale) {
      const failedRaise = this.sinceRaise <= DYNRES.failWindowSec;
      if (failedRaise) this.backoff = Math.min(DYNRES.maxBackoff, this.backoff * 2);
      this.set(failedRaise ? this.beforeRaise : this.s - DYNRES.downStep);
      this.sinceRaise = Infinity;
    } else if (this.underT >= DYNRES.raiseAfterSec * this.backoff && this.s < DYNRES.maxScale) {
      this.beforeRaise = this.s;
      this.set(this.s + DYNRES.upStep);
      this.sinceRaise = 0;
    }
  }

  private set(x: number) {
    this.s = Math.round(Math.max(DYNRES.minScale, Math.min(DYNRES.maxScale, x)) * 100) / 100;
    this.sinceChange = 0;
    this.overT = 0;
    this.underT = 0;
  }
}
