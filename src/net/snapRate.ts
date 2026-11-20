/**
 * Per-client snapshot rate: every sim tick (30 Hz) while that client's stream fits the bandwidth
 * budget, every 2nd tick (15 Hz) otherwise. Hysteresis keeps it from flapping: it drops to 15 Hz
 * when the projected 30 Hz rate passes `downFrac` of the budget and comes back only under `upFrac`.
 */
export const SNAP_RATE = {
  /** Per-client downstream budget (bytes/s). */
  budgetBps: 32 * 1024,
  upFrac: 0.6,
  downFrac: 0.9,
  /** EWMA weight of the newest message size. */
  alpha: 0.1,
  tickHz: 30,
};

export class SnapRate {
  fast = true;
  private avg = 0;

  /** Should this client get the snapshot of sim tick `tick`? */
  due(tick: number): boolean {
    return this.fast || tick % 2 === 0;
  }

  /** A message of `bytes` went out; full (non-delta) snapshots are one-offs and don't count. */
  sent(bytes: number, full: boolean): void {
    if (full) return;
    this.avg = this.avg ? this.avg + (bytes - this.avg) * SNAP_RATE.alpha : bytes;
    const bps = this.avg * SNAP_RATE.tickHz;
    if (this.fast && bps > SNAP_RATE.budgetBps * SNAP_RATE.downFrac) this.fast = false;
    else if (!this.fast && bps < SNAP_RATE.budgetBps * SNAP_RATE.upFrac) this.fast = true;
  }

  /** Smoothed message size (bytes), for debugging. */
  get avgBytes() { return this.avg; }
}
