/**
 * Frame-time budget governor (pure: no three.js / DOM). Holds a stable frame rate by stepping quality knobs down
 * one at a time while frames run over budget, and back up (last in, first out) with headroom.
 *
 * Which knob goes first depends on what the frame is bound by. The frame loop passes the main-thread time of each
 * frame next to its interval: when the main thread is busy for well under the frame interval, the GPU is the
 * limit (a Retina Mac on high), so render scale drops first, in small 5 % steps, with GTAO getting cheaper in
 * between. When the main thread fills the frame, scale barely helps: LOD distance, grass and shadows go first.
 *
 * No knob may recompile a shader (a mid-match pipeline rebuild froze the game for seconds): every one is a live
 * size, count or uniform. GTAO never switches off, it only gets cheaper (resolution).
 *
 * Timing is DynamicResolution's (dynRes.ts): a smoothed frame time (EMA) over budget × overFrac for overSec steps
 * down; under budget × underFrac for raiseAfterSec steps up; every change waits cooldownSec; a raise that
 * overloads again within failWindowSec is undone and the next raise waits twice as long (backoff).
 */
export type GovernorKnobs = {
  /** GTAO cost level: 0 = full, 1 = cheap (60 % resolution), 2 = minimal (30 % resolution) */
  ao: 0 | 1 | 2;
  /** shadow map size multiplier (1, 0.5) */
  shadowScale: number;
  /** grass density multiplier */
  grass: number;
  /** multiplier on every LOD / cull distance */
  lodBias: number;
  /** render-resolution multiplier on the pixel ratio */
  res: number;
};

export const FULL_KNOBS: GovernorKnobs = { ao: 0, shadowScale: 1, grass: 1, lodBias: 1, res: 1 };

export type Step = 'res' | 'ao' | 'shadow' | 'grass' | 'lod';

/** Step limits: res goes 1 → 0.6 in 5 % steps; AO two levels; the rest one step each. */
export const RES_STEP = 0.05, RES_MIN = 0.6;

/** Step-down priority. GPU-bound: render scale first (smooth), cheaper AO in between; CPU-bound: draw-side first. */
export const GPU_ORDER: Step[] = ['res', 'res', 'ao', 'res', 'res', 'shadow', 'res', 'res', 'ao', 'res', 'res', 'grass', 'lod'];
export const CPU_ORDER: Step[] = ['lod', 'grass', 'shadow', 'ao', 'ao', 'res', 'res', 'res', 'res', 'res', 'res', 'res', 'res'];

export const GOVERNOR = {
  overFrac: 1.15,
  underFrac: 1.0,
  overSec: 0.6,
  raiseAfterSec: 3,
  cooldownSec: 1,
  /** render-scale steps are small and cheap: they may follow each other faster */
  resCooldownSec: 0.4,
  failWindowSec: 4,
  maxBackoff: 16,
  /** main-thread share of the frame below which the frame counts as GPU-bound */
  gpuBoundFrac: 0.6,
  /** Frame intervals above this are not frames (tab hidden, debugger): ignored. */
  ignoreMs: 250,
  /** Frames are clamped to this before smoothing, so one hitch can't trip a drop. */
  sampleCapMs: 50,
  tauMs: 250,
};

export function applyStep(k: GovernorKnobs, s: Step): GovernorKnobs | null {
  switch (s) {
    case 'res': return k.res - RES_STEP < RES_MIN - 1e-9 ? null : { ...k, res: Math.round((k.res - RES_STEP) * 100) / 100 };
    case 'ao': return k.ao >= 2 ? null : { ...k, ao: (k.ao + 1) as 1 | 2 };
    case 'shadow': return k.shadowScale < 1 ? null : { ...k, shadowScale: 0.5 };
    case 'grass': return k.grass < 1 ? null : { ...k, grass: 0.5 };
    case 'lod': return k.lodBias < 1 ? null : { ...k, lodBias: 0.7 };
  }
}

export class FrameGovernor {
  enabled = true;
  /** knobs after each applied step; [0] = full quality */
  private stack: GovernorKnobs[] = [FULL_KNOBS];
  private steps: Step[] = [];
  private ema = 0;
  private workEma = 0;
  private overT = 0;
  private underT = 0;
  private sinceChange = Infinity;
  private backoff = 1;
  private sinceRaise = Infinity;
  private undone: { knobs: GovernorKnobs; step: Step } | null = null;
  /** Optional: steps that do nothing on this preset (e.g. AO when the preset has none) are skipped. */
  constructor(private skip: (s: Step) => boolean = () => false) {}

