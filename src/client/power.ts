import type { GovernorKnobs } from './governor';

/**
 * Power mode (Settings → Video → Power): what a laptop on battery should trade for smoothness.
 *
 * - quality: never trims (plugged-in behaviour; the frame cap and dynamic resolution settings as set).
 * - performance: always the saver.
 * - auto (default): the saver while the battery is discharging (navigator.getBattery, where the browser has it)
 *   or while frames are persistently slow (frame-time average over the display's budget × slowFrac for slowSec),
 *   with hysteresis: it holds at least holdSec, leaves only after exitSec of main-thread headroom, and a saver
 *   that had to come straight back holds twice as long next time (no flapping).
 *
 * The saver: a stable frame cap (60, or the user's lower cap), dynamic resolution on, and cheaper effects through
 * the frame governor's knobs (GTAO cheap, grass and LOD distance trimmed, render scale ≤ resMax). Every one is a
 * live uniform / size / count: switching never recompiles a shader (docs/perf.md "Frame-time governor").
 * Pure (no DOM): main.ts feeds it frames and the battery state.
 */
export const POWER_MODES = ['auto', 'performance', 'quality'] as const;
export type PowerMode = (typeof POWER_MODES)[number];

export const POWER = {
  /** saver frame cap (Hz): a steady 60 beats a 90–140 swing on efficiency cores */
  capHz: 60,
  /** auto: frame-time EMA above display budget × slowFrac for slowSec → saver */
  slowFrac: 1.3,
  slowSec: 5,
  /** auto (slow-triggered): leave after exitSec with main-thread work EMA below display budget × exitWorkFrac */
  exitWorkFrac: 0.6,
  exitSec: 15,
  /** minimum time in the saver once entered; doubled (up to maxHoldSec) when it re-enters within reentrySec */
  holdSec: 30,
  maxHoldSec: 240,
  reentrySec: 30,
  tauMs: 500,
  /** menus / unfocused window: frame cap (Hz) */
  idleCapHz: 30,
};

/** Effect trims while saving (applied on top of the governor's own knobs: whichever is cheaper wins). */
export const SAVER_TRIM = { ao: 1 as const, grass: 0.75, lodBias: 0.85, resMax: 0.85 };

export class PowerState {
  mode: PowerMode = 'auto';
  /** null = the browser can't tell (no Battery Status API) */
  onBattery: boolean | null = null;
  private slow = false;
  private ema = 0;
  private workEma = 0;
  private overT = 0;
  private underT = 0;
  private heldT = 0;
  private hold = POWER.holdSec;
  private sinceExit = Infinity;

  get saver(): boolean {
    if (this.mode === 'performance') return true;
    if (this.mode === 'quality') return false;
    return this.onBattery === true || this.slow;
  }

  get reason(): string {
    if (this.mode !== 'auto') return this.mode;
    return this.onBattery === true ? 'battery' : this.slow ? 'slow frames' : 'plugged in';
  }

  /**
   * One drawn frame: `ms` interval, `workMs` main-thread time, `displayBudgetMs` the display's own frame time
   * (uncapped). Returns true when `saver` changed.
   */
  frame(ms: number, workMs: number, displayBudgetMs: number): boolean {
    if (!(ms > 0) || ms > 250) return false;
    const dt = ms / 1000;
    const k = 1 - Math.exp(-ms / POWER.tauMs);
    this.ema = this.ema === 0 ? ms : this.ema + (ms - this.ema) * k;
    this.workEma = this.workEma === 0 ? workMs : this.workEma + (workMs - this.workEma) * k;
    this.sinceExit += dt;
    if (this.mode !== 'auto' || this.onBattery === true) { this.overT = this.underT = 0; return false; }
    if (!this.slow) {
      this.overT = this.ema > displayBudgetMs * POWER.slowFrac ? this.overT + dt : 0;
      if (this.overT < POWER.slowSec) return false;
      this.slow = true;
      this.heldT = 0;
      this.underT = 0;
      this.hold = this.sinceExit < POWER.reentrySec ? Math.min(POWER.maxHoldSec, this.hold * 2) : POWER.holdSec;
      return true;
    }
    this.heldT += dt;
    this.underT = this.workEma < displayBudgetMs * POWER.exitWorkFrac ? this.underT + dt : 0;
    if (this.heldT < this.hold || this.underT < POWER.exitSec) return false;
    this.slow = false;
    this.overT = 0;
    this.sinceExit = 0;
    return true;
  }

  /** Effective frame cap (0 = vsync) for the user's cap, the saver and menus. */
  cap(userCap: number, idle: boolean): number {
    let c = userCap;
    if (this.saver) c = c ? Math.min(c, POWER.capHz) : POWER.capHz;
    if (idle) c = c ? Math.min(c, POWER.idleCapHz) : POWER.idleCapHz;
    return c;
  }

  /** The governor's knobs with the saver's trims on top. */
  trim(k: GovernorKnobs): GovernorKnobs {
    if (!this.saver) return k;
    return {
      ao: Math.max(k.ao, SAVER_TRIM.ao) as 0 | 1 | 2,
      shadowScale: k.shadowScale,
      grass: Math.min(k.grass, SAVER_TRIM.grass),
      lodBias: Math.min(k.lodBias, SAVER_TRIM.lodBias),
      res: Math.min(k.res, SAVER_TRIM.resMax),
    };
  }

  info() { return { mode: this.mode, onBattery: this.onBattery, saver: this.saver, reason: this.reason, emaMs: +this.ema.toFixed(2), workMs: +this.workEma.toFixed(2) }; }
}

/** Battery Status API (Chromium): calls `on(discharging)` now and on every change; no-op where unsupported. */
export function watchBattery(on: (discharging: boolean) => void): () => void {
  type Bat = { charging: boolean; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
  const nav = navigator as unknown as { getBattery?: () => Promise<Bat> };
  if (!nav.getBattery) return () => {};
  let bat: Bat | null = null, stopped = false;
  const f = () => { if (bat) on(!bat.charging); };
  nav.getBattery().then((b) => { if (stopped) return; bat = b; f(); b.addEventListener('chargingchange', f); }, () => {});
  return () => { stopped = true; bat?.removeEventListener('chargingchange', f); };
}
