/**
 * Frame-time budget governor (pure: no three.js / DOM). Holds a stable frame rate by walking a ladder of
 * quality knobs: the expensive effects go first (GTAO, shadow resolution, grass density, LOD distance), render
 * resolution only after them; with headroom it climbs back the same way, effects last-in first-out.
 *
 * Timing is DynamicResolution's (dynRes.ts): a smoothed frame time (EMA) over budget × overFrac for overSec steps
 * down one rung; under budget × underFrac for raiseAfterSec steps up one rung; every change waits cooldownSec; a
 * raise that overloads again within failWindowSec is undone and the next raise waits twice as long (backoff).
 */
export type GovernorKnobs = {
  /** screen-space ambient occlusion on (if the preset has it) */
  ao: boolean;
  /** shadow map size multiplier (1, 0.5) */
  shadowScale: number;
  /** grass density multiplier */
  grass: number;
  /** multiplier on every LOD / cull distance */
  lodBias: number;
  /** render-resolution multiplier on the pixel ratio */
  res: number;
};

export const FULL_KNOBS: GovernorKnobs = { ao: true, shadowScale: 1, grass: 1, lodBias: 1, res: 1 };

/** The ladder, rung 0 = everything on. Each rung cuts one more thing; resolution is the last resort. */
export const GOVERNOR_LADDER: GovernorKnobs[] = [
  FULL_KNOBS,
  { ao: false, shadowScale: 1, grass: 1, lodBias: 1, res: 1 },
  { ao: false, shadowScale: 0.5, grass: 1, lodBias: 1, res: 1 },
  { ao: false, shadowScale: 0.5, grass: 0.5, lodBias: 1, res: 1 },
  { ao: false, shadowScale: 0.5, grass: 0.5, lodBias: 0.7, res: 1 },
  { ao: false, shadowScale: 0.5, grass: 0.5, lodBias: 0.7, res: 0.9 },
  { ao: false, shadowScale: 0.5, grass: 0.5, lodBias: 0.7, res: 0.8 },
  { ao: false, shadowScale: 0.5, grass: 0.35, lodBias: 0.6, res: 0.7 },
  { ao: false, shadowScale: 0.5, grass: 0.35, lodBias: 0.6, res: 0.6 },
];

export const GOVERNOR = {
  overFrac: 1.15,
  underFrac: 1.0,
  overSec: 0.6,
  raiseAfterSec: 3,
  cooldownSec: 1,
  failWindowSec: 4,
  maxBackoff: 16,
  /** Frame intervals above this are not frames (tab hidden, debugger): ignored. */
  ignoreMs: 250,
  /** Frames are clamped to this before smoothing, so one hitch can't trip a drop. */
  sampleCapMs: 50,
  tauMs: 250,
};

export class FrameGovernor {
  enabled = true;
  private rung = 0;
  private ema = 0;
  private overT = 0;
  private underT = 0;
  private sinceChange = Infinity;
  private backoff = 1;
  private sinceRaise = Infinity;
  private beforeRaise = 0;

  /**
   * `ladder` defaults to GOVERNOR_LADDER; `skip(a, b)` = true when stepping a → b changes nothing on this preset
   * (e.g. AO already off on low): such rungs are passed through in one change.
   */
  constructor(private ladder: GovernorKnobs[] = GOVERNOR_LADDER, private skip: (a: GovernorKnobs, b: GovernorKnobs) => boolean = () => false) {}

  /** Current knobs (full quality when disabled). */
  get knobs(): GovernorKnobs { return this.enabled ? this.ladder[this.rung] : this.ladder[0]; }
  get level(): number { return this.enabled ? this.rung : 0; }
  get smoothedMs(): number { return this.ema; }

  setSkip(skip: (a: GovernorKnobs, b: GovernorKnobs) => boolean) { this.skip = skip; }

  /** One frame took `ms`; `budgetMs` = target frame time. Returns true when the knobs changed. */
  frame(ms: number, budgetMs: number): boolean {
    if (!this.enabled || !(ms > 0) || ms > GOVERNOR.ignoreMs) return false;
    const x = Math.min(ms, GOVERNOR.sampleCapMs);
    const k = 1 - Math.exp(-x / GOVERNOR.tauMs);
    this.ema = this.ema === 0 ? x : this.ema + (x - this.ema) * k;
    const dt = x / 1000;
    this.sinceChange += dt;
    this.sinceRaise += dt;
    if (this.sinceRaise > GOVERNOR.failWindowSec && this.sinceRaise - dt <= GOVERNOR.failWindowSec) this.backoff = Math.max(1, this.backoff / 2);

    if (this.ema > budgetMs * GOVERNOR.overFrac) { this.overT += dt; this.underT = 0; }
    else if (this.ema <= budgetMs * GOVERNOR.underFrac) { this.underT += dt; this.overT = 0; }
    else { this.overT = 0; this.underT = 0; }

    if (this.sinceChange < GOVERNOR.cooldownSec) return false;
    const last = this.ladder.length - 1;
    if (this.overT >= GOVERNOR.overSec && this.rung < last) {
      const failedRaise = this.sinceRaise <= GOVERNOR.failWindowSec;
      if (failedRaise) this.backoff = Math.min(GOVERNOR.maxBackoff, this.backoff * 2);
      this.set(failedRaise ? this.beforeRaise : this.next(this.rung, 1));
      this.sinceRaise = Infinity;
      return true;
    }
    if (this.underT >= GOVERNOR.raiseAfterSec * this.backoff && this.rung > 0) {
      this.beforeRaise = this.rung;
      this.set(this.next(this.rung, -1));
      this.sinceRaise = 0;
      return true;
    }
    return false;
  }

  /** Next rung in direction `dir`, passing rungs that change nothing (skip). */
  private next(r: number, dir: 1 | -1): number {
    const L = this.ladder, last = L.length - 1;
    let n = r + dir;
    if (dir > 0) while (n < last && this.skip(L[n - 1], L[n])) n++; // step n-1 → n was a no-op: keep going
    else while (n > 0 && this.skip(L[n], L[n + 1])) n--;
    return Math.max(0, Math.min(last, n));
  }

  private set(r: number) {
    this.rung = r;
    this.sinceChange = 0;
    this.overT = 0;
    this.underT = 0;
  }

  /** Back to full quality (preset change: the new preset gets a fresh start). */
  reset() {
    this.set(0);
    this.sinceRaise = Infinity;
    this.backoff = 1;
  }
}