  get knobs(): GovernorKnobs { return this.enabled ? this.stack[this.stack.length - 1] : FULL_KNOBS; }
  get level(): number { return this.enabled ? this.steps.length : 0; }
  get smoothedMs(): number { return this.ema; }
  /** true when the last frames were GPU-bound (main thread idle for most of the frame) */
  get gpuBound(): boolean { return this.ema > 0 && this.workEma < this.ema * GOVERNOR.gpuBoundFrac; }

  setSkip(skip: (s: Step) => boolean) { this.skip = skip; }

  /**
   * One frame took `ms` (interval); `budgetMs` = target frame time; `workMs` = main-thread time spent in it
   * (omit = assume CPU-bound). Returns true when the knobs changed.
   */
  frame(ms: number, budgetMs: number, workMs = ms): boolean {
    if (!this.enabled || !(ms > 0) || ms > GOVERNOR.ignoreMs) return false;
    const x = Math.min(ms, GOVERNOR.sampleCapMs);
    const k = 1 - Math.exp(-x / GOVERNOR.tauMs);
    this.ema = this.ema === 0 ? x : this.ema + (x - this.ema) * k;
    const w = Math.min(workMs, x);
    this.workEma = this.workEma === 0 ? w : this.workEma + (w - this.workEma) * k;
    const dt = x / 1000;
    this.sinceChange += dt;
    this.sinceRaise += dt;
    if (this.sinceRaise > GOVERNOR.failWindowSec && this.sinceRaise - dt <= GOVERNOR.failWindowSec) this.backoff = Math.max(1, this.backoff / 2);

    if (this.ema > budgetMs * GOVERNOR.overFrac) { this.overT += dt; this.underT = 0; }
    else if (this.ema <= budgetMs * GOVERNOR.underFrac) { this.underT += dt; this.overT = 0; }
    else { this.overT = 0; this.underT = 0; }

    const lastStep = this.steps[this.steps.length - 1];
    const cooldown = lastStep === 'res' ? GOVERNOR.resCooldownSec : GOVERNOR.cooldownSec;
    if (this.sinceChange < cooldown) return false;
    if (this.overT >= GOVERNOR.overSec) {
      if (this.sinceRaise <= GOVERNOR.failWindowSec && this.undone) {
        // the raise didn't hold: put that step back and wait twice as long before trying again
        this.backoff = Math.min(GOVERNOR.maxBackoff, this.backoff * 2);
        this.push(this.undone.knobs, this.undone.step);
        this.undone = null;
        this.sinceRaise = Infinity;
        return true;
      }
      const next = this.nextDown();
      if (!next) return false;
      this.push(next.knobs, next.step);
      this.sinceRaise = Infinity;
      return true;
    }
    if (this.underT >= GOVERNOR.raiseAfterSec * this.backoff && this.steps.length > 0) {
      this.undone = { knobs: this.stack[this.stack.length - 1], step: this.steps[this.steps.length - 1] };
      this.stack.pop();
      this.steps.pop();
      this.changed();
      this.sinceRaise = 0;
      return true;
    }
    return false;
  }

  /** First applicable step in the order for the current bound. */
  private nextDown(): { knobs: GovernorKnobs; step: Step } | null {
    const cur = this.stack[this.stack.length - 1];
    // walk the order, consuming the steps already taken, so 'res' entries interleave with the others
    const taken = new Map<Step, number>();
    for (const s of this.steps) taken.set(s, (taken.get(s) ?? 0) + 1);
    for (const s of this.gpuBound ? GPU_ORDER : CPU_ORDER) {
      const t = taken.get(s) ?? 0;
      if (t > 0) { taken.set(s, t - 1); continue; }
      if (this.skip(s)) continue;
      const k = applyStep(cur, s);
      if (k) return { knobs: k, step: s };
    }
    return null;
  }

  private push(k: GovernorKnobs, s: Step) {
    this.stack.push(k);
    this.steps.push(s);
    this.changed();
  }

  private changed() {
    this.sinceChange = 0;
    this.overT = 0;
    this.underT = 0;
  }

  /** Back to full quality (preset change: the new preset gets a fresh start). */
  reset() {
    this.stack = [FULL_KNOBS];
    this.steps = [];
    this.undone = null;
    this.changed();
    this.sinceRaise = Infinity;
    this.backoff = 1;
  }
}
